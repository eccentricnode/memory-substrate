# memory-substrate — Strategy & Architecture

**Date:** 2026-05-27
**Status:** DRAFT — pre-fork, pre-commit
**Author:** Austin (with Jeff)
**Sibling docs:** `2026-05-27_pai-thin-strategy.md`, pai-lite SHAPE.md

---

## What memory-substrate is

A **substrate-independent specification + reference implementation** for the agent-memory layer PAI invented in practice but never extracted as a primitive. The thesis: PAI's memory works, but it's coupled to Claude Code's auto-memory mechanism. Decouple it, and the same pattern runs on pi.dev, codex exec, raw API harnesses, future substrates — wherever an agent has files + a write tool + a system-prompt surface.

**Differentiation from sibling projects:**

| Project | Layer | Substrate | What it owns |
|---|---|---|---|
| `danielmiessler/Personal_AI_Infrastructure` | Application | Claude Code | Whole-system PAI (memory is one part) |
| `eccentricnode/pai-thin` | Application | Claude Code 2026 (native) | Thin PAI; consumes memory-substrate via CC adapter |
| `eccentricnode/pai-lite` | Application | pi.dev | Lite PAI; consumes memory-substrate via pi.dev adapter |
| **`eccentricnode/memory-substrate`** | **Primitive** | **Any** | **The memory spec + file format + protocol + adapters** |

memory-substrate sits *under* pai-thin, pai-lite, and any future PAI variant. They consume it the way they consume any other library: install the spec, point at a memory directory, follow the protocol.

---

## The diagnosis

### What PAI's memory does that works

Six things, all substrate-independent in shape but coupled to CC in current implementation:

1. **Markdown files with frontmatter** — `name`, `description`, `metadata.type`. One concern per file.
2. **Four categories**: `user` (identity/preferences/role), `feedback` (corrections + confirmations of approach), `project` (active state — who/what/why), `reference` (pointers to external systems).
3. **Index file (`MEMORY.md`)** — one-line entries pointing to topic files. Loaded first.
4. **Topic files load on demand** — agent reads them when relevant, not all at session start.
5. **`[[name]]` cross-links** between memories, link-liberally philosophy.
6. **Distillation-from-existing-data refresh** — Aaron Axeman's Memory Onboarding Protocol pattern. TELOS refresh was a one-shot of this.

These are the bones. They survive any substrate.

### What's coupled to Claude Code (where it breaks)

1. **The default path** — `~/.claude/projects/<proj>/memory/`. CC owns this convention; pi.dev / codex exec don't.
2. **The 200-line bootstrap cap with silent truncation** — MEMORY.md is currently 262 lines / 30KB; ~6KB silently drops every CC session. The cap is a CC implementation detail, not a memory-layer design choice.
3. **The "Claude decides when to save" judgment** — baked into CC's system prompt invisibly. Other substrates don't inherit it.
4. **Hook-forced writes** — `WorkCompletionLearning`, `SatisfactionCapture`, `RelationshipMemory` only exist because CC exposes the hook surface. pi.dev has extension points but pai-lite chose not to use them; codex exec has no hook surface.
5. **`@`-imports for the heaviest memories** — PRINCIPAL_IDENTITY, DA_IDENTITY, PROJECTS, PRINCIPAL_TELOS load via CC's `@` mechanism. Other substrates have system-prompt or AGENTS.md surfaces but the mechanism differs.
6. **Retrieval-as-grep** — works in CC because the model just runs Read/Grep without being told. Substrates with weaker tool-use defaults need explicit instruction.

### What's load-bearing vs incidental

| Element | Load-bearing? | Where it lives in spec |
|---|---|---|
| Markdown + frontmatter + index pattern | YES | Storage layer |
| Four categories (user/feedback/project/reference) | YES | Schema |
| Write protocol (when, what, how to dedupe) | YES | Protocol |
| Read protocol (bootstrap + lazy load) | YES | Protocol |
| `[[name]]` cross-link convention | YES | Schema |
| Periodic distillation | YES | Protocol |
| CC default path | NO | Adapter |
| 200-line cap | NO (but a similar cap is needed) | Adapter |
| Hook-forced writes | NO | Optional adapter capability |
| `@`-import bootstrap | NO | Adapter capability |

This split is the spec's job.

---

## Design principles

1. **Files are the data. Everything else is access pattern.** The on-disk format is the spec; access patterns (direct file IO, MCP server, hook-driven writes) are adapters over the same bytes.
2. **The schema decides type, not the substrate.** A `feedback` memory is a `feedback` memory whether it was written by CC, pi.dev, or a future tool. The frontmatter is the contract.
3. **Read protocol survives any substrate; write protocol assumes prompt-baking.** Every substrate has *some* way to load files at start and inject system-prompt-shaped instructions. That's the floor.
4. **Caps and discipline are part of the spec, not the host.** MEMORY.md drifted past 200 lines because no one enforced the cap. The spec ships the cap, the validator, and the compactor — not "trust the agent to remember the cap."
5. **MCP is optional, not foundational.** A memory directory + adapter works without any daemon. MCP exists for substrates that benefit from cross-tool access semantics, and reads/writes the same files.
6. **Multi-substrate sync is a deployment concern, not a spec concern.** Two hosts wanting to share memory can rsync / syncthing / git the directory. The spec doesn't mandate a sync mechanism; it just guarantees byte-compatibility across adapters.

---

## The five concerns (the body of the spec)

memory-substrate splits the conflated PAI memory layer into five named concerns. Each one ships independently, each has a clear contract, each is testable.

### 1. Storage

**Owns:** the on-disk format.

- **Layout:** `<memory_root>/MEMORY.md` (index) + `<memory_root>/*.md` (topic files). One topic per file. Optional subdirectories for namespacing (e.g., `WORK/`, `KNOWLEDGE/` if useful), but the flat default is canonical.
- **Topic-file frontmatter (required):**
  ```yaml
  ---
  name: short-kebab-case-slug    # matches filename stem
  description: one-line summary  # used by index entry
  metadata:
    type: user | feedback | project | reference
  ---
  ```
- **Topic-file body:**
  - For `feedback` and `project`: lead line + `**Why:**` + `**How to apply:**` (the discipline already in your CLAUDE.md).
  - For `user` and `reference`: free-form short prose.
  - `[[name]]` links allowed anywhere; an unresolved link is a TODO marker, not an error.
- **Index file (`MEMORY.md`):**
  - No frontmatter.
  - Grouped by topic with H2 headings (`## Austin — Identity & Handles`, etc.).
  - Each entry: `- [Title](file.md) — one-line hook (≤150 chars)`.
  - Hard cap: **150 lines / 25KB** (below CC's 200-line cap with safety margin; substrate adapters may enforce stricter caps).
  - When a topic gets too long for one line, MOVE detail to the topic file, don't grow the index.
- **Filenames:** `<type>_<slug>.md` convention (e.g., `feedback_codex-ralph-loop-default-fresh.md`). Type prefix is informational; the source-of-truth type is in frontmatter.

### 2. Write protocol

**Owns:** when to save, what to save, dedupe-or-update logic, type assignment.

- **When to save (no hook required):**
  - User explicitly asks ("remember that…") → save immediately.
  - User corrects a behavior or confirms a non-obvious approach → save as `feedback`.
  - User describes their role, preferences, knowledge → save as `user`.
  - User shares non-derivable context about ongoing work → save as `project`.
  - User names an external system Austin uses → save as `reference`.
- **What NOT to save** (mirrors current CLAUDE.md exclusion list):
  - Code patterns, conventions, file paths (derivable from project state).
  - Git history / who-changed-what (use `git log`).
  - Debugging recipes (the fix is in the code).
  - Ephemeral task state (use plans/tasks, not memory).
- **Dedupe-or-update:**
  - Before writing a new memory, search by `name` slug and by description keyword.
  - If a match exists: UPDATE (Edit, not Write).
  - If outdated or contradicted by current state: REMOVE the old entry.
- **Two-step save (mandatory):**
  1. Write/Edit the topic file (with frontmatter).
  2. Add or update the one-line pointer in `MEMORY.md`.
- **Prompt-bakeable form:** the protocol ships as a prompt block adapters can drop into their system prompt or skill. ~40 lines, prose form, the same shape as CLAUDE.md's current auto-memory section.

### 3. Read protocol

**Owns:** what loads at session start, what loads on demand, how the agent finds memories.

- **Bootstrap (start of session):** load the first N lines of `MEMORY.md` (default N=150, configurable per adapter).
- **On-demand (during session):**
  - Agent searches the index for keyword/topic match.
  - Agent reads matching topic files via standard Read tool.
  - For substrates with weaker tool-use defaults, ship a prompt block that explicitly instructs: "if the user references prior work or a topic you don't recall, search MEMORY.md before answering."
- **Verification before use:**
  - If a memory names a specific file path, function, flag → verify it still exists before recommending.
  - If a memory summarizes repo state → prefer fresh `git log` or file read over the snapshot for current-state questions.
  - Already in CLAUDE.md; ships as part of the spec.
- **Ignore mode:** if the user says "don't use memory" or "ignore memory" → bootstrap content stays in context but is not cited, compared against, or applied. The spec defines the behavior; substrates wire the toggle.

### 4. Decay / refresh

**Owns:** keeping memory from rotting.

- **Continuous discipline (every write):**
  - Update or remove memories that turn out to be wrong.
  - When an index line outgrows ~150 chars, move detail to the topic file.
- **Periodic distillation (cadence-based):**
  - Trigger options (per adapter):
    - Time-based: cron/skill that runs every N weeks.
    - Threshold-based: when index exceeds 80% of cap, run compaction.
    - User-initiated: `/memory refresh` slash command or equivalent.
  - Process: re-distill from existing memories + recent activity. Don't re-interview; mine what's already on disk (Aaron Axeman's Memory Onboarding Protocol pattern).
- **TELOS-style derived files:**
  - If memory feeds into a higher-level derived document (PRINCIPAL_TELOS, PROJECTS overview), the spec defines the sync direction: memory → derived, never the reverse. Derived files auto-regenerate.

### 5. Adapters

**Owns:** the per-substrate shim that wires the protocol to the host's mechanisms.

Each adapter is small (50–150 lines) and answers exactly these questions:

| Question | CC adapter | pi.dev adapter | codex exec adapter | MCP adapter |
|---|---|---|---|---|
| Where is `<memory_root>`? | `~/.claude/projects/<proj>/memory/` | `~/.pi/agent/<name>/memory/` (or project-local) | Project-local `.memory/` | Configured path |
| How does bootstrap load? | CC auto-loads `MEMORY.md` first 200 lines | pi.dev instruction loader | System message prefix | Server returns on connect |
| How does the write protocol get injected? | CC's CLAUDE.md + system prompt | pi.dev's AGENTS.md or skill | Codex `AGENTS.md` | Server tool schema |
| Are forced writes available? | YES (hooks) | OPTIONAL (extension API) | NO | YES (server-driven) |
| Validation on write? | Hook can validate | Extension can validate | Agent self-validates | Server validates |

Adapter responsibilities:
1. Place the write protocol into the substrate's system-prompt surface.
2. Place the read protocol bootstrap into the substrate's session-start surface.
3. Optionally provide forced-write hooks if the substrate supports them.
4. Optionally provide validation (frontmatter check, cap enforcement) at write time.

**MCP-as-adapter is one option, not the canonical path.** A `memory-mcp` server reads/writes the same files via standard MCP tool calls (`memory.save`, `memory.search`, `memory.read`, `memory.list`, `memory.link`). Substrates that benefit from cross-tool sharing or built-in query semantics use it. Substrates that prefer zero daemons (pi.dev on UHC laptop, codex exec) skip it. Both modes produce identical on-disk bytes.

---

## Target structure

```
memory-substrate/
  SPEC.md                            # canonical spec (storage + protocols)
  STRATEGY.md                        # this file
  DIVERGENCE.md                      # how this differs from PAI's current memory
  schema/
    frontmatter.schema.json          # frontmatter validation
    index.schema.md                  # MEMORY.md format rules
  protocol/
    write-protocol.md                # prompt-bakeable write rules
    read-protocol.md                 # prompt-bakeable read rules
    decay-protocol.md                # distillation cadence + process
  adapters/
    claude-code/
      README.md                      # how to install
      install.sh                     # wires CLAUDE.md + system prompt
      validator.ts                   # optional hook
    pi-dev/
      README.md
      install.sh                     # wires AGENTS.md / skill
    codex-exec/
      README.md
      AGENTS.md.template
    mcp/
      server.ts                      # MCP façade over files
      manifest.json
  reference/
    validator.ts                     # validates a memory directory against spec
    compactor.ts                     # the distillation skill (substrate-agnostic)
    migrator.ts                      # PAI-shaped → memory-substrate-shaped migration
  examples/
    pai-imported/                    # Austin's current memory, post-migration
```

---

## Migration story (what happens to existing PAI memories)

Austin's current memory lives at `~/.claude/projects/-home-ajohnson-Work/memory/` (PAI-shaped). The migrator's job:

1. **Validate frontmatter** — every file has `name`, `description`, `metadata.type`. PAI-shaped memories mostly do.
2. **Enforce index cap** — current `MEMORY.md` is 262 lines / 30KB. Migrator identifies the bloat (lines >150 chars, sections that grew, duplicates) and proposes a compaction. Human reviews; not auto-applied.
3. **Promote `@`-imported files into the protocol** — `PRINCIPAL_IDENTITY.md`, `DA_IDENTITY.md`, `PROJECTS.md`, `PRINCIPAL_TELOS.md` either become `user`-type memories (if they fit) OR stay as derived files generated from memories (current state for PRINCIPAL_TELOS).
4. **Validate `[[name]]` links** — surface unresolved links as TODOs.
5. **Output** — a `MIGRATION_REPORT.md` and a proposed cleaned memory directory, no destructive changes.

Migration is reversible until the human approves. Current memory directory stays as `.bak`.

---

## Implementation phases

| Phase | Goal | Success criterion | Estimate |
|---|---|---|---|
| **P0 — Strategy + fork** | Repo exists with STRATEGY + SPEC outline + DIVERGENCE | First commit pushed | This session |
| **P1 — SPEC.md** | Storage + protocols formalized in one canonical doc | Spec is self-contained — adapter author needs nothing else | 1 session |
| **P2 — Reference validator** | TypeScript validator runs against a memory directory and reports schema + cap violations | Validates Austin's current PAI memory; produces useful errors | Ralph mission, 2-3 hours |
| **P3 — CC adapter** | `install.sh` wires CC's CLAUDE.md + system prompt; existing PAI memory works unchanged | Austin's CC session loads memory via spec, not via PAI's bespoke setup | 1 session |
| **P4 — pi.dev adapter** | `install.sh` wires pi.dev AGENTS.md + skill | pai-lite Phase 2 uses this adapter instead of inventing its own | Ralph mission, 2-3 hours |
| **P5 — Migrator** | PAI-shaped → memory-substrate-shaped, with MIGRATION_REPORT | Migrator processes Austin's current memory; report is reviewable | 1 session |
| **P6 — Compactor / distillation skill** | Substrate-agnostic compaction; runs against a memory directory and produces a proposed compacted version | Compactor brings MEMORY.md back under 150 lines without losing load-bearing content | 1 session |
| **P7 — MCP adapter (optional)** | `memory-mcp` server exposes the protocol as MCP tools | CC and codex exec both wire to one shared memory directory via MCP | Deferred — only if cross-tool sharing earns its rent |
| **P8 — Dogfood** | Austin's daily memory writes go through the spec for 1 week | No P0/P1 bugs; cap holds; topic files stay coherent | 1 week observation |
| **P9 — v0.1 release** | Tag, release notes, publish | `gh release create v0.1` | 1 session |

---

## Open questions / decisions deferred

1. **One memory directory across substrates, or one per substrate?** If Austin runs CC + pi.dev + codex exec on the same machine, do they share `~/.memory-substrate/<scope>/` or maintain separate stores? Sharing is cleaner but raises the HIPAA-boundary question again. **Defer to P3/P4 — decide when both adapters exist.**

2. **Cap enforcement: hard fail or soft warn?** PAI's current "warning at bottom of file" is a soft signal that already got ignored. Hard fail (refuse to write if index >150 lines until compaction runs) is stricter but interrupts flow. **Lean toward soft warn during P2-P5, harden to fail in P6 once compactor exists.**

3. **`@`-imports as substrate feature vs spec feature?** CC's `@` mechanism is convenient but CC-specific. Two options: (a) spec defines a "bootstrap-always" subset of memories that adapters wire via whatever mechanism the host supports, (b) `@`-imports stay CC-only, other adapters use a "load these specific topic files at start" config. **Lean toward (a); decide in P1.**

4. **Where does PRINCIPAL_TELOS live?** Currently auto-generated from TELOS source files (MISSION, GOALS, etc.). In the new world: are those source files `user`-type memories? Or stay as a parallel `TELOS/` tree that memory-substrate is silent about? **Defer to P5 — depends on how the migrator handles them.**

5. **MCP server: ship in P7, or never?** If files + adapters cover every substrate we currently care about (CC, pi.dev, codex exec), MCP is pure overhead. Only ship if a real cross-tool use case emerges (e.g., Cursor sessions sharing memory with CC sessions). **Defer to P7; explicitly OK to drop.**

6. **Per-substrate-memory namespace vs project namespace?** PAI scopes by project (`~/.claude/projects/<proj>/memory/`). Should memory-substrate scope by project, by user, by both? **Defer to P1 — answer in spec.**

7. **Encryption / at-rest protection?** Personal memories include identity, opinions, relationship notes. The current PAI store is plaintext. For UHC-laptop or shared machines, this could matter. **Defer to a later phase; out of scope for v0.1.**

---

## Anti-scope (what memory-substrate is NOT)

- **Not** a knowledge graph database. Markdown + frontmatter + `[[links]]` is the ceiling.
- **Not** a vector store. If retrieval-by-meaning is needed later, that's an MCP adapter extension, not a core concern.
- **Not** a personal CRM. Contact details + relationships are user-content concerns, not memory-layer concerns.
- **Not** a replacement for plans, tasks, ISAs, or scratch notes. Those are intra-session artifacts; memory is cross-session.
- **Not** an opinion about WHAT goes in memory beyond the type definitions. The spec defines categories and discipline; the user/agent decides content.
- **Not** a productized release for general users at v0.1. It's Austin's daily-driver memory layer, dogfooded in public, with adapters that anyone can pick up.

---

## Relationship to sibling projects

- **pai-thin P5 (MEMORY.md restructure)** becomes a *consumer* of memory-substrate. Instead of pai-thin defining the file format, it installs the CC adapter from memory-substrate.
- **pai-lite Phase 2 (durable memory)** likewise. Installs the pi.dev adapter, follows the spec, contributes back any pi.dev-specific learnings.
- **Sequencing:** memory-substrate P1-P3 (spec + validator + CC adapter) should land BEFORE pai-thin P5 commits. Otherwise pai-thin invents a memory shape that memory-substrate then has to retrofit.
- **Upstream:** memory-substrate is not a fork of anything. It's a fresh extraction. Doesn't pull from `danielmiessler/Personal_AI_Infrastructure`; can offer migration-from-PAI as a one-way capability.

---

## Success criterion for this strategy doc

If a future Austin (or Ralph, or another contributor) reads this cold and can answer all of these without further conversation, the doc has done its job:

- [ ] Why does memory-substrate exist as a separate project? (PAI memory works but is CC-coupled; the bones are substrate-independent)
- [ ] What are the five concerns and why are they separated? (storage / write protocol / read protocol / decay / adapters — each independently testable)
- [ ] What's substrate-coupled vs portable in current PAI memory? (the diagnosis table)
- [ ] What's the relationship to MCP? (optional access layer over the same files, not foundational)
- [ ] What's the migration story for existing PAI memories? (migrator + report, reversible)
- [ ] What's the implementation order? (P0 → P9)
- [ ] Where are unresolved decisions parked? (Open Questions section)
- [ ] What is this NOT? (Anti-scope section)

---

## Next action (this session, after Austin reviews)

1. Fork or create `eccentricnode/memory-substrate` on GitHub
2. Clone to `~/Work/active/memory-substrate`
3. Drop STRATEGY.md (this doc) + initial SPEC.md outline + DIVERGENCE.md into the repo
4. Push to main
5. Open issue #1 with the implementation roadmap (P0 → P9)
6. Hand to Austin for review before P1 spins up

Estimated time for steps 1-5: ~20-30 min once strategy is approved.
