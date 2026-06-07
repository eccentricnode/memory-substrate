import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryExtensionCore } from "../adapters/pi-dev/extension/core.ts";
import {
  createDeterministicMemoryWorkerRunner,
  type MemoryWorkerRequest,
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

function request(root: string, message: string, dryRun = false): MemoryWorkerRequest {
  return {
    batchId: "batch-1",
    cwd: tempDir(),
    memoryRoot: root,
    model: "claude-haiku-4-5",
    dryRun,
    env: {
      PI_MEMORY_ENABLED: "0",
      PI_MEMORY_ROOT: root,
      PI_MEMORY_MODEL: "claude-haiku-4-5",
      PI_MEMORY_DRY_RUN: dryRun ? "1" : "0",
    },
    items: [
      {
        id: "item-1",
        trigger: "agent_end",
        createdAt: 1,
        messageCount: 1,
        messages: [message],
      },
    ],
  };
}

function topicFiles(root: string): string[] {
  return readdirSync(root).filter(
    (entry) => entry.endsWith(".md") && entry !== "MEMORY.md",
  );
}

describe("deterministic memory worker write path", () => {
  test("chatter produces no memory writes", async () => {
    const root = memoryRoot();
    const worker = createDeterministicMemoryWorkerRunner();

    const result = await worker.run(request(root, "Fixed the lint error and kept going."));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no memory written");
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe("# Memory\n");
  });

  test("explicit durable decision writes topic file, index pointer, and validator result", async () => {
    const root = memoryRoot();
    const state = {
      entries: [] as Array<{ type: string; data: unknown }>,
      appendEntry(type: string, data: unknown) {
        this.entries.push({ type, data });
      },
    };
    const worker = createDeterministicMemoryWorkerRunner();
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root },
      state,
      worker,
    });

    await core.handleAgentEnd({
      messages: [
        "The durable decision is to use Bun for all build and test commands.",
      ],
    });
    await core.flush();

    const topics = topicFiles(root);
    expect(topics).toHaveLength(1);
    const topic = readFileSync(join(root, topics[0] ?? ""), "utf8");
    expect(topic).toContain("metadata:\n  type: project");
    expect(topic).toContain("use Bun for all build and test commands");
    const index = readFileSync(join(root, "MEMORY.md"), "utf8");
    expect(index).toContain(`](${topics[0]}) -- use Bun for all build and test commands`);

    const runRecord = state.entries.find(
      (entry) => entry.type === "memory-substrate-worker-run",
    )?.data as { status?: string; validatorResult?: { exitCode: number } } | undefined;
    expect(runRecord?.status).toBe("completed");
    expect(runRecord?.validatorResult?.exitCode).toBe(0);
  });

  test("repeated durable fact updates instead of duplicating", async () => {
    const root = memoryRoot();
    const worker = createDeterministicMemoryWorkerRunner();
    const first = request(
      root,
      "The durable decision is to use Bun for all build and test commands.",
    );
    const second = request(
      root,
      "The durable decision is to use Bun for all build and test commands.",
    );

    expect((await worker.run(first)).exitCode).toBe(0);
    expect((await worker.run(second)).exitCode).toBe(0);

    expect(topicFiles(root)).toHaveLength(1);
    const indexEntries = readFileSync(join(root, "MEMORY.md"), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("- ["));
    expect(indexEntries).toHaveLength(1);
  });

  test("dry-run reports proposed paths and writes nothing", async () => {
    const root = memoryRoot();
    const before = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner();

    const result = await worker.run(
      request(
        root,
        "The durable decision is to use Bun for all build and test commands.",
        true,
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dry-run");
    expect(result.proposedPaths?.some((path) => path.endsWith("MEMORY.md"))).toBe(
      true,
    );
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(before);
  });

  test("out-of-root topic path is refused before writing", async () => {
    const root = memoryRoot();
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          type: "project",
          description: "escape attempt",
          body: "escape attempt",
          relativePath: "../escape.md",
        },
      ],
    });

    const result = await worker.run(request(root, "The durable decision is escape."));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("out-of-root");
    expect(topicFiles(root)).toEqual([]);
    expect(readdirSync(join(root, "..")).includes("escape.md")).toBe(false);
  });

  test("symlink topic path escaping the memory root is refused", async () => {
    const root = memoryRoot();
    const outside = tempDir();
    const outsideFile = join(outside, "outside.md");
    writeFileSync(outsideFile, "outside\n");
    symlinkSync(outsideFile, join(root, "project_escape-attempt.md"));
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          type: "project",
          description: "escape attempt",
          body: "escape attempt",
          relativePath: "project_escape-attempt.md",
        },
      ],
    });

    const result = await worker.run(request(root, "The durable decision is escape."));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("symlink escape");
    expect(readFileSync(outsideFile, "utf8")).toBe("outside\n");
  });

  test("validator failure marks the worker run failed after the two-step write", async () => {
    const root = memoryRoot();
    const worker = createDeterministicMemoryWorkerRunner({
      validate: async () => ({
        exitCode: 1,
        stdout: "validator found errors",
      }),
    });

    const result = await worker.run(
      request(root, "The durable decision is to use Bun for all commands."),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("validator failed");
    expect(result.changedPaths?.some((path) => path.endsWith("MEMORY.md"))).toBe(
      true,
    );
    expect(result.validator?.exitCode).toBe(1);
  });
});
