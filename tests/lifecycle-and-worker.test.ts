import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKER_MODEL } from "../adapters/pi-dev/extension/config.ts";
import { MemoryExtensionCore, type MemoryScheduler } from "../adapters/pi-dev/extension/core.ts";
import type {
  LivePiProcessExecutor,
  LivePiProcessOptions,
  MemoryWorkerRequest,
  MemoryWorkerResult,
  MemoryWorkerRunner,
} from "../adapters/pi-dev/extension/worker.ts";
import { createLivePiMemoryWorkerRunner } from "../adapters/pi-dev/extension/worker.ts";

const tmpRoots: string[] = [];
const MODEL_REGISTRY = `provider      model                       context  max-out  thinking  images
openai-codex  gpt-5.3-codex-spark         128K     128K     yes       no
`;

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-substrate-test-"));
  tmpRoots.push(dir);
  return dir;
}

function memoryRoot(): string {
  const root = tempDir();
  writeFileSync(join(root, "MEMORY.md"), "# Memory\n");
  return root;
}

class FakeScheduler implements MemoryScheduler {
  private nextHandle = 0;
  private callbacks = new Map<number, () => void>();
  currentTime = 1_000;

  setTimeout(callback: () => void, _ms: number): unknown {
    const handle = ++this.nextHandle;
    this.callbacks.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  now(): number {
    return this.currentTime++;
  }

  get pendingTimers(): number {
    return this.callbacks.size;
  }

  async fireAll(): Promise<void> {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
    await Promise.resolve();
  }
}

function recordingState() {
  const entries: Array<{ type: string; data: unknown }> = [];
  return {
    entries,
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
  };
}

function recordingWorker(
  result: MemoryWorkerResult = { exitCode: 0, stdout: "no memory written" },
): MemoryWorkerRunner & { requests: MemoryWorkerRequest[] } {
  return {
    supportsEnv: true,
    requests: [],
    async run(request) {
      this.requests.push(request);
      return result;
    },
  };
}

describe("pi-dev lifecycle batching and worker orchestration", () => {
  test("disabled mode queues nothing and records no audit state", async () => {
    const state = recordingState();
    const worker = recordingWorker();
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ENABLED: "0", PI_MEMORY_ROOT: "/missing" },
      state,
      worker,
    });

    await core.handleAgentEnd({ messages: ["remember nothing"] });
    await core.flush();

    expect(core.pendingBatchItems).toBe(0);
    expect(worker.requests).toHaveLength(0);
    expect(state.entries).toHaveLength(0);
  });

  test("ignore mode suppresses forced-write queueing", async () => {
    const state = recordingState();
    const worker = recordingWorker();
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: memoryRoot(), PI_MEMORY_IGNORE: "1" },
      state,
      worker,
    });

    await core.handleAgentEnd({ messages: ["remember this durable preference"] });
    await core.flush();

    expect(core.pendingBatchItems).toBe(0);
    expect(worker.requests).toHaveLength(0);
    expect(state.entries).toHaveLength(2);
    expect(state.entries.map((entry) => entry.type)).toEqual([
      "memory-substrate-mode",
      "memory-substrate-mode",
    ]);
    expect((state.entries[0]?.data as { source?: string }).source).toBe("config");
    expect((state.entries[1]?.data as { source?: string }).source).toBe("flush");
  });

  test("prompt ignore mode records the matched phrase for false-positive audits", () => {
    const state = recordingState();
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: memoryRoot() },
      state,
    });

    const falsePositive = core.handleBeforeAgentStart({
      prompt: "Investigate a no memory leak report.",
      systemPrompt: "base",
    });
    const ignored = core.handleBeforeAgentStart({
      prompt: `Please do not use memory for this session. ${"x".repeat(2_000)}`,
      systemPrompt: "base",
    });

    const modeRecord = state.entries.find(
      (entry) => entry.type === "memory-substrate-mode",
    )?.data as
      | {
          source?: string;
          matchedPhrase?: string;
          prompt?: { preview?: string };
        }
      | undefined;

    expect(falsePositive).toBeUndefined();
    expect(ignored?.systemPrompt).toContain("Memory ignore mode is active");
    expect(modeRecord?.source).toBe("prompt");
    expect(modeRecord?.matchedPhrase).toBe("do not use memory");
    expect(modeRecord?.prompt?.preview).toContain("do not use memory");
    expect(modeRecord?.prompt?.preview).not.toContain("x".repeat(400));
  });

  test("rapid agent_end events collapse into one debounced worker run", async () => {
    const scheduler = new FakeScheduler();
    const state = recordingState();
    const worker = recordingWorker();
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: memoryRoot(), PI_MEMORY_DEBOUNCE_MS: "25" },
      scheduler,
      state,
      worker,
    });

    await core.handleAgentEnd({ messages: ["first"] });
    await core.handleAgentEnd({ messages: ["second"] });

    expect(worker.requests).toHaveLength(0);
    expect(scheduler.pendingTimers).toBe(1);

    await scheduler.fireAll();
    await core.waitForIdle();

    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]?.items).toHaveLength(2);
    expect(state.entries.filter((entry) => entry.type === "memory-substrate-queue")).toHaveLength(2);
    expect(state.entries.filter((entry) => entry.type === "memory-substrate-worker-run")).toHaveLength(1);
  });

  test("max batch size triggers an immediate worker run", async () => {
    const scheduler = new FakeScheduler();
    const worker = recordingWorker();
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: memoryRoot(), PI_MEMORY_MAX_BATCH_ITEMS: "2" },
      scheduler,
      worker,
    });

    await core.handleAgentEnd({ messages: ["first"] });
    await core.handleAgentEnd({ messages: ["second"] });

    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]?.items.map((item) => item.trigger)).toEqual([
      "agent_end",
      "agent_end",
    ]);
  });

  test("compaction event passes preparation content and records bounded audit", async () => {
    const state = recordingState();
    const worker = recordingWorker();
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: memoryRoot(), PI_MEMORY_DEBOUNCE_MS: "10000" },
      state,
      worker,
    });

    await core.handleAgentEnd({ messages: ["pending"] });
    const result = await core.handleSessionBeforeCompact({
      preparation: {
        summary: "The durable decision is to preserve compaction payload details.",
        transcript: "x".repeat(2_000),
      },
    });

    expect(result).toBeUndefined();
    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]?.items.map((item) => item.trigger)).toEqual([
      "agent_end",
      "session_before_compact",
    ]);
    expect(worker.requests[0]?.items[1]?.messageCount).toBe(1);
    expect(worker.requests[0]?.items[1]?.messages).toEqual([
      {
        summary: "The durable decision is to preserve compaction payload details.",
        transcript: "x".repeat(2_000),
      },
    ]);

    const compactQueueRecord = state.entries.find(
      (entry) =>
        entry.type === "memory-substrate-queue" &&
        (entry.data as { trigger?: string }).trigger === "session_before_compact",
    )?.data as { payload?: { preview?: string } } | undefined;
    const workerRunRecord = state.entries.find(
      (entry) => entry.type === "memory-substrate-worker-run",
    )?.data as
      | {
          items?: Array<{
            trigger?: string;
            payload?: { preview?: string };
          }>;
        }
      | undefined;

    expect(compactQueueRecord?.payload?.preview).toContain(
      "preserve compaction payload details",
    );
    expect(compactQueueRecord?.payload?.preview?.length).toBeLessThanOrEqual(1_203);
    expect(compactQueueRecord?.payload?.preview).not.toContain("x".repeat(400));
    expect(
      workerRunRecord?.items?.find(
        (item) => item.trigger === "session_before_compact",
      )?.payload?.preview,
    ).toContain("preserve compaction payload details");
  });

  test("worker request carries recursion guard and dry-run configuration", async () => {
    const root = memoryRoot();
    const worker = recordingWorker({
      exitCode: 0,
      stdout: "proposed: project_decision.md",
      proposedPaths: [join(root, "project_decision.md")],
    });
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: {
        PI_MEMORY_ROOT: root,
        PI_MEMORY_DRY_RUN: "1",
        PI_MEMORY_MODEL: DEFAULT_WORKER_MODEL,
      },
      worker,
    });

    await core.handleAgentEnd({ messages: ["The durable decision is to use Bun only."] });
    await core.flush();

    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]?.dryRun).toBe(true);
    expect(worker.requests[0]?.memoryRoot).toBe(root);
    expect(worker.requests[0]?.model).toBe(DEFAULT_WORKER_MODEL);
    expect(worker.requests[0]?.env.PI_MEMORY_ENABLED).toBe("0");
    expect(worker.requests[0]?.env.PI_MEMORY_DRY_RUN).toBe("1");
  });

  test("queue and worker audit records expose bounded schema fields outside prompt injection", async () => {
    const root = memoryRoot();
    writeFileSync(
      join(root, "MEMORY.md"),
      "# Memory\n- [Audit Contract](audit_contract.md) — audit contract injection sentinel\n",
    );
    const state = recordingState();
    const worker = recordingWorker({
      exitCode: 0,
      stdout: `stdout-start ${"s".repeat(650)} stdout-tail-sentinel`,
      stderr: `stderr-start ${"e".repeat(100)} stderr-tail-sentinel`,
      changedPaths: [join(root, "audit_contract.md")],
      proposedPaths: [join(root, "MEMORY.md"), join(root, "audit_contract.md")],
      validator: {
        exitCode: 0,
        stdout: "validator ok",
        stderr: "validator warning",
      },
    });
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root, PI_MEMORY_DRY_RUN: "1" },
      state,
      worker,
    });

    await core.handleAgentEnd({ messages: ["The durable decision is audit schema."] });
    await core.flush();

    const queueRecord = state.entries.find(
      (entry) => entry.type === "memory-substrate-queue",
    )?.data as
      | {
          id?: string;
          trigger?: string;
          createdAt?: number;
          messageCount?: number;
          queueDepth?: number;
          payload?: unknown;
        }
      | undefined;
    const runRecord = state.entries.find(
      (entry) => entry.type === "memory-substrate-worker-run",
    )?.data as
      | {
          batchId?: string;
          reason?: string;
          itemCount?: number;
          items?: Array<{
            id?: string;
            trigger?: string;
            createdAt?: number;
            messageCount?: number;
            payload?: unknown;
          }>;
          model?: string;
          dryRun?: boolean;
          status?: string;
          exitCode?: number;
          changedPaths?: string[];
          proposedPaths?: string[];
          validatorResult?: { exitCode?: number; outputTail?: string };
          error?: string;
          outputTail?: string;
        }
      | undefined;

    expect(queueRecord).toMatchObject({
      trigger: "agent_end",
      messageCount: 1,
      queueDepth: 1,
    });
    expect(queueRecord?.id).toMatch(/^item-\d+$/);
    expect(typeof queueRecord?.createdAt).toBe("number");
    expect(queueRecord?.payload).toBeUndefined();

    expect(runRecord).toMatchObject({
      reason: "manual",
      itemCount: 1,
      model: DEFAULT_WORKER_MODEL,
      dryRun: true,
      status: "completed",
      exitCode: 0,
      changedPaths: [join(root, "audit_contract.md")],
      proposedPaths: [join(root, "MEMORY.md"), join(root, "audit_contract.md")],
      validatorResult: {
        exitCode: 0,
        outputTail: "validator ok\nvalidator warning",
      },
    });
    expect(runRecord?.batchId).toMatch(/^batch-\d+$/);
    expect(runRecord?.items).toHaveLength(1);
    expect(runRecord?.items?.[0]).toMatchObject({
      id: queueRecord?.id,
      trigger: "agent_end",
      createdAt: queueRecord?.createdAt,
      messageCount: 1,
    });
    expect(runRecord?.items?.[0]?.payload).toBeUndefined();
    expect(runRecord?.error).toBeUndefined();
    expect(runRecord?.outputTail).toContain("stdout-tail-sentinel");
    expect(runRecord?.outputTail).toContain("stderr-tail-sentinel");
    expect(runRecord?.outputTail).not.toContain("stdout-start");
    expect(runRecord?.outputTail?.length).toBeLessThanOrEqual(800);

    const injection = core.handleBeforeAgentStart({
      prompt: "audit contract",
      systemPrompt: "base prompt",
    });
    expect(injection?.systemPrompt).toContain("audit contract injection sentinel");
    expect(injection?.systemPrompt).not.toContain("memory-substrate-worker-run");
    expect(injection?.systemPrompt).not.toContain("stdout-tail-sentinel");
    expect(injection?.systemPrompt).not.toContain(join(root, "audit_contract.md"));
  });

  test("worker launch fails closed when env forwarding is unsupported", async () => {
    const state = recordingState();
    const worker: MemoryWorkerRunner = {
      supportsEnv: false,
      async run() {
        throw new Error("must not spawn");
      },
    };
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: memoryRoot() },
      state,
      worker,
    });

    await core.handleAgentEnd({ messages: ["remember this"] });
    const result = await core.flush();

    const runRecord = state.entries.find(
      (entry) => entry.type === "memory-substrate-worker-run",
    )?.data as { status?: string; error?: string } | undefined;
    expect(result.status).toBe("refused");
    expect(result.processedItems).toBe(0);
    expect(result.remainingItems).toBe(1);
    expect(core.pendingBatchItems).toBe(1);
    expect(runRecord?.status).toBe("refused");
    expect(runRecord?.error).toContain("PI_MEMORY_ENABLED=0");
  });

  test("failed worker run keeps the batch queued for a later flush", async () => {
    const state = recordingState();
    const worker = recordingWorker({
      exitCode: 1,
      stderr: "model unavailable",
    });
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: memoryRoot() },
      state,
      worker,
    });

    await core.handleAgentEnd({ messages: ["remember this after worker recovery"] });
    const result = await core.flush();

    const runRecord = state.entries.find(
      (entry) => entry.type === "memory-substrate-worker-run",
    )?.data as { status?: string; error?: string } | undefined;
    expect(result.status).toBe("failed");
    expect(result.error).toBe("model unavailable");
    expect(result.processedItems).toBe(0);
    expect(result.remainingItems).toBe(1);
    expect(core.pendingBatchItems).toBe(1);
    expect(runRecord?.status).toBe("failed");
    expect(runRecord?.error).toBe("model unavailable");
  });

  test("unreachable live model preflight fails closed and retains queued batch", async () => {
    const state = recordingState();
    const calls: Array<{
      command: string;
      args: string[];
      options: LivePiProcessOptions;
    }> = [];
    const process: LivePiProcessExecutor = async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === "--list-models") {
        return { code: 0, stdout: MODEL_REGISTRY, stderr: "", killed: false };
      }
      return {
        code: 7,
        stdout: "",
        stderr: "third-party usage disabled",
        killed: false,
      };
    };
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: memoryRoot() },
      state,
      worker: createLivePiMemoryWorkerRunner({ process }),
    });

    await core.handleAgentEnd({
      messages: ["The durable decision is to retain batches on auth failures."],
    });
    const result = await core.flush();

    const runRecord = state.entries.find(
      (entry) => entry.type === "memory-substrate-worker-run",
    )?.data as
      | {
          status?: string;
          error?: string;
          outputTail?: string;
        }
      | undefined;
    expect(result.status).toBe("failed");
    expect(result.error).toBe("third-party usage disabled");
    expect(result.processedItems).toBe(0);
    expect(result.remainingItems).toBe(1);
    expect(core.pendingBatchItems).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args.join("\n")).toContain("reachability check");
    expect(calls[1]?.args.join("\n")).not.toContain("Candidate batch");
    expect(runRecord?.status).toBe("failed");
    expect(runRecord?.error).toBe("third-party usage disabled");
    expect(runRecord?.outputTail).toContain("third-party usage disabled");
  });
});
