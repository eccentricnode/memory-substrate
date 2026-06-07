import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WORKER_MODEL,
  resolveRuntimeConfig,
} from "../adapters/pi-dev/extension/config.ts";
import { MemoryExtensionCore } from "../adapters/pi-dev/extension/core.ts";
import { INJECTION_MAX_LINES } from "../adapters/pi-dev/extension/injection.ts";

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

function writeIndex(root: string, lines: string[]): void {
  writeFileSync(join(root, "MEMORY.md"), `# Memory\n\n${lines.join("\n")}\n`);
}

describe("pi-dev runtime config", () => {
  test("disabled mode does not resolve or touch the memory root", () => {
    const config = resolveRuntimeConfig({
      cwd: "/tmp/missing-cwd",
      env: { PI_MEMORY_ENABLED: "0", PI_MEMORY_ROOT: "/tmp/missing-memory" },
      homeDir: "/tmp/missing-home",
    });

    expect(config.enabled).toBe(false);
    expect(config.memoryRoot).toBeUndefined();
    expect(config.error).toBeUndefined();
  });

  test("resolves explicit relative roots against the pi cwd", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".memory"));

    const config = resolveRuntimeConfig({
      cwd,
      env: { PI_MEMORY_ROOT: ".memory" },
      homeDir: tempDir(),
    });

    expect(config.enabled).toBe(true);
    expect(config.memoryRoot).toBe(join(cwd, ".memory"));
    expect(config.model).toBe(DEFAULT_WORKER_MODEL);
  });

  test("records invalid roots and leaves memory unavailable", () => {
    const config = resolveRuntimeConfig({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: "missing" },
      homeDir: tempDir(),
    });

    expect(config.enabled).toBe(true);
    expect(config.memoryRoot).toBeUndefined();
    expect(config.error).toContain("memory root does not exist");
  });

  test("honors dry-run, ignore, model, debounce, and batch knobs", () => {
    const root = tempDir();
    const config = resolveRuntimeConfig({
      cwd: tempDir(),
      env: {
        PI_MEMORY_ROOT: root,
        PI_MEMORY_DRY_RUN: "1",
        PI_MEMORY_IGNORE: "1",
        PI_MEMORY_MODEL: "claude-haiku-4-5",
        PI_MEMORY_DEBOUNCE_MS: "25",
        PI_MEMORY_MAX_BATCH_ITEMS: "3",
      },
      homeDir: tempDir(),
    });

    expect(config.dryRun).toBe(true);
    expect(config.ignore).toBe(true);
    expect(config.model).toBe("claude-haiku-4-5");
    expect(config.debounceMs).toBe(25);
    expect(config.maxBatchItems).toBe(3);
  });
});

describe("memory injection", () => {
  test("disabled mode injects nothing and performs zero memory reads", () => {
    let reads = 0;
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ENABLED: "0", PI_MEMORY_ROOT: "/missing" },
      fs: {
        readFile() {
          reads += 1;
          throw new Error("must not read");
        },
      },
    });

    const result = core.handleBeforeAgentStart({
      prompt: "Tell me about Ralph memory.",
      systemPrompt: "base",
    });

    expect(result).toBeUndefined();
    expect(reads).toBe(0);
  });

  test("ignore mode injects nothing and performs zero memory reads", () => {
    let reads = 0;
    const root = tempDir();
    writeIndex(root, ["- [Ralph loop](project_ralph-loop.md) — use one test runner"]);
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root, PI_MEMORY_IGNORE: "1" },
      fs: {
        readFile() {
          reads += 1;
          return "";
        },
      },
    });

    expect(
      core.handleBeforeAgentStart({
        prompt: "Use the Ralph loop notes.",
        systemPrompt: "base",
      }),
    ).toBeUndefined();
    expect(reads).toBe(0);
  });

  test("user ignore request persists for the session", () => {
    let reads = 0;
    const root = tempDir();
    writeIndex(root, ["- [Ralph loop](project_ralph-loop.md) — use one test runner"]);
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root },
      fs: {
        readFile() {
          reads += 1;
          return "";
        },
      },
    });

    expect(
      core.handleBeforeAgentStart({
        prompt: "Ignore memory for this session.",
        systemPrompt: "base",
      }),
    ).toBeUndefined();
    expect(core.ignored).toBe(true);
    expect(
      core.handleBeforeAgentStart({
        prompt: "Now use Ralph loop notes.",
        systemPrompt: "base",
      }),
    ).toBeUndefined();
    expect(reads).toBe(0);
  });

  test("no salient overlap injects nothing", () => {
    const root = tempDir();
    writeIndex(root, ["- [Ralph loop](project_ralph-loop.md) — use one test runner"]);
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root },
    });

    expect(
      core.handleBeforeAgentStart({
        prompt: "Explain CSS layout.",
        systemPrompt: "base",
      }),
    ).toBeUndefined();
  });

  test("overlap injects attributed bounded index snippets only", () => {
    const root = tempDir();
    writeIndex(root, [
      "- [Ralph loop](project_ralph-loop.md) — use one test runner",
      "- [Pi memory](reference_pi-memory.md) — pi extension uses MEMORY.md snippets",
    ]);
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root },
    });

    const result = core.handleBeforeAgentStart({
      prompt: "What should Ralph remember about pi memory?",
      systemPrompt: "base prompt",
    });

    expect(result?.systemPrompt).toContain("base prompt");
    expect(result?.systemPrompt).toContain("Durable memory from memory-substrate");
    expect(result?.systemPrompt).toContain(
      "- [Pi memory](reference_pi-memory.md) — pi extension uses MEMORY.md snippets",
    );
    expect(result?.systemPrompt).not.toContain("topic body");
  });

  test("injection is capped at twelve index lines", () => {
    const root = tempDir();
    writeIndex(
      root,
      Array.from(
        { length: 20 },
        (_, i) => `- [Ralph ${i}](project_ralph-${i}.md) — Ralph memory line ${i}`,
      ),
    );
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root },
    });

    const result = core.handleBeforeAgentStart({
      prompt: "Ralph memory",
      systemPrompt: "",
    });
    const injectedEntryCount =
      result?.systemPrompt
        ?.split("\n")
        .filter((line) => line.startsWith("- [Ralph")).length ?? 0;

    expect(injectedEntryCount).toBe(INJECTION_MAX_LINES);
  });
});
