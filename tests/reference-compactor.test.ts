import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compactMemoryDirectory } from "../reference/compactor.ts";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-compactor-test-"));
  tmpRoots.push(dir);
  return dir;
}

function writeTopic(
  root: string,
  relativePath: string,
  frontmatterName: string,
  description: string,
  type = "project",
): void {
  const path = join(root, relativePath);
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(
    path,
    `---
name: ${frontmatterName}
description: ${description}
metadata:
  type: ${type}
---

${description}
`,
  );
}

describe("reference compactor", () => {
  test("writes a reviewable proposal without mutating the memory root", () => {
    const root = tempDir();
    const outputDir = join(tempDir(), "proposal");
    writeTopic(root, "project_bun-commands.md", "bun-commands", "Use Bun for build and test commands");
    writeTopic(root, "feedback_review-first.md", "review-first", "Review existing source before changing behavior", "feedback");
    const originalIndex = `# Memory

## Existing
- [Bun commands](project_bun-commands.md) — ${"Use Bun for build and test commands".repeat(6)}
- [Duplicate Bun](project_bun-commands.md) — duplicate pointer
- [Broken](missing.md) — stale pointer
`;
    writeFileSync(join(root, "MEMORY.md"), originalIndex);

    const report = compactMemoryDirectory(root, { outputDir });

    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(originalIndex);
    expect(existsSync(join(root, "COMPACTION_REPORT.md"))).toBe(false);
    expect(report.writtenFiles).toEqual([
      join(outputDir, "MEMORY.md"),
      join(outputDir, "COMPACTION_REPORT.md"),
    ]);
    expect(report.findings.some((finding) => finding.kind === "duplicate-index-entry")).toBe(true);
    expect(report.findings.some((finding) => finding.kind === "broken-index-entry")).toBe(true);
    expect(report.findings.some((finding) => finding.kind === "long-index-line")).toBe(true);

    const proposedIndex = readFileSync(join(outputDir, "MEMORY.md"), "utf8");
    expect(proposedIndex).toContain("- [Bun Commands](project_bun-commands.md) — Use Bun for build and test commands");
    expect(proposedIndex).toContain("- [Review First](feedback_review-first.md) — Review existing source before changing behavior");
    expect(proposedIndex).not.toContain("missing.md");
    expect(proposedIndex.split("project_bun-commands.md")).toHaveLength(2);

    const reportText = readFileSync(join(outputDir, "COMPACTION_REPORT.md"), "utf8");
    expect(reportText).toContain("## Why this matters");
    expect(reportText).toContain("The proposal is written outside the memory root");
    expect(reportText).toContain("duplicate-index-entry");
    expect(reportText).toContain("orphan-topic");
  });

  test("fails closed when the output directory is inside the memory root", () => {
    const root = tempDir();
    writeTopic(root, "project_bun-commands.md", "bun-commands", "Use Bun for build and test commands");
    writeFileSync(
      join(root, "MEMORY.md"),
      "# Memory\n\n- [Bun Commands](project_bun-commands.md) — Use Bun for build and test commands\n",
    );

    expect(() =>
      compactMemoryDirectory(root, { outputDir: join(root, "proposal") }),
    ).toThrow("output directory must be outside the memory root");
  });
});
