import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import memorySubstrateExtension from "../adapters/pi-dev/extension/index.ts";
import { MemoryExtensionCore } from "../adapters/pi-dev/extension/core.ts";
import type {
  MemoryWorkerRequest,
  MemoryWorkerResult,
  MemoryWorkerRunner,
} from "../adapters/pi-dev/extension/worker.ts";

const tmpRoots: string[] = [];
const envKeys = [
  "PI_MEMORY_ENABLED",
  "PI_MEMORY_ROOT",
  "PI_MEMORY_IGNORE",
  "PI_MEMORY_MODEL",
  "PI_MEMORY_RESEARCH_MODEL",
];
const savedEnv = new Map<string, string | undefined>();

for (const key of envKeys) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
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

interface FakeContext {
  cwd: string;
  ui: {
    notifications: Array<{ message: string; level?: string }>;
    statuses: Array<{ key: string; value: string | undefined }>;
    notify(message: string, level?: string): void;
    setStatus(key: string, value: string | undefined): void;
  };
}

interface FakeCommand {
  description: string;
  handler(args: string, ctx: FakeContext): void | Promise<void>;
}

function fakeContext(cwd = tempDir()): FakeContext {
  return {
    cwd,
    ui: {
      notifications: [],
      statuses: [],
      notify(message, level) {
        this.notifications.push({ message, level });
      },
      setStatus(key, value) {
        this.statuses.push({ key, value });
      },
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

function fakePi(options: Parameters<typeof memorySubstrateExtension>[1] = {}) {
  const handlers = new Map<string, (event: unknown, ctx: FakeContext) => unknown>();
  const commands = new Map<string, FakeCommand>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: FakeContext) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: FakeCommand) {
      commands.set(name, command);
    },
  };
  memorySubstrateExtension(
    pi as unknown as Parameters<typeof memorySubstrateExtension>[0],
    options,
  );
  return { handlers, commands };
}

describe("pi-dev memory command surface", () => {
  test("core validation is suppressed in disabled mode without invoking the runner", async () => {
    let calls = 0;
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ENABLED: "0", PI_MEMORY_ROOT: "/missing" },
      validator: async () => {
        calls += 1;
        return { exitCode: 0 };
      },
    });

    const result = await core.validateMemory();

    expect(result.status).toBe("disabled");
    expect(calls).toBe(0);
  });

  test("core validation runs in ignore mode because it is a non-mutating diagnostic", async () => {
    let calls = 0;
    const root = memoryRoot();
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root, PI_MEMORY_IGNORE: "1" },
      validator: async (memoryRoot) => {
        calls += 1;
        expect(memoryRoot).toBe(root);
        return { exitCode: 0 };
      },
    });

    const result = await core.validateMemory();

    expect(result.status).toBe("passed");
    expect(result.memoryRoot).toBe(root);
    expect(calls).toBe(1);
  });

  test("core validation reports reference validator failures from the resolved root", async () => {
    const root = memoryRoot();
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root },
      validator: async (memoryRoot) => ({
        exitCode: 1,
        stdout: `checked ${memoryRoot}`,
        stderr: "broken link",
      }),
    });

    const result = await core.validateMemory();

    expect(result.status).toBe("failed");
    expect(result.memoryRoot).toBe(root);
    expect(result.outputTail).toContain("checked");
    expect(result.outputTail).toContain("broken link");
  });

  test("memory-validate command invokes the reference validator against the resolved root", async () => {
    const root = memoryRoot();
    process.env.PI_MEMORY_ROOT = root;
    delete process.env.PI_MEMORY_ENABLED;
    const { handlers, commands } = fakePi();
    const ctx = fakeContext();

    handlers.get("session_start")?.({}, ctx);
    await commands.get("memory-validate")?.handler("", ctx);

    const notification = ctx.ui.notifications.at(-1);
    expect(notification?.level).toBe("success");
    expect(notification?.message).toContain("memory validation passed");
    expect(notification?.message).toContain(root);
    expect(notification?.message).toContain("0 errors");
  });

  test("memory-validate command obeys disabled mode and does not require a root", async () => {
    process.env.PI_MEMORY_ENABLED = "0";
    process.env.PI_MEMORY_ROOT = "/missing-memory-root";
    const { handlers, commands } = fakePi();
    const ctx = fakeContext();

    handlers.get("session_start")?.({}, ctx);
    await commands.get("memory-validate")?.handler("", ctx);

    const notification = ctx.ui.notifications.at(-1);
    expect(notification?.level).toBe("info");
    expect(notification?.message).toBe("memory validation skipped: disabled");
  });

  test("memory-validate command runs in ignore mode without using or writing memory", async () => {
    const root = memoryRoot();
    process.env.PI_MEMORY_ROOT = root;
    process.env.PI_MEMORY_IGNORE = "1";
    delete process.env.PI_MEMORY_ENABLED;
    const { handlers, commands } = fakePi();
    const ctx = fakeContext();

    handlers.get("session_start")?.({}, ctx);
    await commands.get("memory-validate")?.handler("", ctx);

    const notification = ctx.ui.notifications.at(-1);
    expect(notification?.level).toBe("success");
    expect(notification?.message).toContain("memory validation passed");
    expect(notification?.message).toContain(root);
  });

  test("memory-flush command drains queued candidates without a real model", async () => {
    const root = memoryRoot();
    process.env.PI_MEMORY_ROOT = root;
    delete process.env.PI_MEMORY_ENABLED;
    const worker = recordingWorker();
    const { handlers, commands } = fakePi({ worker });
    const ctx = fakeContext();

    handlers.get("session_start")?.({}, ctx);
    await handlers.get("agent_end")?.({
      messages: ["The durable decision is to test flush with a stub worker."],
    }, ctx);

    expect(worker.requests).toHaveLength(0);

    await commands.get("memory-flush")?.handler("", ctx);

    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]?.items.map((item) => item.trigger)).toEqual([
      "agent_end",
    ]);
    const notification = ctx.ui.notifications.at(-1);
    expect(notification?.level).toBe("success");
    expect(notification?.message).toContain("processed 1 queued memory candidate");
    expect(notification?.message).toContain("no memory changes accepted");
    expect(ctx.ui.statuses.at(-1)?.value).toContain(root);
  });

  test("memory-flush command distinguishes write-changing success", async () => {
    const root = memoryRoot();
    process.env.PI_MEMORY_ROOT = root;
    delete process.env.PI_MEMORY_ENABLED;
    const worker = recordingWorker({
      exitCode: 0,
      stdout: "wrote memory",
      changedPaths: [join(root, "MEMORY.md"), join(root, "project_flush.md")],
    });
    const { handlers, commands } = fakePi({ worker });
    const ctx = fakeContext();

    handlers.get("session_start")?.({}, ctx);
    await handlers.get("agent_end")?.({
      messages: ["The durable decision is to test a changing flush."],
    }, ctx);
    await commands.get("memory-flush")?.handler("", ctx);

    const notification = ctx.ui.notifications.at(-1);
    expect(notification?.level).toBe("success");
    expect(notification?.message).toContain("processed 1 queued memory candidate");
    expect(notification?.message).toContain("2 memory path change(s)");
    expect(notification?.message).not.toContain("no memory changes accepted");
  });

  test("memory-flush command reports worker failures and retains queued candidates", async () => {
    const root = memoryRoot();
    process.env.PI_MEMORY_ROOT = root;
    delete process.env.PI_MEMORY_ENABLED;
    const worker = recordingWorker({
      exitCode: 1,
      stderr: "worker model unavailable",
    });
    const { handlers, commands } = fakePi({ worker });
    const ctx = fakeContext();

    handlers.get("session_start")?.({}, ctx);
    await handlers.get("agent_end")?.({
      messages: ["The durable decision is to test failed flush retention."],
    }, ctx);
    await commands.get("memory-flush")?.handler("", ctx);

    const notification = ctx.ui.notifications.at(-1);
    expect(notification?.level).toBe("error");
    expect(notification?.message).toContain("memory flush failed");
    expect(notification?.message).toContain("worker model unavailable");
    expect(notification?.message).toContain("1 queued memory candidate(s) retained");
    expect(worker.requests).toHaveLength(1);
  });

  test("memory-flush command reports validator rollback failures distinctly", async () => {
    const root = memoryRoot();
    process.env.PI_MEMORY_ROOT = root;
    delete process.env.PI_MEMORY_ENABLED;
    const worker = recordingWorker({
      exitCode: 1,
      stderr: "validator failed after memory write; rolled back attempted changes",
      proposedPaths: [join(root, "MEMORY.md")],
      validator: {
        exitCode: 1,
        stderr: "validator found errors",
      },
    });
    const { handlers, commands } = fakePi({ worker });
    const ctx = fakeContext();

    handlers.get("session_start")?.({}, ctx);
    await handlers.get("agent_end")?.({
      messages: ["The durable decision is to test validator rollback status."],
    }, ctx);
    await commands.get("memory-flush")?.handler("", ctx);

    const notification = ctx.ui.notifications.at(-1);
    expect(notification?.level).toBe("error");
    expect(notification?.message).toContain("memory flush validation failed");
    expect(notification?.message).toContain("rolled back attempted changes");
    expect(notification?.message).toContain("1 queued memory candidate(s) retained");
    expect(worker.requests).toHaveLength(1);
  });

  test("memory-flush command obeys disabled mode and does not require a root", async () => {
    process.env.PI_MEMORY_ENABLED = "0";
    process.env.PI_MEMORY_ROOT = "/missing-memory-root";
    const worker = recordingWorker();
    const { handlers, commands } = fakePi({ worker });
    const ctx = fakeContext();

    handlers.get("session_start")?.({}, ctx);
    await commands.get("memory-flush")?.handler("", ctx);

    expect(worker.requests).toHaveLength(0);
    expect(ctx.ui.notifications.at(-1)).toEqual({
      message: "memory flush skipped: disabled",
      level: "info",
    });
  });

  test("memory-refresh command writes a root-confined reviewable proposal without mutating durable memory", () => {
    const root = memoryRoot();
    const originalIndex =
      "# Memory\n\n- [Duplicate](project_bun-commands.md) — duplicate pointer\n- [Duplicate Again](project_bun-commands.md) — duplicate pointer\n";
    writeFileSync(
      join(root, "project_bun-commands.md"),
      `---
name: bun-commands
description: Use Bun for project automation
metadata:
  type: project
---

Use Bun for project automation.
`,
    );
    writeFileSync(join(root, "MEMORY.md"), originalIndex);
    process.env.PI_MEMORY_ROOT = root;
    delete process.env.PI_MEMORY_ENABLED;
    const { handlers, commands } = fakePi();
    const ctx = fakeContext();

    handlers.get("session_start")?.({}, ctx);
    commands.get("memory-refresh")?.handler("", ctx);

    const outputDir = join(root, ".memory-substrate", "refresh-proposal");
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(originalIndex);
    expect(existsSync(join(root, "COMPACTION_REPORT.md"))).toBe(false);
    expect(readFileSync(join(outputDir, "MEMORY.md"), "utf8")).toContain(
      "- [Bun Commands](project_bun-commands.md) — Use Bun for project automation",
    );
    expect(readFileSync(join(outputDir, "COMPACTION_REPORT.md"), "utf8")).toContain(
      "hidden in-root directory",
    );

    const notification = ctx.ui.notifications.at(-1);
    expect(notification?.level).toBe("warn");
    expect(notification?.message).toContain("memory refresh proposal created");
    expect(notification?.message).toContain(outputDir);
    expect(notification?.message).toContain("durable memory was not modified");
  });

  test("memory-refresh command rejects explicit output outside the memory root", () => {
    const root = memoryRoot();
    const outputDir = join(tempDir(), "refresh-proposal");
    writeFileSync(
      join(root, "project_bun-commands.md"),
      `---
name: bun-commands
description: Use Bun for project automation
metadata:
  type: project
---

Use Bun for project automation.
`,
    );
    writeFileSync(
      join(root, "MEMORY.md"),
      "# Memory\n\n- [Bun Commands](project_bun-commands.md) — Use Bun for project automation\n",
    );
    process.env.PI_MEMORY_ROOT = root;
    delete process.env.PI_MEMORY_ENABLED;
    const { handlers, commands } = fakePi();
    const ctx = fakeContext();

    handlers.get("session_start")?.({}, ctx);
    commands.get("memory-refresh")?.handler(outputDir, ctx);

    expect(existsSync(join(outputDir, "MEMORY.md"))).toBe(false);
    expect(ctx.ui.notifications.at(-1)?.level).toBe("error");
    expect(ctx.ui.notifications.at(-1)?.message).toContain(
      "proposal output must be inside the memory root",
    );
  });

  test("memory-refresh command reports unavailable, ignored, and disabled modes", () => {
    delete process.env.PI_MEMORY_ENABLED;
    process.env.PI_MEMORY_ROOT = "/missing-memory-root";
    const unavailable = fakePi();
    const unavailableCtx = fakeContext();
    unavailable.handlers.get("session_start")?.({}, unavailableCtx);
    unavailable.commands.get("memory-refresh")?.handler("", unavailableCtx);
    expect(unavailableCtx.ui.notifications.at(-1)?.message).toContain(
      "memory refresh unavailable",
    );
    expect(unavailableCtx.ui.notifications.at(-1)?.level).toBe("error");

    const root = memoryRoot();
    process.env.PI_MEMORY_ROOT = root;
    process.env.PI_MEMORY_IGNORE = "1";
    const ignored = fakePi();
    const ignoredCtx = fakeContext();
    ignored.handlers.get("session_start")?.({}, ignoredCtx);
    ignored.commands.get("memory-refresh")?.handler("", ignoredCtx);
    expect(ignoredCtx.ui.notifications.at(-1)).toEqual({
      message: "memory refresh skipped: ignored",
      level: "info",
    });

    process.env.PI_MEMORY_ENABLED = "0";
    process.env.PI_MEMORY_ROOT = "/missing-memory-root";
    delete process.env.PI_MEMORY_IGNORE;
    const disabled = fakePi();
    const disabledCtx = fakeContext();
    disabled.handlers.get("session_start")?.({}, disabledCtx);
    disabled.commands.get("memory-refresh")?.handler("", disabledCtx);
    expect(disabledCtx.ui.notifications.at(-1)).toEqual({
      message: "memory refresh skipped: disabled",
      level: "info",
    });
  });

  test("disabled extension handlers short-circuit before resolving the memory root", async () => {
    process.env.PI_MEMORY_ENABLED = "0";
    process.env.PI_MEMORY_ROOT = "/missing-memory-root";
    const { handlers, commands } = fakePi();
    const ctx = fakeContext();

    handlers.get("session_start")?.({}, ctx);
    const startResult = await handlers.get("before_agent_start")?.(
      { prompt: "remember Bun", systemPrompt: "base" },
      ctx,
    );
    await handlers.get("agent_end")?.({ messages: ["remember Bun"] }, ctx);
    const compactResult = await handlers.get("session_before_compact")?.({}, ctx);
    commands.get("memory-status")?.handler("", ctx);

    expect(startResult).toBeUndefined();
    expect(compactResult).toBeUndefined();
    expect(ctx.ui.statuses.map((status) => status.value)).toEqual([
      "memory: disabled",
      "memory: disabled",
      "memory: disabled",
      "memory: disabled",
    ]);
    expect(ctx.ui.notifications.at(-1)).toEqual({
      message: "memory: disabled",
      level: "info",
    });
  });

  test("memory-status reports malformed model configuration before command preflight", () => {
    process.env.PI_MEMORY_ROOT = "/missing-memory-root";
    process.env.PI_MEMORY_MODEL = "claude-haiku-4-5";
    const { commands } = fakePi();
    const ctx = fakeContext();

    commands.get("memory-status")?.handler("", ctx);

    expect(ctx.ui.notifications.at(-1)?.level).toBe("info");
    expect(ctx.ui.notifications.at(-1)?.message).toContain("memory: unavailable");
    expect(ctx.ui.notifications.at(-1)?.message).toContain(
      "memory worker model must be provider-qualified",
    );
    expect(ctx.ui.notifications.at(-1)?.message).not.toContain(
      "memory root does not exist",
    );
  });

  test("host substrate disabled signal short-circuits handlers before root resolution", async () => {
    delete process.env.PI_MEMORY_ENABLED;
    process.env.PI_MEMORY_ROOT = "/missing-memory-root";
    const worker = recordingWorker();
    const { handlers, commands } = fakePi({ worker });
    const ctx = Object.assign(fakeContext(), {
      substrate: {
        memoryDisabled: true,
        memoryDisabledReason: "host HIPAA boundary",
      },
    });

    handlers.get("session_start")?.({}, ctx);
    const startResult = await handlers.get("before_agent_start")?.(
      { prompt: "remember Bun", systemPrompt: "base" },
      ctx,
    );
    await handlers.get("agent_end")?.({ messages: ["remember Bun"] }, ctx);
    const compactResult = await handlers.get("session_before_compact")?.({}, ctx);
    commands.get("memory-status")?.handler("", ctx);
    await commands.get("memory-flush")?.handler("", ctx);
    await commands.get("memory-validate")?.handler("", ctx);
    commands.get("memory-refresh")?.handler("", ctx);

    expect(startResult).toBeUndefined();
    expect(compactResult).toBeUndefined();
    expect(worker.requests).toHaveLength(0);
    expect(ctx.ui.statuses.map((status) => status.value)).toEqual([
      "memory: disabled",
      "memory: disabled",
      "memory: disabled",
      "memory: disabled",
    ]);
    expect(ctx.ui.notifications).toEqual([
      { message: "memory: disabled", level: "info" },
      { message: "memory flush skipped: disabled", level: "info" },
      { message: "memory validation skipped: disabled", level: "info" },
      { message: "memory refresh skipped: disabled", level: "info" },
    ]);
  });
});
