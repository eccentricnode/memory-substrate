import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WORKER_MODEL } from "../adapters/pi-dev/extension/config.ts";
import { validateMemoryDirectory } from "../reference/validator.ts";

const liveDescribe =
  process.env.PI_MEMORY_INTEGRATION === "1" ? describe : describe.skip;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_PATH = join(REPO_ROOT, "adapters/pi-dev/extension/index.ts");
const DEFAULT_MEMORY_ROOT = resolve(homedir(), ".memory");
const PI_COMMAND = process.env.PI_MEMORY_PI_COMMAND ?? "pi";
const MAIN_MODEL = process.env.PI_MEMORY_MAIN_MODEL ?? DEFAULT_WORKER_MODEL;
const LIVE_TIMEOUT_MS = 240_000;
const WORKER_AUDIT_TYPE = "memory-substrate-worker-run";
const QUEUE_AUDIT_TYPE = "memory-substrate-queue";
const MODE_AUDIT_TYPE = "memory-substrate-mode";
const REACTIVE_AUDIT_TYPE = "memory-substrate-reactive-research";

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface SessionEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

interface FsSnapshotEntry {
  kind: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
  mode: number;
  target?: string;
}

type FsSnapshot = Map<string, FsSnapshotEntry>;

interface LivePiRun {
  cwd: string;
  homeDir: string;
  memoryRoot: string;
  memoryRootBefore: FsSnapshot;
  sessionFile: string;
  result: ProcessResult;
  entries: SessionEntry[];
}

function isInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(`${resolvedRoot}${sep}`)
  );
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createMemoryRoot(
  seed?: (memoryRoot: string) => void,
): string {
  const root = tempDir("memory-substrate-live-root-");
  writeFileSync(join(root, "MEMORY.md"), "# Memory\n");
  seed?.(root);
  return root;
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stats = lstatSync(full);
      if (stats.isDirectory()) {
        walk(full);
      } else {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

function topicFiles(root: string): string[] {
  return walkFiles(root).filter(
    (path) => path.endsWith(".md") && basename(path) !== "MEMORY.md",
  );
}

function snapshotPath(root: string): FsSnapshot {
  const snapshot: FsSnapshot = new Map();
  if (!existsSync(root)) return snapshot;

  const walk = (path: string) => {
    const stats = lstatSync(path);
    const rel = relative(root, path) || ".";
    snapshot.set(rel, {
      kind: stats.isFile()
        ? "file"
        : stats.isDirectory()
          ? "dir"
          : stats.isSymbolicLink()
            ? "symlink"
            : "other",
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      mode: stats.mode,
      target: stats.isSymbolicLink() ? realpathSync(path) : undefined,
    });
    if (!stats.isDirectory()) return;
    for (const entry of readdirSync(path)) walk(join(path, entry));
  };

  walk(root);
  return snapshot;
}

function expectSnapshotUnchanged(before: FsSnapshot, after: FsSnapshot): void {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [path, previous] of before) {
    expect(after.get(path)).toEqual(previous);
  }
}

function parseSessionEntries(sessionFile: string): SessionEntry[] {
  if (!existsSync(sessionFile)) return [];
  return readFileSync(sessionFile, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as SessionEntry);
}

function customEntries(run: LivePiRun, customType: string): SessionEntry[] {
  return run.entries.filter(
    (entry) => entry.type === "custom" && entry.customType === customType,
  );
}

function workerRecords(run: LivePiRun): Record<string, unknown>[] {
  return customEntries(run, WORKER_AUDIT_TYPE).map(
    (entry) => entry.data as Record<string, unknown>,
  );
}

function queueRecords(run: LivePiRun): Record<string, unknown>[] {
  return customEntries(run, QUEUE_AUDIT_TYPE).map(
    (entry) => entry.data as Record<string, unknown>,
  );
}

function modeRecords(run: LivePiRun): Record<string, unknown>[] {
  return customEntries(run, MODE_AUDIT_TYPE).map(
    (entry) => entry.data as Record<string, unknown>,
  );
}

function reactiveRecords(run: LivePiRun): Record<string, unknown>[] {
  return customEntries(run, REACTIVE_AUDIT_TYPE).map(
    (entry) => entry.data as Record<string, unknown>,
  );
}

function allAuditPaths(run: LivePiRun): string[] {
  return workerRecords(run).flatMap((record) => [
    ...((record.changedPaths as string[] | undefined) ?? []),
    ...((record.proposedPaths as string[] | undefined) ?? []),
  ]);
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<ProcessResult> {
  return await new Promise((resolveProcess) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs);

    const finish = (result: ProcessResult) => {
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
      finish({ code: 2, stdout, stderr: error.message });
    });
    child.on("close", (code, signal) => {
      finish({
        code: code ?? 1,
        stdout,
        stderr:
          signal === null ? stderr : `${stderr}\nprocess ended by ${signal}`.trim(),
      });
    });
  });
}

function cleanProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("PI_MEMORY_")) continue;
    env[key] = value;
  }
  env.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  env.npm_config_update_notifier = "false";
  env.NPM_CONFIG_LOGLEVEL = "error";
  env.npm_config_loglevel = "error";
  return env;
}

async function runLivePi(
  prompt: string,
  env: Record<string, string | undefined> = {},
  seedMemory?: (memoryRoot: string) => void,
): Promise<LivePiRun> {
  const cwd = tempDir("memory-substrate-live-cwd-");
  const memoryRoot = createMemoryRoot(seedMemory);
  const memoryRootBefore = snapshotPath(memoryRoot);
  const sessionFile = join(tempDir("memory-substrate-live-session-"), "session.jsonl");
  const tempHome = tempDir("memory-substrate-live-home-");
  const sessionDir = dirname(sessionFile);
  const processEnv = Object.fromEntries(
    Object.entries({
      ...cleanProcessEnv(),
      HOME: tempHome,
      PI_CODING_AGENT_DIR:
        process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      PI_MEMORY_ROOT: memoryRoot,
      PI_MEMORY_MAX_BATCH_ITEMS: "1",
      PI_MEMORY_DEBOUNCE_MS: "0",
      ...env,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const result = await runProcess(
    PI_COMMAND,
    [
      "--print",
      "--no-extensions",
      "--extension",
      EXTENSION_PATH,
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-tools",
      "--session",
      sessionFile,
      "--model",
      MAIN_MODEL,
      prompt,
    ],
    {
      cwd,
      timeoutMs: LIVE_TIMEOUT_MS,
      env: processEnv,
    },
  );
  return {
    cwd,
    homeDir: tempHome,
    memoryRoot,
    memoryRootBefore,
    sessionFile,
    result,
    entries: parseSessionEntries(sessionFile),
  };
}

function expectPiSuccess(run: LivePiRun): void {
  expect(
    `${PI_COMMAND} exited ${run.result.code}\nstdout:\n${run.result.stdout}\nstderr:\n${run.result.stderr}`,
  ).toContain(`${PI_COMMAND} exited 0`);
}

function seedResearchMemory(root: string): void {
  writeFileSync(
    join(root, "project_live-research-build-command.md"),
    `---
name: live-research-build-command
description: Live research should find the Bun verification command
metadata:
  type: project
---

The durable live-research verification command is \`bunx tsc --noEmit && bun test\`.
**Why:** This proves the read-side sub-agent can synthesize from a topic file.
**How to apply:** Cite this topic when asked about live-research verification.
`,
  );
  writeFileSync(
    join(root, "MEMORY.md"),
    "# Memory\n\n- [Live research build command](project_live-research-build-command.md) — Live research should cite the Bun verification command\n",
  );
}

function expectNoOutOfRootAuditPaths(run: LivePiRun): void {
  for (const path of allAuditPaths(run)) {
    expect(path).not.toBe(DEFAULT_MEMORY_ROOT);
    expect(path.startsWith(`${DEFAULT_MEMORY_ROOT}${sep}`)).toBe(false);
    expect(isInsideRoot(run.memoryRoot, path)).toBe(true);
  }
}

function cleanup(run: LivePiRun): void {
  rmSync(run.cwd, { force: true, recursive: true });
  rmSync(run.homeDir, { force: true, recursive: true });
  rmSync(run.memoryRoot, { force: true, recursive: true });
  rmSync(dirname(run.sessionFile), { force: true, recursive: true });
}

liveDescribe("opt-in live pi.dev memory integration", () => {
  test(
    "loads the extension in a real no-tools pi session",
    async () => {
      const defaultRootBefore = snapshotPath(DEFAULT_MEMORY_ROOT);
      const run = await runLivePi("Reply exactly: OK.");
      try {
        expectPiSuccess(run);
        expect(topicFiles(run.memoryRoot)).toEqual([]);
        expect(queueRecords(run)).toHaveLength(1);
        expect(workerRecords(run)).toHaveLength(1);
        const records = workerRecords(run);
        expect(records[0]?.changedPaths).toEqual([]);
        expect(records[0]?.proposedPaths).toEqual([]);
        expectNoOutOfRootAuditPaths(run);
      } finally {
        expectSnapshotUnchanged(defaultRootBefore, snapshotPath(DEFAULT_MEMORY_ROOT));
        cleanup(run);
      }
    },
    LIVE_TIMEOUT_MS + 30_000,
  );

  test(
    "writes one validator-clean durable memory inside the sandbox",
    async () => {
      const defaultRootBefore = snapshotPath(DEFAULT_MEMORY_ROOT);
      const run = await runLivePi(
        "The durable decision is to keep the live integration harness root confined. Reply in one short sentence.",
      );
      try {
        expectPiSuccess(run);
        const topics = topicFiles(run.memoryRoot);
        expect(topics).toHaveLength(1);
        expect(readFileSync(join(run.memoryRoot, "MEMORY.md"), "utf8")).toContain(
          relative(run.memoryRoot, topics[0] ?? "").split(sep).join("/"),
        );

        const report = validateMemoryDirectory(run.memoryRoot);
        expect(report.counts.error).toBe(0);
        expect(report.counts.warn).toBe(0);

        const records = workerRecords(run);
        expect(records).toHaveLength(1);
        expect(records[0]?.status).toBe("completed");
        expect(records[0]?.dryRun).toBe(false);
        expect(records[0]?.model).toBe(DEFAULT_WORKER_MODEL);
        expect((records[0]?.validatorResult as { exitCode?: number })?.exitCode).toBe(
          0,
        );
        for (const line of readFileSync(join(run.memoryRoot, "MEMORY.md"), "utf8").split(
          /\r?\n/,
        )) {
          if (line.startsWith("- [")) expect(line.length).toBeLessThanOrEqual(150);
        }
        expectNoOutOfRootAuditPaths(run);
      } finally {
        expectSnapshotUnchanged(defaultRootBefore, snapshotPath(DEFAULT_MEMORY_ROOT));
        cleanup(run);
      }
    },
    LIVE_TIMEOUT_MS + 30_000,
  );

  test(
    "does not write for chatter",
    async () => {
      const defaultRootBefore = snapshotPath(DEFAULT_MEMORY_ROOT);
      const run = await runLivePi("Say hello in five words.");
      try {
        expectPiSuccess(run);
        expect(topicFiles(run.memoryRoot)).toEqual([]);
        expect(validateMemoryDirectory(run.memoryRoot).counts.error).toBe(0);
        const records = workerRecords(run);
        expect(records).toHaveLength(1);
        expect(records[0]?.status).toBe("completed");
        expect(records[0]?.changedPaths).toEqual([]);
        expect(records[0]?.proposedPaths).toEqual([]);
        expectNoOutOfRootAuditPaths(run);
      } finally {
        expectSnapshotUnchanged(defaultRootBefore, snapshotPath(DEFAULT_MEMORY_ROOT));
        cleanup(run);
      }
    },
    LIVE_TIMEOUT_MS + 30_000,
  );

  test(
    "disabled mode performs no writes and records no worker invocation",
    async () => {
      const defaultRootBefore = snapshotPath(DEFAULT_MEMORY_ROOT);
      const run = await runLivePi(
        "The durable decision is to prove disabled mode suppresses worker launch.",
        {
          PI_MEMORY_ENABLED: "0",
          PI_MEMORY_MODEL: "not-a-provider/not-a-model",
        },
      );
      try {
        expectPiSuccess(run);
        expect(topicFiles(run.memoryRoot)).toEqual([]);
        expect(queueRecords(run)).toEqual([]);
        expect(workerRecords(run)).toEqual([]);
      } finally {
        expectSnapshotUnchanged(defaultRootBefore, snapshotPath(DEFAULT_MEMORY_ROOT));
        cleanup(run);
      }
    },
    LIVE_TIMEOUT_MS + 30_000,
  );

  test(
    "ignore mode records the mode and suppresses writes and worker launch",
    async () => {
      const defaultRootBefore = snapshotPath(DEFAULT_MEMORY_ROOT);
      const run = await runLivePi(
        "The durable decision is to prove ignore mode suppresses worker launch.",
        { PI_MEMORY_IGNORE: "1" },
      );
      try {
        expectPiSuccess(run);
        expect(topicFiles(run.memoryRoot)).toEqual([]);
        expect(queueRecords(run)).toEqual([]);
        expect(workerRecords(run)).toEqual([]);
        expect(modeRecords(run).some((record) => record.mode === "ignore")).toBe(
          true,
        );
      } finally {
        expectSnapshotUnchanged(defaultRootBefore, snapshotPath(DEFAULT_MEMORY_ROOT));
        cleanup(run);
      }
    },
    LIVE_TIMEOUT_MS + 30_000,
  );

  test(
    "dry-run reports proposals without mutating memory",
    async () => {
      const defaultRootBefore = snapshotPath(DEFAULT_MEMORY_ROOT);
      const run = await runLivePi(
        "The durable decision is to keep dry-run live integration non-mutating.",
        { PI_MEMORY_DRY_RUN: "1" },
      );
      try {
        expectPiSuccess(run);
        expect(topicFiles(run.memoryRoot)).toEqual([]);
        expect(readFileSync(join(run.memoryRoot, "MEMORY.md"), "utf8")).toBe(
          "# Memory\n",
        );
        const records = workerRecords(run);
        expect(records).toHaveLength(1);
        expect(records[0]?.status).toBe("completed");
        expect(records[0]?.dryRun).toBe(true);
        expect(records[0]?.changedPaths).toEqual([]);
        expect((records[0]?.proposedPaths as string[] | undefined)?.length).toBeGreaterThan(
          0,
        );
        expectNoOutOfRootAuditPaths(run);
      } finally {
        expectSnapshotUnchanged(defaultRootBefore, snapshotPath(DEFAULT_MEMORY_ROOT));
        cleanup(run);
      }
    },
    LIVE_TIMEOUT_MS + 30_000,
  );

  test(
    "bad worker model fails closed with retained queue and no write",
    async () => {
      const defaultRootBefore = snapshotPath(DEFAULT_MEMORY_ROOT);
      const run = await runLivePi(
        "The durable decision is to retain queued memory when the worker model is invalid.",
        { PI_MEMORY_MODEL: "not-a-provider/not-a-model" },
      );
      try {
        expectPiSuccess(run);
        expect(topicFiles(run.memoryRoot)).toEqual([]);
        const records = workerRecords(run);
        expect(records).toHaveLength(1);
        expect(records[0]?.status).toBe("failed");
        expect(records[0]?.retainedQueueCount).toBe(1);
        expect(String(records[0]?.error ?? "").length).toBeGreaterThan(0);
        expect(String(records[0]?.error ?? "")).not.toContain("pi --list-models");
        expectNoOutOfRootAuditPaths(run);
      } finally {
        expectSnapshotUnchanged(defaultRootBefore, snapshotPath(DEFAULT_MEMORY_ROOT));
        cleanup(run);
      }
    },
    LIVE_TIMEOUT_MS + 30_000,
  );

  test(
    "reactive memory trigger injects seeded research without mutating it",
    async () => {
      const defaultRootBefore = snapshotPath(DEFAULT_MEMORY_ROOT);
      const run = await runLivePi(
        "What did we decide last time about the live-research verification command? Reply with the command only.",
        { PI_MEMORY_REACTIVE: "1" },
        seedResearchMemory,
      );
      try {
        expectPiSuccess(run);
        expect(`${run.result.stdout}\n${run.result.stderr}`).toMatch(/bunx tsc --noEmit && bun test/i);
        const records = reactiveRecords(run);
        expect(records.some((record) => record.action === "fired")).toBe(true);
        expect(records.some((record) => record.found === true)).toBe(true);
        expectSnapshotUnchanged(run.memoryRootBefore, snapshotPath(run.memoryRoot));
      } finally {
        expectSnapshotUnchanged(defaultRootBefore, snapshotPath(DEFAULT_MEMORY_ROOT));
        cleanup(run);
      }
    },
    LIVE_TIMEOUT_MS + 30_000,
  );
});
