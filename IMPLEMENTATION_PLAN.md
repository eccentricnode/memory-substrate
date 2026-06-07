<!-- Generated and maintained by Ralph (plan + build modes). Priority-sorted. -->

- P0 — pi-dev forced-write extension.
  - Status: completed and verified, including the new manual `memory-flush` command.
  - Completed: live worker runner uses an env-capable launcher and runs child `pi` with `PI_MEMORY_ENABLED=0` plus isolation flags.
  - Completed: root-confined applicator remains the write authority and enforces two-step saves: topic file plus `MEMORY.md` pointer.
  - Completed: status, validate, and flush commands are present.
  - Completed: specs/04 and specs/05 wording tensions are resolved.
  - Completed: failed/refused flushes report clear failed/refused status, retain queued candidates, and are covered by lifecycle plus `memory-flush` command regression tests.
  - Completed: worker canonicalizes new in-root topic paths before indexing.
  - Completed: worker preflights `MEMORY.md` line and byte caps before mutating files.
  - Completed: post-write validation failure rolls back affected topic/index files plus empty created directories.
  - Completed: compaction event structured `summary`/`preparation` content reaches the worker decision text as candidate content.
  - Completed: queue and worker audit records include bounded payload summaries and item summaries.
  - Completed: prompt, config, and flush ignore-mode transitions are audited for false-positive debugging.
  - Completed: ignore mode injects a protective no-cite/no-apply instruction while avoiding memory reads.
  - Follow-up: dry-run writes nothing and returns `proposedPaths`, but stdout currently reports only the proposed write count rather than detailed proposed paths/content inline.
  - Verified: targeted tests passed: `bun test tests/worker-write.test.ts tests/lifecycle-and-worker.test.ts tests/config-and-injection.test.ts`; exit 0, 32 pass, 139 assertions across 3 files.
  - Verified: green gate passed via exactly one test subagent: `bunx tsc --noEmit && bun test`; exit 0, 52 pass, 253 assertions across 8 files.

- P0 — Config and mode gates.
  - Status: completed and test-covered.
  - Completed: enabled/disabled, ignore, dry-run, memory root, model default, debounce, and max batch defaults.
  - Completed: `PI_MEMORY_ENABLED=0` prevents bootstrap, reads, writes, injection, queueing, worker invocation, and validation.
  - Completed: host/substrate disabled signals are supported through `RuntimeConfig.disabledReason` and pi-dev adapter host/context/integration disabled checks before memory root resolution.
  - Completed: ignore mode prevents injection, writes, citations, and application.
  - Verified: focused tests passed: `bun test tests/config-and-injection.test.ts tests/validate-command.test.ts`; exit 0, 20 pass, 68 expectations.
  - Verified: green gate passed via exactly one test subagent: `bunx tsc --noEmit && bun test`; exit 0, 54 pass, 262 expectations.

- P0 — Memory injection.
  - Status: completed and test-covered.
  - Completed: `before_agent_start` reads `MEMORY.md`, ranks index lines by prompt overlap, and injects attributed snippets only.
  - Completed: disabled and ignore modes inject nothing.
  - Completed: injection audit records include selected line count, byte length, caps, selected lines, and truncation status.
  - Bounds: no topic-file bodies; cap at 12 index lines or 4 KB, whichever is smaller.
  - Verified: focused tests passed via the single test subagent: `bun test tests/config-and-injection.test.ts`; exit 0, 13 pass.
  - Verified: green gate passed via the single test subagent: `bunx tsc --noEmit && bun test`; exit 0, 56 pass.

- P0 — Host safety boundaries.
  - Status: preserved through the verified implementation.
  - Preserve: no global install into `~/.pi/agent/extensions/`.
  - Preserve: child workers must receive `PI_MEMORY_ENABLED=0`; unsupported `pi.exec` env forwarding must keep failing closed.
  - Preserve: all writes stay confined to the resolved memory root and refuse symlink/out-of-root escapes.
  - Preserve: default worker model is `claude-haiku-4-5`; `PI_MEMORY_MODEL` overrides.
  - Verified: default `~/.memory` root resolution is covered in `tests/config-and-injection.test.ts`.

- P1 — Reference validator.
  - Status: completed and verified.
  - Completed: importable `validateMemoryDirectory` API added while preserving CLI behavior.
  - Completed: validator checks description length, rejects `MEMORY.md` frontmatter, checks filename/name consistency, rejects markdown in descriptions, detects root-escaping/broken links and invalid index lines, reports unresolved `[[name]]` links as info, and treats topic files missing from `MEMORY.md` as two-step-save errors.
  - Unresolved review findings: stricter validator requirements for canonical em dash index pointers, flat type coercion, topic markdown links, and target file type/name form.

- P1 — pi-dev adapter docs/protocol.
  - Status: completed and verified.
  - Completed: `adapters/pi-dev/README.md` and `adapters/pi-dev/memory-protocol.md` document the extension-first forced-write path, bounded injection behavior, command surface, validator/root paths, and canonical index pointer format.

- P2 — Later extension capabilities.
  - Status: compactor and migrator completed.
  - Completed: `reference/compactor.ts` adds a CLI/API that reads the memory root, emits proposed `MEMORY.md` plus `COMPACTION_REPORT.md` to an output directory outside the root, and does not mutate durable memory.
  - Verified: compactor covered by `tests/reference-compactor.test.ts`.
  - Completed: `reference/migrator.ts` adds a CLI/API that converts historical PAI-shaped memory directories into a reviewable `memory/` proposal plus `MIGRATION_REPORT.md` without mutating the source.
  - Completed: migrator normalizes flat `type:` frontmatter into `metadata.type`, infers frontmatter for imported markdown files, rebuilds a validator-clean `MEMORY.md`, records ambiguous/non-pointer/broken/duplicate source index lines in the report, and validates the proposed memory root with `reference/validator.ts`.
  - Verified: focused migrator tests passed: `bun test tests/reference-migrator.test.ts`; exit 0, 2 tests, 25 expectations.
  - Verified: migrator processed the historical PAI memory root from `STRATEGY.md` in a temporary proposal; exit 0, 93/93 topic files migrated, proposed index 103 lines, no output-validation failure.
  - Verified: green gate passed via exactly one test subagent: `bunx tsc --noEmit && bun test`; exit 0, 46 tests, 212 expectations across 8 files.
  - Unresolved review findings: add audit schema coverage.
  - Current finding: specs define `reference/migrator.ts` but do not formally define the PAI-shaped input schema; the implementation therefore uses conservative inference and makes every inferred/ambiguous conversion reviewable in `MIGRATION_REPORT.md`.
