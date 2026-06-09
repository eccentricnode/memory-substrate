# 12 — Reactive Memory Trigger (event-driven read)

The read-side mirror of the write-worker's event reactivity. The write-worker
hooks `agent_end` and auto-writes. This hooks **`before_agent_start`** and, when
the turn actually needs durable memory, **auto-fires the research sub-agent
(spec 11) and injects its synthesis** — so the main agent gets the relevant
memory without having to call a tool.

## Why

`memory_research` (spec 11) is pull-only: the agent must remember to call it.
This adds the push: the system reacts to the turn's needs and triggers research
itself. It is the same event-reactive pattern the worker already proves, applied
to reads.

## Surface

- Extends the existing `before_agent_start` handler in
  `adapters/pi-dev/extension/` (the one that already does bounded index injection).
- One reactive fire **per turn**, maximum.

## The gate (cheap — no model call, no SFPAI dependency)

The trigger MUST decide cheaply whether the turn needs deep research, then fire
only when warranted. **It must NOT call a model on every turn** (that is the
per-turn-tax anti-pattern) and MUST NOT depend on SFPAI / `inference`. Use signals
already available in `before_agent_start`:

1. **Recall-intent cues** in the user prompt — phrases asking about durable past
   ("remember", "we decided", "last time", "prior", "earlier", "what did we",
   "did we", "previously", etc.).
2. **Index overlap** — reuse the prompt→`MEMORY.md` index ranking the bounded
   injection already computes; a strong-overlap turn is a research candidate.

Fire research when recall-intent cues are present OR index overlap clears a
threshold. Thresholds are Ralph's to tune, pinned by tests. (Model-based gating is
a future *pluggable* option — out of scope here precisely because it can't depend
on SFPAI and a per-turn model call defeats the gate.)

## Behavior

- **Gated-in:** fire `researchMemory(prompt)` (spec 11) in its recursion-guarded
  sub-context; inject the returned synthesis (+ citations), bounded, into the
  system prompt. This synthesis **supersedes** the plain index-line injection for
  that turn.
- **Gated-out:** fall through to the existing bounded index injection only — no
  sub-agent fired.
- A `found:false` research result injects nothing extra (and may fall back to the
  index injection).

## Config & safety

- **Opt-in, default OFF** — a config flag (e.g. `PI_MEMORY_REACTIVE=1`). When off,
  behavior is exactly today's bounded index injection.
- Honors disabled / ignore / dry-run. **Dry-run** reports what it *would* fire and
  inject, writing/injecting nothing.
- Recursion guard: the research child already runs with `PI_MEMORY_ENABLED=0`, so
  the trigger cannot fire inside its own sub-agent. The trigger MUST also never
  fire more than once per turn.
- Injected synthesis is bounded by the same caps as index injection (do not blow
  the main context — the whole point is to keep it lean).

## Backpressure (green gate)

- Mock the gate inputs and `researchMemory` (inject a fake, as the worker/research
  tests do). Deterministic `bun test`, no network:
  - gate fires on recall-intent cues; gate fires on high index overlap; gate skips
    on neither.
  - gated-in injects the synthesis (bounded) and supersedes index injection.
  - gated-out injects only the index lines.
  - `found:false` injects nothing extra.
  - opt-in flag off → today's behavior unchanged.
  - disabled / ignore / dry-run honored; at most one fire per turn.
- Opt-in live test behind the existing integration flag, skipped by default.
- `bunx tsc --noEmit && bun test` green.

## Out of scope

- Model-based gating (future pluggable). Writing memory (the worker). The MCP
  remote mode. Changing spec-11's `memory_research` tool/command surface.
