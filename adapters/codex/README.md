# codex exec adapter

codex exec reads `AGENTS.md` from the cwd and its ancestors as its system context surface. To make a codex session memory-aware, the memory protocol goes into `AGENTS.md`.

## Install (per-project)

Append the protocol to your project's `AGENTS.md` (or create one if none exists):

```markdown
<!-- in your project's AGENTS.md -->
... your existing AGENTS.md content ...

---

# Memory protocol

(paste the contents of ~/Work/active/memory-substrate/adapters/codex/memory-protocol.md here)
```

Or, if you don't want to inline the content, codex will follow markdown links — so this often works:

```markdown
See ~/Work/active/memory-substrate/adapters/codex/memory-protocol.md for the memory protocol you MUST follow.
```

Less reliable than inlining — codex doesn't always traverse references unless prompted. Inlining is safer.

## Install (global)

There is no canonical global `AGENTS.md` location for codex exec. The closest equivalents:

- Symlink the protocol into every project's tree — fragile.
- Pre-append the protocol to every prompt via a shell wrapper — works, here is one:

```bash
codex-mem() {
  local memprompt
  memprompt=$(cat ~/Work/active/memory-substrate/adapters/codex/memory-protocol.md)
  codex exec "$@" "Background context — follow this memory protocol throughout:

$memprompt"
}
```

Then `codex-mem --add-dir ~/.memory "your prompt"`.

## Invocation requirements

Whenever invoking codex with the memory protocol, always:

```bash
codex exec --add-dir ~/.memory ...
```

Without `--add-dir ~/.memory`, codex's sandbox rejects reads/writes outside cwd.

## What this does NOT do

- Does not auto-save (no hook surface in codex).
- Does not enforce caps at write time. Run the reference validator after to check.
- Does not handle concurrent writes specially. Relies on the file-format-as-contract discipline.
