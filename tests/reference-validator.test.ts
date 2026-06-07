import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    "# Memory\n\n- [Bun commands](project_bun-commands.md) -- Use Bun for build and test commands\n",
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
  });

  test("reports unresolved wiki links as non-blocking diagnostics", () => {
    const root = tempDir();
    writeFileSync(join(root, "MEMORY.md"), "# Memory\n");
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
});
