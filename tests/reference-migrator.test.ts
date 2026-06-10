import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
    expect(report.inputContract).toBe("specs/10-pai-migrator-input-schema.md");
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
    expect(reportText).toContain("## Input Contract");
    expect(reportText).toContain("historical flat `type:` frontmatter");
    expect(reportText).toContain("The source directory is left untouched");
    expect(reportText).toContain("frontmatter-inferred");
  });

  test("re-points intra-memory links when cross-linked topics are renamed", () => {
    const sourceRoot = tempDir();
    const outputDir = join(tempDir(), "proposal");
    // Both topics are renamed (frontmatter name differs from filename stem) AND
    // they cross-link each other by old filename — the real-PAI shape that
    // breaks validation without a body-link rewrite pass.
    writeFileSync(
      join(sourceRoot, "project_alpha.md"),
      `---
name: alpha-renamed
description: Alpha cross-links beta by its old filename
metadata:
  type: project
---

Alpha depends on [Beta](project_beta.md#section) and an [external](https://example.com).
`,
    );
    writeFileSync(
      join(sourceRoot, "project_beta.md"),
      `---
name: beta-renamed
description: Beta cross-links alpha by its old filename
metadata:
  type: project
---

Beta builds on [Alpha](project_alpha.md).
`,
    );
    writeFileSync(
      join(sourceRoot, "MEMORY.md"),
      `# Memory Index

## Projects
- [Alpha](project_alpha.md) — Alpha cross-links beta by its old filename
- [Beta](project_beta.md) — Beta cross-links alpha by its old filename
`,
    );

    const report = migratePaiMemoryDirectory(sourceRoot, outputDir);
    const outputMemoryRoot = join(outputDir, "memory");

    // The proposal must be validator-clean despite the renames.
    expect(validateMemoryDirectory(outputMemoryRoot).counts.error).toBe(0);
    expect(
      report.findings.filter((finding) => finding.kind === "output-validation-finding"),
    ).toEqual([]);
    expect(report.findings.some((finding) => finding.kind === "body-link-rewritten")).toBe(true);

    const alpha = readFileSync(join(outputMemoryRoot, "project_alpha-renamed.md"), "utf8");
    // Renamed target re-pointed, fragment preserved, external link untouched.
    expect(alpha).toContain("[Beta](project_beta-renamed.md#section)");
    expect(alpha).toContain("[external](https://example.com)");
    const beta = readFileSync(join(outputMemoryRoot, "project_beta-renamed.md"), "utf8");
    expect(beta).toContain("[Alpha](project_alpha-renamed.md)");
  });

  test("normalizes spaced and angle-bracket source index and body links", () => {
    const sourceRoot = tempDir();
    const outputDir = join(tempDir(), "proposal");
    mkdirSync(join(sourceRoot, "team docs"));
    writeFileSync(
      join(sourceRoot, "team docs", "project_alpha space.md"),
      `---
name: alpha-space-renamed
description: Alpha has a spaced source path
metadata:
  type: project
---

Alpha points to [Beta](<project_beta space.md#details>).
`,
    );
    writeFileSync(
      join(sourceRoot, "team docs", "project_beta space.md"),
      `---
name: beta-space-renamed
description: Beta has a spaced source path
metadata:
  type: project
---

Beta points to [Alpha](project_alpha space.md).
`,
    );
    writeFileSync(
      join(sourceRoot, "MEMORY.md"),
      `# Memory Index

## Projects
- [Alpha](<team docs/project_alpha space.md>) — Alpha has a spaced source path
- [Beta](team docs/project_beta space.md) — Beta has a spaced source path
`,
    );

    const report = migratePaiMemoryDirectory(sourceRoot, outputDir);
    const outputMemoryRoot = join(outputDir, "memory");

    expect(validateMemoryDirectory(outputMemoryRoot).counts.error).toBe(0);
    expect(
      report.findings.filter((finding) => finding.kind === "index-broken-pointer"),
    ).toEqual([]);
    expect(report.findings.some((finding) => finding.kind === "body-link-rewritten")).toBe(true);

    const alpha = readFileSync(
      join(outputMemoryRoot, "project_alpha-space-renamed.md"),
      "utf8",
    );
    expect(alpha).toContain("[Beta](project_beta-space-renamed.md#details)");
    const beta = readFileSync(
      join(outputMemoryRoot, "project_beta-space-renamed.md"),
      "utf8",
    );
    expect(beta).toContain("[Alpha](project_alpha-space-renamed.md)");
  });

  test("migrates imported markdown without a source index while reporting the incomplete source", () => {
    const sourceRoot = tempDir();
    const outputDir = join(tempDir(), "proposal");
    writeFileSync(
      join(sourceRoot, "PROJECTS.md"),
      `# Projects

The imported projects file carries useful context but no memory frontmatter.
`,
    );

    const report = migratePaiMemoryDirectory(sourceRoot, outputDir);

    expect(report.sourceIndexLineCount).toBe(0);
    expect(report.migratedTopicFileCount).toBe(1);
    expect(
      report.findings.some(
        (finding) =>
          finding.kind === "source-validation-finding" &&
          finding.file === "MEMORY.md" &&
          finding.message === "index file missing",
      ),
    ).toBe(true);
    expect(report.findings.some((finding) => finding.kind === "frontmatter-inferred")).toBe(true);

    const outputMemoryRoot = join(outputDir, "memory");
    const inferredTopic = readFileSync(
      join(outputMemoryRoot, "project_projects.md"),
      "utf8",
    );
    expect(inferredTopic).toContain("name: projects");
    expect(inferredTopic).toContain("metadata:\n  type: project");
    expect(validateMemoryDirectory(outputMemoryRoot).counts.error).toBe(0);
  });

  test("fails closed when the output directory is inside the PAI root", () => {
    const sourceRoot = tempDir();
    writeFileSync(join(sourceRoot, "MEMORY.md"), "# Memory\n");

    expect(() =>
      migratePaiMemoryDirectory(sourceRoot, join(sourceRoot, "proposal")),
    ).toThrow("output directory must be outside the PAI source root");
  });

  test("fails closed when a symlinked output ancestor resolves inside the PAI root", () => {
    const sourceRoot = tempDir();
    const outside = tempDir();
    const link = join(outside, "source-link");
    writeFileSync(join(sourceRoot, "MEMORY.md"), "# Memory\n");
    symlinkSync(sourceRoot, link, "dir");

    expect(() =>
      migratePaiMemoryDirectory(sourceRoot, join(link, "proposal")),
    ).toThrow("output directory must be outside the PAI source root");
    expect(existsSync(join(sourceRoot, "proposal"))).toBe(false);
  });
});
