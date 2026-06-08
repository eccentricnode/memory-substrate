# 07 — Live Configuration Resolution and Integration Verification

This spec is derived from a live smoke test of the extension in real pi.dev sessions
(2026-06-08). It corrects model-resolution defects found only at runtime and mandates a
rigorous, repeatable integration layer that exercises real inputs and outputs — distinct
from the existing offline unit tests.

## Evidence (what the smoke test established)
- The extension loads in a real pi session, observes `agent_end`, runs the recursion-guarded
  worker subprocess, and writes a spec-conformant memory confined to the resolved root.
- A durable turn produced a valid `project` memory with two-step save; chatter produced no
  write; disabled mode produced no write; nothing escaped the configured memory root.
- Three defects surfaced that the offline unit suite could not catch. They are now contract.

## Jobs to be done
- The extension's default configuration works out-of-the-box on this host without manual model
  surgery.
- A model that cannot be reached fails loudly and is audited, never silently no-ops a write.
- The team can re-run the live behavior (the four smoke cases) on demand as a real
  integration check, without that check polluting any real memory directory or slowing the
  offline green gate.

## Behavioral contract

### Model resolution (corrects findings 1 and 2)
- The worker invokes its model through pi as a subprocess. Model identifiers MUST be resolved
  in a provider-qualified form (`<provider>/<model-id>`); a bare model id that matches more
  than one provider is not acceptable, because it silently resolves to an unintended,
  possibly unauthenticated provider.
- The default worker model MUST be one that is reachable on this host's authenticated
  providers. `claude-haiku-4-5` is NOT acceptable as the default here: pi.dev calling
  Anthropic is rejected with a third-party-usage error on this account, and the bare id is
  ambiguous because the registry lists it under multiple providers. The default MUST be a
  reachable provider-qualified model; `openai-codex/gpt-5.3-codex-spark` is the verified
  working choice and the required default as of 2026-06-08. `PI_MEMORY_MODEL` overrides it
  only if the override is also reachable.
- When the configured worker model cannot be reached (auth error, unknown provider,
  ambiguous id), the worker run MUST fail closed: no partial write, an explicit audited
  error, and the queued candidates retained for a later attempt — never a silent success.
- Reachability MUST NOT be determined by membership in `pi --list-models` output. That
  listing omits authenticated providers that do not enumerate their catalog (the
  `openai-codex` provider is not listed there, yet `openai-codex/gpt-5.3-codex-spark` is
  fully reachable), and the listing has been observed to return empty. A preflight that
  gates on `--list-models` membership wrongly rejects the verified default and makes every
  worker run fail closed — this is a regression and is prohibited. The preflight MUST
  validate only that the configured model is provider-qualified in form; actual reachability
  is established by the real worker subprocess call, whose genuine auth/invocation failure
  drives the existing fail-closed path. This rule MUST be covered by an offline unit test
  (no real model call) asserting that a provider-qualified model absent from a stubbed/empty
  `--list-models` is accepted by the preflight, so the green gate catches any regression.

### Index hook length (corrects finding 3)
- When the worker (or the extension applying its draft) writes the `MEMORY.md` pointer, the
  one-line hook MUST be held at or under the SPEC §2.5 cap (150 characters). The worker's
  instructions MUST direct it to produce a hook within the cap, and the applier SHOULD reject
  or trim a pointer that exceeds it rather than emit a validator warning.

### Integration verification layer (the rigorous testing)
- A dedicated integration verification harness MUST exist, separate from the offline unit
  suite. It drives a REAL pi.dev session with the extension loaded against a disposable
  sandbox memory root, and asserts on both inputs and outputs.
- It MUST run, at minimum, the four smoke cases as explicit pass/fail assertions:
  1. Load — the extension initializes in a real session with no error.
  2. Durable turn — a turn carrying a durable fact produces exactly one spec-conformant topic
     file plus one in-cap index pointer, in the sandbox, and the reference validator reports
     zero errors against it.
  3. Chatter turn — a trivial turn produces zero topic files.
  4. Disabled mode (`PI_MEMORY_ENABLED=0`) — a durable turn produces zero writes and no worker
     invocation.
- Input assertions: the harness MUST confirm the worker's resolved model is provider-qualified
  and reachable (the run does not fail with an auth/provider error), and that mode flags
  (`PI_MEMORY_ENABLED`, `PI_MEMORY_IGNORE`, `PI_MEMORY_DRY_RUN`) take effect.
- Output assertions: written files are spec-conformant (validator clean), the two-step save is
  complete, and — the hard one — NOTHING is written outside the sandbox memory root. The
  harness MUST fail if any path under a real default root (e.g. `~/.memory`) is touched.
- Isolation: the harness MUST use a freshly created temporary memory root per run and MUST set
  the main session to use no file tools, so only the extension can write. It MUST NOT write to
  any real memory directory under any circumstance.
- Separation from the green gate: this harness MUST NOT run as part of the default
  `bun test` / green-gate invocation (it makes real, paid model calls). It MUST be opt-in —
  gated behind an explicit command or environment flag (e.g. `PI_MEMORY_INTEGRATION=1`) — and
  documented in `AGENTS.md` with the exact command to run it.

## Verification signals
- With no `PI_MEMORY_MODEL` set, a real durable turn writes a memory (default model is
  reachable) — proving the default works out of the box.
- A deliberately bad `PI_MEMORY_MODEL` causes an audited fail-closed with retained queue and
  no write.
- A produced index pointer never exceeds 150 characters; the validator reports zero warnings
  of that class.
- The integration harness, run opt-in, passes all four cases and asserts zero out-of-root
  writes; the offline `bun test` green gate still runs without any real model call.
