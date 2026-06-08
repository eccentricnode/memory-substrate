<!-- Generated and maintained by Ralph (plan + build modes). Priority-sorted. -->

- P0 — Write-boundary conflict for `/memory-refresh`.
  - Status: open; the extension command currently creates compaction proposals outside the resolved memory root, while AGENTS/SPEC safety language says extension writes must stay within the memory root except host config.
  - Evidence: `adapters/pi-dev/extension/index.ts` exposes `/memory-refresh`, `core.ts` passes an arbitrary output directory to `reference/compactor.ts`, and tests assert external `MEMORY.md` plus `COMPACTION_REPORT.md` proposal output.
  - Plan: decide and document the allowed boundary for reviewable compaction proposals. If extension writes remain strictly root-confined, remove/disable external `/memory-refresh` writes from the pi-dev extension or require an explicit host-config-owned output root. If external proposals are intentionally allowed, update the safety specs/invariants before relying on that behavior.

- P0 — Bounded existing-memory snapshot for the live worker.
  - Status: open; `specs/03-background-worker.md` permits only a bounded existing-memory snapshot, but `existingMemorySnapshot()` serializes the full index plus every topic frontmatter into the live worker prompt.
  - Plan: cap snapshot by bytes and topic count, always include enough index/dedupe context to update existing memories, and audit truncation without putting full memory corpus into the worker prompt.
  - Plan: add a regression with an oversized memory root proving the worker prompt is bounded and still includes deterministic dedupe fields.

- P1 — Dry-run proposal validation.
  - Status: open; dry-run planning checks caps and prints proposed topic/index content but returns before invoking the reference validator.
  - Plan: validate a temporary/proposed memory-root state before dry-run stdout, while leaving the real memory root unchanged.
  - Plan: add regression coverage for a dry-run proposal that only the validator can reject, such as a broken local markdown link in the proposed topic body.

- P1 — Frontmatter parser alignment in worker dedupe.
  - Status: open; worker-local frontmatter parsing treats flat top-level `type:` as typed, while the reference validator rejects flat `type:` outside `metadata.type`.
  - Plan: reuse/export a shared parser or make the worker parser accept only validator-conformant `metadata.type` for trusted type matching.
  - Plan: add a worker regression with an existing flat-`type:` topic proving dedupe cannot rely on validator-invalid type metadata.

- P1 — Worker draft contract strictness.
  - Status: open; `normalizeDraft()` truncates over-cap descriptions/hooks instead of refusing all malformed worker drafts.
  - Plan: refuse worker-supplied descriptions that exceed the 200-character cap; keep hook fitting only where the adapter intentionally trims to satisfy the rendered `MEMORY.md` pointer-line cap, or document/refine the contract if hook trimming remains desired.
  - Plan: add tests for over-cap descriptions and delete reasons so malformed live JSON cannot be normalized into accepted output.

- P1 — Delete drafts must target topic memories only.
  - Status: open; delete drafts reject `MEMORY.md` and out-of-root paths, but any existing `.md` file under the root can be deleted without first proving it is a valid topic memory.
  - Plan: before delete planning, require valid topic frontmatter and an index pointer for the target, or use the reference validator/topic parser to classify it as an existing topic memory.
  - Plan: add regressions for deleting an unindexed markdown file and a markdown file with invalid/missing frontmatter.

- P1 — Prompt fallback block length.
  - Status: open; SPEC §3.5 caps prompt-bakeable write protocol blocks at 80 lines, while `adapters/pi-dev/memory-protocol.md` is currently over that cap.
  - Plan: compress the fallback protocol without dropping disabled/ignore/dry-run, two-step save, dedupe, exclusions, validation, and read-verification requirements.
  - Plan: add a simple line-count regression or documented check so future protocol edits do not drift past the cap.

- P2 — Compactor parser alignment.
  - Status: open; `reference/compactor.ts` also uses a local regex parser that can treat flat top-level `type:` as a trusted compaction group, unlike the validator.
  - Plan: keep validator findings in the compaction report, but do not classify flat `type:` as a trusted `metadata.type`; group invalid/unknown topics conservatively.
  - Plan: add a compactor regression for flat `type:` frontmatter showing both the validator finding and expected proposal grouping.

- P2 — Live harness cadence.
  - Status: opt-in by design; `tests/pi-dev-live-integration.test.ts` is skipped unless `PI_MEMORY_INTEGRATION=1`, per `specs/07`.
  - Plan: after model/auth/preflight changes or pi.dev upgrades, run `bun run test:pi-live` intentionally and record the latest result in this plan.

- Completed — Core pi-dev forced-write surface.
  - Model preflight now validates only provider-qualified shape; `worker.ts` no longer calls `pi --list-models`, reachability comes from the no-tools subprocess, docs/specs/tests were updated, and `bunx tsc --noEmit && bun test` passed with 94 pass and 7 skip.
  - Event batching/debounce/max-batch/compaction flush are implemented and test-covered.
  - Disabled mode prevents bootstrap, reads, writes, validation, queueing, and worker launch; ignore mode suppresses injection, writes, citations/application, and validation/refresh/flush behavior as documented.
  - Live worker launch uses an env-capable subprocess path with `PI_MEMORY_ENABLED=0`, no extensions/context/skills/session/tools, and fails closed when env forwarding cannot be proven.
  - Applicator is the write authority for upsert/delete drafts, performs root canonicalization, two-step topic/index updates, adapter cap checks, reference validation, rollback on validation failure, and queue retention on failure.
  - Bounded turn-start injection uses relevant `MEMORY.md` index snippets only, capped at 12 lines or 4 KB, visibly attributed as durable advisory context.
  - Command surface exists for status, validate, flush, and refresh, subject to the open write-boundary item above.
  - Reference validator, migrator, and compactor CLIs/APIs exist; migrator intentionally normalizes historical flat `type:` frontmatter under `specs/10`.
