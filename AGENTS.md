# AGENTS.md — memory-substrate

Operational contract for Ralph. Status/progress live in `IMPLEMENTATION_PLAN.md`, not here.

## What this repo is
Substrate-neutral spec for agent memory (`SPEC.md`) + per-host adapters. Current Ralph
target: the **pi.dev event-driven extension** — the pi-dev adapter's §6.2 forced-write
capability. Source: `adapters/pi-dev/extension/`. Shared lib: `reference/`. Host: pi.dev
(pi-coding-agent, installed `~/.local/bin/pi`, v0.78.1).

## Toolchain (bun always — never npm/npx)
- Type-check: `bunx tsc --noEmit`
- Test:       `bun test`
- Reactive read-side research: opt in with `PI_MEMORY_REACTIVE=1`; covered by normal
  `bunx tsc --noEmit && bun test`. Live behavior remains `bun run test:pi-live`.
- Run validator: `bun reference/validator.ts <memory_root>`
- Run migrator:  `bun reference/migrator.ts <pai_root> <output_dir>`
- Opt-in live pi.dev harness: `bun run test:pi-live` (real pi/model calls; not green gate)
- In `pi --print`, `ctx.hasUI` is false, so `ctx.ui.notify` slash-command output is
  not observable; assert command UI via RPC/interactive mode, and keep `test:pi-live`
  to print-observable agent/tool/reactive behavior.
- Inspect pi extension API: `~/.local/share/mise/installs/node/25.1.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- Working extension template to copy patterns from: `~/Work/active/pai-lite/extensions/blueprint-loader.ts`
- Inspect model names: `pi --list-models` (advisory only; worker reachability is the no-tools subprocess; see invariant 6)

## Green-build gate
A loop is green only when BOTH pass with **exactly 1** test subagent:
`bunx tsc --noEmit && bun test`. Concurrent test runs hide failures — that's the backpressure.

## Invariants (never violate — these are safety + isolation boundaries)
1. **Confine writes.** The extension and its worker MUST write only inside the resolved
   memory root (SPEC §6.3). Never mutate files elsewhere except the host's own config.
2. **Disabled mode is law.** `PI_MEMORY_ENABLED=0` ⇒ no bootstrap, no reads, no writes
   (SPEC §4.5). Ignore mode (SPEC §4.4) ⇒ no writes, no citations.
3. **Recursion guard.** The background worker is a `pi` subprocess; it MUST run with the
   extension disabled (pass `PI_MEMORY_ENABLED=0` in its env) so it cannot re-trigger itself.
   Installed pi.dev v0.78.1 `pi.exec` / `ExecOptions` has no env forwarding; fail closed
   unless using a safe env-capable launcher.
4. **No global install during build/test.** Do NOT copy the extension into
   `~/.pi/agent/extensions/` — it would load into every pi session. Develop and test it
   project-local (`.pi/extensions/` or via the test harness) only.
5. **Dry-run before live.** Tests MUST NOT call a real model for write decisions. Use
   `PI_MEMORY_DRY_RUN=1` (prints proposed changes, writes nothing) or a stubbed worker.
6. **Reachable model.** Background worker default is `openai-codex/gpt-5.3-codex-spark`;
   Anthropic `claude-haiku-4-5` currently fails third-party usage auth. `PI_MEMORY_MODEL` overrides.
7. **Use the reference validator** (`reference/validator.ts`) — do not reimplement (SPEC §7).
8. **Two-step save** (SPEC §3.3): topic file + `MEMORY.md` pointer, or it's an error.

## Substrate note (concurrent Ralph awareness)
Another Ralph may be running in a different repo. State here is fully repo-local
(`scripts/ralph/runs/`), so no collision. Only shared resource is codex/claude API quota.
