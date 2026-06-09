# 09 — Worker Failure Retention

Failed worker runs retain candidate batches for explicit recovery.

## Jobs to be done
- Durable memory candidates are not lost when the background model or subprocess fails.
- Operators can see why a forced-write attempt failed.
- Recovery does not create an unbounded retry loop.

## Scope
- In scope: failed-run states, queue retention, retry triggers, and operator visibility.
- Out of scope: provider-specific authentication setup, model pricing policy, and long-term
  durable storage of the extension queue.

## Behavioral contract

### Failed-run classes
- A refused run occurs when the extension cannot prove a required safety property before
  launching the worker.
- A failed run occurs when the worker launches but cannot return an acceptable structured
  proposal result, exits unsuccessfully, times out, or produces proposals the applicator
  refuses.
- A validation-failed run occurs when proposals were applied temporarily but the reference
  validator rejected the resulting memory directory. The applicator must roll back before
  the run is reported.

### Retention
- Candidate items from a refused, failed, or validation-failed run remain queued.
- Candidate retention preserves ordering relative to later items.
- Retained candidates are not duplicated in the queue.
- A disabled or ignored session does not process retained candidates.

### Recovery triggers
- An explicit operator flush may retry retained candidates.
- A later eligible event may schedule another attempt only after the current failed run has
  fully settled.
- The extension must not spin in an immediate retry loop after a deterministic failure.
- A successful retry removes only the candidate items that were processed successfully.

### Operator visibility
- Each failed or refused run records an audit entry with the trigger reason, batch size,
  selected model, dry-run state, failure class, retained queue count, applicator-proposed
  paths in dry-run or changed paths in live mode, validator result when available, and a
  bounded output tail.
- User-facing status or command output distinguishes disabled, ignored, unavailable,
  refused, failed, and successful no-write outcomes.
- Failure output is bounded so extension state does not become a hidden transcript dump.

## Verification signals
- An unreachable model produces no file changes, records a failed run, and retains the
  candidate batch.
- A refused unsafe launch produces no subprocess invocation and retains the candidate batch.
- A validator failure rolls back all temporary file changes and retains the candidate batch.
- A manual flush after fixing the cause can process retained candidates exactly once.
- Repeated deterministic failures do not create concurrent or immediate recursive retries.
