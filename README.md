# memory-substrate

A substrate-independent specification for agent memory. Files on disk + a write protocol + thin per-host adapters. Works with Claude Code, pi.dev, codex exec, raw API, or anything that reads markdown and has a system-prompt surface.

**Status:** v0.1.0-draft. Spec stabilizing; adapters not yet written.

## Why this exists

PAI's auto-memory pattern works — markdown index + topic files + four categories (`user` / `feedback` / `project` / `reference`) + the discipline of writing memories proactively. But the implementation is coupled to Claude Code's auto-memory directory, system prompt, and hook surface.

memory-substrate extracts the pattern into a substrate-neutral spec. Same files. Same protocols. Different hosts.

## Read this in order

1. [`STRATEGY.md`](STRATEGY.md) — the why, the diagnosis, the five concerns, the implementation phases.
2. [`SPEC.md`](SPEC.md) — the contract. MUST / SHOULD / MAY clauses adapters implement against.
3. `adapters/<host>/README.md` — per-substrate wiring (not yet written).

## What's here

- `STRATEGY.md` — design rationale, sibling-project relationships, phased plan.
- `SPEC.md` — v0.1.0-draft of the specification.
- `adapters/` — per-host shims (TBD).
- `reference/` — substrate-agnostic tools: validator, compactor, and migrator.

## Reference tools

Validate a memory root:

```bash
bun reference/validator.ts <memory_root>
```

Create a human-reviewed compaction proposal without mutating the memory root:

```bash
bun reference/compactor.ts <memory_root> [output_dir]
```

The compactor writes `MEMORY.md` and `COMPACTION_REPORT.md` to a proposal directory outside
the memory root so the index can be reviewed before any durable memory is changed.

Create a human-reviewed migration proposal from a historical PAI memory directory:

```bash
bun reference/migrator.ts <pai_root> <output_dir>
```

The migrator writes `MIGRATION_REPORT.md` plus a proposed `memory/` directory under the
output directory. The report stays outside the proposed memory root so validator runs only
against durable memory files.

## Sibling projects

- [`eccentricnode/pai-thin`](https://github.com/eccentricnode/pai-thin) — thin PAI on native Claude Code. Consumes memory-substrate via the CC adapter.
- [`eccentricnode/pai-lite`](https://github.com/eccentricnode/pai-lite) — PAI on pi.dev. Consumes memory-substrate via the pi.dev adapter.
- [`danielmiessler/Personal_AI_Infrastructure`](https://github.com/danielmiessler/Personal_AI_Infrastructure) — upstream PAI. memory-substrate is the extracted memory primitive; not a fork.

## License

TBD (likely Apache-2.0 or MIT — pick before v0.1 release).
