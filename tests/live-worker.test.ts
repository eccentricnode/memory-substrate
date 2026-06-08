import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKER_MODEL } from "../adapters/pi-dev/extension/config.ts";
import {
  createLivePiMemoryWorkerRunner,
  type LivePiProcessExecutor,
  type LivePiProcessOptions,
  type MemoryWorkerRequest,
} from "../adapters/pi-dev/extension/worker.ts";

const tmpRoots: string[] = [];
const MODEL_REGISTRY = `provider      model                       context  max-out  thinking  images
openai-codex  gpt-5.3-codex-spark         128K     128K     yes       no
anthropic     claude-haiku-4-5            200K     64K      yes       yes
oc-sdk-zen    claude-haiku-4-5            200K     64K      yes       yes
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

function request(
  root: string,
  dryRun = false,
  model = DEFAULT_WORKER_MODEL,
): MemoryWorkerRequest {
  return {
    batchId: "batch-1",
    cwd: tempDir(),
    memoryRoot: root,
    model,
    dryRun,
    env: {
      PI_MEMORY_ENABLED: "0",
      PI_MEMORY_ROOT: root,
      PI_MEMORY_MODEL: model,
      PI_MEMORY_DRY_RUN: dryRun ? "1" : "0",
    },
    items: [
      {
        id: "item-1",
        trigger: "agent_end",
        createdAt: 1,
        messageCount: 1,
        messages: [
          "The durable decision is to keep live memory writes root-confined.",
        ],
      },
    ],
  };
}

function topicFiles(root: string): string[] {
  return readdirSync(root).filter(
    (entry) => entry.endsWith(".md") && entry !== "MEMORY.md",
  );
}

function writeExistingMemory(root: string): void {
  writeFileSync(
    join(root, "project_stale-live-rule.md"),
    `---
name: stale-live-rule
description: Stale live rule
metadata:
  type: project
---

Stale live rule.
`,
  );
  writeFileSync(
    join(root, "MEMORY.md"),
    "# Memory\n\n- [Stale live rule](project_stale-live-rule.md) — Stale live rule\n",
  );
}

function recordingProcess(
  stdout: string,
): LivePiProcessExecutor & {
  calls: Array<{ command: string; args: string[]; options: LivePiProcessOptions }>;
} {
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
    if (args.some((arg) => arg.includes("reachability check"))) {
      return { code: 0, stdout: "OK", stderr: "", killed: false };
    }
    return { code: 0, stdout, stderr: "", killed: false };
  };
  return Object.assign(process, { calls });
}

describe("live pi memory worker runner", () => {
  test("spawns pi with recursion guard env and applies structured drafts safely", async () => {
    const root = memoryRoot();
    const process = recordingProcess(
      JSON.stringify({
        drafts: [
          {
            type: "project",
            description: "keep live memory writes root-confined",
            body:
              "keep live memory writes root-confined\n\n**Why:** Direct model file tools cannot be mechanically confined by pi today.\n\n**How to apply:** Return drafts and let the extension perform the two-step save.",
            hook: "keep live memory writes root-confined",
            title: "Live Memory Root Confined",
            name: "live-memory-root-confined",
            relativePath: "project_live-memory-root-confined.md",
          },
        ],
      }),
    );
    const worker = createLivePiMemoryWorkerRunner({
      command: "pi",
      process,
      validate: async () => ({ exitCode: 0, stdout: "ok" }),
    });

    const result = await worker.run(request(root));

    expect(result.exitCode).toBe(0);
    expect(process.calls).toHaveLength(3);
    expect(process.calls[0]?.args).toEqual(["--list-models"]);
    const reachabilityCall = process.calls[1];
    expect(reachabilityCall?.args).toContain("--print");
    expect(reachabilityCall?.args).toContain("--no-tools");
    expect(reachabilityCall?.args).toContain(DEFAULT_WORKER_MODEL);
    expect(reachabilityCall?.args.join("\n")).toContain("reachability check");
    expect(reachabilityCall?.args.join("\n")).not.toContain("Candidate batch");
    const call = process.calls[2];
    expect(call?.command).toBe("pi");
    expect(call?.options.cwd).toBe(root);
    expect(call?.options.env.PI_MEMORY_ENABLED).toBe("0");
    expect(call?.options.env.PI_MEMORY_ROOT).toBe(root);
    expect(call?.args).toContain("--print");
    expect(call?.args).toContain("--no-extensions");
    expect(call?.args).toContain("--no-context-files");
    expect(call?.args).toContain("--no-skills");
    expect(call?.args).toContain("--no-prompt-templates");
    expect(call?.args).toContain("--no-session");
    expect(call?.args).toContain("--no-tools");
    expect(call?.args).toContain(DEFAULT_WORKER_MODEL);
    expect(result.changedPaths?.some((path) => path.endsWith("MEMORY.md"))).toBe(
      true,
    );
    expect(topicFiles(root)).toHaveLength(1);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toContain(
      "project_live-memory-root-confined.md",
    );
  });

  test("dry-run invokes the live model but reports proposed paths without writing", async () => {
    const root = memoryRoot();
    const process = recordingProcess(
      JSON.stringify({
        drafts: [
          {
            type: "project",
            description: "dry-run memory write",
            body:
              "dry-run memory write\n\n**Why:** Operators need a no-mutation check.\n\n**How to apply:** Inspect proposed paths before enabling live writes.",
            hook: "dry-run memory write",
            title: "Dry Run Memory Write",
            name: "dry-run-memory-write",
            relativePath: "project_dry-run-memory-write.md",
          },
        ],
      }),
    );
    const worker = createLivePiMemoryWorkerRunner({ process });

    const result = await worker.run(request(root, true));

    expect(result.exitCode).toBe(0);
    expect(process.calls[2]?.options.env.PI_MEMORY_DRY_RUN).toBe("1");
    expect(result.stdout).toContain("proposed paths:");
    expect(result.stdout).toContain("- MEMORY.md");
    expect(result.stdout).toContain("- project_dry-run-memory-write.md");
    expect(result.stdout).toContain("--- project_dry-run-memory-write.md ---");
    expect(result.stdout).toContain("dry-run memory write");
    expect(result.stdout).toContain("--- MEMORY.md ---");
    expect(result.proposedPaths?.some((path) => path.endsWith("MEMORY.md"))).toBe(
      true,
    );
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe("# Memory\n");
  });

  test("applies live delete drafts through the safe applicator", async () => {
    const root = memoryRoot();
    writeExistingMemory(root);
    const process = recordingProcess(
      JSON.stringify({
        drafts: [
          {
            action: "delete",
            relativePath: "project_stale-live-rule.md",
            description: "stale live rule contradicted by the batch",
          },
        ],
      }),
    );
    const worker = createLivePiMemoryWorkerRunner({
      process,
      validate: async () => ({ exitCode: 0, stdout: "ok" }),
    });

    const result = await worker.run(request(root));

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, "project_stale-live-rule.md"))).toBe(false);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).not.toContain(
      "project_stale-live-rule.md",
    );
    expect(result.changedPaths?.some((path) =>
      path.endsWith("project_stale-live-rule.md"),
    )).toBe(true);
  });

  test("malformed live worker output fails without writing", async () => {
    const root = memoryRoot();
    const process = recordingProcess("not json");
    const worker = createLivePiMemoryWorkerRunner({ process });

    const result = await worker.run(request(root));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("JSON");
    expect(topicFiles(root)).toEqual([]);
  });

  test("fenced live worker JSON fails without writing", async () => {
    const root = memoryRoot();
    const process = recordingProcess(
      `\`\`\`json
${JSON.stringify({ drafts: [] })}
\`\`\``,
    );
    const worker = createLivePiMemoryWorkerRunner({ process });

    const result = await worker.run(request(root));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("exactly one JSON object");
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe("# Memory\n");
  });

  test("surrounded live worker JSON fails without writing", async () => {
    const root = memoryRoot();
    const process = recordingProcess(
      `Here is the structured response:\n${JSON.stringify({ drafts: [] })}`,
    );
    const worker = createLivePiMemoryWorkerRunner({ process });

    const result = await worker.run(request(root));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("exactly one JSON object");
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe("# Memory\n");
  });

  test("live upsert drafts must carry the full structured contract", async () => {
    const root = memoryRoot();
    const process = recordingProcess(
      JSON.stringify({
        drafts: [
          {
            type: "project",
            description: "missing structured fields",
            body:
              "missing structured fields\n\n**Why:** This should fail before writing.\n\n**How to apply:** Reject the malformed draft.",
          },
        ],
      }),
    );
    const worker = createLivePiMemoryWorkerRunner({ process });

    const result = await worker.run(request(root));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing required upsert fields");
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe("# Memory\n");
  });

  test("live project drafts must carry why and how body sections", async () => {
    const root = memoryRoot();
    const process = recordingProcess(
      JSON.stringify({
        drafts: [
          {
            type: "project",
            description: "bad body shape",
            body: "bad body shape without rationale",
            hook: "bad body shape",
            title: "Bad Body Shape",
            name: "bad-body-shape",
            relativePath: "project_bad-body-shape.md",
          },
        ],
      }),
    );
    const worker = createLivePiMemoryWorkerRunner({ process });

    const result = await worker.run(request(root));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must include **Why:** and **How to apply:**");
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe("# Memory\n");
  });

  test("unreachable authenticated model fails before the worker prompt", async () => {
    const root = memoryRoot();
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
    const worker = createLivePiMemoryWorkerRunner({ process });

    const result = await worker.run(request(root));

    expect(calls).toHaveLength(2);
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("third-party usage disabled");
    expect(calls[1]?.args.join("\n")).toContain("reachability check");
    expect(calls[1]?.args.join("\n")).not.toContain("Candidate batch");
    expect(topicFiles(root)).toEqual([]);
  });

  test("nonzero live worker prompt result is surfaced without applying writes", async () => {
    const root = memoryRoot();
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
      if (args.some((arg) => arg.includes("reachability check"))) {
        return { code: 0, stdout: "OK", stderr: "", killed: false };
      }
      return { code: 7, stdout: "", stderr: "model unavailable", killed: false };
    };
    const worker = createLivePiMemoryWorkerRunner({ process });

    const result = await worker.run(request(root));

    expect(calls).toHaveLength(3);
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("model unavailable");
    expect(topicFiles(root)).toEqual([]);
  });

  test("bare or ambiguous model fails preflight before the worker prompt", async () => {
    const root = memoryRoot();
    const process = recordingProcess(JSON.stringify({ drafts: [] }));
    const worker = createLivePiMemoryWorkerRunner({ process });

    const result = await worker.run(request(root, false, "claude-haiku-4-5"));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("provider-qualified");
    expect(result.stderr).toContain("anthropic");
    expect(result.stderr).toContain("oc-sdk-zen");
    expect(process.calls).toHaveLength(1);
    expect(process.calls[0]?.args).toEqual(["--list-models"]);
    expect(topicFiles(root)).toEqual([]);
  });

  test("absent provider-qualified model fails preflight before the worker prompt", async () => {
    const root = memoryRoot();
    const process = recordingProcess(JSON.stringify({ drafts: [] }));
    const worker = createLivePiMemoryWorkerRunner({ process });

    const result = await worker.run(
      request(root, false, "openai-codex/missing-model"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not present in pi --list-models");
    expect(process.calls).toHaveLength(1);
    expect(process.calls[0]?.args).toEqual(["--list-models"]);
    expect(topicFiles(root)).toEqual([]);
  });
});
