# 05 — Safety Boundaries and Verification Strategy

This spec is cross-cutting: it defines the hard safety boundaries the other specs must
respect and the test strategy that proves the extension behaves. Per backpressure-driven
development, the tests in this spec must exist and fail before implementation begins (Red Gate).

## Safety boundaries (hard constraints)
- **Write confinement.** No write, by the extension or its worker, lands outside the resolved
  memory root or the host's own config (SPEC §6.3). For memory writes, the resolved memory
  root is the allowlisted boundary: write targets are canonicalized and accepted only when
  they remain inside that root. An attempted out-of-root write fails closed.
- **Recursion guard.** The worker subprocess runs with the extension disabled in its
  environment so it cannot trigger itself into an unbounded fork. Before relying on env-based
  disabling, confirm the host's subprocess call forwards environment; if it does not, the
  worker must not be spawned (fail closed) rather than risk recursion.
- **Disabled and ignore modes** (SPEC §4.4, §4.5) are honored in every handler.
- **No global install during development.** The extension is exercised project-local or via
  the test harness; it is never copied into the global pi extensions directory during build,
  so it cannot leak into unrelated pi sessions.
- **Dry-run** produces proposed output and a zero-diff tree.

## Verification strategy

### Toolchain
- Type-check and tests run under bun: a type-check pass and a `bun test` pass together
  constitute the green gate. Tests run single-threaded (exactly one test runner) so failures
  are not masked.

### Required test coverage (write these first; they must fail before code exists)
- **Modes:** disabled ⇒ no I/O and truthful status; ignore ⇒ no writes/citations; dry-run ⇒
  proposals only, clean tree.
- **Batching:** rapid turns in one window ⇒ one run; max-batch ⇒ immediate run; compaction ⇒
  forced flush without cancelling compaction.
- **Worker decisions:** chatter ⇒ no write; one durable decision ⇒ one conformant topic file
  plus one index pointer; repeat fact ⇒ update not duplicate.
- **Spec conformance of writes:** frontmatter valid, two-step save complete, index line stays
  one line — verified by invoking `reference/validator.ts` against the produced memory root.
- **Confinement:** out-of-root write attempt is refused.
- **Recursion guard:** worker environment carries the disable flag; if env forwarding is
  unavailable the worker is not spawned.
- **Injection:** no overlap ⇒ nothing injected; overlap ⇒ small visible attributed snippet.

### Worker isolation in tests
- Tests never call a real model for write decisions; they use dry-run or a stubbed worker so
  the suite is deterministic, offline, and free.

## Verification signals
- `bunx tsc --noEmit && bun test` is green with a single test runner.
- The reference validator reports zero errors against memory directories produced in tests.
- No test mutates anything outside its temporary memory root.
