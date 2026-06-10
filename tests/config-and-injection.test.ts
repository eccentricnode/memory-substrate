import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WORKER_MODEL,
  resolveRuntimeConfig,
} from "../adapters/pi-dev/extension/config.ts";
import { MemoryExtensionCore } from "../adapters/pi-dev/extension/core.ts";
import {
  buildReactiveMemoryGate,
  INJECTION_MAX_BYTES,
  INJECTION_MAX_LINES,
} from "../adapters/pi-dev/extension/injection.ts";
import type { MemoryResearchResult } from "../adapters/pi-dev/extension/research.ts";

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

function recordingState() {
  const entries: Array<{ type: string; data: unknown }> = [];
  return {
    entries,
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
  };
}

function foundResearch(answer = "Use Bun for verification."): MemoryResearchResult {
  return {
    status: "found",
    found: true,
    answer,
    citations: ["project_bun.md"],
  };
}

function recordingResearch(result: MemoryResearchResult) {
  const calls: Array<{
    question: string;
    cwd: string;
    env?: Record<string, string | undefined>;
  }> = [];
  return Object.assign(
    async (request: {
      question: string;
      cwd: string;
      env?: Record<string, string | undefined>;
    }) => {
      calls.push(request);
      return result;
    },
    { calls },
  );
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

  test("host disabled signal does not resolve or touch the memory root", () => {
    const config = resolveRuntimeConfig({
      cwd: "/tmp/missing-cwd",
      env: { PI_MEMORY_ROOT: "/tmp/missing-memory" },
      homeDir: "/tmp/missing-home",
      disabledReason: "host HIPAA boundary",
    });

    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toBe("host HIPAA boundary");
    expect(config.memoryRoot).toBeUndefined();
    expect(config.error).toBeUndefined();
  });

  test("resolves explicit relative roots against the pi cwd", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".memory"));
    writeFileSync(join(cwd, ".memory", "MEMORY.md"), "# Memory\n");

    const config = resolveRuntimeConfig({
      cwd,
      env: { PI_MEMORY_ROOT: ".memory" },
      homeDir: tempDir(),
    });

    expect(config.enabled).toBe(true);
    expect(config.memoryRoot).toBe(join(cwd, ".memory"));
    expect(config.model).toBe(DEFAULT_WORKER_MODEL);
  });

  test("resolves the default memory root under the configured home directory", () => {
    const homeDir = tempDir();
    const defaultRoot = join(homeDir, ".memory");
    mkdirSync(defaultRoot);
    writeFileSync(join(defaultRoot, "MEMORY.md"), "# Memory\n");

    const config = resolveRuntimeConfig({
      cwd: tempDir(),
      env: {},
      homeDir,
    });

    expect(config.enabled).toBe(true);
    expect(config.memoryRoot).toBe(defaultRoot);
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

  test("requires MEMORY.md before enabled mode can use a root", () => {
    const root = tempDir();

    const config = resolveRuntimeConfig({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root },
      homeDir: tempDir(),
    });

    expect(config.enabled).toBe(true);
    expect(config.memoryRoot).toBeUndefined();
    expect(config.error).toContain("memory index does not exist");
  });

  test("rejects a directory where MEMORY.md should be", () => {
    const root = tempDir();
    mkdirSync(join(root, "MEMORY.md"));

    const config = resolveRuntimeConfig({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root },
      homeDir: tempDir(),
    });

    expect(config.enabled).toBe(true);
    expect(config.memoryRoot).toBeUndefined();
    expect(config.error).toContain("memory index is not a regular file");
  });

  test("rejects a symlinked MEMORY.md before injection can read outside the root", () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "MEMORY.md"), "# Memory\n");
    symlinkSync(join(outside, "MEMORY.md"), join(root, "MEMORY.md"));

    const config = resolveRuntimeConfig({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root },
      homeDir: tempDir(),
    });

    expect(config.enabled).toBe(true);
    expect(config.memoryRoot).toBeUndefined();
    expect(config.error).toContain("memory index is not a regular file");
  });

  test("rejects a regular file as the memory root", () => {
    const cwd = tempDir();
    const fileRoot = join(cwd, "memory-file");
    writeFileSync(fileRoot, "# not a directory\n");

    const config = resolveRuntimeConfig({
      cwd,
      env: { PI_MEMORY_ROOT: fileRoot },
      homeDir: tempDir(),
    });

    expect(config.enabled).toBe(true);
    expect(config.memoryRoot).toBeUndefined();
    expect(config.error).toContain("memory root is not a directory");
  });

  test("honors dry-run, ignore, model, debounce, and batch knobs", () => {
    const root = tempDir();
    writeFileSync(join(root, "MEMORY.md"), "# Memory\n");
    const config = resolveRuntimeConfig({
      cwd: tempDir(),
      env: {
        PI_MEMORY_ROOT: root,
        PI_MEMORY_DRY_RUN: "1",
        PI_MEMORY_IGNORE: "1",
        PI_MEMORY_REACTIVE: "1",
        PI_MEMORY_MODEL: "openai-codex/gpt-5.3-codex-spark",
        PI_MEMORY_DEBOUNCE_MS: "25",
        PI_MEMORY_MAX_BATCH_ITEMS: "3",
      },
      homeDir: tempDir(),
    });

    expect(config.dryRun).toBe(true);
    expect(config.ignore).toBe(true);
    expect(config.reactive).toBe(true);
    expect(config.model).toBe("openai-codex/gpt-5.3-codex-spark");
    expect(config.researchModel).toBe("openai-codex/gpt-5.3-codex-spark");
    expect(config.debounceMs).toBe(25);
    expect(config.maxBatchItems).toBe(3);
  });

  test("rejects malformed worker and research models before root discovery", () => {
    const missingRoot = join(tempDir(), "missing-memory");

    const workerConfig = resolveRuntimeConfig({
      cwd: tempDir(),
      env: {
        PI_MEMORY_ROOT: missingRoot,
        PI_MEMORY_MODEL: "claude-haiku-4-5",
      },
      homeDir: tempDir(),
    });
    const researchConfig = resolveRuntimeConfig({
      cwd: tempDir(),
      env: {
        PI_MEMORY_ROOT: missingRoot,
        PI_MEMORY_RESEARCH_MODEL: "gpt-5.3-codex-spark",
      },
      homeDir: tempDir(),
    });

    expect(workerConfig.memoryRoot).toBeUndefined();
    expect(workerConfig.error).toContain("memory worker model must be provider-qualified");
    expect(workerConfig.error).not.toContain("memory root does not exist");
    expect(researchConfig.memoryRoot).toBeUndefined();
    expect(researchConfig.error).toContain(
      "memory research model must be provider-qualified",
    );
    expect(researchConfig.error).not.toContain("memory root does not exist");
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

    const result = core.handleBeforeAgentStart({
      prompt: "Use the Ralph loop notes.",
      systemPrompt: "base",
    });

    expect(result?.systemPrompt).toContain("Memory ignore mode is active");
    expect(reads).toBe(0);
  });

  test("user ignore request persists for the session without matching false positives", () => {
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
        prompt: "Debug a no memory leak report.",
        systemPrompt: "base",
      }),
    ).toBeUndefined();
    expect(core.ignored).toBe(false);
    reads = 0;

    const ignoreResult = core.handleBeforeAgentStart({
      prompt: "Ignore memory for this session.",
      systemPrompt: "base",
    });

    expect(ignoreResult?.systemPrompt).toContain("Memory ignore mode is active");
    expect(core.ignored).toBe(true);
    const laterResult = core.handleBeforeAgentStart({
      prompt: "Now use Ralph loop notes.",
      systemPrompt: "base",
    });
    expect(laterResult?.systemPrompt).toContain("Memory ignore mode is active");
    expect(reads).toBe(0);
  });

  test("operator can resume prompt-triggered ignore mode but not config ignore", () => {
    const root = tempDir();
    writeIndex(root, ["- [Ralph loop](project_ralph-loop.md) — use one test runner"]);
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root },
    });

    core.handleBeforeAgentStart({
      prompt: "Ignore memory for now.",
      systemPrompt: "base",
    });
    expect(core.ignored).toBe(true);

    const resumed = core.handleBeforeAgentStart({
      prompt: "Resume memory and use Ralph loop notes.",
      systemPrompt: "base",
    });

    expect(core.ignored).toBe(false);
    expect(resumed?.systemPrompt).toContain("Durable memory from memory-substrate");
    expect(resumed?.systemPrompt).not.toContain("Memory ignore mode is active");

    const configIgnored = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root, PI_MEMORY_IGNORE: "1" },
    });
    const configResult = configIgnored.resumeMemory("command");

    expect(configResult.status).toBe("ignored-by-config");
    expect(configIgnored.ignored).toBe(true);
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

  test("injection is capped at four KB and records truncation audit", () => {
    const root = tempDir();
    const state = recordingState();
    const longHook = "ralph durable byte cap ".repeat(24);
    writeIndex(
      root,
      Array.from(
        { length: INJECTION_MAX_LINES },
        (_, i) => `- [Ralph ${i}](project_ralph-${i}.md) — ${longHook}${i}`,
      ),
    );
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root },
      state,
    });

    const result = core.handleBeforeAgentStart({
      prompt: "Ralph durable byte cap",
      systemPrompt: "",
    });
    const injectionText = result?.systemPrompt ?? "";
    const auditRecord = state.entries.find(
      (entry) => entry.type === "memory-substrate-injection",
    )?.data as
      | {
          byteLength: number;
          byteCap: number;
          lineCap: number;
          selectedLineCount: number;
          truncated: boolean;
        }
      | undefined;

    if (!auditRecord) throw new Error("missing injection audit record");
    expect(Buffer.byteLength(injectionText, "utf8")).toBeLessThanOrEqual(
      INJECTION_MAX_BYTES,
    );
    expect(auditRecord.byteLength).toBe(Buffer.byteLength(injectionText, "utf8"));
    expect(auditRecord.byteCap).toBe(INJECTION_MAX_BYTES);
    expect(auditRecord.lineCap).toBe(INJECTION_MAX_LINES);
    expect(auditRecord.selectedLineCount).toBeGreaterThan(0);
    expect(auditRecord.selectedLineCount).toBeLessThan(INJECTION_MAX_LINES);
    expect(auditRecord.truncated).toBe(true);
  });
});

describe("reactive memory trigger", () => {
  test("gate fires on recall-intent cues", () => {
    const root = tempDir();
    writeIndex(root, []);
    const config = resolveRuntimeConfig({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root, PI_MEMORY_REACTIVE: "1" },
      homeDir: tempDir(),
    });

    const gate = buildReactiveMemoryGate({
      config,
      prompt: "What did we decide last time about releases?",
      ignored: false,
    });

    expect(gate.shouldFire).toBe(true);
    expect(gate.reason).toBe("recall-cue");
  });

  test("gate fires on high index overlap and skips on weak overlap", () => {
    const root = tempDir();
    writeIndex(root, ["- [Ralph loop](project_ralph-loop.md) — Ralph loop uses one test runner"]);
    const config = resolveRuntimeConfig({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root, PI_MEMORY_REACTIVE: "1" },
      homeDir: tempDir(),
    });

    const high = buildReactiveMemoryGate({
      config,
      prompt: "Ralph loop",
      ignored: false,
    });
    const weak = buildReactiveMemoryGate({
      config,
      prompt: "Ralph",
      ignored: false,
    });

    expect(high.shouldFire).toBe(true);
    expect(high.reason).toBe("index-overlap");
    expect(weak.shouldFire).toBe(false);
  });

  test("gated-in research synthesis supersedes index injection", async () => {
    const cwd = tempDir();
    const root = join(cwd, ".memory");
    mkdirSync(root);
    tmpRoots.push(root);
    writeIndex(root, ["- [Bun checks](project_bun.md) — index-only sentinel"]);
    const research = recordingResearch(foundResearch("Run bunx tsc and bun test."));
    const core = new MemoryExtensionCore({
      cwd,
      env: {
        PI_MEMORY_ROOT: ".memory",
        PI_MEMORY_REACTIVE: "1",
        PI_MEMORY_MODEL: DEFAULT_WORKER_MODEL,
        PI_MEMORY_RESEARCH_MODEL: "openai-codex/gpt-5.3-codex-spark",
      },
      research,
    });

    const result = await core.handleBeforeAgentStartAsync({
      prompt: "Remember the Bun checks?",
      systemPrompt: "base",
    });

    expect(research.calls).toHaveLength(1);
    expect(research.calls[0]?.env?.PI_MEMORY_ROOT).toBe(root);
    expect(research.calls[0]?.env?.PI_MEMORY_MODEL).toBe(DEFAULT_WORKER_MODEL);
    expect(research.calls[0]?.env?.PI_MEMORY_RESEARCH_MODEL).toBe(
      "openai-codex/gpt-5.3-codex-spark",
    );
    expect(result?.systemPrompt).toContain("Durable memory research");
    expect(result?.systemPrompt).toContain("Run bunx tsc and bun test.");
    expect(result?.systemPrompt).toContain("- project_bun.md");
    expect(result?.systemPrompt).not.toContain("index-only sentinel");
  });

  test("gated-out reactive mode falls back to index-only injection", async () => {
    const root = tempDir();
    writeIndex(root, ["- [Bun checks](project_bun.md) — index-only sentinel"]);
    const research = recordingResearch(foundResearch());
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root, PI_MEMORY_REACTIVE: "1" },
      research,
    });

    const result = await core.handleBeforeAgentStartAsync({
      prompt: "Bun",
      systemPrompt: "base",
    });

    expect(research.calls).toHaveLength(0);
    expect(result?.systemPrompt).toContain("Durable memory from memory-substrate");
    expect(result?.systemPrompt).toContain("index-only sentinel");
  });

  test("not-found research injects no synthesis and may fall back to index lines", async () => {
    const root = tempDir();
    writeIndex(root, ["- [Bun checks](project_bun.md) — index fallback sentinel"]);
    const research = recordingResearch({
      status: "not-found",
      found: false,
      answer: "No matching memory was found.",
      citations: [],
    });
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root, PI_MEMORY_REACTIVE: "1" },
      research,
    });

    const result = await core.handleBeforeAgentStartAsync({
      prompt: "Do you remember Bun checks?",
      systemPrompt: "base",
    });

    expect(research.calls).toHaveLength(1);
    expect(result?.systemPrompt).not.toContain("No matching memory was found.");
    expect(result?.systemPrompt).toContain("index fallback sentinel");
  });

  test("reactive flag off preserves index-only behavior without research", async () => {
    const root = tempDir();
    writeIndex(root, ["- [Bun checks](project_bun.md) — flag-off sentinel"]);
    const research = recordingResearch(foundResearch());
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root },
      research,
    });

    const result = await core.handleBeforeAgentStartAsync({
      prompt: "Remember Bun checks?",
      systemPrompt: "base",
    });

    expect(research.calls).toHaveLength(0);
    expect(result?.systemPrompt).toContain("flag-off sentinel");
    expect(result?.systemPrompt).not.toContain("Durable memory research");
  });

  test("disabled, ignore, and dry-run suppress reactive research", async () => {
    const root = tempDir();
    writeIndex(root, ["- [Bun checks](project_bun.md) — dry-run sentinel"]);
    const research = recordingResearch(foundResearch());
    const disabled = new MemoryExtensionCore({
      cwd: tempDir(),
      env: {
        PI_MEMORY_ROOT: root,
        PI_MEMORY_REACTIVE: "1",
        PI_MEMORY_ENABLED: "0",
      },
      research,
    });
    const ignored = new MemoryExtensionCore({
      cwd: tempDir(),
      env: {
        PI_MEMORY_ROOT: root,
        PI_MEMORY_REACTIVE: "1",
        PI_MEMORY_IGNORE: "1",
      },
      research,
    });
    const dryRun = new MemoryExtensionCore({
      cwd: tempDir(),
      env: {
        PI_MEMORY_ROOT: root,
        PI_MEMORY_REACTIVE: "1",
        PI_MEMORY_DRY_RUN: "1",
      },
      research,
    });

    expect(
      await disabled.handleBeforeAgentStartAsync({
        prompt: "Remember Bun checks?",
        systemPrompt: "base",
      }),
    ).toBeUndefined();
    expect(
      (
        await ignored.handleBeforeAgentStartAsync({
          prompt: "Remember Bun checks?",
          systemPrompt: "base",
        })
      )?.systemPrompt,
    ).toContain("Memory ignore mode is active");
    expect(
      await dryRun.handleBeforeAgentStartAsync({
        prompt: "Remember Bun checks?",
        systemPrompt: "base",
      }),
    ).toBeUndefined();
    expect(research.calls).toHaveLength(0);
  });

  test("one reactive turn fires research at most once", async () => {
    const root = tempDir();
    writeIndex(root, ["- [Bun checks](project_bun.md) — overlap sentinel"]);
    const research = recordingResearch(foundResearch());
    const core = new MemoryExtensionCore({
      cwd: tempDir(),
      env: { PI_MEMORY_ROOT: root, PI_MEMORY_REACTIVE: "1" },
      research,
    });

    await core.handleBeforeAgentStartAsync({
      prompt: "Remember Bun checks?",
      systemPrompt: "base",
    });

    expect(research.calls).toHaveLength(1);
  });
});
