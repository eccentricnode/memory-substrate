# 03 — Background Memory Worker

When a batch is ready, the extension invokes a cheap, narrowly-scoped background subprocess
that decides whether anything in the batch deserves durable memory and, if so, writes it in
spec-conformant form. Default-deny is the governing bias.

## Jobs to be done
- Memory classification and note-writing run on a cheaper model than the main coding work.
- Ordinary progress and chatter never become durable memories.
- Reusable decisions, corrections, repeated workflows, and future-use context do.

## Behavioral contract

### Invocation
- The worker runs as a separate, non-interactive pi subprocess scoped to a narrow toolset
  (read, write, edit, search) and pinned to the configured cheap model. (Host surface:
  `pi.exec` to spawn it; pi has no built-in subagents, so a separate process is the mechanism.)
- The worker receives only the batch under consideration, not the full session context.
- The worker runs with the memory extension disabled in its own environment (recursion guard,
  per AGENTS.md invariant 3).

### Decision discipline
- Default output is "no memory written." The worker writes only when the batch contains
  something durable per SPEC §3.1 triggers, and never for the SPEC §3.2 exclusions.
- The worker inspects existing memories first and updates an existing one rather than
  creating a parallel entry when the subject already exists (dedupe, SPEC §3.4).
- Stale or contradicted memories are corrected or removed, not duplicated (SPEC §3.4, §5.1).

### Spec-conformant writes
- Every written memory carries valid frontmatter — name, one-line description ≤200 chars,
  and a type of user / feedback / project / reference (SPEC §2.2).
- The pi.dev adapter emits filenames as `<type>_<name>.md`, where `<name>` is the
  kebab-case frontmatter `name`. The type prefix is not part of `name`.
- An unrecognized frontmatter type is a write error for this adapter. The worker must choose
  one of the four SPEC types or produce no write; it must never coerce an unknown type.
- Each write performs the two-step save: topic file then `MEMORY.md` pointer; a write that
  updates one without the other is an error (SPEC §3.3).
- For feedback and project types the body leads with the fact, then why and how-to-apply
  (SPEC §2.3). The index pointer stays a single line (SPEC §2.5).
- Writes are confined to the resolved memory root; the worker never mutates source code or
  any path outside the root (SPEC §6.3).

### Audit
- Each run records reason, batch reference, model, exit status, and a short output tail to
  extension state that stays out of the LLM context.

## Verification signals
- A batch of pure progress chatter yields a no-write result and a clean working tree.
- A batch containing one durable decision yields exactly one spec-conformant topic file plus
  one new `MEMORY.md` pointer, and nothing else changes.
- A batch repeating an already-stored fact updates the existing memory rather than adding a duplicate.
- A worker attempt to write outside the memory root is refused.
- Every run leaves a retrievable audit record.
