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
            name: "live-memory-root-confined",
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
    expect(process.calls).toHaveLength(2);
    expect(process.calls[0]?.args).toEqual(["--list-models"]);
    const call = process.calls[1];
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
          },
        ],
      }),
    );
    const worker = createLivePiMemoryWorkerRunner({ process });

    const result = await worker.run(request(root, true));

    expect(result.exitCode).toBe(0);
    expect(process.calls[1]?.options.env.PI_MEMORY_DRY_RUN).toBe("1");
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

  test("nonzero live process result is surfaced without applying writes", async () => {
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
      return { code: 7, stdout: "", stderr: "model unavailable", killed: false };
    };
    const worker = createLivePiMemoryWorkerRunner({ process });

    const result = await worker.run(request(root));

    expect(calls).toHaveLength(2);
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
