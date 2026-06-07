import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryExtensionCore, type MemoryScheduler } from "../adapters/pi-dev/extension/core.ts";
import type {
  MemoryWorkerRequest,
  MemoryWorkerResult,
  MemoryWorkerRunner,
} from "../adapters/pi-dev/extension/worker.ts";

const tmpRoots: string[] = [];

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
    expect(state.entries).toHaveLength(0);
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

  test("compaction event forces a flush and does not cancel compaction", async () => {
    const worker = recordingWorker();
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: memoryRoot(), PI_MEMORY_DEBOUNCE_MS: "10000" },
      worker,
    });

    await core.handleAgentEnd({ messages: ["pending"] });
    const result = await core.handleSessionBeforeCompact({});

    expect(result).toBeUndefined();
    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]?.items.map((item) => item.trigger)).toEqual([
      "agent_end",
      "session_before_compact",
    ]);
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
        PI_MEMORY_MODEL: "claude-haiku-4-5",
      },
      worker,
    });

    await core.handleAgentEnd({ messages: ["The durable decision is to use Bun only."] });
    await core.flush();

    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]?.dryRun).toBe(true);
    expect(worker.requests[0]?.memoryRoot).toBe(root);
    expect(worker.requests[0]?.model).toBe("claude-haiku-4-5");
    expect(worker.requests[0]?.env.PI_MEMORY_ENABLED).toBe("0");
    expect(worker.requests[0]?.env.PI_MEMORY_DRY_RUN).toBe("1");
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
});
