<!-- Generated and maintained by Ralph (plan + build modes). Priority-sorted. -->

- P0 — pi-dev forced-write extension.
  - Status: completed and verified, including the new manual `memory-flush` command.
  - Completed: live worker runner uses an env-capable launcher and runs child `pi` with `PI_MEMORY_ENABLED=0` plus isolation flags.
  - Completed: root-confined applicator remains the write authority and enforces two-step saves: topic file plus `MEMORY.md` pointer.
  - Completed: status, validate, and flush commands are present.
  - Completed: specs/04 and specs/05 wording tensions are resolved.
  - Verified: focused command tests passed: `bun test tests/validate-command.test.ts`; exit 0, 7 tests, 24 expectations.
  - Verified: green gate passed via exactly one test subagent: `bunx tsc --noEmit && bun test`; exit 0, 40 tests, 156 expectations.

- P0 — Config and mode gates.
  - Status: completed and test-covered.
  - Completed: enabled/disabled, ignore, dry-run, memory root, model default, debounce, and max batch defaults.
  - Completed: `PI_MEMORY_ENABLED=0` prevents bootstrap, reads, writes, injection, queueing, worker invocation, and validation.
  - Completed: ignore mode prevents injection, writes, citations, and application.

- P0 — Memory injection.
  - Status: completed and test-covered.
  - Completed: `before_agent_start` reads `MEMORY.md`, ranks index lines by prompt overlap, and injects attributed snippets only.
  - Completed: disabled and ignore modes inject nothing.
  - Bounds: no topic-file bodies; cap at 12 index lines or 4 KB, whichever is smaller.

- P0 — Host safety boundaries.
  - Status: preserved through the verified implementation.
  - Preserve: no global install into `~/.pi/agent/extensions/`.
  - Preserve: child workers must receive `PI_MEMORY_ENABLED=0`; unsupported `pi.exec` env forwarding must keep failing closed.
  - Preserve: all writes stay confined to the resolved memory root and refuse symlink/out-of-root escapes.
  - Preserve: default worker model is `claude-haiku-4-5`; `PI_MEMORY_MODEL` overrides.

- P1 — Reference validator.
  - Status: completed and verified.
  - Completed: importable `validateMemoryDirectory` API added while preserving CLI behavior.
  - Completed: validator checks description length, rejects `MEMORY.md` frontmatter, checks filename/name consistency, rejects markdown in descriptions, detects root-escaping/broken links and invalid index lines, reports unresolved `[[name]]` links as info, and treats topic files missing from `MEMORY.md` as two-step-save errors.
  - Known unresolved gaps: none currently documented.

- P1 — pi-dev adapter docs/protocol.
  - Status: completed and verified.
  - Completed: `adapters/pi-dev/README.md` and `adapters/pi-dev/memory-protocol.md` document the extension-first forced-write path, bounded injection behavior, command surface, validator/root paths, and canonical index pointer format.

- P2 — Later extension capabilities.
  - Status: deferred.
  - Remaining: SPEC §7 compactor/migrator reconciliation.
