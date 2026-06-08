# 10 — PAI Migrator Input Schema

The PAI migrator accepts historical markdown memory roots and emits a reviewable
memory-substrate proposal.

## Scope
- In scope: accepted source directory shape, accepted topic file shapes, index handling,
  finding semantics, output isolation, and review artifacts.
- Out of scope: automatic application of migrated output, compaction quality, external PAI
  subsystems, and host adapter wiring.

## Jobs to be done
- A historical PAI memory directory can be converted without trusting an in-place rewrite.
- Non-uniform legacy files are preserved as reviewable proposals instead of being dropped
  silently.
- Ambiguity is visible in `MIGRATION_REPORT.md` so a human can decide whether inferred
  memories are load-bearing.

## Behavioral contract

### Source root
- The source root MUST be an existing directory.
- `MEMORY.md` MAY exist. When present, it is treated as the historical index. When absent,
  migration still considers topic files, but the missing index is reported through source
  validation findings so the reviewer knows the source was incomplete.
- Every non-hidden markdown file except a file named `MEMORY.md` is a candidate source
  topic. Hidden paths are ignored because PAI memories are user-facing markdown, not dotfile
  state.
- Symlinks or paths that resolve outside the source root MUST be skipped and reported.

### Accepted topic shapes
- A topic with memory-substrate frontmatter (`name`, `description`, `metadata.type`) is
  accepted as already close to the target shape.
- A topic with historical flat `type:` frontmatter is accepted and normalized to
  `metadata.type`.
- A markdown file with no parseable memory frontmatter is accepted as an imported PAI
  document. The proposal infers frontmatter from the file path and first useful body line.
- A frontmatter type outside `user`, `feedback`, `project`, or `reference` is not coerced
  silently. The proposal infers a valid type and records the invalid source type as a
  finding.

### Name and type inference
- The source frontmatter `name` is preferred when present. Otherwise the filename stem is
  slugified after removing a recognized type prefix.
- Duplicate names within the same inferred type are disambiguated in the proposal and
  reported.
- Type inference is conservative: explicit valid type wins; otherwise recognizable filename
  signals may infer `feedback`, `project`, `reference`, or `user`; otherwise the fallback is
  `reference` because it is the least behavior-shaping category.

### Index handling
- Historical `MEMORY.md` pointer lines are used only for findings and review context. The
  proposed `MEMORY.md` is rebuilt from migrated topic frontmatter so the output has one
  canonical pointer per migrated topic.
- Non-pointer source index lines, duplicate pointers, broken pointers, and over-cap pointer
  lines MUST be reported.
- Source validation findings MUST NOT block proposal generation. Output validation findings
  MUST be included in the report, and output validation errors make the CLI exit nonzero.

### Output
- The output directory MUST be outside the source root.
- The source root MUST NOT be mutated.
- The output directory contains `MIGRATION_REPORT.md` and a proposed `memory/` root.
- The proposed memory root MUST be validator-clean for a successful migration.

## Verification signals
- A source with nested frontmatter, flat `type:` frontmatter, and imported markdown produces
  a validator-clean proposal while leaving the source unchanged.
- A missing source `MEMORY.md` still migrates candidate topics and records the missing index
  as a source validation finding.
- Broken, duplicate, non-pointer, and long source index lines appear in `MIGRATION_REPORT.md`
  but do not get copied into the proposed index.
- An output directory inside the source root is refused before any source mutation.
