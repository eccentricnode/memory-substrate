# Specs Directory

Source of truth for what the system should do. Ralph reads everything here every iteration.

## Three ways to populate this dir

1. **Greenfield project** — run `./scripts/ralph/ralph.sh specs` to walk JTBD → topic → spec.
2. **Existing codebase** — run `./scripts/ralph/ralph.sh reverse` to extract specs from current `src/`.
3. **By hand** — write `NN-kebab-case.md` files following the discipline below.

## One-topic discipline ("one sentence without 'and'")

Each spec describes **one topic of concern**. Test: write the purpose in **one sentence without "and"**. If you need "and", split.

- ✅ "The color extraction system analyzes images to identify dominant colors."
- ❌ "The user system handles authentication, profiles, and billing." → 3 specs.

## File naming

`NN-kebab-case.md` — the leading integer encodes priority order:
- `01-session-management.md`
- `02-range-optimization.md`
- `03-adaptive-behavior.md`

## What goes in a spec

- **Topic statement** — one sentence, no "and".
- **Scope** — in-scope, out-of-scope, boundary contracts.
- **Acceptance criteria** — observable behavioral outcomes (NOT implementation).
- **Data contracts** — inputs, outputs, state.
- **Behaviors** — in execution order.
- **State transitions** — if applicable.

## What does NOT go in a spec

- Code blocks
- Variable names
- Function/class names
- Library/framework references
- File paths in `src/`
- Implementation approach ("use K-means clustering with 3 iterations")

A different team on a different stack must be able to reimplement from the spec alone.

## Files that are not topic specs

These don't follow the topic-spec discipline:
- `README.md` (this file) — directory meta.
- Anything explicitly marked as a tracker or backlog.
