import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import memorySubstrateExtension from "../adapters/pi-dev/extension/index.ts";
import {
  researchMemory,
  type MemoryResearchProcessExecutor,
  type MemoryResearchProcessOptions,
} from "../adapters/pi-dev/extension/research.ts";
import memoryResearchTools from "../adapters/pi-dev/extension/research-tools.ts";
import { DEFAULT_WORKER_MODEL } from "../adapters/pi-dev/extension/config.ts";

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

function writeTopic(root: string, path: string, name: string, description: string): void {
  writeFileSync(
    join(root, path),
    `---
name: ${name}
description: ${description}
metadata:
  type: project
---
${description}
`,
  );
  writeFileSync(join(root, "MEMORY.md"), `# Memory\n\n- [${description}](${path}) — ${description}\n`);
}

function recordingProcess(
  stdout: string,
): MemoryResearchProcessExecutor & {
  calls: Array<{ command: string; args: string[]; options: MemoryResearchProcessOptions }>;
} {
  const calls: Array<{
    command: string;
    args: string[];
    options: MemoryResearchProcessOptions;
  }> = [];
  const process: MemoryResearchProcessExecutor = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.some((arg) => arg.includes("reachability check"))) {
      return { code: 0, stdout: "OK", stderr: "", killed: false };
    }
    return { code: 0, stdout, stderr: "", killed: false };
  };
  return Object.assign(process, { calls });
}

describe("memory research sub-agent", () => {
  test("spawns a recursion-guarded read-only pi sub-agent and parses citations", async () => {
    const root = memoryRoot();
    writeTopic(root, "project_bun.md", "bun", "Bun is the project build command");
    const researchProcess = recordingProcess(
      JSON.stringify({
        found: true,
        answer: "Bun is the project build command.",
        citations: ["project_bun.md"],
      }),
    );

    const result = await researchMemory(
      {
        question: "What build command should be used?",
        cwd: tempDir(),
        env: { PI_MEMORY_ROOT: root },
      },
      { command: "pi", process: researchProcess },
    );

    expect(result.status).toBe("found");
    expect(result.found).toBe(true);
    expect(result.answer).toContain("Bun");
    expect(result.citations).toEqual(["project_bun.md"]);
    expect(researchProcess.calls).toHaveLength(2);

    const reachabilityCall = researchProcess.calls[0];
    expect(reachabilityCall?.args.join("\n")).toContain("reachability check");
    expect(reachabilityCall?.args.join("\n")).not.toContain("Question:");
    const call = researchProcess.calls[1];
    expect(call?.command).toBe("pi");
    expect(call?.options.cwd).toBe(root);
    expect(call?.options.env.PI_MEMORY_ENABLED).toBe("0");
    expect(call?.options.env.PI_MEMORY_ROOT).toBe(root);
    expect(call?.args).toContain("--print");
    expect(call?.args).toContain("--no-builtin-tools");
    expect(call?.args).toContain("--no-extensions");
    expect(call?.args).toContain("--extension");
    expect(call?.args.join("\n")).toContain("research-tools.ts");
    expect(call?.args).toContain("--no-context-files");
    expect(call?.args).toContain("--no-skills");
    expect(call?.args).toContain("--no-prompt-templates");
    expect(call?.args).toContain("--no-session");
    expect(call?.args).toContain("--tools");
    expect(call?.args).toContain("memory_index,memory_read,memory_grep,memory_list");
    expect(call?.args).not.toContain("read,grep,find,ls");
    expect(call?.args).not.toContain("--no-tools");
    expect(call?.args.join("\n")).not.toContain("write,edit");
    expect(call?.args).toContain(DEFAULT_WORKER_MODEL);
    expect(call?.args.at(-1)).toContain("These tools reject paths");
  });

  test("parses research JSON despite npm wrapper notices", async () => {
    const root = memoryRoot();
    writeTopic(root, "project_bun.md", "bun", "Bun is the project build command");
    const researchProcess = recordingProcess(`npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead
npm notice
npm notice New minor version of npm available! 11.12.1 -> 11.16.0
${JSON.stringify({
  found: true,
  answer: "Bun is the project build command.",
  citations: ["project_bun.md"],
})}
npm notice`);

    const result = await researchMemory(
      {
        question: "What build command should be used?",
        cwd: tempDir(),
        env: { PI_MEMORY_ROOT: root },
      },
      { process: researchProcess },
    );

    expect(result.status).toBe("found");
    expect(result.citations).toEqual(["project_bun.md"]);
    expect(researchProcess.calls[1]?.options.env.NPM_CONFIG_UPDATE_NOTIFIER).toBe(
      "false",
    );
    expect(researchProcess.calls[1]?.options.env.NPM_CONFIG_LOGLEVEL).toBe("error");
  });

  test("fails closed when research returns citations outside indexed topic files", async () => {
    const root = memoryRoot();
    writeTopic(root, "project_bun.md", "bun", "Bun is the project build command");
    const researchProcess = recordingProcess(
      JSON.stringify({
        found: true,
        answer: "Bun is the project build command.",
        citations: ["../outside.md"],
      }),
    );

    const result = await researchMemory(
      {
        question: "What build command should be used?",
        cwd: tempDir(),
        env: { PI_MEMORY_ROOT: root },
      },
      { process: researchProcess },
    );

    expect(result.status).toBe("failed");
    expect(result.found).toBe(false);
    expect(result.citations).toEqual([]);
    expect(result.error).toContain("invalid memory research citation");
  });

  test("honors not-found responses without inventing citations", async () => {
    const root = memoryRoot();
    const researchProcess = recordingProcess(
      JSON.stringify({
        found: false,
        answer: "No matching memory was found.",
        citations: [],
      }),
    );

    const result = await researchMemory(
      {
        question: "What does memory say about a missing topic?",
        cwd: tempDir(),
        env: { PI_MEMORY_ROOT: root },
      },
      { process: researchProcess },
    );

    expect(result.status).toBe("not-found");
    expect(result.found).toBe(false);
    expect(result.answer).toContain("No matching memory");
    expect(result.citations).toEqual([]);
  });

  test("fails before launch for an ambiguous model", async () => {
    const root = memoryRoot();
    const process = recordingProcess(JSON.stringify({ found: false, answer: "no", citations: [] }));

    const result = await researchMemory(
      {
        question: "What is stored?",
        cwd: tempDir(),
        env: { PI_MEMORY_ROOT: root, PI_MEMORY_RESEARCH_MODEL: "claude-haiku-4-5" },
      },
      { process },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("provider-qualified");
    expect(process.calls).toHaveLength(0);
  });

  test("disabled and ignore modes suppress research without a memory read", async () => {
    const root = memoryRoot();
    const process = recordingProcess(JSON.stringify({ found: false, answer: "no", citations: [] }));

    const disabled = await researchMemory(
      {
        question: "What is stored?",
        cwd: tempDir(),
        env: { PI_MEMORY_ROOT: root, PI_MEMORY_ENABLED: "0" },
      },
      { process },
    );
    const ignored = await researchMemory(
      {
        question: "What is stored?",
        cwd: tempDir(),
        env: { PI_MEMORY_ROOT: root, PI_MEMORY_IGNORE: "1" },
      },
      { process },
    );

    expect(disabled.status).toBe("disabled");
    expect(ignored.status).toBe("ignored");
    expect(process.calls).toHaveLength(0);
  });
});

describe("root-confined memory research tools", () => {
  test("read/search tools only expose markdown files inside PI_MEMORY_ROOT", async () => {
    const root = memoryRoot();
    const outside = tempDir();
    writeFileSync(join(outside, "outside.md"), "outside secret\n");
    writeTopic(root, "project_bun.md", "bun", "Bun is required");
    process.env.PI_MEMORY_ROOT = root;
    const tools = new Map<
      string,
      {
        execute(
          toolCallId: string,
          params: unknown,
          signal: unknown,
          onUpdate: unknown,
          ctx: unknown,
        ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
      }
    >();

    memoryResearchTools({
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
    });

    const index = await tools
      .get("memory_index")
      ?.execute("tool-1", {}, undefined, undefined, {});
    const grep = await tools
      .get("memory_grep")
      ?.execute("tool-2", { pattern: "Bun" }, undefined, undefined, {});
    const read = await tools
      .get("memory_read")
      ?.execute("tool-3", { path: "project_bun.md" }, undefined, undefined, {});

    expect(index?.content[0]?.text).toContain("project_bun.md");
    expect(grep?.content[0]?.text).toContain("project_bun.md");
    expect(read?.content[0]?.text).toContain("Bun is required");
    await expect(
      tools
        .get("memory_read")
        ?.execute("tool-4", { path: "../outside.md" }, undefined, undefined, {}),
    ).rejects.toThrow("escapes PI_MEMORY_ROOT");
    await expect(
      tools
        .get("memory_read")
        ?.execute("tool-5", { path: join(outside, "outside.md") }, undefined, undefined, {}),
    ).rejects.toThrow("must be relative");
  });
});

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

interface FakeTool {
  name: string;
  execute(
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: FakeContext,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
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

function fakePi(options: Parameters<typeof memorySubstrateExtension>[1] = {}) {
  const handlers = new Map<string, (event: unknown, ctx: FakeContext) => unknown>();
  const commands = new Map<string, FakeCommand>();
  const tools = new Map<string, FakeTool>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: FakeContext) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: FakeCommand) {
      commands.set(name, command);
    },
    registerTool(tool: FakeTool) {
      tools.set(tool.name, tool);
    },
  };
  memorySubstrateExtension(
    pi as unknown as Parameters<typeof memorySubstrateExtension>[0],
    options,
  );
  return { handlers, commands, tools };
}

describe("memory research extension surfaces", () => {
  test("memory-research command reports synthesis with citations", async () => {
    const root = memoryRoot();
    writeTopic(root, "project_bun.md", "bun", "Bun is required");
    process.env.PI_MEMORY_ROOT = root;
    const researchProcess = recordingProcess(
      JSON.stringify({
        found: true,
        answer: "Bun is required.",
        citations: ["project_bun.md"],
      }),
    );
    const { handlers, commands } = fakePi({ research: { process: researchProcess } });
    const ctx = fakeContext();

    handlers.get("session_start")?.({}, ctx);
    await commands.get("memory-research")?.handler("What command?", ctx);

    const notification = ctx.ui.notifications.at(-1);
    expect(notification?.level).toBe("success");
    expect(notification?.message).toContain("Bun is required.");
    expect(notification?.message).toContain("project_bun.md");
  });

  test("prompt-triggered ignore suppresses memory-research command until resumed", async () => {
    const root = memoryRoot();
    writeTopic(root, "project_bun.md", "bun", "Bun is required");
    process.env.PI_MEMORY_ROOT = root;
    const researchProcess = recordingProcess(
      JSON.stringify({
        found: true,
        answer: "Bun is required.",
        citations: ["project_bun.md"],
      }),
    );
    const { handlers, commands } = fakePi({ research: { process: researchProcess } });
    const ctx = fakeContext();

    handlers.get("session_start")?.({}, ctx);
    await handlers.get("before_agent_start")?.(
      { prompt: "Please ignore memory for this session.", systemPrompt: "base" },
      ctx,
    );
    await commands.get("memory-research")?.handler("What command?", ctx);

    expect(ctx.ui.notifications.at(-1)).toEqual({
      message: "memory research skipped: ignored",
      level: "info",
    });
    expect(researchProcess.calls).toHaveLength(0);

    commands.get("memory-resume")?.handler("", ctx);
    await commands.get("memory-research")?.handler("What command?", ctx);

    expect(ctx.ui.notifications.at(-1)?.message).toContain("Bun is required.");
    expect(researchProcess.calls).toHaveLength(2);
  });

  test("memory_research tool returns only synthesis and structured details", async () => {
    const root = memoryRoot();
    writeTopic(root, "project_worker.md", "worker", "Use the root-confined worker");
    process.env.PI_MEMORY_ROOT = root;
    const researchProcess = recordingProcess(
      JSON.stringify({
        found: true,
        answer: "Use the root-confined worker.",
        citations: ["project_worker.md"],
      }),
    );
    const { tools } = fakePi({ research: { process: researchProcess } });
    const ctx = fakeContext();

    const result = await tools
      .get("memory_research")
      ?.execute("tool-1", { question: "What worker?" }, undefined, undefined, ctx);

    expect(result?.content[0]?.text).toContain("Use the root-confined worker.");
    expect(result?.content[0]?.text).toContain("project_worker.md");
    expect(result?.details).toMatchObject({
      status: "found",
      found: true,
      citations: ["project_worker.md"],
    });
  });

  test("prompt-triggered ignore suppresses memory_research tool", async () => {
    const root = memoryRoot();
    writeTopic(root, "project_worker.md", "worker", "Use the root-confined worker");
    process.env.PI_MEMORY_ROOT = root;
    const researchProcess = recordingProcess(
      JSON.stringify({
        found: true,
        answer: "Use the root-confined worker.",
        citations: ["project_worker.md"],
      }),
    );
    const { handlers, tools } = fakePi({ research: { process: researchProcess } });
    const ctx = fakeContext();

    handlers.get("session_start")?.({}, ctx);
    await handlers.get("before_agent_start")?.(
      { prompt: "Do not use memory.", systemPrompt: "base" },
      ctx,
    );
    const result = await tools
      .get("memory_research")
      ?.execute("tool-1", { question: "What worker?" }, undefined, undefined, ctx);

    expect(result?.content[0]?.text).toBe("memory research skipped: ignored");
    expect(result?.details).toMatchObject({
      status: "ignored",
      found: false,
      citations: [],
    });
    expect(researchProcess.calls).toHaveLength(0);
  });
});
