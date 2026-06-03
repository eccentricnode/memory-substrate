# pi.dev adapter

Thinnest possible adapter: append the memory protocol to pi.dev's system prompt. pi.dev has the same Read/Bash/Edit/Write surface as Claude Code, so once it knows about `~/.memory/` and the write protocol, it uses standard file tools to do everything.

## Install (per-invocation)

```bash
pi -p --append-system-prompt @~/Work/active/memory-substrate/adapters/pi-dev/memory-protocol.md \
  "your prompt here"
```

Anything you can do with pi.dev now sees and respects `~/.memory/`.

## Install (project-default)

If a project uses pi.dev as its agent, add the protocol to the project's `AGENTS.md`:

```markdown
<!-- in your AGENTS.md -->
@~/Work/active/memory-substrate/adapters/pi-dev/memory-protocol.md
```

(Or copy the content directly into AGENTS.md if you don't want a runtime dependency on this path.)

## Install (global, optional)

To make every pi.dev session aware of memory by default, set the protocol as a default system prompt in your pi.dev config or shell alias:

```bash
alias pim='pi --append-system-prompt @~/Work/active/memory-substrate/adapters/pi-dev/memory-protocol.md'
```

Then `pim -p "..."` is your memory-aware pi.dev.

## Disable per session

```bash
pi -p "ignore memory: ..."  # honors §4.4 ignore mode
```

Or omit `--append-system-prompt` entirely and the agent doesn't see the protocol.

## What this does NOT do

- Does not auto-save (no hook surface). The agent decides when to save based on the prompt rules.
- Does not enforce caps at write time (no wrapper around the Write tool). The validator catches violations after.
- Does not handle concurrent writes specially. Relies on the file-format-as-contract discipline (proven concurrent-safe in PAI testing).
