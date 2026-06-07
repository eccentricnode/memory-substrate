import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLivePiMemoryWorkerRunner,
  type LivePiProcessExecutor,
  type LivePiProcessOptions,
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

function request(root: string, dryRun = false): MemoryWorkerRequest {
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
    expect(process.calls).toHaveLength(1);
    const call = process.calls[0];
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
    expect(call?.args).toContain("claude-haiku-4-5");
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
    expect(process.calls[0]?.options.env.PI_MEMORY_DRY_RUN).toBe("1");
    expect(result.proposedPaths?.some((path) => path.endsWith("MEMORY.md"))).toBe(
      true,
    );
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe("# Memory\n");
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
      return { code: 7, stdout: "", stderr: "model unavailable", killed: false };
    };
    const worker = createLivePiMemoryWorkerRunner({ process });

    const result = await worker.run(request(root));

    expect(calls).toHaveLength(1);
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("model unavailable");
    expect(topicFiles(root)).toEqual([]);
  });
});
