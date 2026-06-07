# 06 — pi.dev Host Binding

The pi.dev adapter binds memory-substrate behavior to pi.dev-specific runtime surfaces.

## Jobs to be done
- The adapter has deterministic host-specific answers where the substrate-neutral spec leaves choices open.
- The adapter fails closed when pi.dev cannot provide a required safety property.
- Operators can understand what the extension injected, queued, wrote, or refused.

## Behavioral contract

### Required pi.dev capabilities
- SPEC §6.2 treats forced-write hooks as optional for adapters in general. For this pi.dev
  target they are required: pi.dev exposes turn-end and pre-compaction hook surfaces, so the
  adapter must implement forced writes through those surfaces or fail its target contract.
- Forced-write protocol delivery is extension-first: the worker receives the write rules as
  internal context and the applicator enforces the structural parts. The prompt-bakeable
  adapter protocol remains available for manual fallback, not as the primary forced-write
  delivery surface.

### Memory root precedence
- The resolved memory root is chosen once per extension runtime and reused by every handler.
- Explicit operator configuration has precedence over defaults.
- If no explicit root is configured, the adapter uses the substrate-neutral canonical root from SPEC §1.
- Relative roots are resolved against the active pi.dev working directory; home-relative roots are expanded before canonicalization.
- If canonicalization fails, the extension reports an error and performs no memory reads, writes, injection, or worker invocation.

### Ignore signal
- Ignore mode can be activated by operator configuration or by user input that plainly asks not to use memory.
- Once active for a session, ignore mode suppresses memory injection and forced writes until the session is replaced or the operator explicitly clears it.
- Ignore mode is less strict than disabled mode: status and non-mutating diagnostics may still report that memory is being ignored.

### Worker launch safety
- The worker must be launched only by a mechanism that can set the child environment to disable this extension inside the child process.
- If the selected launch mechanism cannot prove that the disable flag reaches the child process, the extension records a refused worker run and does not spawn.
- The worker receives only the candidate batch, the resolved memory root, the dry-run setting, and the write protocol.
- The live worker runs without file tools and returns structured drafts only. The extension
  applicator is the sole write authority because it can canonicalize targets, enforce
  dry-run, perform the two-step save, and run the validator.
- Any future worker runner that grants file tools must still confine them to the resolved
  memory root; broader tool access is a test failure.

### Injection bounds
- Injected memory uses index snippets only, never topic-file bodies.
- A single injection is capped at 12 index lines and 4 KB, whichever is smaller.
- The injected text is visibly attributed as durable memory and is advisory context rather than instruction.
- If relevant snippets exceed the cap, the adapter chooses the best-scoring lines and records that truncation occurred.

### Audit records
- Each queued batch and worker run records structured audit data in pi.dev extension state outside the LLM context.
- Audit data includes trigger reason, batch item count, selected model, dry-run flag, exit status, proposed or changed paths, validator result, error summary, and a short output tail.
- Audit records must not include entire conversation transcripts unless needed for a failed-run diagnostic, and even then they are bounded.

### Validator command surface
- The pi.dev adapter exposes a validate operation that runs the reference validator against the resolved memory root.
- Disabled mode suppresses validation because disabled mode means no memory I/O.
- Invalid frontmatter types are validator errors for this adapter. Validator errors fail the
  operation; general v0.1 warnings remain advisory.
- Adapter-specific stricter caps are allowed by SPEC §2.5. When the pi.dev adapter declares
  an index cap, exceeding it is a pi.dev write-time refusal even if the substrate-neutral
  v0.1 validator would otherwise classify that cap family as a warning.

## Verification signals
- Root precedence tests prove explicit configuration wins and default resolution is stable.
- An invalid or uncanonicalizable root produces no memory I/O and a visible failure status.
- User ignore input prevents injection and forced writes for the rest of the session.
- Worker launch tests prove the child process receives the disable flag or the run is refused.
- Injection tests verify the 12-line / 4 KB cap and visible attribution.
- Audit tests verify queue and run records are retrievable from extension state but absent from LLM messages.
- Validate command tests invoke the reference validator with the resolved root and obey disabled mode.
- Forced-write tests prove adapter-specific index cap violations are refused before topic files are written.
