#!/usr/bin/env bash
# Ralph — Huntley-canonical autonomous coding loop.
#
# Substrate: codex exec (primary, gpt-5.5) or claude -p (backup, opus).
# Switch via:  RALPH_SUBSTRATE=claude ./ralph.sh ...
#
# Usage:
#   ./ralph.sh                          # build mode, unlimited iterations
#   ./ralph.sh plan                     # plan mode (refresh IMPLEMENTATION_PLAN.md)
#   ./ralph.sh specs                    # generate specs from JTBD discussion
#   ./ralph.sh reverse                  # reverse-engineer specs via orchestrator + parallel workers
#   ./ralph.sh build 20                 # build mode, max 20 iterations
#   ./ralph.sh plan 5                   # plan mode, max 5 iterations
#
# Per-iteration capture (each run gets its own dir):
#   scripts/ralph/runs/<run-id>/iter-NNN.{jsonl,txt}              # build/plan/specs
#   scripts/ralph/runs/<run-id>/iter-NNN/orchestrator.{jsonl,txt} # reverse mode
#   scripts/ralph/runs/<run-id>/iter-NNN/workers/worker-NNN.md    # reverse mode
#   scripts/ralph/runs/<run-id>/next-chunks.txt                   # reverse mode (orchestrator writes; empty = done)
#   scripts/ralph/runs/<run-id>/ralph.log
#
# Reverse-mode env knobs:
#   RALPH_WORKER_MODEL          (default: gpt-5.3-codex-spark)  — model for parallel workers
#   RALPH_ORCHESTRATOR_MODEL    (default: gpt-5.5)              — model for the supervising orchestrator
#   RALPH_REASONING_EFFORT      (default: medium)               — low|medium|high|xhigh; orchestrator + workers
#   RALPH_WORKER_PARALLELISM    (default: 5)                    — max concurrent workers per iter
#
# No COMPLETE tag (except reverse mode, which exits on empty next-chunks.txt).
# No per-iteration budget cap. Trust the model. Ctrl+C to stop.
# git push happens after every successful iteration.

set -uo pipefail

# --- args --------------------------------------------------------------------

MODE="build"
PROMPT_FILE="PROMPT_build.md"
MAX_ITERATIONS=0

if [ "${1:-}" = "plan" ]; then
  MODE="plan"; PROMPT_FILE="PROMPT_plan.md"; MAX_ITERATIONS=${2:-0}
elif [ "${1:-}" = "specs" ]; then
  MODE="specs"; PROMPT_FILE="PROMPT_specs.md"; MAX_ITERATIONS=${2:-1}
elif [ "${1:-}" = "reverse" ]; then
  MODE="reverse"; PROMPT_FILE="PROMPT_reverse_orchestrator.md"; MAX_ITERATIONS=${2:-0}
elif [ "${1:-}" = "build" ]; then
  MODE="build"; PROMPT_FILE="PROMPT_build.md"; MAX_ITERATIONS=${2:-0}
elif [[ "${1:-}" =~ ^[0-9]+$ ]]; then
  MAX_ITERATIONS=$1
fi

# --- paths -------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
RUNS_DIR="$SCRIPT_DIR/runs/$RUN_ID"
LOGFILE="$RUNS_DIR/ralph.log"
PROMPT_PATH="$SCRIPT_DIR/$PROMPT_FILE"

[ ! -f "$PROMPT_PATH" ] && { echo "❌ missing $PROMPT_PATH — run Scaffold workflow" >&2; exit 1; }

# --- substrate ---------------------------------------------------------------

SUBSTRATE="${RALPH_SUBSTRATE:-codex}"

case "$SUBSTRATE" in
  codex)
    command -v codex >/dev/null 2>&1 || { echo "❌ codex not on PATH" >&2; exit 1; }
    ;;
  claude)
    command -v claude >/dev/null 2>&1 || { echo "❌ claude not on PATH" >&2; exit 1; }
    export CLAUDE_CODE_SKIP_NEST_CHECK=1
    unset CLAUDECODE
    ;;
  *) echo "unknown RALPH_SUBSTRATE: $SUBSTRATE" >&2; exit 2 ;;
esac

JQ_BIN="$(command -v jq || true)"
CURRENT_BRANCH="$(cd "$PROJECT_ROOT" && git branch --show-current 2>/dev/null || echo '')"
mkdir -p "$RUNS_DIR"

# --- banner ------------------------------------------------------------------

{
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Mode:      $MODE"
echo "Substrate: $SUBSTRATE"
echo "Prompt:    $PROMPT_FILE"
echo "Branch:    ${CURRENT_BRANCH:-<none>}"
echo "Run dir:   $RUNS_DIR"
[ "$MAX_ITERATIONS" -gt 0 ] && echo "Max:       $MAX_ITERATIONS iterations" || echo "Max:       unlimited (Ctrl+C to stop)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
} | tee "$LOGFILE"

cd "$PROJECT_ROOT"

# --- invocation helpers ------------------------------------------------------

run_codex() {
  local prompt_path="$1" out="$2" model="${3:-gpt-5.5}" effort="${4:-high}"
  codex exec \
    --model "$model" \
    --sandbox danger-full-access \
    --dangerously-bypass-approvals-and-sandbox \
    -c model_reasoning_effort="$effort" \
    --json \
    - < "$prompt_path" > "$out" 2>&1
}

run_claude() {
  local prompt_path="$1" out="$2"
  claude \
    --dangerously-skip-permissions \
    --model opus \
    --verbose \
    --output-format stream-json \
    --include-partial-messages \
    --no-session-persistence \
    -p \
    < "$prompt_path" > "$out" 2>&1
}

extract_text() {
  local jsonl="$1" txt="$2"
  [ -n "$JQ_BIN" ] && [ -s "$jsonl" ] && \
    "$JQ_BIN" -r 'select(.type=="assistant" or .type=="text") | (.message.content[]? // .) | (.text // empty)' \
      "$jsonl" 2>/dev/null > "$txt" || true
}

# --- reverse-mode fanout helpers --------------------------------------------

WORKER_MODEL="${RALPH_WORKER_MODEL:-gpt-5.3-codex-spark}"
ORCHESTRATOR_MODEL="${RALPH_ORCHESTRATOR_MODEL:-gpt-5.5}"
REASONING_EFFORT="${RALPH_REASONING_EFFORT:-medium}"
WORKER_PARALLELISM="${RALPH_WORKER_PARALLELISM:-5}"
CHUNKS_FILE="$RUNS_DIR/next-chunks.txt"
WORKER_PROMPT_PATH="$SCRIPT_DIR/PROMPT_reverse_worker.md"

run_worker() {
  # $1 = chunk, $2 = worker output path
  local chunk="$1" out="$2"
  RALPH_CHUNK="$chunk" codex exec \
    --model "$WORKER_MODEL" \
    --sandbox danger-full-access \
    --dangerously-bypass-approvals-and-sandbox \
    -c model_reasoning_effort="$REASONING_EFFORT" \
    -c shell_environment_policy.inherit=all \
    --json \
    - < "$WORKER_PROMPT_PATH" > "$out.jsonl" 2>&1
  extract_text "$out.jsonl" "$out"
}

dispatch_workers() {
  # Reads CHUNKS_FILE, spawns up to WORKER_PARALLELISM workers in parallel,
  # writes each worker's stdout summary to $ITER_DIR/workers/worker-NNN.md
  local iter_dir="$1"
  local workers_dir="$iter_dir/workers"
  mkdir -p "$workers_dir"
  local n_chunks
  n_chunks="$(grep -cve '^[[:space:]]*$' "$CHUNKS_FILE" 2>/dev/null || echo 0)"
  if [ "$n_chunks" -eq 0 ]; then
    echo "  (no chunks to dispatch)" | tee -a "$LOGFILE"
    return 0
  fi
  echo "  dispatching $n_chunks worker(s), parallelism=$WORKER_PARALLELISM, model=$WORKER_MODEL" | tee -a "$LOGFILE"
  local worker_id=0
  local -a pids=()
  while IFS= read -r chunk; do
    # skip blank/whitespace lines
    [ -z "${chunk//[[:space:]]/}" ] && continue
    worker_id=$((worker_id + 1))
    local wnum
    wnum="$(printf '%03d' "$worker_id")"
    local wout="$workers_dir/worker-$wnum.md"
    echo "    → worker $wnum: $chunk" | tee -a "$LOGFILE"
    ( run_worker "$chunk" "$wout" ) &
    pids+=($!)
    # throttle
    while [ "${#pids[@]}" -ge "$WORKER_PARALLELISM" ]; do
      sleep 1
      local -a alive=()
      for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && alive+=("$p"); done
      pids=("${alive[@]}")
    done
  done < "$CHUNKS_FILE"
  wait
  echo "  all workers done" | tee -a "$LOGFILE"
}

# --- main loop ---------------------------------------------------------------

ITERATION=0

if [ "$MODE" = "reverse" ]; then
  # Reverse mode: orchestrator + parallel worker fanout per iter.
  # First iter: orchestrator bootstraps (no prior worker dir, writes initial next-chunks.txt).
  # Subsequent iters: orchestrator reads last iter's workers/, integrates → specs/, writes new next-chunks.txt.
  # Exit: orchestrator writes empty next-chunks.txt OR MAX_ITERATIONS reached.
  PREV_WORKERS_DIR=""
  while true; do
    if [ "$MAX_ITERATIONS" -gt 0 ] && [ "$ITERATION" -ge "$MAX_ITERATIONS" ]; then
      echo "Reached max iterations: $MAX_ITERATIONS" | tee -a "$LOGFILE"
      break
    fi
    ITERATION=$((ITERATION + 1))
    ITER_NUM="$(printf '%03d' "$ITERATION")"
    ITER_DIR="$RUNS_DIR/iter-$ITER_NUM"
    mkdir -p "$ITER_DIR"
    {
      echo ""
      echo "======================== REVERSE ITER $ITERATION ========================"
      echo "$(date '+%Y-%m-%d %H:%M:%S')"
    } | tee -a "$LOGFILE"

    # --- Orchestrator phase ---
    echo "── orchestrator phase (model=$ORCHESTRATOR_MODEL, effort=$REASONING_EFFORT) ──" | tee -a "$LOGFILE"
    ORCH_INPUT="$ITER_DIR/orchestrator-input.md"
    {
      echo "ITERATION: $ITERATION"
      echo "PREV_WORKERS_DIR: ${PREV_WORKERS_DIR:-<none — first iter, bootstrap mode>}"
      echo "NEXT_CHUNKS_FILE: $CHUNKS_FILE"
      echo ""
      echo "Read your role definition below and act."
      echo ""
      cat "$PROMPT_PATH"
    } > "$ORCH_INPUT"
    set +e
    run_codex "$ORCH_INPUT" "$ITER_DIR/orchestrator.jsonl" "$ORCHESTRATOR_MODEL" "$REASONING_EFFORT"
    set -e
    extract_text "$ITER_DIR/orchestrator.jsonl" "$ITER_DIR/orchestrator.txt"
    [ -s "$ITER_DIR/orchestrator.txt" ] && tee -a "$LOGFILE" < "$ITER_DIR/orchestrator.txt" >/dev/null

    # --- Exit check ---
    if [ ! -f "$CHUNKS_FILE" ] || [ ! -s "$CHUNKS_FILE" ]; then
      echo "Orchestrator wrote empty/missing $CHUNKS_FILE — reverse phase complete." | tee -a "$LOGFILE"
      break
    fi

    # --- Worker fanout phase ---
    echo "── worker fanout phase ──" | tee -a "$LOGFILE"
    dispatch_workers "$ITER_DIR"
    PREV_WORKERS_DIR="$ITER_DIR/workers"

    # Push after every iter
    if [ -n "$CURRENT_BRANCH" ]; then
      git push origin "$CURRENT_BRANCH" 2>/dev/null || git push -u origin "$CURRENT_BRANCH" 2>/dev/null || \
        echo "⚠️  git push failed (no remote? branch unset?) — continuing" | tee -a "$LOGFILE"
    fi
  done
else
  # Sequential single-session mode (build/plan/specs).
  while true; do
    if [ "$MAX_ITERATIONS" -gt 0 ] && [ "$ITERATION" -ge "$MAX_ITERATIONS" ]; then
      echo "Reached max iterations: $MAX_ITERATIONS" | tee -a "$LOGFILE"
      break
    fi

    ITERATION=$((ITERATION + 1))
    ITER_NUM="$(printf '%03d' "$ITERATION")"
    ITER_JSONL="$RUNS_DIR/iter-$ITER_NUM.jsonl"
    ITER_TXT="$RUNS_DIR/iter-$ITER_NUM.txt"

    {
      echo ""
      echo "======================== LOOP $ITERATION ========================"
      echo "$(date '+%Y-%m-%d %H:%M:%S')"
    } | tee -a "$LOGFILE"

    set +e
    if [ "$SUBSTRATE" = "codex" ]; then run_codex "$PROMPT_PATH" "$ITER_JSONL" "$ORCHESTRATOR_MODEL" "$REASONING_EFFORT"
    else                                  run_claude "$PROMPT_PATH" "$ITER_JSONL"; fi
    set -e

    extract_text "$ITER_JSONL" "$ITER_TXT"
    [ -s "$ITER_TXT" ] && tee -a "$LOGFILE" < "$ITER_TXT" >/dev/null

    # Push after every iteration
    if [ -n "$CURRENT_BRANCH" ]; then
      git push origin "$CURRENT_BRANCH" 2>/dev/null || git push -u origin "$CURRENT_BRANCH" 2>/dev/null || \
        echo "⚠️  git push failed (no remote? branch unset?) — continuing" | tee -a "$LOGFILE"
    fi
  done
fi
