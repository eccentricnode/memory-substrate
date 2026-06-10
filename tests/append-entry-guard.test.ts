import { describe, expect, test } from "bun:test";
import { safeAppendEntry } from "../adapters/pi-dev/extension/index.ts";

describe("safeAppendEntry — worker audit must survive a torn-down session", () => {
  test("swallows a stale-ctx throw so the async worker audit can't crash", () => {
    // Reproduces the live `-p` bug: the worker fires on agent_end, the session
    // is already torn down, and pi throws on append.
    expect(() =>
      safeAppendEntry(
        {
          appendEntry: () => {
            throw new Error(
              "This extension ctx is stale after session replacement or reload",
            );
          },
        },
        "memory-substrate-worker-audit",
        { ok: true },
      ),
    ).not.toThrow();
  });

  test("passes the audit entry through when the session is alive", () => {
    const calls: Array<[string, unknown]> = [];
    safeAppendEntry({ appendEntry: (t, d) => calls.push([t, d]) }, "evt", { a: 1 });
    expect(calls).toEqual([["evt", { a: 1 }]]);
  });

  test("no-op when the host exposes no appendEntry", () => {
    expect(() => safeAppendEntry({}, "evt", {})).not.toThrow();
  });
});
