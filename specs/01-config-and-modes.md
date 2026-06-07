# 01 — Configuration and Operating Modes

The extension's behavior is governed by environment knobs and by the two spec-mandated
operating modes. These are checked before any other work in every event handler.

## Jobs to be done
- An operator can turn the whole substrate off without uninstalling it.
- An operator can run it in a no-write observation mode to inspect what it *would* do.
- The extension resolves the memory root, the worker model, and timing thresholds from
  configuration with safe defaults, and never hard-codes machine-specific values.

## Behavioral contract

### Disabled mode (SPEC §4.5)
- When disabled, the extension performs no bootstrap, no reads, and no writes for the
  whole session. It registers no effective work in any handler.
- Disabled state is settable by environment knob (`PI_MEMORY_ENABLED=0`) and must also be
  honorable from a substrate constraint (e.g. a HIPAA/PHI host).
- When asked, the extension must be able to report that it is disabled.

### Ignore mode (SPEC §4.4)
- When ignore mode is active, bootstrapped memory may remain in context but must not be
  cited, compared against, or applied, and no new memories are written.

### Dry-run mode
- A dry-run knob (`PI_MEMORY_DRY_RUN=1`) makes the worker print its proposed changes and
  changed paths but write nothing to disk.

### Configuration resolution
- Memory root resolves deterministically from host config (SPEC §6.1.1), defaulting to the
  substrate-neutral canonical root; never assume a hard-coded absolute path.
- Worker model resolves from `PI_MEMORY_MODEL`, defaulting to a cheap model that exists in
  this host's registry (`claude-haiku-4-5`). The build must confirm the default against
  `pi --list-models` and must never default to a name absent from the registry.
- Debounce window and max batch size resolve from `PI_MEMORY_DEBOUNCE_MS` and
  `PI_MEMORY_MAX_BATCH_ITEMS` with sane defaults; both are tunable without code changes.

## Verification signals
- With the disable knob set, a full session produces zero reads, zero writes, zero worker
  invocations, and a truthful disabled-status report.
- With the dry-run knob set, a durable-looking turn produces proposed-change output and a
  zero-diff working tree.
- Requesting an absent model name surfaces a clear error rather than a silent failure.
