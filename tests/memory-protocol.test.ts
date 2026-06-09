import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const protocolPath = join(import.meta.dir, "..", "adapters", "pi-dev", "memory-protocol.md");

describe("pi.dev prompt memory protocol", () => {
  test("stays prompt-bakeable under the SPEC line cap", () => {
    const protocol = readFileSync(protocolPath, "utf8");
    const lines = protocol.split(/\r?\n/);

    if (lines.at(-1) === "") lines.pop();

    expect(lines.length).toBeLessThanOrEqual(80);
  });

  test("keeps the fallback rules that matter for safe prompt-only use", () => {
    const protocol = readFileSync(protocolPath, "utf8");

    for (const required of [
      "PI_MEMORY_ENABLED=0",
      "ignore memory",
      "dry-run",
      "Write or edit the topic file",
      "Add or update the single-line pointer in `MEMORY.md`",
      "search existing memories",
      "Correct or remove stale memories",
      "bun reference/validator.ts <memory_root>",
      "verify named file paths, functions, flags, and",
    ]) {
      expect(protocol).toContain(required);
    }
  });
});
