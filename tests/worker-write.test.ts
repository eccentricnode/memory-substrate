import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKER_MODEL } from "../adapters/pi-dev/extension/config.ts";
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
    model: DEFAULT_WORKER_MODEL,
    dryRun,
    env: {
      PI_MEMORY_ENABLED: "0",
      PI_MEMORY_ROOT: root,
      PI_MEMORY_MODEL: DEFAULT_WORKER_MODEL,
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

function writeExistingMemory(root: string): void {
  writeFileSync(
    join(root, "project_stale-rule.md"),
    `---
name: stale-rule
description: Stale rule
metadata:
  type: project
---

Stale rule.
`,
  );
  writeFileSync(
    join(root, "MEMORY.md"),
    "# Memory\n\n- [Stale rule](project_stale-rule.md) — Stale rule\n",
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

  test("tool-only payloads do not become deterministic memory candidates", async () => {
    const root = memoryRoot();
    const worker = createDeterministicMemoryWorkerRunner();

    const result = await worker.run({
      ...request(root, "unused"),
      items: [
        {
          id: "item-tool-only",
          trigger: "agent_end",
          createdAt: 1,
          messageCount: 1,
          messages: [
            {
              role: "tool",
              content:
                "The durable decision is to never let tool output become memory.",
            },
          ],
        },
      ],
    });

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
    expect(index).toContain(`](${topics[0]}) — use Bun for all build and test commands`);

    const runRecord = state.entries.find(
      (entry) => entry.type === "memory-substrate-worker-run",
    )?.data as { status?: string; validatorResult?: { exitCode: number } } | undefined;
    expect(runRecord?.status).toBe("completed");
    expect(runRecord?.validatorResult?.exitCode).toBe(0);
  });

  test("compaction preparation summary can drive a deterministic memory write", async () => {
    const root = memoryRoot();
    const worker = createDeterministicMemoryWorkerRunner();
    const result = await worker.run({
      ...request(root, "unused"),
      items: [
        {
          id: "item-compact",
          trigger: "session_before_compact",
          createdAt: 1,
          messageCount: 1,
          messages: [
            {
              preparation: {
                summary:
                  "The durable decision is to preserve compaction preparation as candidate content.",
              },
            },
          ],
        },
      ],
    });

    expect(result.exitCode).toBe(0);
    const topics = topicFiles(root);
    expect(topics).toHaveLength(1);
    expect(readFileSync(join(root, topics[0] ?? ""), "utf8")).toContain(
      "preserve compaction preparation as candidate content",
    );
    const pointer = readFileSync(join(root, "MEMORY.md"), "utf8")
      .split(/\r?\n/)
      .find((line) => line.startsWith("- ["));
    expect(pointer?.length).toBeLessThanOrEqual(150);
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

  test("description keyword match updates an existing memory instead of duplicating", async () => {
    const root = memoryRoot();
    writeFileSync(
      join(root, "project_bun-commands.md"),
      `---
name: bun-commands
description: Use Bun commands for project automation
metadata:
  type: project
---

Use Bun commands for project automation.
`,
    );
    writeFileSync(
      join(root, "MEMORY.md"),
      "# Memory\n\n- [Bun commands](project_bun-commands.md) — Use Bun commands for project automation\n",
    );
    const worker = createDeterministicMemoryWorkerRunner();

    const result = await worker.run(
      request(
        root,
        "The durable decision is to use Bun for all build and test commands.",
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(topicFiles(root)).toEqual(["project_bun-commands.md"]);
    const topic = readFileSync(join(root, "project_bun-commands.md"), "utf8");
    expect(topic).toContain("name: bun-commands");
    expect(topic).toContain("use Bun for all build and test commands");
    const indexEntries = readFileSync(join(root, "MEMORY.md"), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("- ["));
    expect(indexEntries).toHaveLength(1);
    expect(indexEntries[0]).toContain("](project_bun-commands.md) — use Bun");
    expect(result.changedPaths?.some((path) =>
      path.endsWith("project_bun-commands.md"),
    )).toBe(true);
  });

  test("flat type frontmatter is not trusted for dedupe", async () => {
    const root = memoryRoot();
    writeFileSync(
      join(root, "project_bun-commands.md"),
      `---
name: bun-commands
description: Use Bun commands for project automation
type: feedback
---

Historical flat frontmatter should not steer worker dedupe.
`,
    );
    writeFileSync(
      join(root, "MEMORY.md"),
      "# Memory\n\n- [Bun commands](project_bun-commands.md) — Use Bun commands for project automation\n",
    );
    const beforeInvalidTopic = readFileSync(
      join(root, "project_bun-commands.md"),
      "utf8",
    );
    const worker = createDeterministicMemoryWorkerRunner({
      validate: async () => ({ exitCode: 0, stdout: "ok" }),
    });

    const result = await worker.run(
      request(
        root,
        "The durable decision is to use Bun for all build and test commands.",
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "project_bun-commands.md"), "utf8")).toBe(
      beforeInvalidTopic,
    );
    expect(topicFiles(root)).toContain(
      "project_use-bun-for-all-build-and-test-commands.md",
    );
    expect(result.changedPaths?.some((path) =>
      path.endsWith("project_bun-commands.md"),
    )).toBe(false);
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
    expect(result.stdout).toContain("proposed paths:");
    expect(result.stdout).toContain("- MEMORY.md");
    expect(result.stdout).toContain("- project_use-bun-for-all-build-and-test-commands.md");
    expect(result.stdout).toContain("--- project_use-bun-for-all-build-and-test-commands.md ---");
    expect(result.stdout).toContain("metadata:\n  type: project");
    expect(result.stdout).toContain("--- MEMORY.md ---");
    expect(result.stdout).toContain(
      "- [Use Bun For All Build And Test Commands](project_use-bun-for-all-build-and-test-commands.md) — use Bun for all build and test commands",
    );
    expect(result.proposedPaths?.some((path) => path.endsWith("MEMORY.md"))).toBe(
      true,
    );
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(before);
  });

  test("dry-run validates proposed memory with the reference validator", async () => {
    const root = memoryRoot();
    const before = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          type: "project",
          name: "broken-link-proposal",
          description: "Broken link proposal",
          body: "Broken link proposal\n\n**Why:** Dry-run must catch validator-only failures like [missing](missing.md).\n\n**How to apply:** Reject invalid proposals before showing proposed stdout.",
          hook: "Broken link proposal",
          title: "Broken link proposal",
          relativePath: "project_broken-link-proposal.md",
        },
      ],
    });

    const result = await worker.run(
      request(root, "The durable decision is broken link proposal.", true),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("validator failed for dry-run proposal");
    expect(result.stdout).toBeUndefined();
    expect(result.validator?.exitCode).toBe(1);
    expect(
      [result.validator?.stdout, result.validator?.stderr].filter(Boolean).join("\n"),
    ).toContain("broken link: missing.md");
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(before);
  });

  test("missing MEMORY.md is refused before live write planning", async () => {
    const root = tempDir();
    const worker = createDeterministicMemoryWorkerRunner();

    const result = await worker.run(
      request(root, "The durable decision is to refuse implicit index creation."),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("memory index does not exist");
    expect(topicFiles(root)).toEqual([]);
    expect(existsSync(join(root, "MEMORY.md"))).toBe(false);
  });

  test("missing MEMORY.md is refused before dry-run proposals", async () => {
    const root = tempDir();
    const worker = createDeterministicMemoryWorkerRunner();

    const result = await worker.run(
      request(
        root,
        "The durable decision is to refuse dry-run implicit index creation.",
        true,
      ),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("memory index does not exist");
    expect(result.stdout).toBeUndefined();
    expect(topicFiles(root)).toEqual([]);
    expect(existsSync(join(root, "MEMORY.md"))).toBe(false);
  });

  test("delete draft removes stale topic file and index pointer", async () => {
    const root = memoryRoot();
    writeExistingMemory(root);
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          action: "delete",
          relativePath: "project_stale-rule.md",
          description: "stale rule contradicted by current user correction",
        },
      ],
    });

    const result = await worker.run(request(root, "Correction: stale rule is wrong."));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("applied 1 memory change");
    expect(existsSync(join(root, "project_stale-rule.md"))).toBe(false);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).not.toContain(
      "project_stale-rule.md",
    );
    expect(result.changedPaths?.some((path) => path.endsWith("MEMORY.md"))).toBe(
      true,
    );
    expect(result.changedPaths?.some((path) =>
      path.endsWith("project_stale-rule.md"),
    )).toBe(true);
    expect(result.validator?.exitCode).toBe(0);
  });

  test("delete dry-run reports proposed removal and writes nothing", async () => {
    const root = memoryRoot();
    writeExistingMemory(root);
    const beforeTopic = readFileSync(join(root, "project_stale-rule.md"), "utf8");
    const beforeIndex = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          action: "delete",
          relativePath: "project_stale-rule.md",
          description: "dry-run stale removal",
        },
      ],
    });

    const result = await worker.run(
      request(root, "Correction: stale rule is wrong.", true),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dry-run");
    expect(result.stdout).toContain("0 memory write(s), 1 memory delete(s)");
    expect(result.stdout).toContain("proposed deletes:");
    expect(result.stdout).toContain("- project_stale-rule.md: dry-run stale removal");
    expect(result.stdout).toContain("--- MEMORY.md ---");
    expect(result.stdout).not.toContain(
      "- [Stale rule](project_stale-rule.md) — Stale rule",
    );
    expect(readFileSync(join(root, "project_stale-rule.md"), "utf8")).toBe(
      beforeTopic,
    );
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(beforeIndex);
  });

  test("delete draft refuses unindexed markdown files", async () => {
    const root = memoryRoot();
    writeFileSync(
      join(root, "project_unindexed-rule.md"),
      `---
name: unindexed-rule
description: Unindexed rule
metadata:
  type: project
---

Unindexed rule.
`,
    );
    const beforeTopic = readFileSync(join(root, "project_unindexed-rule.md"), "utf8");
    const beforeIndex = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          action: "delete",
          relativePath: "project_unindexed-rule.md",
          description: "unindexed stale removal",
        },
      ],
    });

    const result = await worker.run(request(root, "Correction: stale rule is wrong."));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not indexed in MEMORY.md");
    expect(readFileSync(join(root, "project_unindexed-rule.md"), "utf8")).toBe(
      beforeTopic,
    );
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(beforeIndex);
  });

  test("delete draft refuses invalid topic frontmatter", async () => {
    const root = memoryRoot();
    writeFileSync(
      join(root, "project_invalid-rule.md"),
      `---
name: invalid-rule
description: Invalid rule
type: project
---

Invalid rule.
`,
    );
    writeFileSync(
      join(root, "MEMORY.md"),
      "# Memory\n\n- [Invalid rule](project_invalid-rule.md) — Invalid rule\n",
    );
    const beforeTopic = readFileSync(join(root, "project_invalid-rule.md"), "utf8");
    const beforeIndex = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          action: "delete",
          relativePath: "project_invalid-rule.md",
          description: "invalid stale removal",
        },
      ],
    });

    const result = await worker.run(request(root, "Correction: stale rule is wrong."));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not a valid topic memory");
    expect(readFileSync(join(root, "project_invalid-rule.md"), "utf8")).toBe(
      beforeTopic,
    );
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(beforeIndex);
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

  test("absolute topic paths are refused before writing even inside the memory root", async () => {
    const root = memoryRoot();
    const before = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          type: "project",
          description: "absolute path attempt",
          body: "absolute path attempt",
          relativePath: join(root, "project_absolute-path-attempt.md"),
        },
      ],
    });

    const result = await worker.run(request(root, "The durable decision is absolute."));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("relativePath must be relative");
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(before);
  });

  test("worker-supplied relative paths must use the pi-dev topic filename convention", async () => {
    const root = memoryRoot();
    const before = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          type: "project",
          name: "filename-contract",
          description: "filename contract",
          body: "filename contract",
          relativePath: "custom_filename-contract.md",
        },
      ],
    });

    const result = await worker.run(request(root, "The durable decision is filename."));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "memory relativePath filename must be project_filename-contract.md",
    );
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(before);
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

  test("canonicalizes in-root relative paths before indexing", async () => {
    const root = memoryRoot();
    mkdirSync(join(root, "nested"));
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          type: "project",
          name: "canonical-topic",
          description: "canonical topic",
          body: "canonical topic\n\n**Why:** Keeps index pointers stable.\n\n**How to apply:** Use the canonical path.",
          relativePath: "nested/../project_canonical-topic.md",
        },
      ],
    });

    const result = await worker.run(request(root, "The durable decision is canonical."));

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, "project_canonical-topic.md"))).toBe(true);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toContain(
      "](project_canonical-topic.md) — canonical topic",
    );
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).not.toContain(
      "nested/../project_canonical-topic.md",
    );
  });

  test("refuses index line cap overflow before writing topic files", async () => {
    const root = memoryRoot();
    writeFileSync(
      join(root, "MEMORY.md"),
      `${Array.from({ length: 149 }, (_, i) =>
        i === 0 ? "# Memory" : `## Existing ${i}`,
      ).join("\n")}\n`,
    );
    const before = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          type: "project",
          description: "would exceed line cap",
          body:
            "would exceed line cap\n\n**Why:** The adapter must reject over-cap indexes before writing.\n\n**How to apply:** Keep index planning bounded.",
        },
      ],
    });

    const result = await worker.run(request(root, "The durable decision is line cap."));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("MEMORY.md would exceed 150-line cap");
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(before);
  });

  test("refuses index byte cap overflow before writing topic files", async () => {
    const root = memoryRoot();
    writeFileSync(join(root, "MEMORY.md"), `# Memory\n\n${"x".repeat(25 * 1024)}\n`);
    const before = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          type: "project",
          description: "would exceed byte cap",
          body:
            "would exceed byte cap\n\n**Why:** The adapter must reject over-cap indexes before writing.\n\n**How to apply:** Keep index planning bounded.",
        },
      ],
    });

    const result = await worker.run(request(root, "The durable decision is byte cap."));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("MEMORY.md would exceed 25600-byte cap");
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(before);
  });

  test("refuses over-cap rendered pointer lines before writing topic files", async () => {
    const root = memoryRoot();
    const before = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          type: "project",
          name: "this-topic-name-is-long-enough-to-make-the-index-pointer-overflow",
          title:
            "This title is also intentionally long enough to overflow before hook text is added",
          description: "pointer line overflow",
          body: "pointer line overflow",
          hook: "this hook fits its own cap but not the full rendered pointer line",
          relativePath:
            "project_this-topic-name-is-long-enough-to-make-the-index-pointer-overflow.md",
        },
      ],
    });

    const result = await worker.run(
      request(root, "The durable decision is pointer line overflow."),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "MEMORY.md pointer prefix would exceed 150-character cap",
    );
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(before);
  });

  test("dry-run refuses over-cap rendered pointer lines without proposed output", async () => {
    const root = memoryRoot();
    const before = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          type: "project",
          name: "dry-run-pointer-line-overflow-for-active-adapter-cap",
          title:
            "Dry run pointer line overflow for active adapter cap before hook text is added",
          description: "dry-run pointer line overflow",
          body: "dry-run pointer line overflow",
          hook: "this hook fits its own cap but not the full rendered pointer line",
          relativePath: "project_dry-run-pointer-line-overflow-for-active-adapter-cap.md",
        },
      ],
    });

    const result = await worker.run(
      request(root, "The durable decision is dry-run pointer line overflow.", true),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pointer prefix would exceed 150-character cap");
    expect(result.stdout).toBeUndefined();
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(before);
  });

  test("validator failure rolls back the attempted two-step write", async () => {
    const root = memoryRoot();
    const before = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          type: "project",
          description: "invalid after write",
          body:
            "invalid after write\n\n**Why:** This test exercises validator rollback after mutation.\n\n**How to apply:** Restore all affected files when validation fails.",
          relativePath: "nested/project_invalid-after-write.md",
        },
      ],
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
    expect(result.stderr).toContain("rolled back");
    expect(result.stdout).toContain("rolled back");
    expect(result.changedPaths).toEqual([]);
    expect(result.proposedPaths?.some((path) => path.endsWith("MEMORY.md"))).toBe(true);
    expect(result.validator?.exitCode).toBe(1);
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(before);
    expect(existsSync(join(root, "nested"))).toBe(false);
  });

  test("validator failure restores an existing topic and index entry", async () => {
    const root = memoryRoot();
    writeFileSync(
      join(root, "project_existing-rule.md"),
      `---
name: existing-rule
description: Existing rule
metadata:
  type: project
---

Existing rule.
`,
    );
    writeFileSync(
      join(root, "MEMORY.md"),
      "# Memory\n\n- [Existing rule](project_existing-rule.md) — Existing rule\n",
    );
    const beforeTopic = readFileSync(join(root, "project_existing-rule.md"), "utf8");
    const beforeIndex = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          type: "project",
          name: "existing-rule",
          description: "Updated rule",
          body: "Updated rule\n\n**Why:** Test rollback.\n\n**How to apply:** Keep the old value when validation fails.",
          hook: "Updated rule",
          relativePath: "project_existing-rule.md",
        },
      ],
      validate: async () => ({
        exitCode: 1,
        stderr: "validator found errors",
      }),
    });

    const result = await worker.run(request(root, "The durable decision is update."));

    expect(result.exitCode).toBe(1);
    expect(readFileSync(join(root, "project_existing-rule.md"), "utf8")).toBe(
      beforeTopic,
    );
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(beforeIndex);
  });

  test("validator failure restores a deleted topic and index entry", async () => {
    const root = memoryRoot();
    writeExistingMemory(root);
    const beforeTopic = readFileSync(join(root, "project_stale-rule.md"), "utf8");
    const beforeIndex = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          action: "delete",
          relativePath: "project_stale-rule.md",
          description: "delete rollback",
        },
      ],
      validate: async () => ({
        exitCode: 1,
        stderr: "validator found errors",
      }),
    });

    const result = await worker.run(request(root, "Correction: stale rule is wrong."));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("rolled back");
    expect(readFileSync(join(root, "project_stale-rule.md"), "utf8")).toBe(
      beforeTopic,
    );
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(beforeIndex);
  });

  test("unknown draft actions are refused before mutation", async () => {
    const root = memoryRoot();
    const before = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          action: "rename",
          type: "project",
          description: "unknown action",
          body:
            "unknown action\n\n**Why:** Unknown actions cannot be mapped to a safe applicator operation.\n\n**How to apply:** Refuse the whole batch.",
        } as never,
      ],
    });

    const result = await worker.run(request(root, "The durable decision is unknown."));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid memory draft action");
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(before);
  });

  test("markdown descriptions are refused before mutation", async () => {
    const root = memoryRoot();
    const before = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          type: "project",
          description: "**markdown** description",
          body:
            "markdown description\n\n**Why:** Frontmatter descriptions are one-line plain text.\n\n**How to apply:** Refuse markdown before writing.",
        },
      ],
    });

    const result = await worker.run(request(root, "The durable decision is markdown."));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("description must not contain markdown");
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(before);
  });

  test("over-cap descriptions are refused instead of truncated", async () => {
    const root = memoryRoot();
    const before = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          type: "project",
          description: "x".repeat(201),
          body:
            "over-cap description\n\n**Why:** Worker drafts must satisfy the contract before writing.\n\n**How to apply:** Refuse malformed drafts instead of silently fitting them.",
          hook: "over-cap description",
        },
      ],
    });

    const result = await worker.run(
      request(root, "The durable decision is over-cap description."),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("description must be <=200 characters");
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(before);
  });

  test("delete markdown descriptions are refused before mutation", async () => {
    const root = memoryRoot();
    writeExistingMemory(root);
    const beforeTopic = readFileSync(join(root, "project_stale-rule.md"), "utf8");
    const beforeIndex = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          action: "delete",
          relativePath: "project_stale-rule.md",
          description: "**stale** memory",
        },
      ],
    });

    const result = await worker.run(request(root, "Correction: stale rule is wrong."));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reason must not contain markdown");
    expect(readFileSync(join(root, "project_stale-rule.md"), "utf8")).toBe(
      beforeTopic,
    );
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(beforeIndex);
  });

  test("over-cap delete reasons are refused instead of truncated", async () => {
    const root = memoryRoot();
    writeExistingMemory(root);
    const beforeTopic = readFileSync(join(root, "project_stale-rule.md"), "utf8");
    const beforeIndex = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          action: "delete",
          relativePath: "project_stale-rule.md",
          description: "x".repeat(201),
        },
      ],
    });

    const result = await worker.run(request(root, "Correction: stale rule is wrong."));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("delete reason must be <=200 characters");
    expect(readFileSync(join(root, "project_stale-rule.md"), "utf8")).toBe(
      beforeTopic,
    );
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(beforeIndex);
  });

  test("project and feedback drafts require why and how body sections", async () => {
    const root = memoryRoot();
    const before = readFileSync(join(root, "MEMORY.md"), "utf8");
    const worker = createDeterministicMemoryWorkerRunner({
      decideWrites: () => [
        {
          type: "project",
          description: "missing rationale sections",
          body: "missing rationale sections",
        },
      ],
    });

    const result = await worker.run(request(root, "The durable decision is body shape."));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must include **Why:** and **How to apply:**");
    expect(topicFiles(root)).toEqual([]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(before);
  });
});
