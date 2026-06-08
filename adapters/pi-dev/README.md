# pi.dev adapter

pi.dev binding for memory-substrate. The active target is the event-driven extension in
`extension/`; `memory-protocol.md` is the prompt-bakeable protocol block for fallback or
manual installations.

## Extension behavior

The extension:

- Resolves the memory root from `PI_MEMORY_ROOT`, defaulting to `~/.memory`.
- Injects only relevant `MEMORY.md` index snippets before an agent turn, capped at 12
  lines or 4 KB.
- Queues completed `agent_end` turns and `session_before_compact` moments for a debounced
  background write decision.
- Launches the live worker with `PI_MEMORY_ENABLED=0` and no extensions/context/skills so
  it cannot recurse into itself.
- Applies structured worker drafts itself, confined to the memory root, then runs
  `reference/validator.ts`.
- Registers `/memory-status`, `/memory-validate`, `/memory-flush`, and
  `/memory-refresh`.

The worker default model is `openai-codex/gpt-5.3-codex-spark`; set `PI_MEMORY_MODEL`
to override it with another reachable provider-qualified model. The live worker preflights
the selected model against `pi --list-models` before sending candidate memory.

## Local development load

Use project-local loading or an explicit extension flag while developing. Do not install this
extension globally during build/test work.

```bash
pi -e ./adapters/pi-dev/extension/index.ts
```

For project-local auto-discovery, place or symlink the extension under `.pi/extensions/`
for that project only, then use `/reload` inside pi.dev.

## Environment knobs

```bash
PI_MEMORY_ENABLED=0       # disabled mode: no bootstrap, reads, writes, validation, or worker
PI_MEMORY_IGNORE=1        # ignore mode: no injection or writes for the session
PI_MEMORY_DRY_RUN=1       # worker proposes paths/changes without writing
PI_MEMORY_ROOT=~/.memory  # memory root; relative paths resolve against pi cwd
PI_MEMORY_MODEL=openai-codex/gpt-5.3-codex-spark
PI_MEMORY_DEBOUNCE_MS=3000
PI_MEMORY_MAX_BATCH_ITEMS=8
```

## Prompt-only fallback

For a prompt-only session without forced writes, append the protocol block:

```bash
pi -p --append-system-prompt @./adapters/pi-dev/memory-protocol.md "your prompt here"
```

That mode relies on the main agent to follow the protocol with ordinary file tools. It does
not provide event batching, background worker decisions, recursion-guarded subprocesses, or
extension commands.

## Verification

Use the repo green gate:

```bash
bunx tsc --noEmit && bun test
```

Run the real pi.dev integration harness only when you intentionally want paid/live model
verification. It loads the extension with `--no-tools` against disposable memory and
session roots, then checks durable, chatter, disabled, dry-run, and bad-model behavior.

```bash
bun run test:pi-live
```

Validate a memory root directly with:

```bash
bun reference/validator.ts <memory_root>
```

Create a reviewable compaction proposal without mutating the memory root:

```bash
/memory-refresh [proposal_output_dir]
```
