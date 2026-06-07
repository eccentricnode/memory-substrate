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
import { migratePaiMemoryDirectory } from "../reference/migrator.ts";
import { validateMemoryDirectory } from "../reference/validator.ts";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-migrator-test-"));
  tmpRoots.push(dir);
  return dir;
}

describe("reference migrator", () => {
  test("writes a validator-clean migration proposal without mutating the PAI root", () => {
    const sourceRoot = tempDir();
    const outputDir = join(tempDir(), "proposal");
    writeFileSync(
      join(sourceRoot, "feedback_old-shape.md"),
      `---
name: old-shape
description: "Use the historical flat type shape during migration tests"
type: feedback
---

Historical PAI memories may use flat type frontmatter.
`,
    );
    writeFileSync(
      join(sourceRoot, "project_existing.md"),
      `---
name: existing
description: Existing nested frontmatter is preserved
metadata:
  type: project
---

Existing nested frontmatter is already close to the target shape.
`,
    );
    writeFileSync(
      join(sourceRoot, "PRINCIPAL_IDENTITY.md"),
      `# Principal Identity

This imported identity file did not have memory frontmatter.
`,
    );
    const originalIndex = `# Memory Index

## Migrated
- [Old Shape](feedback_old-shape.md) — ${"Use the historical flat type shape during migration tests".repeat(4)}
- [Duplicate Old Shape](feedback_old-shape.md) — duplicate pointer
- [Existing](project_existing.md) — Existing nested frontmatter is preserved
- [Broken](missing.md) — missing pointer

## Plain PAI Bullets
- Plain non-pointer note that needs human review.
`;
    writeFileSync(join(sourceRoot, "MEMORY.md"), originalIndex);

    const report = migratePaiMemoryDirectory(sourceRoot, outputDir);

    expect(readFileSync(join(sourceRoot, "MEMORY.md"), "utf8")).toBe(originalIndex);
    expect(existsSync(join(sourceRoot, "MIGRATION_REPORT.md"))).toBe(false);
    expect(report.outputMemoryRoot).toBe(join(outputDir, "memory"));
    expect(report.migratedTopicFileCount).toBe(3);
    expect(report.findings.some((finding) => finding.kind === "frontmatter-normalized")).toBe(true);
    expect(report.findings.some((finding) => finding.kind === "frontmatter-inferred")).toBe(true);
    expect(report.findings.some((finding) => finding.kind === "index-non-pointer-line")).toBe(true);
    expect(report.findings.some((finding) => finding.kind === "index-broken-pointer")).toBe(true);
    expect(report.findings.some((finding) => finding.kind === "index-duplicate-pointer")).toBe(true);
    expect(report.findings.some((finding) => finding.kind === "index-long-line")).toBe(true);

    const outputMemoryRoot = join(outputDir, "memory");
    const normalizedTopic = readFileSync(
      join(outputMemoryRoot, "feedback_old-shape.md"),
      "utf8",
    );
    expect(normalizedTopic).toContain("metadata:\n  type: feedback");
    expect(normalizedTopic).not.toContain("\ntype: feedback\n");

    const inferredTopic = readFileSync(
      join(outputMemoryRoot, "user_principal-identity.md"),
      "utf8",
    );
    expect(inferredTopic).toContain("name: principal-identity");
    expect(inferredTopic).toContain("metadata:\n  type: user");

    const proposedIndex = readFileSync(join(outputMemoryRoot, "MEMORY.md"), "utf8");
    expect(proposedIndex).toContain("- [Old Shape](feedback_old-shape.md) — Use the historical flat type shape during migration tests");
    expect(proposedIndex).toContain("- [Existing](project_existing.md) — Existing nested frontmatter is preserved");
    expect(proposedIndex).toContain("- [Principal Identity](user_principal-identity.md)");
    expect(proposedIndex).not.toContain("missing.md");
    expect(proposedIndex).not.toContain("Plain non-pointer note");

    const validation = validateMemoryDirectory(outputMemoryRoot);
    expect(validation.counts.error).toBe(0);
    expect(
      report.findings.filter((finding) => finding.kind === "output-validation-finding"),
    ).toEqual([]);

    const reportText = readFileSync(join(outputDir, "MIGRATION_REPORT.md"), "utf8");
    expect(reportText).toContain("## Why this matters");
    expect(reportText).toContain("The source directory is left untouched");
    expect(reportText).toContain("frontmatter-inferred");
  });

  test("fails closed when the output directory is inside the PAI root", () => {
    const sourceRoot = tempDir();
    writeFileSync(join(sourceRoot, "MEMORY.md"), "# Memory\n");

    expect(() =>
      migratePaiMemoryDirectory(sourceRoot, join(sourceRoot, "proposal")),
    ).toThrow("output directory must be outside the PAI source root");
  });
});
