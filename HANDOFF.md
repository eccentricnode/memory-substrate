# HANDOFF — pi.dev memory extension: port real memory + live-test

**Date:** 2026-06-08
**For:** the next session porting PAI memory into a local pai-lite setup and live-testing the
pi.dev memory-substrate extension, then iterating on the rigor backlog.
**State:** extension is a live-verified v0 — tag `0.0.37`, green gate clean, integration
harness 7/7 against real pi.dev sessions. Canonical `~/.memory` is intact.

---

## HARD RULES (do not violate)

1. **openai-codex only. Anthropic is OUT.** Use codex models for everything — main agent and
   the memory worker. Do not call Anthropic models through pi (blocked for third-party apps on
   this account, and out of scope by decision). The worker default is already a codex model.

2. **Protect the canonical vault.** Never let the extension OR a tool-enabled main agent write
   to canonical `~/.memory`. Point `PI_MEMORY_ROOT` at a **local copy**, and/or run the main
   session `--no-tools`. (A tool-enabled main agent told to "remember/record" will write to
   `~/.memory` itself, bypassing the extension — this already polluted the real vault once.)

3. **Project-local install only.** Load with `-e`; never copy the extension into
   `~/.pi/agent/extensions/` (it would load into every pi session).

---

## Working config (known-good)

```bash
# model — provider-qualified; bare ids mis-resolve, codex isn't in `pi --list-models` but IS reachable
export PI_MEMORY_MODEL="openai-codex/gpt-5.3-codex-spark"
export PI_MEMORY_ROOT="<a LOCAL dir, NOT ~/.memory>"

# load extension project-local
pi -ne -e ./adapters/pi-dev/extension/index.ts --no-tools --model "openai-codex/gpt-5.3-codex-spark"
```

Mode/tuning env knobs:
- `PI_MEMORY_ENABLED=0` — disabled (no bootstrap/read/write/worker)
- `PI_MEMORY_IGNORE=1` — ignore (no injection/writes)
- `PI_MEMORY_DRY_RUN=1` — worker proposes, writes nothing
- `PI_MEMORY_MAX_BATCH_ITEMS=1` — forces immediate flush at turn end (use for `-p` testing; the
  worker is otherwise debounced and may not fire before a `-p` process exits)
- `PI_MEMORY_DEBOUNCE_MS` — debounce window

Verify:
- Green gate (offline, fast, no model calls): `bunx tsc --noEmit && bun test`
- Live integration harness (real codex calls, opt-in): `PI_MEMORY_INTEGRATION=1 bun run test:pi-live`

---

## Porting real memory

- `~/.memory` already mirrors the PAI auto-memory (~94 files, same basenames as
  `~/.claude/projects/-home-ajohnson-Work/memory/`).
- **Only 54 of 95 files have proper `metadata:` frontmatter** — the rest are older flat-format
  (`type:` at top level) that the validator flags. This is the real-world data that will exercise
  the parser-consistency gap below.
- Normalize PAI-shape → substrate format into a LOCAL dir with the migrator:
  ```bash
  bun reference/migrator.ts <pai_root> <local_output_dir>
  ```
  Then set `PI_MEMORY_ROOT=<local_output_dir>`. Never migrate over the canonical vault in place.

---

## How the extension works (orientation)

- Hooks pi events: `agent_end`, `session_before_compact` → debounced/batched.
- On flush: spawns a recursion-guarded worker — a separate `pi` subprocess, `--no-tools`, run
  with `PI_MEMORY_ENABLED=0` in its env (via `child_process.spawn`, because `pi.exec` can't set
  child env). Worker returns a structured draft; the extension applies the write, confined to the
  memory root, two-step (topic file + `MEMORY.md` pointer).
- `before_agent_start` injects only a small relevant index slice (cap 12 lines / 4 KB).
- Registers `/memory-status`, `/memory-validate`, `/memory-flush`, `/memory-refresh`.

---

## Open rigor backlog (iterate after live test)

In rough priority:
1. **Parser consistency (biggest)** — worker, `reference/validator.ts`, and `reference/compactor.ts`
   handle flat top-level `type:` vs `metadata.type` differently. They must agree. The 41
   flat-format files in real memory will expose this immediately.
2. Dry-run should run the validator before printing proposals.
3. Delete-drafts can target any `.md` under root, not just verified topic files.
4. `adapters/pi-dev/memory-protocol.md` exceeds the SPEC §3.5 80-line cap.
5. Worker prompt cites "SPEC §3" but doesn't enumerate the full trigger/exclusion/dedupe/
   stale-correction/two-step rules.
6. `agent_end` passes whole turn messages to the worker (should be bounded; tool results out of scope).
7. Audit collapses `validation-failed` into `failed` (weaker operator visibility).
8. Partial-write atomicity — interruption between topic-file writes and the index write.

---

## Authoritative sources in-repo
- `SPEC.md` — the memory contract. `specs/*.md` — adapter contracts (07 = live config + integration).
- `AGENTS.md` — operational invariants. `IMPLEMENTATION_PLAN.md` — current open items.
- `tests/pi-dev-live-integration.test.ts` — the live harness (the 4 smoke cases + more).
