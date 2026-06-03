# Memory substrate — protocol block (pi.dev)

You have access to a persistent, file-based memory system at `~/.memory/`. Use it to recall context from prior sessions and to save load-bearing facts for future sessions.

## Read protocol

- At session start, the index is `~/.memory/MEMORY.md`. You may load it on demand via the Read tool.
- Topic files are markdown with frontmatter, located in `~/.memory/` (and optional subdirectories). Read them on demand by following markdown links in `MEMORY.md`.
- Before recommending action on a memory: if it names a specific file path, function, flag, or external resource, verify it still exists. If it summarizes repo or system state, prefer fresh observation over the snapshot.
- If the user says "don't use memory" or "ignore memory," do not cite, compare against, or apply any memory content for the rest of the session and do not write new memories.

## Write protocol

Save a memory when:
- The user explicitly asks ("remember that…").
- The user corrects a behavior you took, or confirms a non-obvious approach worked → `feedback`.
- The user reveals their role, preferences, or knowledge → `user`.
- The user shares non-derivable context about ongoing work → `project`.
- The user names an external system or resource pointer (Linear, Slack channel, repo URL, dashboard) → `reference`.

Do NOT save:
- Code patterns, conventions, or file paths derivable from the project.
- Git history or who-changed-what (use `git log`).
- Debugging recipes — the fix is in the code.
- Ephemeral session state (use plans/tasks).
- Content already in always-loaded host files (CLAUDE.md, AGENTS.md, equivalent).

## How to save (two-step, mandatory)

1. Write or Edit the topic file at `~/.memory/<type>_<slug>.md` with valid frontmatter:

```yaml
---
name: <kebab-case-slug>
description: <one-line summary, ≤300 chars>
metadata:
  type: user | feedback | project | reference
---
```

For `feedback` and `project`, lead body with the fact, then `**Why:**` and `**How to apply:**` lines.

2. Add or update the one-line pointer in `~/.memory/MEMORY.md`:

```
- [<title>](<file.md>) — <one-line hook, ≤150 chars total line>
```

Put the entry under the most relevant H2 section. Do not add new H2 sections without reason.

## Discipline

- Dedupe-or-update: before writing, search by `name` slug and description keywords. If a matching memory exists, UPDATE (Edit), don't create a parallel entry.
- Remove memories that turn out to be wrong or outdated.
- The index `MEMORY.md` SHOULD stay ≤150 lines and ≤25 KB. If an index line grows beyond ~150 chars, move detail into the topic file.
- Link related memories with `[[name]]`. An unresolved `[[name]]` is a TODO marker, not an error.

## Validation

If a validator is available, run it after writing:

```
bun ~/Work/active/memory-substrate/reference/validator.ts ~/.memory
```

A clean run shows 0 errors. Warnings are advisory.

## Categories (canonical)

- `user` — identity, role, preferences, knowledge background.
- `feedback` — corrections and confirmations of approach.
- `project` — non-derivable state about ongoing work (who, what, why, by when).
- `reference` — pointers to external systems or fixed resources.

Use the type that fits best. If unsure, prefer `reference` for stable pointers and `project` for living state.
