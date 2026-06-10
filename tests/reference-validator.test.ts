import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateMemoryDirectory } from "../reference/validator.ts";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-validator-test-"));
  tmpRoots.push(dir);
  return dir;
}

function writeValidMemory(root: string): void {
  writeFileSync(
    join(root, "project_bun-commands.md"),
    `---
name: bun-commands
description: Use Bun for build and test commands
metadata:
  type: project
---

Use Bun for build and test commands.
`,
  );
  writeFileSync(
    join(root, "MEMORY.md"),
    "# Memory\n\n- [Bun commands](project_bun-commands.md) — Use Bun for build and test commands\n",
  );
}

describe("reference validator API", () => {
  test("validates a spec-conformant memory directory without exiting", () => {
    const root = tempDir();
    writeValidMemory(root);

    const result = validateMemoryDirectory(root);

    expect(result.topicFileCount).toBe(1);
    expect(result.counts.error).toBe(0);
    expect(result.findings).toEqual([]);
  });

  test("reports frontmatter, description, filename, and index shape violations", () => {
    const root = tempDir();
    const longDescription = `${"x".repeat(201)}`;
    writeFileSync(
      join(root, "project_expected-name.md"),
      `---
name: mismatched-name
description: **${longDescription}**
metadata:
  type: project
---

Body.
`,
    );
    writeFileSync(
      join(root, "MEMORY.md"),
      `---
name: invalid-index-frontmatter
---

# Memory
- malformed index entry
- [Escapes](../outside.md) -- outside
- [Missing](missing.md) -- missing
`,
    );

    const result = validateMemoryDirectory(root);
    const messages = result.findings.map((finding) => finding.msg);

    expect(result.counts.error).toBeGreaterThanOrEqual(5);
    expect(messages).toContain("index must not have frontmatter");
    expect(messages).toContain("frontmatter `name` must match filename stem `expected-name`");
    expect(messages).toContain("description must not contain markdown formatting");
    expect(messages).toContain("invalid index entry line");
    expect(messages).toContain("link escapes memory root: ../outside.md");
    expect(messages).toContain("broken link: missing.md");
    expect(messages).toContain("description 205 chars exceeds 200 cap");
    expect(messages).toContain("orphan: not referenced from MEMORY.md");
  });

  test("rejects flat type frontmatter and non-canonical index hooks", () => {
    const root = tempDir();
    writeFileSync(
      join(root, "project_flat-type.md"),
      `---
name: flat-type
description: Flat type must not be silently coerced
type: project
---

Flat type must be migrated before validation.
`,
    );
    writeFileSync(
      join(root, "MEMORY.md"),
      "# Memory\n\n- [Flat type](project_flat-type.md) -- Flat type must not be silently coerced\n",
    );

    const result = validateMemoryDirectory(root);
    const messages = result.findings.map((finding) => finding.msg);

    expect(result.counts.error).toBeGreaterThanOrEqual(4);
    expect(messages).toContain("frontmatter `type` must be nested under `metadata.type`");
    expect(messages).toContain("frontmatter missing `metadata.type`");
    expect(messages).toContain("invalid index entry line");
    expect(messages).toContain("orphan: not referenced from MEMORY.md");
  });

  test("parses the documented strict YAML subset for topic frontmatter", () => {
    const root = tempDir();
    writeFileSync(
      join(root, "project_yaml-subset.md"),
      [
        "---",
        "name: yaml-subset",
        'description: "Hash # stays because this scalar is quoted"',
        "metadata: # strict schema block",
        "  type: project # inline comment is ignored",
        "---",
        "",
        "The parser supports the small YAML subset the schema requires.",
        "",
      ].join("\r\n"),
    );
    writeFileSync(
      join(root, "MEMORY.md"),
      "# Memory\n\n- [YAML Subset](project_yaml-subset.md) — Hash # stays because this scalar is quoted\n",
    );

    const result = validateMemoryDirectory(root);

    expect(result.findings).toEqual([]);
    expect(result.counts.error).toBe(0);
  });

  test("rejects frontmatter outside the documented strict YAML subset", () => {
    const root = tempDir();
    writeFileSync(
      join(root, "project_yaml-block.md"),
      `---
name: yaml-block
description: |
  Block scalar descriptions are outside the strict subset.
metadata: { type: project }
---

Unsupported YAML must fail closed instead of being guessed.
`,
    );
    writeFileSync(
      join(root, "MEMORY.md"),
      "# Memory\n\n- [YAML Block](project_yaml-block.md) — Block scalar descriptions are outside the strict subset\n",
    );

    const result = validateMemoryDirectory(root);
    const messages = result.findings.map((finding) => finding.msg);

    expect(messages).toContain("frontmatter missing `description`");
    expect(messages).toContain("frontmatter missing `metadata.type`");
    expect(result.counts.error).toBeGreaterThanOrEqual(2);
  });

  test("enforces kebab-case topic names and duplicate normalized names", () => {
    const root = tempDir();
    writeFileSync(
      join(root, "project_Foo Bar.md"),
      `---
name: Foo Bar
description: Invalid slug with spaces and uppercase
metadata:
  type: project
---

Invalid slug.
`,
    );
    writeFileSync(
      join(root, "reference_foo-bar.md"),
      `---
name: foo-bar
description: Same slug after normalization
metadata:
  type: reference
---

Duplicate normalized slug.
`,
    );
    writeFileSync(
      join(root, "MEMORY.md"),
      [
        "# Memory",
        "",
        "- [Foo Bar](project_Foo Bar.md) — Invalid slug with spaces and uppercase",
        "- [Foo Bar Reference](reference_foo-bar.md) — Same slug after normalization",
        "",
      ].join("\n"),
    );

    const result = validateMemoryDirectory(root);
    const messages = result.findings.map((finding) => finding.msg);

    expect(messages).toContain("frontmatter `name` must be a kebab-case slug");
    expect(
      messages.some((message) =>
        message.startsWith("duplicate topic name after slug normalization: foo-bar already used by "),
      ),
    ).toBe(true);
    expect(result.counts.error).toBeGreaterThanOrEqual(2);
  });

  test("validates local markdown links inside topic bodies", () => {
    const root = tempDir();
    writeFileSync(
      join(root, "reference_related.md"),
      `---
name: related
description: Related reference target
metadata:
  type: reference
---

Related target.
`,
    );
    writeFileSync(
      join(root, "project_links.md"),
      `---
name: links
description: Local markdown links must stay valid
metadata:
  type: project
---

[Related](reference_related.md) is valid.
[Missing](missing.md) is broken.
[Outside](../outside.md) escapes.
[External](https://example.com/memory.md) is outside validator scope.
`,
    );
    writeFileSync(
      join(root, "MEMORY.md"),
      [
        "# Memory",
        "",
        "- [Links](project_links.md) — Local markdown links must stay valid",
        "- [Related](reference_related.md) — Related reference target",
        "",
      ].join("\n"),
    );

    const result = validateMemoryDirectory(root);
    const messages = result.findings.map((finding) => finding.msg);

    expect(messages).toContain("broken link: missing.md");
    expect(messages).toContain("link escapes memory root: ../outside.md");
    expect(messages).not.toContain("broken link: https://example.com/memory.md");
  });

  test("validates angle-bracket and spaced markdown links while ignoring fenced examples", () => {
    const root = tempDir();
    mkdirSync(join(root, "team docs"));
    writeFileSync(
      join(root, "team docs", "reference_related-topic.md"),
      `---
name: related-topic
description: Related reference target in a spaced directory
metadata:
  type: reference
---

Related target.
`,
    );
    writeFileSync(
      join(root, "project_link-forms.md"),
      `---
name: link-forms
description: Markdown link forms must be parsed like routable memory pointers
metadata:
  type: project
---

[Angle related](<team docs/reference_related-topic.md>) is valid.
[Spaced related](team docs/reference_related-topic.md) is also accepted by the reference validator.

\`\`\`md
[Example only](missing-from-example.md)
[Example outside](../outside-example.md)
\`\`\`
`,
    );
    writeFileSync(
      join(root, "MEMORY.md"),
      [
        "# Memory",
        "",
        "- [Link Forms](project_link-forms.md) — Markdown link forms must be parsed like routable memory pointers",
        "- [Related Topic](<team docs/reference_related-topic.md>) — Related reference target in a spaced directory",
        "",
      ].join("\n"),
    );

    const result = validateMemoryDirectory(root);
    const messages = result.findings.map((finding) => finding.msg);

    expect(messages).not.toContain("broken link: <team docs/reference_related-topic.md>");
    expect(messages).not.toContain("broken link: team docs/reference_related-topic.md");
    expect(messages).not.toContain("broken link: missing-from-example.md");
    expect(messages).not.toContain("link escapes memory root: ../outside-example.md");
    expect(result.counts.error).toBe(0);
  });

  test("requires index targets to be markdown topic files", () => {
    const root = tempDir();
    writeValidMemory(root);
    writeFileSync(join(root, "notes.txt"), "not a memory topic\n");
    writeFileSync(
      join(root, "MEMORY.md"),
      [
        "# Memory",
        "",
        "- [Self](MEMORY.md) — Index cannot point at itself",
        "- [Text](notes.txt) — Index targets must be markdown topic files",
        "- [Bun commands](project_bun-commands.md) — Use Bun for build and test commands",
        "",
      ].join("\n"),
    );

    const result = validateMemoryDirectory(root);
    const messages = result.findings.map((finding) => finding.msg);

    expect(messages).toContain("index target must reference a topic file: MEMORY.md");
    expect(messages).toContain("index target must be a markdown file: notes.txt");
  });

  test("reports unresolved wiki links as non-blocking diagnostics", () => {
    const root = tempDir();
    writeFileSync(
      join(root, "MEMORY.md"),
      "# Memory\n\n- [Pointer](reference_pointer.md) — Points to a future memory\n",
    );
    writeFileSync(
      join(root, "reference_pointer.md"),
      `---
name: pointer
description: Points to a future memory
metadata:
  type: reference
---

See [[future-memory]] when it exists.
`,
    );

    const result = validateMemoryDirectory(root);
    const wikiFinding = result.findings.find((finding) =>
      finding.msg.includes("[[future-memory]]"),
    );

    expect(wikiFinding?.severity).toBe("info");
    expect(result.counts.error).toBe(0);
  });

  test("reports topic files missing from MEMORY.md as errors", () => {
    const root = tempDir();
    writeFileSync(join(root, "MEMORY.md"), "# Memory\n");
    writeFileSync(
      join(root, "project_unindexed.md"),
      `---
name: unindexed
description: Missing the required index pointer
metadata:
  type: project
---

Missing the required index pointer.
`,
    );

    const result = validateMemoryDirectory(root);
    const orphan = result.findings.find((finding) =>
      finding.msg.includes("orphan"),
    );

    expect(orphan?.severity).toBe("error");
    expect(result.counts.error).toBeGreaterThan(0);
  });
});
