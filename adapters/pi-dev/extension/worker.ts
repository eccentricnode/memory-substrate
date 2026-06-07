import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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

function normalizeDraft(draft: MemoryWriteDraft): RequiredMemoryDraft {
  if (!VALID_TYPES.has(draft.type)) {
    throw new Error(`invalid memory type: ${draft.type}`);
  }
  const description = oneLine(draft.description, DESCRIPTION_CAP);
  if (!description) throw new Error("memory description is required");
  const name = slugify(draft.name ?? description);
  const relativePath = draft.relativePath ?? `${draft.type}_${name}.md`;
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

function ensureIndex(root: string): string {
  const indexPath = safePath(root, "MEMORY.md");
  if (!existsSync(indexPath)) writeFileSync(indexPath, "# Memory\n");
  return indexPath;
}

function upsertIndexLine(
  root: string,
  topicRelativePath: string,
  draft: RequiredMemoryDraft,
): string {
  const indexPath = ensureIndex(root);
  const index = readFileSync(indexPath, "utf8");
  const line = `- [${draft.title}](${topicRelativePath}) -- ${draft.hook}`;
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

function relativeTopicPath(root: string, topicPath: string): string {
  const rel = relative(root, topicPath).split(sep).join("/");
  if (rel.startsWith("..")) throw new Error(`refusing out-of-root topic path: ${rel}`);
  return rel;
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
      : draft.relativePath;
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

  for (const item of writePlan) {
    mkdirSync(dirname(item.topicPath), { recursive: true });
    writeFileSync(item.topicPath, renderTopic(item.draft));
    changedPaths.add(item.topicPath);
    const nextIndex = upsertIndexLine(
      request.memoryRoot,
      item.topicRelativePath,
      item.draft,
    );
    writeFileSync(safePath(request.memoryRoot, "MEMORY.md"), nextIndex);
    changedPaths.add(safePath(request.memoryRoot, "MEMORY.md"));
  }

  const validator = await (options.validate ?? runReferenceValidator)(
    request.memoryRoot,
  );
  const failedValidation = validator && validator.exitCode !== 0;
  return {
    exitCode: failedValidation ? 1 : 0,
    stdout: `wrote ${writePlan.length} memory write(s)`,
    stderr: failedValidation ? "validator failed after memory write" : undefined,
    changedPaths: [...changedPaths],
    proposedPaths: [...proposedPaths],
    validator,
  };
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
