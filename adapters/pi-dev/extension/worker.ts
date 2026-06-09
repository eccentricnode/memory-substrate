import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeEnv } from "./config.ts";

export type BatchTrigger = "agent_end" | "session_before_compact";
export type WorkerRunStatus = "completed" | "failed" | "refused";
export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryBatchItem {
  id: string;
  trigger: BatchTrigger;
  createdAt: number;
  messageCount: number;
  messages?: unknown[];
  payload?: unknown;
}

export interface MemoryWorkerRequest {
  batchId: string;
  items: MemoryBatchItem[];
  cwd: string;
  memoryRoot: string;
  model: string;
  dryRun: boolean;
  env: RuntimeEnv;
}

export interface MemoryWorkerResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  changedPaths?: string[];
  proposedPaths?: string[];
  validator?: MemoryValidationResult;
}

export interface MemoryWorkerRunner {
  supportsEnv: boolean;
  run(request: MemoryWorkerRequest): Promise<MemoryWorkerResult>;
}

export type MemoryDraftAction = "upsert" | "delete";

export interface MemoryWriteDraft {
  action?: MemoryDraftAction;
  type?: MemoryType;
  description?: string;
  body?: string;
  hook?: string;
  title?: string;
  name?: string;
  relativePath?: string;
}

export interface DeterministicMemoryWorkerOptions {
  decideWrites?: (request: MemoryWorkerRequest) => MemoryWriteDraft[];
  validate?: (memoryRoot: string) => Promise<MemoryValidationResult>;
}

export interface LivePiProcessOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface LivePiProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export type LivePiProcessExecutor = (
  command: string,
  args: string[],
  options: LivePiProcessOptions,
) => Promise<LivePiProcessResult>;

export interface LivePiMemoryWorkerOptions {
  command?: string;
  timeoutMs?: number;
  process?: LivePiProcessExecutor;
  validate?: (memoryRoot: string) => Promise<MemoryValidationResult>;
}

export interface MemoryValidationResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export const RECURSION_GUARD_ENV: RuntimeEnv = {
  PI_MEMORY_ENABLED: "0",
};

export function buildWorkerEnv(request: {
  memoryRoot: string;
  model: string;
  dryRun: boolean;
}): RuntimeEnv {
  return {
    ...RECURSION_GUARD_ENV,
    PI_MEMORY_ROOT: request.memoryRoot,
    PI_MEMORY_MODEL: request.model,
    PI_MEMORY_DRY_RUN: request.dryRun ? "1" : "0",
  };
}

export function outputTail(stdout = "", stderr = "", maxChars = 800): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  if (combined.length <= maxChars) return combined;
  return combined.slice(combined.length - maxChars);
}

const VALID_TYPES = new Set<MemoryType>([
  "user",
  "feedback",
  "project",
  "reference",
]);
const DESCRIPTION_CAP = 200;
const HOOK_CAP = 150;
const INDEX_POINTER_LINE_CAP = 150;
const INDEX_LINE_CAP = 150;
const INDEX_BYTE_CAP = 25 * 1024;
const EXISTING_MEMORY_SNAPSHOT_BYTE_CAP = 8 * 1024;
const EXISTING_MEMORY_SNAPSHOT_TOPIC_CAP = 40;
const SNAPSHOT_FIELD_CAP = 240;
const LIVE_WORKER_TIMEOUT_MS = 120_000;
const LIVE_WORKER_REACHABILITY_PROMPT =
  "Memory worker model reachability check. Reply exactly: OK";
const VALIDATOR_PATH = fileURLToPath(
  new URL("../../../reference/validator.ts", import.meta.url),
);
const DEDUPE_STOP_WORDS = new Set([
  "about",
  "agent",
  "apply",
  "that",
  "this",
  "when",
  "with",
  "from",
  "into",
  "for",
  "all",
  "and",
  "the",
  "one",
  "two",
  "memory",
  "project",
  "reference",
  "feedback",
  "user",
  "must",
  "should",
  "shall",
  "use",
  "uses",
  "using",
]);

function isInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(`${resolvedRoot}${sep}`)
  );
}

function nearestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function safePath(root: string, relativePath: string): string {
  if (relativePath.trim() === "" || relativePath.includes("\0")) {
    throw new Error("empty or invalid memory path");
  }
  const target = resolve(root, relativePath);
  if (!isInsideRoot(root, target)) {
    throw new Error(`refusing out-of-root memory path: ${relativePath}`);
  }
  const realRoot = realpathSync(root);
  if (existsSync(target)) {
    const realTarget = realpathSync(target);
    if (!isInsideRoot(realRoot, realTarget)) {
      throw new Error(`refusing symlink escape memory path: ${relativePath}`);
    }
    return target;
  }
  const realAncestor = realpathSync(nearestExistingAncestor(dirname(target)));
  if (!isInsideRoot(realRoot, realAncestor)) {
    throw new Error(`refusing symlink escape memory path: ${relativePath}`);
  }
  return target;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
  return slug || "memory";
}

function titleize(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function oneLine(value: string, cap: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length <= cap) return line;
  return line.slice(0, cap - 1).trimEnd();
}

function requiredOneLineField(
  value: string | undefined,
  fieldName: string,
  cap: number,
): string {
  const line = (value ?? "").replace(/\s+/g, " ").trim();
  if (!line) throw new Error(`memory ${fieldName} is required`);
  if (line.length > cap) {
    throw new Error(
      `memory ${fieldName} must be <=${cap} characters (${line.length} chars)`,
    );
  }
  return line;
}

function textFromMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromMessage).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return [
    record.text,
    record.content,
    record.message,
    record.messages,
    record.prompt,
    record.summary,
    record.preparation,
  ]
    .map(textFromMessage)
    .filter(Boolean)
    .join("\n");
}

function batchText(request: MemoryWorkerRequest): string {
  return request.items
    .flatMap((item) => item.messages ?? [])
    .map(textFromMessage)
    .filter(Boolean)
    .join("\n");
}

function classifyMemory(text: string): MemoryType {
  const lower = text.toLowerCase();
  if (/https?:\/\/|linear|slack|github|repo|channel/.test(lower)) return "reference";
  if (/correct|correction|should not|worked|failed|instead/.test(lower)) {
    return "feedback";
  }
  if (/\bi prefer\b|\bmy preference\b|\bmy role\b|\bi am\b|\bi'm\b/.test(lower)) {
    return "user";
  }
  return "project";
}

function durableFactFromText(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  const patterns = [
    /\bremember(?:\s+that)?\s+(.+?)(?:$|[.!?]\s)/i,
    /\bdurable decision is\s+(?:to\s+)?(.+?)(?:$|[.!?]\s)/i,
    /\bdecision is\s+(?:to\s+)?(.+?)(?:$|[.!?]\s)/i,
    /\bpreference is\s+(.+?)(?:$|[.!?]\s)/i,
    /\bcorrection:\s+(.+?)(?:$|[.!?]\s)/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const fact = match?.[1]?.trim().replace(/[.!?]+$/g, "");
    if (fact) return fact;
  }
  return undefined;
}

function defaultDecideWrites(request: MemoryWorkerRequest): MemoryWriteDraft[] {
  const text = batchText(request);
  const fact = durableFactFromText(text);
  if (!fact) return [];
  const type = classifyMemory(fact);
  const description = oneLine(fact, DESCRIPTION_CAP);
  const body =
    type === "feedback" || type === "project"
      ? `${description}\n\n**Why:** Captured from an explicit durable-memory trigger in the pi.dev session.\n\n**How to apply:** Reuse this when the same context or preference appears again.\n`
      : `${description}\n`;
  return [
    {
      type,
      description,
      body,
      hook: description,
    },
  ];
}

function topicFiles(root: string): string[] {
  const out: string[] = [];
  const realRoot = realpathSync(root);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      let realFull: string;
      try {
        realFull = realpathSync(full);
      } catch {
        continue;
      }
      if (!isInsideRoot(realRoot, realFull)) continue;
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".md") && entry !== "MEMORY.md") {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function parseTopicFrontmatter(content: string): {
  name?: string;
  description?: string;
  type?: string;
} {
  if (!content.startsWith("---\n")) return {};
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return {};
  const frontmatter = content.slice(4, end);
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter
    .match(/^description:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  const type = parseNestedMetadataType(frontmatter);
  return { name, description, type };
}

function parseNestedMetadataType(frontmatter: string): string | undefined {
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!/^metadata:\s*$/.test(lines[index] ?? "")) continue;
    for (const nestedLine of lines.slice(index + 1)) {
      if (/^[^\s].+/.test(nestedLine)) break;
      const match = nestedLine.match(/^[ \t]+type:\s*(.+)$/);
      if (match?.[1]) return match[1].trim();
    }
    return undefined;
  }
  return undefined;
}

function boundedSnapshotField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= SNAPSHOT_FIELD_CAP) return normalized;
  return normalized.slice(0, SNAPSHOT_FIELD_CAP - 1).trimEnd();
}

function normalizeKeyword(value: string): string {
  if (value.length > 4 && value.endsWith("ies")) {
    return `${value.slice(0, -3)}y`;
  }
  if (value.length > 4 && value.endsWith("es")) return value.slice(0, -2);
  if (value.length > 3 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function descriptionKeywords(value: string): Set<string> {
  const keywords = new Set<string>();
  for (const match of value.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const keyword = normalizeKeyword(match[0] ?? "");
    if (keyword.length < 3 || DEDUPE_STOP_WORDS.has(keyword)) continue;
    keywords.add(keyword);
  }
  return keywords;
}

function hasMarkdown(value: string): boolean {
  return /(`[^`]+`|\*\*?[^*]+\*\*?|__[^_]+__|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|^#{1,6}\s|<[^>\n]+>)/m.test(
    value,
  );
}

function keywordMatchScore(
  draftKeywords: Set<string>,
  existingKeywords: Set<string>,
): number {
  if (draftKeywords.size === 0 || existingKeywords.size === 0) return 0;
  let overlap = 0;
  for (const keyword of draftKeywords) {
    if (existingKeywords.has(keyword)) overlap++;
  }
  if (overlap < 2) return 0;
  return overlap / Math.min(draftKeywords.size, existingKeywords.size);
}

interface ExistingTopicMatch {
  path: string;
  name?: string;
  type?: MemoryType;
  score: number;
}

function findExistingTopic(
  root: string,
  draft: RequiredUpsertMemoryDraft,
): ExistingTopicMatch | undefined {
  const desiredName = draft.name;
  const desiredDescription = draft.description.toLowerCase();
  const desiredKeywords = descriptionKeywords(draft.description);
  let keywordMatch: ExistingTopicMatch | undefined;
  for (const path of topicFiles(root)) {
    const frontmatter = parseTopicFrontmatter(readFileSync(path, "utf8"));
    const type = VALID_TYPES.has(frontmatter.type as MemoryType)
      ? (frontmatter.type as MemoryType)
      : undefined;
    if (type === undefined || type !== draft.type) continue;
    if (frontmatter.name === desiredName) {
      return { path, name: frontmatter.name, type, score: 1 };
    }
    if (frontmatter.description?.toLowerCase() === desiredDescription) {
      return { path, name: frontmatter.name, type, score: 1 };
    }

    const existingText = [frontmatter.name, frontmatter.description]
      .filter(Boolean)
      .join(" ");
    const score = keywordMatchScore(
      desiredKeywords,
      descriptionKeywords(existingText),
    );
    if (score >= 0.5 && (!keywordMatch || score > keywordMatch.score)) {
      keywordMatch = { path, name: frontmatter.name, type, score };
    }
  }
  return keywordMatch;
}

interface RequiredUpsertMemoryDraft {
  action: "upsert";
  type: MemoryType;
  name: string;
  description: string;
  body: string;
  hook: string;
  title: string;
  relativePath: string;
}

interface RequiredDeleteMemoryDraft {
  action: "delete";
  relativePath: string;
  reason: string;
}

type RequiredMemoryDraft = RequiredUpsertMemoryDraft | RequiredDeleteMemoryDraft;

interface UpsertWritePlan {
  action: "upsert";
  draft: RequiredUpsertMemoryDraft;
  topicPath: string;
  topicRelativePath: string;
}

interface DeleteWritePlan {
  action: "delete";
  draft: RequiredDeleteMemoryDraft;
  topicPath: string;
  topicRelativePath: string;
}

type MemoryChangePlan = UpsertWritePlan | DeleteWritePlan;

interface FileSnapshot {
  existed: boolean;
  content?: string;
}

function normalizeDraft(draft: MemoryWriteDraft): RequiredMemoryDraft {
  const action = draft.action ?? "upsert";
  if (action === "delete") {
    const relativePath = draft.relativePath;
    if (!relativePath) throw new Error("delete memory relativePath is required");
    if (isAbsolute(relativePath)) {
      throw new Error(`memory relativePath must be relative: ${relativePath}`);
    }
    if (!relativePath.endsWith(".md") || basename(relativePath) === "MEMORY.md") {
      throw new Error(`invalid topic memory path: ${relativePath}`);
    }
    const reason = requiredOneLineField(
      draft.description ?? draft.body,
      "delete reason",
      DESCRIPTION_CAP,
    );
    if (hasMarkdown(reason)) {
      throw new Error("delete memory reason must not contain markdown formatting");
    }
    return {
      action,
      relativePath,
      reason,
    };
  }
  if (action !== "upsert") {
    throw new Error(`invalid memory draft action: ${action}`);
  }
  if (!VALID_TYPES.has(draft.type as MemoryType)) {
    throw new Error(`invalid memory type: ${draft.type}`);
  }
  const description = requiredOneLineField(
    draft.description,
    "description",
    DESCRIPTION_CAP,
  );
  if (hasMarkdown(description)) {
    throw new Error("memory description must not contain markdown formatting");
  }
  if (!draft.body) throw new Error("memory body is required");
  const name = slugify(draft.name ?? description);
  const type = draft.type as MemoryType;
  const relativePath = draft.relativePath ?? `${type}_${name}.md`;
  if (isAbsolute(relativePath)) {
    throw new Error(`memory relativePath must be relative: ${relativePath}`);
  }
  if (!relativePath.endsWith(".md") || basename(relativePath) === "MEMORY.md") {
    throw new Error(`invalid topic memory path: ${relativePath}`);
  }
  return {
    action,
    type,
    name,
    description,
    body: draft.body.trimEnd(),
    hook: oneLine(draft.hook ?? description, HOOK_CAP),
    title: draft.title ?? titleize(name),
    relativePath,
  };
}

function assertBodyMatchesDraftContract(draft: RequiredUpsertMemoryDraft): void {
  if (draft.type !== "feedback" && draft.type !== "project") return;
  const body = draft.body.trim();
  const firstLine = body.split(/\r?\n/).find((line) => line.trim() !== "");
  if (!firstLine || firstLine.trim().startsWith("**")) {
    throw new Error(
      `${draft.type} memory body must state the durable fact before rationale`,
    );
  }
  if (!/\*\*Why:\*\*/.test(body) || !/\*\*How to apply:\*\*/.test(body)) {
    throw new Error(
      `${draft.type} memory body must include **Why:** and **How to apply:** sections`,
    );
  }
}

function renderTopic(draft: RequiredUpsertMemoryDraft): string {
  return `---\nname: ${draft.name}\ndescription: ${draft.description}\nmetadata:\n  type: ${draft.type}\n---\n\n${draft.body}\n`;
}

function indexPointerPrefix(
  topicRelativePath: string,
  draft: RequiredUpsertMemoryDraft,
): string {
  return `- [${draft.title}](${topicRelativePath}) — `;
}

function fitDraftHookToPointerLine(
  topicRelativePath: string,
  draft: RequiredUpsertMemoryDraft,
): RequiredUpsertMemoryDraft {
  const prefix = indexPointerPrefix(topicRelativePath, draft);
  const maxHookLength = INDEX_POINTER_LINE_CAP - prefix.length;
  if (maxHookLength < 1) {
    throw new Error(
      `MEMORY.md pointer prefix would exceed ${INDEX_POINTER_LINE_CAP}-character cap (${prefix.length} chars)`,
    );
  }
  const hook = oneLine(draft.hook, maxHookLength);
  if (!hook) {
    throw new Error("memory hook is required");
  }
  return hook === draft.hook ? draft : { ...draft, hook };
}

function upsertIndexContent(
  index: string,
  topicRelativePath: string,
  draft: RequiredUpsertMemoryDraft,
): string {
  const line = `${indexPointerPrefix(topicRelativePath, draft)}${draft.hook}`;
  const lines = index.split(/\r?\n/);
  let replaced = false;
  const nextLines = lines.map((existing) => {
    const match = existing.match(/^- \[[^\]]+\]\(([^)]+)\)/);
    if (match?.[1] === topicRelativePath) {
      replaced = true;
      return line;
    }
    return existing;
  });
  if (!replaced) {
    while (nextLines.length > 0 && nextLines[nextLines.length - 1] === "") {
      nextLines.pop();
    }
    nextLines.push(line);
  }
  return `${nextLines.join("\n")}\n`;
}

function removeIndexPointers(index: string, topicRelativePath: string): string {
  const lines = index.split(/\r?\n/);
  const nextLines = lines.filter((existing) => {
    const match = existing.match(/^- \[[^\]]+\]\(([^)]+)\)/);
    return match?.[1] !== topicRelativePath;
  });
  return `${nextLines.join("\n").replace(/\n+$/g, "")}\n`;
}

function assertIndexWithinAdapterCaps(index: string): void {
  const lines = index.split(/\r?\n/);
  const lineCount = lines.length;
  if (lineCount > INDEX_LINE_CAP) {
    throw new Error(
      `MEMORY.md would exceed ${INDEX_LINE_CAP}-line cap (${lineCount} lines)`,
    );
  }
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith("- [")) continue;
    if (line.length > INDEX_POINTER_LINE_CAP) {
      throw new Error(
        `MEMORY.md pointer line ${index + 1} would exceed ${INDEX_POINTER_LINE_CAP}-character cap (${line.length} chars)`,
      );
    }
  }
  const byteSize = Buffer.byteLength(index, "utf8");
  if (byteSize > INDEX_BYTE_CAP) {
    throw new Error(
      `MEMORY.md would exceed ${INDEX_BYTE_CAP}-byte cap (${byteSize} bytes)`,
    );
  }
}

function displayMemoryPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/") || "MEMORY.md";
}

function renderDryRunProposal(
  request: MemoryWorkerRequest,
  changePlan: MemoryChangePlan[],
  proposedPaths: Set<string>,
): string {
  const indexPath = safePath(request.memoryRoot, "MEMORY.md");
  if (!existsSync(indexPath)) {
    throw new Error(`memory index does not exist: ${indexPath}`);
  }
  if (!lstatSync(indexPath).isFile()) {
    throw new Error(`memory index is not a file: ${indexPath}`);
  }
  let proposedIndex = readFileSync(indexPath, "utf8");
  for (const item of changePlan) {
    proposedIndex =
      item.action === "upsert"
        ? upsertIndexContent(proposedIndex, item.topicRelativePath, item.draft)
        : removeIndexPointers(proposedIndex, item.topicRelativePath);
  }
  assertIndexWithinAdapterCaps(proposedIndex);

  const sortedPaths = [...proposedPaths]
    .map((path) => displayMemoryPath(request.memoryRoot, path))
    .sort((a, b) => a.localeCompare(b));
  const upsertSections = changePlan
    .filter((item): item is UpsertWritePlan => item.action === "upsert")
    .map(
      (item) =>
        `--- ${item.topicRelativePath} ---\n${renderTopic(item.draft).trimEnd()}`,
    )
    .join("\n\n");
  const deleteSections = changePlan
    .filter((item): item is DeleteWritePlan => item.action === "delete")
    .map((item) => `- ${item.topicRelativePath}: ${item.draft.reason}`)
    .join("\n");
  const upsertCount = changePlan.filter((item) => item.action === "upsert").length;
  const deleteCount = changePlan.filter((item) => item.action === "delete").length;

  return [
    `dry-run: proposed ${upsertCount} memory write(s), ${deleteCount} memory delete(s)`,
    "proposed paths:",
    ...sortedPaths.map((path) => `- ${path}`),
    upsertSections ? "proposed topic content:" : "",
    upsertSections,
    deleteSections ? "proposed deletes:" : "",
    deleteSections,
    "--- MEMORY.md ---",
    proposedIndex.trimEnd(),
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function relativeTopicPath(root: string, topicPath: string): string {
  const rel = relative(root, topicPath).split(sep).join("/");
  if (rel.startsWith("..")) throw new Error(`refusing out-of-root topic path: ${rel}`);
  return rel;
}

function snapshotFile(path: string): FileSnapshot {
  if (!existsSync(path)) return { existed: false };
  return { existed: true, content: readFileSync(path, "utf8") };
}

function restoreSnapshots(snapshots: Map<string, FileSnapshot>): void {
  for (const [path, snapshot] of snapshots) {
    if (snapshot.existed) {
      writeFileSync(path, snapshot.content ?? "");
    } else {
      rmSync(path, { force: true });
    }
  }
}

function applyPlanToIndex(index: string, changePlan: MemoryChangePlan[]): string {
  let nextIndex = index;
  for (const item of changePlan) {
    nextIndex =
      item.action === "upsert"
        ? upsertIndexContent(nextIndex, item.topicRelativePath, item.draft)
        : removeIndexPointers(nextIndex, item.topicRelativePath);
  }
  return nextIndex;
}

function applyPlanToRoot(root: string, changePlan: MemoryChangePlan[]): void {
  const indexPath = safePath(root, "MEMORY.md");
  if (!existsSync(indexPath)) {
    throw new Error(`memory index does not exist: ${indexPath}`);
  }
  if (!lstatSync(indexPath).isFile()) {
    throw new Error(`memory index is not a file: ${indexPath}`);
  }
  const nextIndex = applyPlanToIndex(readFileSync(indexPath, "utf8"), changePlan);
  assertIndexWithinAdapterCaps(nextIndex);

  for (const item of changePlan) {
    const topicPath = safePath(root, item.topicRelativePath);
    if (item.action === "upsert") {
      mkdirSync(dirname(topicPath), { recursive: true });
      writeFileSync(topicPath, renderTopic(item.draft));
    } else {
      rmSync(topicPath, { force: true });
    }
  }
  writeFileSync(indexPath, nextIndex);
}

async function validateDryRunProposal(
  request: MemoryWorkerRequest,
  changePlan: MemoryChangePlan[],
  validate: (memoryRoot: string) => Promise<MemoryValidationResult>,
): Promise<MemoryValidationResult> {
  const tempParent = mkdtempSync(join(tmpdir(), "memory-substrate-dry-run-"));
  const tempRoot = join(tempParent, "root");
  try {
    cpSync(request.memoryRoot, tempRoot, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
    });
    applyPlanToRoot(tempRoot, changePlan);
    return await validate(tempRoot);
  } finally {
    rmSync(tempParent, { force: true, recursive: true });
  }
}

function cleanupEmptyDirectories(root: string, paths: string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    let dir = dirname(path);
    while (!seen.has(dir) && isInsideRoot(root, dir) && dir !== resolve(root)) {
      seen.add(dir);
      try {
        rmdirSync(dir);
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  }
}

function childEnv(requestEnv: RuntimeEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(requestEnv)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function defaultLivePiProcessExecutor(
  command: string,
  args: string[],
  options: LivePiProcessOptions,
): Promise<LivePiProcessResult> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    const finish = (result: LivePiProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProcess(result);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ code: 2, stdout, stderr: error.message, killed: timedOut });
    });
    child.on("close", (code, signal) => {
      const timeoutMessage = timedOut
        ? `memory worker timed out after ${options.timeoutMs}ms`
        : "";
      finish({
        code: code ?? 1,
        stdout,
        stderr: [stderr.trim(), timeoutMessage].filter(Boolean).join("\n"),
        killed: timedOut || signal !== null,
      });
    });
  });
}

function validateProviderQualifiedModel(model: string): string | undefined {
  const trimmed = model.trim();
  const slashIndex = trimmed.indexOf("/");
  const provider = slashIndex === -1 ? "" : trimmed.slice(0, slashIndex);
  const modelId = slashIndex === -1 ? trimmed : trimmed.slice(slashIndex + 1);

  if (!provider || !modelId || modelId.includes("/")) {
    return `memory worker model must be provider-qualified as <provider>/<model-id>: ${trimmed}`;
  }
  return undefined;
}

function preflightLiveWorkerModel(
  model: string,
): MemoryWorkerResult | undefined {
  const error = validateProviderQualifiedModel(model);
  if (error) {
    return {
      exitCode: 1,
      stderr: error,
      changedPaths: [],
      proposedPaths: [],
    };
  }
  return undefined;
}

function liveWorkerProcessArgs(model: string, prompt: string): string[] {
  return [
    "--print",
    "--no-extensions",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-session",
    "--no-tools",
    "--model",
    model,
    prompt,
  ];
}

async function preflightLiveWorkerReachability(
  command: string,
  model: string,
  execProcess: LivePiProcessExecutor,
  options: LivePiProcessOptions,
): Promise<MemoryWorkerResult | undefined> {
  const result = await execProcess(
    command,
    liveWorkerProcessArgs(model, LIVE_WORKER_REACHABILITY_PROMPT),
    options,
  );
  if (result.code === 0) return undefined;
  return {
    exitCode: result.code,
    stdout: result.stdout,
    stderr:
      result.stderr ||
      `memory worker model reachability preflight failed: ${model}`,
    changedPaths: [],
    proposedPaths: [],
  };
}

interface IndexPointerSnapshot {
  relativePath: string;
  line: string;
}

interface TopicSnapshot {
  relativePath: string;
  name?: string;
  description?: string;
  type?: string;
  indexed: boolean;
  indexLine?: string;
}

function indexPointerLines(index: string): IndexPointerSnapshot[] {
  return index
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^- \[[^\]]+\]\(([^)]+)\)/);
      if (!match?.[1]) return undefined;
      return {
        relativePath: match[1],
        line: boundedSnapshotField(line) ?? "",
      };
    })
    .filter((line): line is IndexPointerSnapshot => line !== undefined);
}

function assertDeleteTargetIsIndexedTopicMemory(
  root: string,
  topicPath: string,
  topicRelativePath: string,
): void {
  const frontmatter = parseTopicFrontmatter(readFileSync(topicPath, "utf8"));
  if (
    !frontmatter.name ||
    !frontmatter.description ||
    !VALID_TYPES.has(frontmatter.type as MemoryType)
  ) {
    throw new Error(
      `delete memory target is not a valid topic memory: ${topicRelativePath}`,
    );
  }
  let index = "";
  try {
    index = readFileSync(safePath(root, "MEMORY.md"), "utf8");
  } catch {
    throw new Error("memory index does not exist");
  }
  if (
    !indexPointerLines(index).some(
      (pointer) => pointer.relativePath === topicRelativePath,
    )
  ) {
    throw new Error(
      `delete memory target is not indexed in MEMORY.md: ${topicRelativePath}`,
    );
  }
}

function snapshotRank(
  candidateKeywords: Set<string>,
  topic: TopicSnapshot,
): number {
  if (candidateKeywords.size === 0) return topic.indexed ? 1 : 0;
  const topicKeywords = descriptionKeywords(
    [
      topic.relativePath,
      topic.name,
      topic.description,
      topic.type,
      topic.indexLine,
    ]
      .filter(Boolean)
      .join(" "),
  );
  let score = 0;
  for (const keyword of candidateKeywords) {
    if (topicKeywords.has(keyword)) score++;
  }
  if (topic.indexed && score > 0) score += 0.25;
  return score;
}

function renderSnapshot(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function emptyExistingMemorySnapshot(index: string, topicCount: number): string {
  const pointerLineCount = indexPointerLines(index).length;
  return renderSnapshot({
    limits: {
      maxBytes: EXISTING_MEMORY_SNAPSHOT_BYTE_CAP,
      maxTopics: EXISTING_MEMORY_SNAPSHOT_TOPIC_CAP,
    },
    index: {
      byteLength: Buffer.byteLength(index, "utf8"),
      pointerLineCount,
      includedPointerLineCount: 0,
      truncated: pointerLineCount > 0,
    },
    topics: [],
    topicCount,
    includedTopicCount: 0,
    truncated: topicCount > 0 || pointerLineCount > 0,
  });
}

function existingMemorySnapshot(root: string, candidateText: string): string {
  let index = "";
  try {
    index = readFileSync(safePath(root, "MEMORY.md"), "utf8");
  } catch {
    index = "";
  }
  const pointers = indexPointerLines(index);
  const pointerByPath = new Map(
    pointers.map((pointer) => [pointer.relativePath, pointer.line]),
  );
  const candidateKeywords = descriptionKeywords(candidateText);

  const topics = topicFiles(root)
    .map((path) => {
      const content = readFileSync(path, "utf8");
      const frontmatter = parseTopicFrontmatter(content);
      const relativePath = relativeTopicPath(root, path);
      return {
        relativePath,
        name: boundedSnapshotField(frontmatter.name),
        description: boundedSnapshotField(frontmatter.description),
        type: boundedSnapshotField(frontmatter.type),
        indexed: pointerByPath.has(relativePath),
        indexLine: pointerByPath.get(relativePath),
      };
    })
    .sort((a, b) => {
      const scoreDelta =
        snapshotRank(candidateKeywords, b) - snapshotRank(candidateKeywords, a);
      if (scoreDelta !== 0) return scoreDelta;
      if (a.indexed !== b.indexed) return a.indexed ? -1 : 1;
      return a.relativePath.localeCompare(b.relativePath);
    });

  const snapshot = {
    limits: {
      maxBytes: EXISTING_MEMORY_SNAPSHOT_BYTE_CAP,
      maxTopics: EXISTING_MEMORY_SNAPSHOT_TOPIC_CAP,
    },
    index: {
      byteLength: Buffer.byteLength(index, "utf8"),
      pointerLineCount: pointers.length,
      includedPointerLineCount: 0,
      truncated: pointers.length > 0,
    },
    topics: [] as TopicSnapshot[],
    topicCount: topics.length,
    includedTopicCount: 0,
    truncated: topics.length > 0,
  };

  for (const topic of topics.slice(0, EXISTING_MEMORY_SNAPSHOT_TOPIC_CAP)) {
    const nextTopics = [...snapshot.topics, topic];
    const next = {
      ...snapshot,
      topics: nextTopics,
      includedTopicCount: nextTopics.length,
      index: {
        ...snapshot.index,
        includedPointerLineCount: nextTopics.filter(
          (item) => item.indexLine !== undefined,
        ).length,
      },
    };
    next.index.truncated =
      next.index.includedPointerLineCount < next.index.pointerLineCount;
    next.truncated =
      next.includedTopicCount < next.topicCount || next.index.truncated;
    if (
      Buffer.byteLength(renderSnapshot(next), "utf8") >
      EXISTING_MEMORY_SNAPSHOT_BYTE_CAP
    ) {
      break;
    }
    snapshot.topics = next.topics;
    snapshot.includedTopicCount = next.includedTopicCount;
    snapshot.index.includedPointerLineCount = next.index.includedPointerLineCount;
    snapshot.index.truncated = next.index.truncated;
    snapshot.truncated = next.truncated;
  }

  snapshot.index.truncated =
    snapshot.index.includedPointerLineCount < snapshot.index.pointerLineCount;
  snapshot.truncated =
    snapshot.includedTopicCount < snapshot.topicCount || snapshot.index.truncated;
  const rendered = renderSnapshot(snapshot);
  if (
    Buffer.byteLength(rendered, "utf8") <= EXISTING_MEMORY_SNAPSHOT_BYTE_CAP
  ) {
    return rendered;
  }

  return emptyExistingMemorySnapshot(index, topics.length);
}

function liveWorkerPrompt(request: MemoryWorkerRequest): string {
  const candidateText = batchText(request);
  return `You are the memory-substrate pi.dev background worker.

Decide whether the candidate batch contains durable memory per SPEC section 3.
Default to no write. Do not save progress chatter, derivable repo facts, git history,
debugging recipes, or ephemeral session state. If an existing memory covers the same
subject, return a draft with that existing relativePath so the host updates it.

You do not have file tools in this worker. Return structured write drafts only; the
extension will perform the confined two-step save and validator run.

Output exactly one JSON object, with no markdown fences and no commentary:
{"drafts":[{"action":"upsert","type":"project","description":"one line <=200 chars","body":"markdown body","hook":"short index hook; the full rendered MEMORY.md pointer line must be <=150 chars","title":"Index title","name":"kebab-case-name","relativePath":"project_kebab-case-name.md"}]}

To remove a stale or contradicted existing memory, use a delete draft:
{"drafts":[{"action":"delete","relativePath":"project_stale-topic.md","description":"why this memory is stale"}]}

Rules:
- drafts must be empty unless the batch contains a durable trigger.
- action defaults to upsert when omitted.
- upsert type must be one of user, feedback, project, reference.
- feedback and project bodies must start with the fact, then include **Why:** and **How to apply:** lines.
- hook, title, and relativePath together must render a MEMORY.md pointer line no longer than 150 characters.
- delete drafts must target an existing topic relativePath from the snapshot.
- relativePath must be inside the memory root and must not be MEMORY.md.
- If no memory should be written, output {"drafts":[]}.

Memory root: ${request.memoryRoot}
Dry run: ${request.dryRun ? "yes" : "no"}

Existing memory snapshot:
${existingMemorySnapshot(request.memoryRoot, candidateText)}

Candidate batch:
${JSON.stringify(request.items, null, 2)}
`;
}

function extractJsonObject(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(
      "live worker did not return exactly one JSON object with no surrounding text",
    );
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseLiveWorkerDrafts(stdout: string): MemoryWriteDraft[] {
  const payload = extractJsonObject(stdout);
  if (!payload || typeof payload !== "object" || !("drafts" in payload)) {
    throw new Error("live worker JSON missing drafts array");
  }
  const drafts = (payload as { drafts: unknown }).drafts;
  if (!Array.isArray(drafts)) throw new Error("live worker drafts must be an array");

  return drafts.map((draft, index) => {
    if (!draft || typeof draft !== "object") {
      throw new Error(`live worker draft ${index} is not an object`);
    }
    const record = draft as Record<string, unknown>;
    const action = asString(record.action);
    const type = asString(record.type);
    const description = asString(record.description);
    const body = asString(record.body);
    const hook = asString(record.hook);
    const title = asString(record.title);
    const name = asString(record.name);
    const relativePath = asString(record.relativePath);
    if (action !== undefined && action !== "upsert" && action !== "delete") {
      throw new Error(`live worker draft ${index} has invalid action`);
    }
    if (action === "delete") {
      if (!relativePath) {
        throw new Error(`live worker draft ${index} missing delete relativePath`);
      }
      if (!description) {
        throw new Error(`live worker draft ${index} missing delete description`);
      }
      return {
        action,
        description,
        relativePath,
      };
    }
    if (!VALID_TYPES.has(type as MemoryType)) {
      throw new Error(`live worker draft ${index} has invalid type`);
    }
    if (!description || !body || !hook || !title || !name || !relativePath) {
      throw new Error(
        `live worker draft ${index} missing required upsert fields`,
      );
    }
    return {
      action: action ?? "upsert",
      type: type as MemoryType,
      description,
      body,
      hook,
      title,
      name,
      relativePath,
    };
  });
}

export async function runReferenceValidator(
  memoryRoot: string,
): Promise<MemoryValidationResult> {
  return new Promise((resolveValidator) => {
    if (!existsSync(VALIDATOR_PATH)) {
      resolveValidator({
        exitCode: 2,
        stderr: `validator not found: ${VALIDATOR_PATH}`,
      });
      return;
    }
    const child = spawn("bun", [VALIDATOR_PATH, memoryRoot], {
      cwd: dirname(dirname(VALIDATOR_PATH)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolveValidator({ exitCode: 2, stderr: error.message });
    });
    child.on("close", (code) => {
      resolveValidator({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

export async function applyMemoryWriteDrafts(
  request: MemoryWorkerRequest,
  drafts: MemoryWriteDraft[],
  options: Pick<DeterministicMemoryWorkerOptions, "validate"> = {},
): Promise<MemoryWorkerResult> {
  const normalized = drafts.map(normalizeDraft);
  if (normalized.length === 0) {
    return { exitCode: 0, stdout: "no memory written" };
  }

  const changedPaths = new Set<string>();
  const proposedPaths = new Set<string>();
  const changePlan = normalized.map((draft): MemoryChangePlan => {
    if (draft.action === "delete") {
      const topicPath = safePath(request.memoryRoot, draft.relativePath);
      if (!existsSync(topicPath)) {
        throw new Error(`delete memory target does not exist: ${draft.relativePath}`);
      }
      if (!statSync(topicPath).isFile()) {
        throw new Error(`delete memory target is not a file: ${draft.relativePath}`);
      }
      const topicRelativePath = relativeTopicPath(request.memoryRoot, topicPath);
      assertDeleteTargetIsIndexedTopicMemory(
        request.memoryRoot,
        topicPath,
        topicRelativePath,
      );
      proposedPaths.add(topicPath);
      proposedPaths.add(safePath(request.memoryRoot, "MEMORY.md"));
      return { action: "delete", draft, topicPath, topicRelativePath };
    }
    const preferredPath = safePath(request.memoryRoot, draft.relativePath);
    const expectedFilename = `${draft.type}_${draft.name}.md`;
    if (basename(preferredPath) !== expectedFilename) {
      throw new Error(
        `memory relativePath filename must be ${expectedFilename}: ${draft.relativePath}`,
      );
    }
    const existingTopic = findExistingTopic(request.memoryRoot, draft);
    const topicRelativePath = existingTopic
      ? relativeTopicPath(request.memoryRoot, existingTopic.path)
      : relativeTopicPath(request.memoryRoot, preferredPath);
    const targetDraft = existingTopic
      ? {
          ...draft,
          name: existingTopic.name ?? draft.name,
          type: existingTopic.type ?? draft.type,
          relativePath: topicRelativePath,
        }
      : draft;
    const expectedTargetFilename = `${targetDraft.type}_${targetDraft.name}.md`;
    if (basename(topicRelativePath) !== expectedTargetFilename) {
      throw new Error(
        `matched memory filename must be ${expectedTargetFilename}: ${topicRelativePath}`,
      );
    }
    const fittedDraft = fitDraftHookToPointerLine(topicRelativePath, targetDraft);
    const topicPath = existingTopic
      ? safePath(request.memoryRoot, topicRelativePath)
      : preferredPath;
    proposedPaths.add(topicPath);
    proposedPaths.add(safePath(request.memoryRoot, "MEMORY.md"));
    assertBodyMatchesDraftContract(fittedDraft);
    return { action: "upsert", draft: fittedDraft, topicPath, topicRelativePath };
  });

  if (request.dryRun) {
    const validator = await validateDryRunProposal(
      request,
      changePlan,
      options.validate ?? runReferenceValidator,
    );
    if (validator.exitCode !== 0) {
      return {
        exitCode: 1,
        stderr: "validator failed for dry-run proposal; real memory root unchanged",
        proposedPaths: [...proposedPaths],
        validator,
      };
    }
    return {
      exitCode: 0,
      stdout: renderDryRunProposal(request, changePlan, proposedPaths),
      proposedPaths: [...proposedPaths],
      validator,
    };
  }

  const snapshots = new Map<string, FileSnapshot>();
  const indexPath = safePath(request.memoryRoot, "MEMORY.md");
  if (!existsSync(indexPath)) {
    throw new Error(`memory index does not exist: ${indexPath}`);
  }
  if (!lstatSync(indexPath).isFile()) {
    throw new Error(`memory index is not a file: ${indexPath}`);
  }
  let nextIndex = readFileSync(indexPath, "utf8");
  nextIndex = applyPlanToIndex(nextIndex, changePlan);
  assertIndexWithinAdapterCaps(nextIndex);

  snapshots.set(indexPath, snapshotFile(indexPath));
  for (const item of changePlan) {
    snapshots.set(item.topicPath, snapshotFile(item.topicPath));
  }

  try {
    for (const item of changePlan) {
      if (item.action === "upsert") {
        mkdirSync(dirname(item.topicPath), { recursive: true });
        writeFileSync(item.topicPath, renderTopic(item.draft));
      } else {
        rmSync(item.topicPath, { force: true });
      }
      changedPaths.add(item.topicPath);
    }
    writeFileSync(indexPath, nextIndex);
    changedPaths.add(indexPath);

    const validator = await (options.validate ?? runReferenceValidator)(
      request.memoryRoot,
    );
    const failedValidation = validator && validator.exitCode !== 0;
    if (failedValidation) {
      restoreSnapshots(snapshots);
      cleanupEmptyDirectories(
        request.memoryRoot,
        changePlan.map((item) => item.topicPath),
      );
    }
    return {
      exitCode: failedValidation ? 1 : 0,
      stdout: failedValidation
        ? `rolled back ${changePlan.length} memory change(s) after validator failure`
        : `applied ${changePlan.length} memory change(s)`,
      stderr: failedValidation
        ? "validator failed after memory write; rolled back attempted changes"
        : undefined,
      changedPaths: failedValidation ? [] : [...changedPaths],
      proposedPaths: [...proposedPaths],
      validator,
    };
  } catch (error) {
    restoreSnapshots(snapshots);
    cleanupEmptyDirectories(
      request.memoryRoot,
      changePlan.map((item) => item.topicPath),
    );
    throw error;
  }
}

export function createDeterministicMemoryWorkerRunner(
  options: DeterministicMemoryWorkerOptions = {},
): MemoryWorkerRunner {
  return {
    supportsEnv: true,
    async run(request) {
      try {
        const drafts = (options.decideWrites ?? defaultDecideWrites)(request);
        return await applyMemoryWriteDrafts(request, drafts, options);
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
          changedPaths: [],
          proposedPaths: [],
        };
      }
    },
  };
}

export function createLivePiMemoryWorkerRunner(
  options: LivePiMemoryWorkerOptions = {},
): MemoryWorkerRunner {
  const command = options.command ?? "pi";
  const timeoutMs = options.timeoutMs ?? LIVE_WORKER_TIMEOUT_MS;
  const execProcess = options.process ?? defaultLivePiProcessExecutor;

  return {
    supportsEnv: true,
    async run(request) {
      const env = childEnv(request.env);
      const preflightFailure = preflightLiveWorkerModel(request.model);
      if (preflightFailure) return preflightFailure;

      const reachabilityFailure = await preflightLiveWorkerReachability(
        command,
        request.model,
        execProcess,
        {
          cwd: request.memoryRoot,
          env,
          timeoutMs,
        },
      );
      if (reachabilityFailure) return reachabilityFailure;

      const args = liveWorkerProcessArgs(request.model, liveWorkerPrompt(request));

      const processResult = await execProcess(command, args, {
        cwd: request.memoryRoot,
        env,
        timeoutMs,
      });
      if (processResult.code !== 0) {
        return {
          exitCode: processResult.code,
          stdout: processResult.stdout,
          stderr: processResult.stderr || "live pi memory worker failed",
          changedPaths: [],
          proposedPaths: [],
        };
      }

      try {
        const drafts = parseLiveWorkerDrafts(processResult.stdout);
        const result = await applyMemoryWriteDrafts(request, drafts, {
          validate: options.validate,
        });
        return {
          ...result,
          stdout: [processResult.stdout.trim(), result.stdout].filter(Boolean).join("\n"),
        };
      } catch (error) {
        return {
          exitCode: 1,
          stdout: processResult.stdout,
          stderr: error instanceof Error ? error.message : String(error),
          changedPaths: [],
          proposedPaths: [],
        };
      }
    },
  };
}

export const unsupportedPiExecWorkerRunner: MemoryWorkerRunner = {
  supportsEnv: false,
  async run() {
    return {
      exitCode: 1,
      stderr:
        "pi.exec in this pi.dev version does not support child environment overrides; refusing worker spawn",
    };
  },
};
