<!-- Generated and maintained by Ralph (plan + build modes). Priority-sorted. -->

- P0 — Current increment: forced-write lifecycle batching.
  - Status: bounded offline write/validation slice complete.
  - Finding: worker orchestration and deterministic offline write application now cover the forced-write contract short of live pi subprocess launch.
  - Completed: `package.json` and `tsconfig.json` added for the Bun-compatible TypeScript scaffold.
  - Completed: `adapters/pi-dev/extension/` now has config, core, injection, and index modules.
  - Completed: offline deterministic coverage added for config/modes, memory injection, and forced-write lifecycle batching.
  - Completed: `agent_end` and `session_before_compact` events are queued through lifecycle batching.
  - Completed: debounce and max-batch behavior are implemented and covered by offline tests.
  - Completed: worker execution is routed through an injected worker-runner contract so tests do not call a real model.
  - Completed: worker requests carry the recursion-guard env requirement (`PI_MEMORY_ENABLED=0`).
  - Completed: unsupported `pi.exec` env-forwarding path fails closed instead of spawning unsafely.
  - Completed: audit entries record queued batches and worker-run results outside LLM context.
  - Completed: deterministic offline worker write decisions are default-deny for chatter and produce bounded memory writes for durable facts.
  - Completed: root-confined two-step saves write/update the topic file plus exactly one `MEMORY.md` pointer.
  - Completed: dry-run reports proposed paths and writes nothing.
  - Completed: repeat facts dedupe/update existing memory instead of duplicating pointers.
  - Completed: symlink and out-of-root write attempts are refused before mutation.
  - Completed: after-write validation invokes `reference/validator.ts`; audit coverage records validator results.
  - Verified: `bunx tsc --noEmit && bun test` passed with 24 tests.
  - Constraints: no real model calls; no global pi extension install; use exactly one test runner for the green gate.

- P0 — Config and mode gates.
  - Status: first slice implemented and test-covered.
  - Cover: enabled/disabled, ignore, dry-run, memory root, model default, debounce/max batch defaults.
  - Required: `PI_MEMORY_ENABLED=0` means no bootstrap, reads, writes, injection, queueing, worker invocation, or validation.
  - Required: ignore mode means no injection, no writes, and no citations/application.
  - Remaining P0: live env-capable worker implementation and pi.dev validate command surface.

- P0 — Memory injection.
  - Status: first slice implemented and test-covered.
  - Cover: `before_agent_start` reads `MEMORY.md`, ranks index lines by prompt overlap, and injects attributed snippets only.
  - Bounds: no topic-file bodies; cap at 12 index lines or 4 KB, whichever is smaller.
  - Modes: inject nothing in disabled or ignore mode.

- P0 — Host safety boundaries to preserve while scaffolding.
  - Status: preserved for the bounded offline write/validation slice.
  - No global install into `~/.pi/agent/extensions/`.
  - Completed: queued worker requests include `PI_MEMORY_ENABLED=0`; unsupported `pi.exec` env forwarding fails closed.
  - Completed: deterministic worker writes are confined to the resolved memory root and refuse symlink/out-of-root escapes.
  - Completed: forced writes are two-step: topic file plus `MEMORY.md` pointer.
  - Remaining: implement a live env-capable worker launcher without violating the recursion guard.
  - Default worker model is `claude-haiku-4-5`; `PI_MEMORY_MODEL` overrides.

- P0 — Remaining forced-write implementation.
  - Status: bounded offline write/validation path complete; live host surfaces pending.
  - Completed: lifecycle batching collects `agent_end` and `session_before_compact` events.
  - Completed: debounce/max-batch behavior, injected worker-runner contract, recursion-guard env in worker requests, fail-closed unsupported `pi.exec` env path, and audit entries are implemented and covered by offline tests.
  - Completed: deterministic offline write decisions, two-step topic/index saves, dry-run proposed paths/no writes, dedupe/update behavior, symlink/out-of-root refusal, and validator-after-write/audit coverage are implemented.
  - Verified: `bunx tsc --noEmit && bun test` passed with 24 tests.
  - Remaining: implement live env-capable worker execution with the `claude-haiku-4-5` default model and `PI_MEMORY_MODEL` override.
  - Remaining: expose the pi.dev validate command surface backed by `reference/validator.ts`.

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
