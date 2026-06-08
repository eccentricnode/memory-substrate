<!-- Generated and maintained by Ralph (plan + build modes). Priority-sorted. -->

- P1 — Dry-run proposal validation.
  - Status: open; dry-run planning checks caps and prints proposed topic/index content but returns before invoking the reference validator.
  - Plan: validate a temporary/proposed memory-root state before dry-run stdout, while leaving the real memory root unchanged.
  - Plan: add regression coverage for a dry-run proposal that only the validator can reject, such as a broken local markdown link in the proposed topic body.

- P1 — Frontmatter parser alignment in worker dedupe.
  - Status: open; worker-local frontmatter parsing treats flat top-level `type:` as typed, while the reference validator rejects flat `type:` outside `metadata.type`.
  - Plan: reuse/export a shared parser or make the worker parser accept only validator-conformant `metadata.type` for trusted type matching.
  - Plan: add a worker regression with an existing flat-`type:` topic proving dedupe cannot rely on validator-invalid type metadata.

- P1 — Delete drafts must target topic memories only.
  - Status: open; delete drafts reject `MEMORY.md` and out-of-root paths, but any existing `.md` file under the root can be deleted without first proving it is a valid topic memory.
  - Plan: before delete planning, require valid topic frontmatter and an index pointer for the target, or use the reference validator/topic parser to classify it as an existing topic memory.
  - Plan: add regressions for deleting an unindexed markdown file and a markdown file with invalid/missing frontmatter.

- P1 — Prompt fallback block length.
  - Status: open; SPEC §3.5 caps prompt-bakeable write protocol blocks at 80 lines, while `adapters/pi-dev/memory-protocol.md` is currently over that cap.
  - Plan: compress the fallback protocol without dropping disabled/ignore/dry-run, two-step save, dedupe, exclusions, validation, and read-verification requirements.
  - Plan: add a simple line-count regression or documented check so future protocol edits do not drift past the cap.

- P1 — Live worker prompt must carry the full write protocol.
  - Status: open; spec review found the live worker prompt currently references “SPEC section 3” but does not enumerate the full trigger table, exclusions, dedupe/update rules, stale-correction rule, and two-step save importance.
  - Why it matters: the live worker is the forced-write decision surface; assuming it already knows the spec weakens recall of explicit remembers, corrections, confirmed approaches, preferences, project context, and external pointers.
  - Plan: expand the worker prompt with the compact §3.1-§3.4 protocol while keeping the prompt bounded, and add regression coverage that the prompt contains the durable-trigger/exclusion cues.

- P1 — Candidate batch prompt payload may be too broad.
  - Status: open; spec review found `agent_end` messages are passed wholesale into worker prompts even though ordinary tool results are out of scope and audit output must stay bounded.
  - Plan: define and enforce a bounded candidate-message extraction policy for worker prompts, preserving durable user/assistant turn content while excluding bulky or tool-only payloads.

- P1 — User-facing flush status should distinguish validation-failed.
  - Status: open; audit records classify validator rollback as `validation-failed`, but `FlushMemoryResult.status` collapses it into `failed`, weakening the operator visibility required by `specs/09`.
  - Plan: add a distinct user-facing validation-failed status/message while preserving retained queue semantics.

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

- Completed — Core pi-dev forced-write surface.
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
