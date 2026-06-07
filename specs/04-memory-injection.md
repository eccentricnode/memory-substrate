# 04 — Relevant Memory Injection

Before the main agent starts a turn, the extension may inject a small, relevant slice of
durable memory — never the whole corpus. Indiscriminate injection would defeat the
context-saving purpose of the substrate.

## Jobs to be done
- The main agent gains relevant prior context at turn start without the operator pasting it.
- Injected content is small, visible, and clearly attributed as durable memory.
- Irrelevant or absent matches inject nothing.

## Behavioral contract

### Trigger and surface
- Relevance is evaluated at the start of an agent turn against the incoming prompt. (Host
  surface: `before_agent_start`, which can inject a message or modify the system prompt.)
- For pi.dev, this bounded turn-start injection is the adapter-specific delivery of SPEC
  §4.1 bootstrap context. The extension may initialize or cache memory state at session
  start, but model-visible memory is injected only as relevant index snippets under this
  spec's caps, not as an unconditional full-index dump.
- When nothing relevant is found, the extension injects nothing and does not alter the prompt.

### Relevance and size
- A first-pass relevance check scans the index (`MEMORY.md`) for overlap with salient terms
  in the prompt; a better ranker may replace it later without changing this contract.
- Injected content is bounded to a small snippet (a slice of the index, not topic-file
  bodies) and is marked as durable memory so the operator can see what was added.
- Injection respects ignore mode (SPEC §4.4) and disabled mode (SPEC §4.5): in either, nothing
  is injected.

### Non-bias
- Injected memory is advisory context, not instruction; it must be short, relevant, and
  visible so it cannot silently steer the main agent.

## Verification signals
- A prompt with no term overlap against the index injects nothing.
- A prompt overlapping a stored topic injects a small, visible, attributed snippet bounded
  to the size cap.
- With ignore mode or disabled mode active, no injection occurs regardless of overlap.
