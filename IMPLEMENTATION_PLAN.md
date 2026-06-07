<!-- Generated and maintained by Ralph (plan + build modes). Priority-sorted. -->

- P0 — Current increment: live forced-write worker.
  - Status: completed and verified.
  - Finding: `pi.exec` remains unsafe for live workers because it cannot forward env, so it cannot prove the recursion guard reaches the child.
  - Completed: pi-dev docs/protocol now match extension-first behavior, and the writer emits canonical em dash index pointers instead of ASCII `--` separators.
  - Completed: reference validator now treats topic files missing from `MEMORY.md` as two-step-save errors instead of orphan-topic warnings.
  - Completed: worker draft `relativePath` now rejects absolute paths before writing, even when the absolute path is inside the memory root.
  - Completed: disabled mode now short-circuits before core construction, preserving the no-bootstrap/no-read/no-write contract.
  - Design: live runner uses Node `spawn` to run `pi -p` with `PI_MEMORY_ENABLED=0`, `--no-extensions`, `--no-context-files`, `--no-skills`, `--no-prompt-templates`, `--no-session`, and `--no-tools`.
  - Design: live model returns structured memory drafts only; the existing root-confined applicator remains the single write authority and performs the two-step topic file plus `MEMORY.md` save.
  - Verified: `bunx tsc --noEmit && bun test` passed via exactly one test subagent; exit 0, 38 tests passed, 0 failed, 148 expectations.
  - Constraints: no real model calls; no global pi extension install; use exactly one test runner for the green gate.

- P0 — Config and mode gates.
  - Status: first slice implemented and test-covered.
  - Cover: enabled/disabled, ignore, dry-run, memory root, model default, debounce/max batch defaults.
  - Required: `PI_MEMORY_ENABLED=0` means no bootstrap, reads, writes, injection, queueing, worker invocation, or validation.
  - Required: ignore mode means no injection, no writes, and no citations/application.

- P0 — Memory injection.
  - Status: first slice implemented and test-covered.
  - Cover: `before_agent_start` reads `MEMORY.md`, ranks index lines by prompt overlap, and injects attributed snippets only.
  - Bounds: no topic-file bodies; cap at 12 index lines or 4 KB, whichever is smaller.
  - Modes: inject nothing in disabled or ignore mode.

- P0 — Host safety boundaries to preserve while scaffolding.
  - Status: preserved through the verified live-worker implementation.
  - No global install into `~/.pi/agent/extensions/`.
  - Preserve: child workers must receive `PI_MEMORY_ENABLED=0`; unsupported `pi.exec` env forwarding must keep failing closed.
  - Preserve: all writes stay confined to the resolved memory root and refuse symlink/out-of-root escapes.
  - Preserve: forced writes are two-step: topic file plus `MEMORY.md` pointer.
  - Default worker model is `claude-haiku-4-5`; `PI_MEMORY_MODEL` overrides.

- P1 — Harden the reference validator to match SPEC.
  - Status: current increment completed and verified.
  - Completed: importable `validateMemoryDirectory` API added while preserving CLI behavior.
  - Completed: validator now checks the 200-character description cap, rejects `MEMORY.md` frontmatter, checks filename/name consistency, rejects markdown in descriptions, detects root-escaping/broken links and invalid index lines, and reports unresolved `[[name]]` links as info.
  - Completed: strict TypeScript regex-capture errors in `reference/validator.ts` were resolved without behavior changes; `bunx tsc --noEmit && bun test` passed afterward.
  - Verified: focused validator tests passed; `bunx tsc --noEmit` passed; `bun test` passed with 35 tests and 137 expectations.
  - Known unresolved gaps: none currently documented.

- P1 — Align prompt-only adapter docs/protocol with canonical behavior.
  - Status: completed and verified for the extension-first behavior.
  - Completed: `adapters/pi-dev/README.md` and `adapters/pi-dev/memory-protocol.md` now document the forced-write extension path instead of stale prompt-only/no-auto-save behavior, on-demand index loading, hardcoded local validator/root paths, or the 300-character description cap.
  - Open note: SPEC/bootstrap wording and pi-dev bounded injection behavior need reconciliation or clarification.
  - Open note: host-binding worker input wording may need clarification because the live prompt includes an existing-memory snapshot for dedupe.

- P2 — Later extension capabilities.
  - Status: deferred.
  - Add status reporting, flush command, and SPEC §7 compactor/migrator reconciliation after the current increment is green.
