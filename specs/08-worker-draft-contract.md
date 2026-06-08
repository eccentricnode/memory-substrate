# 08 — Worker Draft Contract

The background worker output is a bounded structured proposal stream.

## Jobs to be done
- The extension can apply or refuse worker output without interpreting prose.
- A malformed worker response cannot produce a partial memory write.
- Update and delete proposals have the same safety envelope as new-memory proposals.

## Scope
- In scope: proposal shape, required proposal content, refusal conditions, and applicator
  expectations.
- Out of scope: model prompting details, subprocess mechanics, ranking quality, and the
  filesystem implementation of the applicator.

## Behavioral contract

### Response envelope
- The worker returns one structured response containing zero or more memory proposals.
- An empty proposal list means the batch contains no durable memory and is a successful
  no-write result.
- Any non-structured response, extra narrative that prevents parsing, or malformed proposal
  is a failed worker run. The original candidate batch is retained under the failure
  retention contract.

### Proposal actions
- A create-or-update proposal writes one topic memory and one index pointer through the
  extension applicator.
- A delete proposal removes one existing topic memory and its index pointer through the
  extension applicator.
- Unknown actions are refused. Refusal produces no memory mutation.

### Create-or-update content
- Each create-or-update proposal identifies exactly one memory type from the substrate
  type set: user, feedback, project, or reference.
- Each create-or-update proposal carries a stable slug, a one-line description, topic body
  content, an index title, an index hook, and a topic-relative path.
- The slug, topic-relative path, and type must describe the same memory target. A mismatch
  is a refused proposal.
- The description must satisfy the topic frontmatter cap and no-markdown rule.
- The index hook must be short enough that the resulting pointer line satisfies the active
  adapter cap.
- Feedback and project proposals carry body content that states the durable fact first,
  then explains why it matters and how to apply it.

### Delete content
- Each delete proposal identifies one existing topic-relative path and a short deletion
  reason.
- The target must already exist as a topic memory under the resolved memory root.
- Delete proposals never target the index itself.

### Applicator authority
- The worker never writes files directly in the live forced-write path.
- The extension applicator canonicalizes every target, enforces dry-run, performs the
  two-step save or delete, and runs the reference validator.
- If any proposal in a batch is refused or validation fails, the applied result is atomic:
  no partial topic or index mutation remains.

## Verification signals
- A no-memory response produces no file changes and a successful audit record.
- A malformed response produces a failed audit record with the candidate batch retained.
- A create-or-update proposal produces one validator-clean topic file plus one in-cap index
  pointer.
- A delete proposal removes the topic file and matching index pointer without touching
  unrelated memories.
- A proposal with a path/type/slug mismatch, an unknown action, or an out-of-root target is
  refused before mutation.
