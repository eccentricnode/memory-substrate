# 11 — Memory Research Sub-Agent (read-side mediator)

The read-side twin of the write-worker. The main agent delegates a memory
question to a **sub-agent** that researches `PI_MEMORY_ROOT` in its *own* context
and returns only a synthesis — so the main session is never polluted with `rg`
output and file reads.

## Context-offload contract (layer-wide)

Every mediator in this layer — this one, plus harvest / learning-distill /
context-search as they land — MUST do its heavy work in a **spawned sub-context**
and return only a synthesis (+ citations) to the caller. The bulk (search
transcripts, file bodies, raw model output) stays in the child and is dropped.
This is the contract for the whole memory-mediator layer, not a per-tool option —
it is *why* these live as sub-agents and not as main-loop work.

## Scope

- In scope: an agent-callable **tool** and a slash **command** that spawn a
  recursion-guarded, **read-only** pi sub-agent to search + synthesize memory.
- Out of scope: writing memory (that is the worker, specs/03/08), the MCP/remote
  access mode (deferred), and retrieval ranking sophistication (v1 is rg-simple;
  see PAI `TOOLS/MemoryRetriever.ts` BM25 as a later upgrade).

## Jobs to be done

- The main agent answers a memory question without burning its context on the search.
- A miss is reported honestly ("no matching memory") instead of hallucinated —
  the certified behavior from the live negative test.
- Results cite the source topic files so the main agent can attribute or deep-read.

## Surface (both — option c)

1. **Agent-callable tool** `memory_research(question: string)` → returns the
   synthesis. This is what keeps the main session clean *by default*. Wire it via
   pi's extension-tool API (pi supports extension tools — confirmed by the
   `--tools`/`--exclude-tools` flags; the API is simply not used in this extension
   yet — reference the pi SDK/docs to register it).
2. **Slash command** `/memory-research <question>` → same handler, manual escape
   hatch. Register exactly like the existing commands via `pi.registerCommand`
   (mirror `adapters/pi-dev/extension/index.ts:269-323`).

Both paths call one shared `researchMemory(question, ctx)` orchestrator.

## Behavioral contract — the sub-agent spawn (mirror worker.ts)

- Spawn with `spawn` from `node:child_process` — **not** `pi.exec` (it cannot set
  child env in this pi.dev version; see `worker.ts:1506`).
- Child env sets **`PI_MEMORY_ENABLED=0`** (recursion guard, so the research
  sub-agent cannot trigger its own research/worker — `worker.ts:109`).
- Model is **provider-qualified** and validated (reuse / mirror
  `validateProviderQualifiedModel`, `worker.ts:885`); default to the same codex
  model as the worker; `PI_MEMORY_MODEL` (or a dedicated `PI_MEMORY_RESEARCH_MODEL`)
  overrides; preflight reachability before sending the question.
- **Tools differ from the worker.** The worker is `--no-tools`; the research
  sub-agent needs **read + search**, so allowlist read + a search capability and
  **deny write/edit** (e.g. `--tools read,bash` with a no-write prompt, or a
  narrower rg-only tool). It runs against `PI_MEMORY_ROOT`.

## Safety (HARD RULES — this sub-agent is more privileged than the worker)

- **Read-only w.r.t. the memory root.** It MUST NOT write to `~/.memory` / the
  resolved root. Enforce by tool allowlist (no write/edit), prompt, and — if pi
  supports it — a permission/sandbox that denies writes under the root. A
  tool-enabled agent writing to the vault is the exact failure the worker avoided
  by being `--no-tools`; here we keep the capability but forbid mutation.
- Recursion guard (`PI_MEMORY_ENABLED=0`) as above.
- codex-only model; Anthropic is out (account/policy).
- Honor disabled / ignore modes (no research when memory is disabled), same gate
  the other commands use (`memoryDisabled(ctx, options)`).

## Return contract

Structured, e.g. `{ found: boolean, answer: string, citations: string[] }`:

- `found: false` → the honest miss path; `answer` states no matching memory and
  MAY name the closest adjacent decisions (the certified negative-test behavior).
- `citations` → topic file paths the synthesis drew from.
- The tool returns the synthesis to the main agent; the command notifies via
  `ctx.ui.notify`. The raw `rg`/read transcript stays in the child and is dropped.

## Backpressure (green gate, mirror the worker's tests)

- Mock the child spawn (inject a fake runner, as `MemoryWorkerRunner` is injected
  in `index.ts`/`core.ts`) and unit-test the orchestrator: recursion-guard env is
  set, args are read-only (no write/edit), provider-qualified model enforced,
  synthesis + citations parsed, `found:false` miss path, disabled/ignore gates.
- Opt-in live test behind the integration flag, alongside
  `tests/pi-dev-live-integration.test.ts` (real codex call, skipped by default).
- `bunx tsc --noEmit && bun test` stays green.

## Verification signals

- Asking a question whose answer is a saved memory returns a synthesis + the right
  citation, and the main session shows none of the search transcript.
- A question with no matching memory returns `found:false` with an honest answer.
- The child always runs with `PI_MEMORY_ENABLED=0` and without write/edit tools.
