import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

export interface MemoryWriteDraft {
  type: MemoryType;
  description: string;
  body: string;
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
const INDEX_LINE_CAP = 150;
const INDEX_BYTE_CAP = 25 * 1024;
const LIVE_WORKER_TIMEOUT_MS = 120_000;
const VALIDATOR_PATH = fileURLToPath(
  new URL("../../../reference/validator.ts", import.meta.url),
);

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
  const type = frontmatter.match(/^\s*type:\s*(.+)$/m)?.[1]?.trim();
  return { name, description, type };
}

function findExistingTopic(root: string, draft: RequiredMemoryDraft): string | undefined {
  const desiredName = draft.name;
  const desiredDescription = draft.description.toLowerCase();
  for (const path of topicFiles(root)) {
    const frontmatter = parseTopicFrontmatter(readFileSync(path, "utf8"));
    if (frontmatter.name === desiredName) return path;
    if (frontmatter.description?.toLowerCase() === desiredDescription) return path;
  }
  return undefined;
}

interface RequiredMemoryDraft {
  type: MemoryType;
  name: string;
  description: string;
  body: string;
  hook: string;
  title: string;
  relativePath: string;
}

interface FileSnapshot {
  existed: boolean;
  content?: string;
}

function normalizeDraft(draft: MemoryWriteDraft): RequiredMemoryDraft {
  if (!VALID_TYPES.has(draft.type)) {
    throw new Error(`invalid memory type: ${draft.type}`);
  }
  const description = oneLine(draft.description, DESCRIPTION_CAP);
  if (!description) throw new Error("memory description is required");
  const name = slugify(draft.name ?? description);
  const relativePath = draft.relativePath ?? `${draft.type}_${name}.md`;
  if (isAbsolute(relativePath)) {
    throw new Error(`memory relativePath must be relative: ${relativePath}`);
  }
  if (!relativePath.endsWith(".md") || basename(relativePath) === "MEMORY.md") {
    throw new Error(`invalid topic memory path: ${relativePath}`);
  }
  return {
    type: draft.type,
    name,
    description,
    body: draft.body.trimEnd(),
    hook: oneLine(draft.hook ?? description, HOOK_CAP),
    title: draft.title ?? titleize(name),
    relativePath,
  };
}

function renderTopic(draft: RequiredMemoryDraft): string {
  return `---\nname: ${draft.name}\ndescription: ${draft.description}\nmetadata:\n  type: ${draft.type}\n---\n\n${draft.body}\n`;
}

function upsertIndexContent(
  index: string,
  topicRelativePath: string,
  draft: RequiredMemoryDraft,
): string {
  const line = `- [${draft.title}](${topicRelativePath}) — ${draft.hook}`;
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

function assertIndexWithinAdapterCaps(index: string): void {
  const lineCount = index.split(/\r?\n/).length;
  if (lineCount > INDEX_LINE_CAP) {
    throw new Error(
      `MEMORY.md would exceed ${INDEX_LINE_CAP}-line cap (${lineCount} lines)`,
    );
  }
  const byteSize = Buffer.byteLength(index, "utf8");
  if (byteSize > INDEX_BYTE_CAP) {
    throw new Error(
      `MEMORY.md would exceed ${INDEX_BYTE_CAP}-byte cap (${byteSize} bytes)`,
    );
  }
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

function existingMemorySnapshot(root: string): string {
  let index = "";
  try {
    index = readFileSync(safePath(root, "MEMORY.md"), "utf8");
  } catch {
    index = "";
  }

  const topics = topicFiles(root)
    .map((path) => {
      const content = readFileSync(path, "utf8");
      const frontmatter = parseTopicFrontmatter(content);
      return {
        relativePath: relativeTopicPath(root, path),
        name: frontmatter.name,
        description: frontmatter.description,
        type: frontmatter.type,
      };
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return JSON.stringify({ index, topics }, null, 2);
}

function liveWorkerPrompt(request: MemoryWorkerRequest): string {
  return `You are the memory-substrate pi.dev background worker.

Decide whether the candidate batch contains durable memory per SPEC section 3.
Default to no write. Do not save progress chatter, derivable repo facts, git history,
debugging recipes, or ephemeral session state. If an existing memory covers the same
subject, return a draft with that existing relativePath so the host updates it.

You do not have file tools in this worker. Return structured write drafts only; the
extension will perform the confined two-step save and validator run.

Output exactly one JSON object, with no markdown fences and no commentary:
{"drafts":[{"type":"project","description":"one line <=200 chars","body":"markdown body","hook":"index hook <=150 chars","title":"Index title","name":"kebab-case-name","relativePath":"project_kebab-case-name.md"}]}

Rules:
- drafts must be empty unless the batch contains a durable trigger.
- type must be one of user, feedback, project, reference.
- feedback and project bodies must start with the fact, then include **Why:** and **How to apply:** lines.
- relativePath must be inside the memory root and must not be MEMORY.md.
- If no memory should be written, output {"drafts":[]}.

Memory root: ${request.memoryRoot}
Dry run: ${request.dryRun ? "yes" : "no"}

Existing memory snapshot:
${existingMemorySnapshot(request.memoryRoot)}

Candidate batch:
${JSON.stringify(request.items, null, 2)}
`;
}

function extractJsonObject(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    if (fenced) return JSON.parse(fenced);

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("live worker did not return JSON");
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
    const type = asString(record.type);
    const description = asString(record.description);
    const body = asString(record.body);
    if (!VALID_TYPES.has(type as MemoryType)) {
      throw new Error(`live worker draft ${index} has invalid type`);
    }
    if (!description || !body) {
      throw new Error(`live worker draft ${index} missing description or body`);
    }
    return {
      type: type as MemoryType,
      description,
      body,
      hook: asString(record.hook),
      title: asString(record.title),
      name: asString(record.name),
      relativePath: asString(record.relativePath),
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
  const writePlan = normalized.map((draft) => {
    const preferredPath = safePath(request.memoryRoot, draft.relativePath);
    const existingPath = findExistingTopic(request.memoryRoot, draft);
    const topicRelativePath = existingPath
      ? relativeTopicPath(request.memoryRoot, existingPath)
      : relativeTopicPath(request.memoryRoot, preferredPath);
    const topicPath = existingPath
      ? safePath(request.memoryRoot, topicRelativePath)
      : preferredPath;
    proposedPaths.add(topicPath);
    proposedPaths.add(safePath(request.memoryRoot, "MEMORY.md"));
    return { draft, topicPath, topicRelativePath };
  });

  if (request.dryRun) {
    return {
      exitCode: 0,
      stdout: `dry-run: proposed ${writePlan.length} memory write(s)`,
      proposedPaths: [...proposedPaths],
    };
  }

  const snapshots = new Map<string, FileSnapshot>();
  const indexPath = safePath(request.memoryRoot, "MEMORY.md");
  let nextIndex = existsSync(indexPath)
    ? readFileSync(indexPath, "utf8")
    : "# Memory\n";
  for (const item of writePlan) {
    nextIndex = upsertIndexContent(
      nextIndex,
      item.topicRelativePath,
      item.draft,
    );
  }
  assertIndexWithinAdapterCaps(nextIndex);

  snapshots.set(indexPath, snapshotFile(indexPath));
  for (const item of writePlan) {
    snapshots.set(item.topicPath, snapshotFile(item.topicPath));
  }

  try {
    for (const item of writePlan) {
      mkdirSync(dirname(item.topicPath), { recursive: true });
      writeFileSync(item.topicPath, renderTopic(item.draft));
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
        writePlan.map((item) => item.topicPath),
      );
    }
    return {
      exitCode: failedValidation ? 1 : 0,
      stdout: failedValidation
        ? `rolled back ${writePlan.length} memory write(s) after validator failure`
        : `wrote ${writePlan.length} memory write(s)`,
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
      writePlan.map((item) => item.topicPath),
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
      const args = [
        "--print",
        "--no-extensions",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--no-session",
        "--no-tools",
        "--model",
        request.model,
        liveWorkerPrompt(request),
      ];

      const processResult = await execProcess(command, args, {
        cwd: request.memoryRoot,
        env: childEnv(request.env),
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
