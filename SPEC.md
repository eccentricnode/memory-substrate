# memory-substrate — Specification

**Version:** 0.1.0-draft
**Status:** DRAFT
**Date:** 2026-06-02
**Companion docs:** `STRATEGY.md` (rationale), `adapters/*/README.md` (per-substrate wiring)

This document is the contract. Any adapter that conforms to this spec MUST satisfy every MUST clause and SHOULD satisfy every SHOULD clause. MAY clauses are optional.

---

## 1. Terminology

- **Memory directory** — the filesystem location holding `MEMORY.md` and topic files. Substrate-neutral path; canonical default `~/.memory/`. Adapters MAY override.
- **Memory** — a single markdown file representing one accumulated fact, observation, preference, or pointer. One concern per file.
- **Index** — the file `MEMORY.md` at the root of the memory directory. Lists every memory by one-line pointer.
- **Topic file** — any `*.md` file in the memory directory other than `MEMORY.md`. Holds the full content of a single memory.
- **Adapter** — a per-substrate shim that wires this spec to a host environment (Claude Code, pi.dev, codex exec, MCP, etc.).
- **Host** — the agent runtime consuming memories (CC session, pi.dev session, codex exec invocation, etc.).

---

## 2. Storage

### 2.1 Directory layout

```
<memory_root>/
  MEMORY.md            # index (required)
  *.md                 # topic files (zero or more)
  <subdir>/*.md        # optional subdirectory namespacing (MAY)
```

- `<memory_root>` MUST be a single filesystem directory.
- `MEMORY.md` MUST exist at the root, even if empty (header line only).
- Topic files MAY live at the root or in subdirectories. Subdirectories are namespacing only; the schema is identical.
- The directory MUST NOT require any database, daemon, or external service. Plain filesystem is the substrate.

### 2.2 Topic file frontmatter

Every topic file MUST begin with YAML frontmatter:

```yaml
---
name: <kebab-case-slug>
description: <one-line summary, max 200 chars>
metadata:
  type: user | feedback | project | reference
---
```

- `name` MUST be the topic slug. For filenames with no adapter-declared structural prefix,
  `name` MUST match the filename stem. For filenames using the recommended `<type>_<slug>.md`
  convention, `name` MUST match the stem after the `<type>_` prefix (e.g.,
  `feedback_foo.md` -> `name: foo`). Why: links and dedupe need a stable cross-adapter
  slug, while filenames may carry adapter routing or category hints.
- `description` MUST be a single line, ≤200 characters, no markdown.
- `metadata.type` MUST be one of the four category values. Adapters MAY warn on unrecognized types; they MUST NOT silently coerce.

### 2.3 Topic file body

- For `type: feedback` and `type: project`: the body SHOULD lead with the fact or rule, followed by `**Why:**` and `**How to apply:**` lines. This is the format that survives future-self review.
- For `type: user` and `type: reference`: free-form short prose. No structure required.
- `[[name]]` links MAY appear anywhere. An unresolved `[[name]]` is a TODO marker, not an error. Validators MAY report unresolved links; they MUST NOT block writes.

### 2.4 Filename convention

- Topic filenames SHOULD follow `<type>_<slug>.md` (e.g., `feedback_codex-ralph-loop-default-fresh.md`).
- When a filename uses `<type>_<slug>.md`, the `<slug>` portion MUST match frontmatter
  `name`; the `<type>_` prefix is not part of `name`.
- The `<type>_` prefix is a filename convention, not the schema source of truth. The
  source-of-truth type is `metadata.type` in frontmatter, not the filename.
- Filenames MUST be unique within their containing directory.

### 2.5 Index format (`MEMORY.md`)

- MUST NOT have frontmatter.
- SHOULD be organized into H2 sections by topic theme (e.g., `## Austin — Identity & Handles`).
- Each entry MUST be a single line of the form: `- [<title>](<relative-path-to-topic-file>) — <one-line hook>`.
- The one-line hook SHOULD be ≤150 characters.
- The total index file SHOULD NOT exceed **150 lines or 25 KB**, whichever is smaller. Adapters MAY enforce stricter caps.
- When a topic outgrows a single line, the detail MUST move to the topic file. The index hook stays one line.

### 2.6 Caps and validation

- Adapters MUST provide a `validate` operation that checks: frontmatter presence, type validity, index line length, index total length, filename uniqueness, broken markdown links.
- Cap violations SHOULD be reported as warnings during v0.1. v1.0 MAY harden warnings into hard failures.

---

## 3. Write protocol

### 3.1 Triggers (when to save)

A memory SHOULD be written when:

| Trigger | Type |
|---|---|
| User explicitly asks ("remember that…") | inferred from content |
| User corrects a behavior the agent took | `feedback` |
| User confirms a non-obvious approach worked | `feedback` |
| User reveals identity, role, preference, knowledge | `user` |
| User shares non-derivable context about ongoing work | `project` |
| User names an external system or pointer (Linear, Slack channel, repo URL) | `reference` |

The agent MAY save on its own judgment. The agent MUST save when explicitly asked.

### 3.2 Exclusions (what NOT to save)

Memories MUST NOT be created for:

- Code patterns, conventions, file paths derivable from project state.
- Git history, recent changes, who-changed-what (`git log` is canonical).
- Debugging recipes — the fix is in the code; the commit message has the context.
- Ephemeral session state (use plans/tasks, not memory).
- Content already in `CLAUDE.md`, `AGENTS.md`, or equivalent always-loaded host files.

This exclusion list applies even when the user asks for a save. If asked to save excluded content, the agent SHOULD ask what's *surprising* or *non-obvious* about it — that's the part worth keeping.

### 3.3 Two-step save

Every write MUST execute both steps, in order:

1. Write or Edit the topic file (including frontmatter).
2. Add or update the one-line pointer in `MEMORY.md`.

A write that completes step 1 but not step 2 is incomplete and SHOULD be reported as an error.

### 3.4 Dedupe and update

Before writing a new memory:

- The agent MUST search by `name` slug and by description keyword.
- If a matching memory exists, the agent MUST UPDATE (`Edit`) rather than create a parallel entry.
- If a memory contradicts current state or is no longer accurate, the agent MUST remove or correct it. Stale memories are worse than missing ones.

### 3.5 Prompt-bakeable form

Adapters MUST ship a prompt-text block (≤80 lines) that encodes §3.1–§3.4 in instructions the host can drop into a system prompt, skill, or AGENTS.md surface. This is the substrate-independent write protocol for prompt-only fallback; the host's job is delivering the same write rules to the model or forced-write decision surface it uses.

---

## 4. Read protocol

### 4.1 Bootstrap

The host MUST provide bootstrap access to `MEMORY.md` index entries before the agent relies
on durable memory. The default delivery is to load `MEMORY.md` into the agent's context at
session start.

- If the host has a per-session context cap that's smaller than the index, the host MUST
  either load the first N lines where N is the cap or document an adapter-specific bounded
  selection strategy. Adapters SHOULD warn if any content past the cap is silently dropped.
- If a host cannot safely or usefully preload the full index, an adapter MAY satisfy
  bootstrap with bounded, visible, relevant index-snippet injection at the earliest
  host-supported turn boundary. The adapter binding MUST document the trigger, caps,
  attribution, and empty-match behavior. Why: some hosts expose reliable turn-start
  injection rather than a full session-start context surface; the contract is that memory is
  available through a bounded, inspectable index surface, not that every adapter dumps the
  full index unconditionally.
- This bootstrap rule is subordinate to ignore and disabled modes: ignore mode suppresses
  use, citation, and writes (§4.4), while disabled mode skips bootstrap and all memory I/O
  entirely (§4.5).
- The bootstrap content is informational; the agent decides what's relevant.

### 4.2 On-demand reads

During a session:

- The agent reads topic files via standard file-read tools when relevant.
- Markdown links in the index (`[title](file.md)`) are the routing mechanism. The agent follows them like any other markdown link.
- For substrates with weaker tool-use defaults, the adapter SHOULD include in its prompt block: "if the user references prior work or a topic you don't recall, search `MEMORY.md` before answering."

### 4.3 Verification before recommendation

A memory is a claim that was true *when it was written*. Before recommending action on a memory:

- If the memory names a specific file path, function, flag, or external resource → the agent MUST verify it still exists (grep, file check, fetch).
- If the memory summarizes repo or system state → the agent SHOULD prefer fresh observation (`git log`, file read) over the snapshot for current-state questions.

### 4.4 Ignore mode

The host MUST support an ignore signal (user says "don't use memory," "ignore memory," or sets a config flag).

When ignore mode is active:

- Bootstrap content MAY remain in context but MUST NOT be cited, compared against, or applied.
- The agent MUST NOT write new memories during the session.

### 4.5 Disabled mode

The host MUST support a disabled signal (config flag, environment variable, or substrate constraint such as HIPAA/PHI boundaries).

When disabled mode is active:

- The bootstrap step is skipped entirely.
- No reads or writes occur for the duration of the session.
- The adapter MUST report disabled status if asked.

---

## 5. Decay and refresh

### 5.1 Continuous discipline (every write)

The agent SHOULD, at write time:

- Update or remove any memory it observes to be wrong.
- Move detail from index lines that have outgrown ~150 chars into the topic file.
- Remove duplicate or near-duplicate entries.

### 5.2 Periodic distillation

The memory directory SHOULD undergo periodic compaction. Adapters MAY trigger it via:

- **Time-based**: cron, scheduled task, or skill that runs every N weeks.
- **Threshold-based**: triggered when the index exceeds 80% of its cap.
- **User-initiated**: explicit command (e.g., `/memory refresh`).

Distillation MUST be re-distillation from existing memories and recent activity, not re-interview. The Aaron Axeman Memory Onboarding Protocol pattern: mine what's already on disk; ask the user only to confirm.

### 5.3 Compaction operation

A compaction run SHOULD:

1. Read all topic files and the index.
2. Identify load-bearing vs incidental content.
3. Produce a proposed compacted version (new index, possibly consolidated topic files).
4. Output a `COMPACTION_REPORT.md` summarizing changes.
5. NOT auto-apply changes. The human MUST review and accept.

---

## 6. Adapter contract

### 6.1 Required capabilities

Every adapter MUST provide:

1. **Path resolution** — answer: where is `<memory_root>` for this host?
2. **Bootstrap wiring** — provide `MEMORY.md` index bootstrap context per §4.1.
3. **Write protocol delivery** — deliver §3.5 write rules to the active write-decision surface. Prompt-only adapters inject the prompt-bakeable form into the host's system-prompt surface (system prompt, CLAUDE.md, AGENTS.md, skill, etc.); forced-write adapters MAY deliver the rules to a worker/applicator decision surface instead, if they document the prompt-bakeable fallback.
4. **Ignore signal** — honor §4.4 when active.
5. **Disabled signal** — honor §4.5 when active.
6. **Validator invocation** — expose a `validate` command that runs against the memory directory.

### 6.2 Optional capabilities

Adapters MAY provide:

- **Forced-write hooks** — substrate-driven writes (e.g., on session-end). Only available where the host exposes hook surfaces.
- **Validation at write time** — block writes that violate the spec (frontmatter missing, cap exceeded). Only feasible with hook surfaces or write-tool wrapping.
- **Compaction scheduling** — automatic invocation of §5.3.
- **Cross-adapter sync** — synchronization with other memory directories (rsync, syncthing, git, MCP). NOT required; deployment concern.

### 6.3 Conformance checklist

An adapter is v0.1-conformant if it answers YES to all of:

- [ ] Resolves `<memory_root>` deterministically given host config
- [ ] Provides `MEMORY.md` index bootstrap context per §4.1
- [ ] Delivers the write protocol to the active write-decision surface, with documented prompt-bakeable fallback when not injected into the host prompt
- [ ] Honors ignore mode (no writes, no citations)
- [ ] Honors disabled mode (no bootstrap, no I/O)
- [ ] Invokes the reference validator and surfaces its output
- [ ] Does not silently mutate any file outside `<memory_root>` and the host's own config

---

## 7. Reference implementations

memory-substrate ships these reference pieces (substrate-agnostic, written once):

- **Validator** (`reference/validator.ts`) — checks frontmatter, types, index format, caps, link integrity. CLI: `memory-validate <root>`.
- **Compactor** (`reference/compactor.ts`) — performs §5.3 against a memory directory. CLI: `memory-compact <root>`.
- **Migrator** (`reference/migrator.ts`) — converts PAI-shaped memory directories to memory-substrate format. CLI: `memory-migrate <pai-root> <output-root>`.

Adapters SHOULD invoke these rather than reimplementing.

---

## 8. Versioning

- This spec uses semantic versioning at the document level. Breaking changes to MUST clauses bump the major version.
- Memory directories SHOULD declare the spec version they were last validated against. Recommendation: a `MEMORY.md` HTML comment at the top (`<!-- memory-substrate: v0.1.0 -->`).
- Adapters MUST declare which spec version they implement.

---

## 9. Out of scope

This spec does NOT define:

- The agent's identity, personality, or voice. Those are host concerns.
- The host's bootstrap context beyond the memory directory (CLAUDE.md, AGENTS.md, identity files, derived artifacts like TELOS). Those are separate layers.
- Vector search, embeddings, or semantic retrieval. v0.1 is grep + agent judgment.
- Encryption at rest. Memory directories are plaintext markdown. Hosts that need encryption use filesystem-level tools.
- Multi-machine sync. Hosts use rsync / syncthing / git / MCP as deployment concerns.
- Permission models, access control, or audit trails beyond what the host filesystem provides.

---

## 10. Open clauses (decisions deferred to later versions)

1. **Subdirectory semantics** — §2.1 allows subdirectories but doesn't define meaning. Future versions MAY formalize (e.g., `WORK/`, `KNOWLEDGE/` namespaces).
2. **Bootstrap cap** — §2.5 recommends 150 lines / 25 KB but adapters MAY enforce stricter. Future versions MAY standardize a single cap.
3. **Compaction cadence** — §5.2 lists three trigger options but doesn't mandate one. Future versions MAY require at least one to be configured.
4. **Cross-link semantics** — §2.3 allows `[[name]]` links but doesn't define traversal behavior beyond "TODO if unresolved." Future versions MAY define link graphs explicitly.
