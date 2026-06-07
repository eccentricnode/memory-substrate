# 02 — Extension Lifecycle and Event Batching

The extension observes selected pi.dev session events and turns them into batched,
debounced background work, without making the main agent reason about memory.

## Jobs to be done
- The main pi.dev agent never spends its own turn deciding what to remember.
- Completed turns and compaction-adjacent moments are captured as memory candidates.
- Bursts of events collapse into a small number of background invocations, not one per event.

## Behavioral contract

### Observed events
- On end of an agent turn, the completed turn's messages are enqueued as a candidate batch
  item. (Host event surface: `agent_end`, which carries the turn's messages.)
- Immediately before compaction runs, a candidate item marking the compaction moment is
  enqueued and the queue is flushed, because compaction is lossy and high-value context
  must be preserved first. (Host event surface: `session_before_compact`, which can also
  cancel/customize compaction — this extension must not cancel it.)
- The set of observed events is conservative; ordinary tool results are out of scope for v1.

### Queue, debounce, batch
- Enqueued items accumulate; processing fires when either the debounce window elapses since
  the last event or the batch reaches its max size, whichever comes first.
- Only one background processing run is in flight at a time. If items arrive during a run,
  they are processed in the next run, not concurrently.
- The compaction moment forces an immediate flush regardless of the debounce window.

### Isolation from host context
- Candidate batches and run metadata are persisted as extension state that does not enter
  the LLM context. (Host surface: `appendEntry` for audit/debug state.)
- The main session's context is never enlarged by the extension's bookkeeping.

## Verification signals
- A sequence of rapid turns within one debounce window yields exactly one worker run, not one per turn.
- Reaching max batch size before the window elapses triggers a run immediately.
- A compaction event flushes the queue before compaction proceeds, and compaction is not cancelled.
- Run metadata is retrievable from extension state and is absent from the model's context window.
