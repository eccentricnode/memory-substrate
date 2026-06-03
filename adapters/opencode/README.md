# opencode adapter

opencode reads `AGENTS.md` from the cwd (and `--dir` argument) as its system context surface — the same convention codex exec uses. The memory protocol goes into `AGENTS.md`.

## Install (per-project)

Append the protocol to your project's `AGENTS.md` (or create one):

```markdown
<!-- in your project's AGENTS.md -->
... your existing AGENTS.md content ...

---

# Memory protocol

(paste the contents of ~/Work/active/memory-substrate/adapters/opencode/memory-protocol.md here)
```

Inlining is more reliable than `@`-import references.

## Install (global)

There is no canonical global `AGENTS.md` for opencode. Two reliable options:

1. **Symlink** the protocol into every project tree where you want memory.
2. **Shell wrapper** that pre-appends the protocol on every run:

```bash
opencode-mem() {
  local sandbox=$(mktemp -d -t opencode-mem-XXXXXX)
  cat ~/Work/active/memory-substrate/adapters/opencode/memory-protocol.md > "$sandbox/AGENTS.md"
  opencode run --dir "$sandbox" --dangerously-skip-permissions "$@"
}
```

Then `opencode-mem "your prompt"` is your memory-aware opencode.

## Invocation requirements

- **Filesystem access:** opencode's permission model scopes filesystem reads/writes. `--dangerously-skip-permissions` is required for non-interactive use against `~/.memory/`.
- **Working directory:** use `--dir` to point at a project that has the protocol in `AGENTS.md`, OR run from the project's root.
- **Model:** opencode uses whatever provider/model is configured in `~/.config/opencode/opencode.json`. Memory protocol works across providers.

## What this does NOT do

- Does not auto-save (no hook surface used).
- Does not enforce caps at write time. Run the reference validator after.
- Does not handle concurrent writes specially. Relies on the file-format-as-contract discipline (proven concurrent-safe across CC + pi.dev + codex).
