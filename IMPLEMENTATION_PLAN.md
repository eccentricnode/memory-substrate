<!-- Generated and maintained by Ralph (plan + build modes). Priority-sorted. -->

- P0 — Reactive memory trigger (event-driven read). NEW.
  - Spec: `specs/12-reactive-memory-trigger.md` (read it first — it cites spec 11 + the worker pattern to mirror).
  - Goal: on `before_agent_start`, a CHEAP gate (recall-intent cues + existing index-overlap ranking — NO model call, NO SFPAI dependency) decides if the turn needs durable memory; if so, auto-fire `researchMemory` (spec 11) in its recursion-guarded sub-context and inject the bounded synthesis (superseding plain index injection). The push complement to spec 11's pull tool — the read-side mirror of the write-worker's `agent_end` reactivity.
  - Opt-in, default OFF (e.g. `PI_MEMORY_REACTIVE=1`); honors disabled/ignore/dry-run; at most one fire per turn; bounded injection.
  - Backpressure: mock the gate + `researchMemory`; test fires-on-cues, fires-on-overlap, skips-on-neither, gated-in supersedes index injection, gated-out index-only, found:false injects nothing, flag-off unchanged, disabled/ignore/dry-run honored, one-fire-per-turn. Opt-in live test. `bunx tsc --noEmit && bun test` green.
  - Increments: (1) gate (cue + overlap) as a pure, tested function; (2) wire it into `before_agent_start` behind the opt-in flag, gated-out = today's behavior; (3) gated-in fires `researchMemory` + bounded synthesis injection superseding index lines; (4) disabled/ignore/dry-run + one-fire-per-turn hardening; (5) opt-in live test + docs.

- P1 — Worker runner injection is a trust boundary.
  - Status: open; custom `MemoryWorkerRunner.supportsEnv` is runner-declared, and injected runners can bypass applicator/write confinement unless they use `worker.ts`.
  - Plan: narrow the injected runner contract so untrusted runners cannot perform direct memory writes, and make env-recursion support and applicator-only writes mechanically enforced or test-stub-only.

- P1 — Research subprocess root-only guarantees are prompt/tool mediated.
  - Status: open; research citations are not validated as existing relative topic files under `memoryRoot`, and read-only/root-only enforcement relies on pi tool allowlist plus prompt instructions rather than a sandbox.
  - Plan: validate returned citations against canonical in-root topic files before surfacing them, and add a mechanical root-only/read-only boundary or explicit fail-closed behavior when it cannot be enforced.

- P1 — Prompt fallback block length.
  - Status: open; `adapters/pi-dev/memory-protocol.md` is 87 lines, exceeding SPEC §3.5's <=80-line prompt-bakeable cap.
  - Plan: compress the fallback protocol without dropping disabled/ignore/dry-run, two-step save, dedupe, exclusions, validation, and read-verification requirements.
  - Plan: add a simple line-count regression or documented check so future protocol edits do not drift past the cap.

- P2 — Model/config validation should fail before flush/research.
  - Status: open; malformed model values currently surface during flush or research preflight rather than config/status discovery.
  - Plan: validate configured worker/research model shape during config/status paths and expose actionable status without launching subprocess preflight.

- P2 — Ignore mode needs an operator clear path.
  - Status: open; prompt-triggered ignore mode has no explicit operator command/path to clear it within the session.
  - Plan: define and implement a clear/resume command or prompt phrase, with audit output proving when memory remains ignored versus re-enabled.

- P2 — Exact per-write two-step ordering.
  - Status: open; spec review noted the applicator writes all topic files in a batch and then writes the index once. Rollback protects validation failures, but a process interruption between those steps can still leave incomplete topic-only writes.
  - Plan: decide whether batched atomic application is acceptable for this adapter or change application to topic+index per memory with tests documenting interruption/rollback behavior.

- P2 — Worker draft action naming compatibility.
  - Status: open; `specs/08` describes create-or-update proposals while implementation uses `action: "upsert"` as the JSON contract.
  - Plan: either document `upsert` as the concrete wire value in the spec or accept `create-or-update` as an alias without weakening malformed-action refusal.

- P2 — Compactor parser alignment.
  - Status: open; `reference/compactor.ts` also uses a local regex parser that can treat flat top-level `type:` as a trusted compaction group, unlike the validator.
  - Plan: keep validator findings in the compaction report, but do not classify flat `type:` as a trusted `metadata.type`; group invalid/unknown topics conservatively.
  - Plan: add a compactor regression for flat `type:` frontmatter showing both the validator finding and expected proposal grouping.

- P2 — Live harness cadence.
  - Status: opt-in by design; `tests/pi-dev-live-integration.test.ts` is skipped unless `PI_MEMORY_INTEGRATION=1`, per `specs/07`.
  - Plan: after model/auth/preflight changes or pi.dev upgrades, run `bun run test:pi-live` intentionally and record the latest result in this plan.

- P2 — Successful no-write flush visibility.
  - Status: open; spec/search review found `/memory-flush` still reports processed candidate count without distinguishing a successful no-write decision from a write-changing success.
  - Plan: decide whether the worker/core result should carry accepted write/delete counts or a no-write flag, then update command output and regressions without weakening retained-failure statuses.

- P2 — Worker timeout and in-flight queue edge coverage.
  - Status: open; specs require worker timeouts to be failed retained runs and items arriving during an in-flight run to wait for the next run, but current tests do not directly pin those edges.
  - Plan: add focused lifecycle/live-runner tests for timeout audit/retention and no concurrent retry/spin when new candidates arrive during a failed in-flight batch.

- Completed — Core pi-dev forced-write surface.
  - Dry-run proposal validation scratch is now root-confined under `.memory-substrate/dry-run`, copies only durable validator-visible memory contents, validates the proposed root there, and cleans up the hidden workspace after use. Regression coverage asserts the validator receives an in-root scratch path, sees proposed topic/index content, leaves durable memory unchanged, and removes scratch state. Related spec clarifications now name applicator-owned proposed paths/actions, bounded host extension audit state, pi.dev hard cap refusals, and link-validation semantics. Focused `bun test tests/worker-write.test.ts` passed with 34 pass, 0 fail; full green gate `bunx tsc --noEmit && bun test` passed with 114 pass, 8 skip, 0 fail, 122 tests across 10 files.
  - Candidate batch prompt payload is now bounded before it reaches the live worker prompt: worker prompts serialize bounded durable candidate text instead of raw request items; tool/system/bulky payloads and audit payloads are excluded from the live prompt; deterministic fallback also ignores tool-only payloads. Focused `bun test tests/live-worker.test.ts tests/worker-write.test.ts` passed with 48 pass, 0 fail, 274 expect() calls; full green gate via one test subagent `bunx tsc --noEmit && bun test` passed with 113 pass, 8 skip, 0 fail, 612 expect() calls, 121 tests across 10 files.
  - Live worker prompt now carries the full write protocol: explicit durable triggers, exclusions, dedupe/update/stale correction, and two-step save protocol. Regression coverage lives in `tests/live-worker.test.ts`; `bun test tests/live-worker.test.ts` passed with 14 pass, 0 fail, and `bunx tsc --noEmit && bun test` passed with 111 pass, 7 skip, 0 fail.
  - P0 memory research sub-agent is complete: shared `researchMemory` orchestrator, `/memory-research` command, `memory_research` tool registration, recursion guard env, read-only tool allowlist, model preflight, mocked subprocess tests for found/not-found/disabled/ignore/model errors, and pi-dev README coverage for `/memory-research`, `memory_research`, `PI_MEMORY_RESEARCH_MODEL`, and the live harness. `tests/pi-dev-live-integration.test.ts` now has an opt-in `/memory-research` live test that seeds disposable memory, invokes the command, expects citation/output, and asserts no worker queue or memory mutation. Docs make the read-side mediator operationally discoverable; the opt-in live test verifies the read-only recursion-guarded subprocess path without making live calls part of the green gate. Latest verification: focused `bun test tests/memory-research.test.ts tests/pi-dev-live-integration.test.ts` passed with 6 pass, 8 skip, 0 fail; full green gate via one test subagent `bunx tsc --noEmit && bun test` passed with 111 pass, 8 skip, 0 fail, 119 tests.
  - Worker dedupe now only trusts validator-conformant nested `metadata.type`, so flat top-level `type:` frontmatter cannot masquerade as typed topic metadata during snapshot/dedupe decisions. Focused `bun test tests/worker-write.test.ts` passed with 32 pass, 0 fail, and the full green gate passed in one test process: `bunx tsc --noEmit && bun test` -> 104 pass, 7 skip, 0 fail, 111 tests across 9 files.
  - Delete drafts now require valid indexed topic memories, preventing deletion of unindexed markdown files or files with invalid/missing topic frontmatter under the memory root. Focused `bun test tests/worker-write.test.ts` passed with 32 pass, 0 fail, and the full green gate passed in one test process: `bunx tsc --noEmit && bun test` -> 104 pass, 7 skip, 0 fail, 111 tests across 9 files.
  - Dry-run now applies proposed changes to a temporary copy of the memory root, runs the reference validator before printing proposed stdout, deletes the temporary root, and leaves the real root unchanged. Regression coverage proves a validator-only broken-link proposal fails dry-run without writing topic/index changes; focused `bun test tests/worker-write.test.ts tests/lifecycle-and-worker.test.ts tests/validate-command.test.ts` passed with 57 pass, 0 fail, and the full green gate passed via one test subagent: `bunx tsc --noEmit && bun test` -> 101 pass, 7 skip, 0 fail, 108 tests across 9 files.
  - User-facing flush results now preserve validator rollback failures as `validation-failed`, and `/memory-flush` reports a distinct validation-failed message while retaining queued candidates. Regression coverage checks both core status and command notification; focused `bun test tests/worker-write.test.ts tests/lifecycle-and-worker.test.ts tests/validate-command.test.ts` passed with 57 pass, 0 fail, and the full green gate passed via one test subagent: `bunx tsc --noEmit && bun test` -> 101 pass, 7 skip, 0 fail, 108 tests across 9 files.
  - Live worker existing-memory snapshots are bounded to 8 KB / 40 topics, rank topic metadata against candidate batch keywords for dedupe, exclude raw non-pointer index content, and report truncation counts/flags; this keeps forced-write prompts from leaking or bloating the memory corpus. Regression coverage in `tests/live-worker.test.ts` passed, and the full green gate passed via one test subagent: `bunx tsc --noEmit && bun test` -> 99 pass, 7 skip, 0 fail, 106 tests across 9 files.
  - Worker draft normalization now refuses over-cap upsert descriptions and delete reasons instead of truncating malformed live worker JSON into accepted writes; hook fitting remains limited to rendered `MEMORY.md` pointer cap behavior. Focused `bun test tests/worker-write.test.ts` passed with 28 pass, and full `bunx tsc --noEmit && bun test` passed with 98 pass, 7 skip, 0 fail.
  - `/memory-refresh` now writes reviewable compaction proposals only under `.memory-substrate/refresh-proposal` inside the resolved memory root, rejects explicit outside-root output, and keeps hidden proposals out of validator topic scans; `bunx tsc --noEmit && bun test` passed with 96 pass and 7 skip.
  - Model preflight now validates only provider-qualified shape; `worker.ts` no longer calls `pi --list-models`, reachability comes from the no-tools subprocess, docs/specs/tests were updated, and `bunx tsc --noEmit && bun test` passed with 94 pass and 7 skip.
  - Event batching/debounce/max-batch/compaction flush are implemented and test-covered.
  - Disabled mode prevents bootstrap, reads, writes, validation, queueing, and worker launch; ignore mode suppresses injection, writes, citations/application, and validation/refresh/flush behavior as documented.
  - Live worker launch uses an env-capable subprocess path with `PI_MEMORY_ENABLED=0`, no extensions/context/skills/session/tools, and fails closed when env forwarding cannot be proven.
  - Applicator is the write authority for upsert/delete drafts, performs root canonicalization, two-step topic/index updates, adapter cap checks, reference validation, rollback on validation failure, and queue retention on failure.
  - Bounded turn-start injection uses relevant `MEMORY.md` index snippets only, capped at 12 lines or 4 KB, visibly attributed as durable advisory context.
  - Command surface exists for status, validate, flush, and refresh, subject to the open write-boundary item above.
  - Reference validator, migrator, and compactor CLIs/APIs exist; migrator intentionally normalizes historical flat `type:` frontmatter under `specs/10`.
