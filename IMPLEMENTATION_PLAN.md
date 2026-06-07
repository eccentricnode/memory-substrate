<!-- Generated and maintained by Ralph (plan + build modes). Priority-sorted. -->

- P0 — Current increment: scaffold plus offline tests.
  - Status: completed.
  - Completed: `package.json` and `tsconfig.json` added for the Bun-compatible TypeScript scaffold.
  - Completed: `adapters/pi-dev/extension/` now has config, core, injection, and index modules.
  - Completed: offline deterministic coverage added for config/modes and memory injection only.
  - Verified: `bunx tsc --noEmit && bun test` passed with exactly one test subagent.
  - Constraints: no real model calls; no global pi extension install; use exactly one test runner for the green gate.

- P0 — Config and mode gates.
  - Status: first slice implemented and test-covered.
  - Cover: enabled/disabled, ignore, dry-run, memory root, model default, debounce/max batch defaults.
  - Required: `PI_MEMORY_ENABLED=0` means no bootstrap, reads, writes, injection, queueing, worker invocation, or validation.
  - Required: ignore mode means no injection, no writes, and no citations/application.
  - Remaining P0: lifecycle batching, worker invocation, validator command wiring, and write-path enforcement still need implementation coverage.

- P0 — Memory injection.
  - Status: first slice implemented and test-covered.
  - Cover: `before_agent_start` reads `MEMORY.md`, ranks index lines by prompt overlap, and injects attributed snippets only.
  - Bounds: no topic-file bodies; cap at 12 index lines or 4 KB, whichever is smaller.
  - Modes: inject nothing in disabled or ignore mode.

- P0 — Host safety boundaries to preserve while scaffolding.
  - Status: partially preserved by the scaffold; remaining write-path work pending.
  - No global install into `~/.pi/agent/extensions/`.
  - Worker recursion guard must disable the extension in subprocesses; if env override support is unavailable, fail closed.
  - Extension and worker writes must stay confined to the resolved memory root except host-owned extension state.
  - Forced writes must remain two-step: topic file plus `MEMORY.md` pointer.
  - Default worker model is `claude-haiku-4-5`; `PI_MEMORY_MODEL` overrides.

- P0 — Remaining forced-write implementation.
  - Status: pending after scaffold slice.
  - Add lifecycle batching for event collection and debounce/max batch handling.
  - Add worker forced writes with recursion guard and the `claude-haiku-4-5` default model.
  - Wire the reference validator command after writes.
  - Add dry-run audit flow for proposed changes without live model writes.
  - Complete write confinement for all extension and worker write paths.

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
  - Add batching, forced-write worker, dry-run audit flow, validator invocation after writes, status reporting, validate/flush commands, and SPEC §7 compactor/migrator reconciliation after the current increment is green.
