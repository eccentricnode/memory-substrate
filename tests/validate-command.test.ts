import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import memorySubstrateExtension from "../adapters/pi-dev/extension/index.ts";
import { MemoryExtensionCore } from "../adapters/pi-dev/extension/core.ts";

const tmpRoots: string[] = [];
const envKeys = ["PI_MEMORY_ENABLED", "PI_MEMORY_ROOT", "PI_MEMORY_IGNORE"];
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
      notify(message, level) {
        this.notifications.push({ message, level });
      },
      setStatus() {},
    },
  };
}

function fakePi() {
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
  );
  return { handlers, commands };
}

describe("pi-dev memory validation surface", () => {
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
});
