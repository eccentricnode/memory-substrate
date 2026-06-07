<!-- Generated and maintained by Ralph (plan + build modes). Priority-sorted. -->

- P0 — Current increment: live forced-write worker.
  - Status: completed and verified.
  - Finding: `pi.exec` remains unsafe for live workers because it cannot forward env, so it cannot prove the recursion guard reaches the child.
  - Design: live runner uses Node `spawn` to run `pi -p` with `PI_MEMORY_ENABLED=0`, `--no-extensions`, `--no-context-files`, `--no-skills`, `--no-prompt-templates`, `--no-session`, and `--no-tools`.
  - Design: live model returns structured memory drafts only; the existing root-confined applicator remains the single write authority and performs the two-step topic file plus `MEMORY.md` save.
  - Verified: `bunx tsc --noEmit && bun test` passed via exactly one test subagent; exit 0, 32 tests passed, 0 failed, 124 expectations.
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
  - Status: pending for remaining SPEC gaps.
  - Completed: strict TypeScript regex-capture errors in `reference/validator.ts` were resolved without behavior changes; `bunx tsc --noEmit && bun test` passed afterward.
  - Keep documented: validator uses a 300-character description cap while SPEC says 200.
  - Other known gaps: CLI-only API, no rejection of `MEMORY.md` frontmatter, no checks for name/filename consistency, markdown in descriptions, root-escaping links, invalid index lines, or unresolved `[[name]]` TODOs.
  - Plan: expose an importable validation API while preserving CLI behavior, then expand checks under focused tests.

- P1 — Align prompt-only adapter docs/protocol with canonical behavior.
  - Status: pending after extension behavior exists.
  - Known gaps: `adapters/pi-dev/README.md` still says no auto-save; `adapters/pi-dev/memory-protocol.md` describes on-demand index loading, hardcoded local validator/root paths, and the 300-character description cap.

- P2 — Later extension capabilities.
  - Status: deferred.
  - Add status reporting, flush command, and SPEC §7 compactor/migrator reconciliation after the current increment is green.
