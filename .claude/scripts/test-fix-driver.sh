#!/usr/bin/env bash
#
# test-fix-driver.sh — Outer-loop driver for the test-fix workflow.
#
# Loops over /test-fix-round invocations until all ledger entries reach
# a terminal state (fixed or escalated), surviving Agent crashes, context
# overflows, and session disconnects.
#
# Usage:
#   .claude/scripts/test-fix-driver.sh [OPTIONS]
#
# Options:
#   --max-rounds <N>       Maximum fix rounds (default: 10)
#   --round-timeout <SEC>  Per-round timeout in seconds (default: 600)
#   --ledger-path <PATH>   Path to ledger JSON file (default: /tmp/test-fix-ledger-$$.json)
#   --help                 Show this help message and exit

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────
MAX_ROUNDS=10
ROUND_TIMEOUT=600
LEDGER_PATH=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="$PROJECT_ROOT/.claude/logs"
COUNTER_FILE="$LOG_DIR/test-fix-round-counter"

# ── Usage ─────────────────────────────────────────────────────────────
usage() {
  cat <<'EOF'
test-fix-driver.sh — Outer-loop driver for the test-fix workflow

USAGE:
  .claude/scripts/test-fix-driver.sh [OPTIONS]

OPTIONS:
  --max-rounds <N>       Maximum number of fix rounds before force-escalating
                         remaining failures. Default: 10
  --round-timeout <SEC>  Timeout in seconds for each Agent invocation.
                         Default: 600 (10 minutes)
  --ledger-path <PATH>   Path to the ledger JSON file. If the file does not
                         exist, the driver will initialize it via /test-analyze.
                         Default: .claude/logs/test-fix-ledger.json
  --help                 Show this help message and exit

EXIT CODES:
  0  All failures fixed
  1  Some failures escalated (partial success)
  2  Driver error (ledger corruption, missing dependency, script bug)

EXAMPLES:
  # Run with defaults
  .claude/scripts/test-fix-driver.sh

  # Custom ledger path and shorter timeout
  .claude/scripts/test-fix-driver.sh --ledger-path /tmp/my-ledger.json --round-timeout 300

  # Resume from an existing ledger (crash recovery)
  .claude/scripts/test-fix-driver.sh --ledger-path .claude/logs/test-fix-ledger.json
EOF
}

# ── Argument Parsing ──────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-rounds)
      MAX_ROUNDS="$2"
      shift 2
      ;;
    --round-timeout)
      ROUND_TIMEOUT="$2"
      shift 2
      ;;
    --ledger-path)
      LEDGER_PATH="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      echo "Run with --help for usage information." >&2
      exit 2
      ;;
  esac
done

# ── Dependency Check ──────────────────────────────────────────────────
check_dependencies() {
  local missing=()

  if ! command -v claude &>/dev/null; then
    missing+=("claude (Claude Code CLI — install from https://claude.ai/code)")
  fi

  if ! command -v jq &>/dev/null; then
    missing+=("jq (JSON processor — install via: brew install jq)")
  fi

  if ! command -v flock &>/dev/null; then
    missing+=("flock (file locking — install via: brew install util-linux)")
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: Missing required dependencies:" >&2
    for dep in "${missing[@]}"; do
      echo "  - $dep" >&2
    done
    exit 2
  fi
}

check_dependencies

# ── Ensure Log Directory ──────────────────────────────────────────────
mkdir -p "$LOG_DIR"

# Apply default ledger path if not specified (after LOG_DIR is created)
if [[ -z "$LEDGER_PATH" ]]; then
  LEDGER_PATH="$LOG_DIR/test-fix-ledger.json"
fi

# ── Signal Handling ──────────────────────────────────────────────────
# Trap SIGINT/SIGTERM to exit gracefully after the current round completes.
# The driver does NOT kill the Agent mid-round — it waits for completion.
SHUTDOWN_REQUESTED=0

print_ledger_summary() {
  if [[ -f "$LEDGER_PATH" ]] && jq empty "$LEDGER_PATH" 2>/dev/null; then
    local total fixed escalated discovered attempted
    total=$(jq '.entries | length' "$LEDGER_PATH")
    fixed=$(jq '[.entries[] | select(.status == "fixed")] | length' "$LEDGER_PATH")
    escalated=$(jq '[.entries[] | select(.status == "escalated")] | length' "$LEDGER_PATH")
    discovered=$(jq '[.entries[] | select(.status == "discovered")] | length' "$LEDGER_PATH")
    attempted=$(jq '[.entries[] | select(.status == "attempted")] | length' "$LEDGER_PATH")
    echo "[STATUS] Ledger: $total total, $fixed fixed, $escalated escalated, $discovered discovered, $attempted attempted"
  fi
}

handle_shutdown() {
  echo ""
  echo "[SIGNAL] Shutdown requested — will exit after current round completes"
  SHUTDOWN_REQUESTED=1
}

trap handle_shutdown SIGINT SIGTERM

# ── Concurrency Safety: File Locking ─────────────────────────────────
# Acquire an exclusive lock on a lock file derived from the ledger path.
# If another driver instance holds the lock, exit immediately with an error.
LOCK_FILE="${LEDGER_PATH}.lock"

# Open the lock file on file descriptor 9
exec 9>"$LOCK_FILE"

if ! flock -n 9; then
  echo "ERROR: Another test-fix-driver instance is already running (lock held on $LOCK_FILE)" >&2
  echo "If you believe this is stale, remove the lock file: rm $LOCK_FILE" >&2
  exit 2
fi

# Release lock and print summary on exit (normal or signal)
cleanup() {
  flock -u 9 2>/dev/null || true
  exec 9>&- 2>/dev/null || true
  rm -f "$LOCK_FILE" 2>/dev/null || true
  print_ledger_summary
  echo "[EXIT] Driver stopped."
}

trap 'handle_shutdown' SIGINT SIGTERM
trap 'cleanup' EXIT

# ── Print Configuration ───────────────────────────────────────────────
echo "test-fix-driver.sh"
echo "  Project root:  $PROJECT_ROOT"
echo "  Ledger path:   $LEDGER_PATH"
echo "  Max rounds:    $MAX_ROUNDS"
echo "  Round timeout: ${ROUND_TIMEOUT}s"
echo "  Log directory: $LOG_DIR"
echo ""

# ── INIT State: Ledger Initialization ─────────────────────────────────
# If the ledger does not exist, invoke /test-analyze to discover failures
# and create an initial ledger with all entries in "discovered" status.
# If the ledger already exists (crash recovery), skip to LOOP.

init_ledger() {
  echo "[INIT] No ledger found at $LEDGER_PATH"
  echo "[INIT] Invoking /test-analyze to discover test failures..."

  local raw_output="/tmp/test-fix-raw-output-$$.txt"
  local report_file="$LOG_DIR/test-analyze-init.log"

  # Invoke claude with /test-analyze to get a structured failure report
  local exit_code=0
  timeout "$ROUND_TIMEOUT" claude -p "/test-analyze --scope bun --output $raw_output" \
    > "$report_file" 2>&1 || exit_code=$?

  if [[ $exit_code -eq 124 ]]; then
    echo "[ERROR] /test-analyze timed out after ${ROUND_TIMEOUT}s" >&2
    exit 2
  fi

  if [[ ! -s "$report_file" ]]; then
    echo "[ERROR] /test-analyze produced no output. See $report_file" >&2
    exit 2
  fi

  echo "[INIT] /test-analyze complete. Parsing failure report..."

  # Parse failure table rows from the Markdown report.
  # Each data row matches: | <number> | <priority> | <file> | <test> | <error_type> | <message> | <source> |
  local entries_json="[]"
  local count=0

  while IFS='|' read -r _ num priority file test error_type error_message source _rest; do
    # Trim whitespace from each field
    num="$(echo "$num" | xargs)"
    priority="$(echo "$priority" | xargs)"
    file="$(echo "$file" | xargs)"
    test_name="$(echo "$test" | xargs)"
    error_type="$(echo "$error_type" | xargs)"

    # Skip header/separator rows — only process rows where # is an integer
    [[ "$num" =~ ^[0-9]+$ ]] || continue

    count=$((count + 1))
    local entry_id
    printf -v entry_id "F-%03d" "$count"

    # Validate priority is P0-P5; default to P3 if unrecognized
    if [[ ! "$priority" =~ ^P[0-5]$ ]]; then
      priority="P3"
    fi

    entries_json=$(echo "$entries_json" | jq \
      --arg id "$entry_id" \
      --arg file "$file" \
      --arg test "$test_name" \
      --arg priority "$priority" \
      '. + [{
        id: $id,
        file: $file,
        test: $test,
        priority: $priority,
        status: "discovered",
        attempt_count: 0,
        max_attempts: 3,
        diagnosis: null,
        fix_applied: null,
        escalation_reason: null,
        modified_files: []
      }]')
  done < <(grep -E '^\| *[0-9]' "$report_file" 2>/dev/null || true)

  # Build the full ledger JSON
  local session_id
  session_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  local now
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  jq -n \
    --arg session_id "$session_id" \
    --arg created_at "$now" \
    --arg updated_at "$now" \
    --argjson initial_failure_count "$count" \
    --argjson entries "$entries_json" \
    '{
      session_id: $session_id,
      created_at: $created_at,
      updated_at: $updated_at,
      initial_failure_count: $initial_failure_count,
      entries: $entries
    }' > "$LEDGER_PATH"

  # Validate the generated ledger is valid JSON
  if ! jq empty "$LEDGER_PATH" 2>/dev/null; then
    echo "[ERROR] Generated ledger is not valid JSON" >&2
    exit 2
  fi

  echo "[INIT] Ledger initialized: $count failure(s) in 'discovered' state"
  echo "[INIT] Ledger written to $LEDGER_PATH"

  # Initialize round counter to 0
  echo "0" > "$COUNTER_FILE"
  echo "[INIT] Round counter initialized at $COUNTER_FILE"
}

# ── State Machine Entry Point ─────────────────────────────────────────
if [[ -f "$LEDGER_PATH" ]]; then
  echo "[INIT] Existing ledger found at $LEDGER_PATH — resuming"

  # Validate existing ledger is valid JSON
  if ! jq empty "$LEDGER_PATH" 2>/dev/null; then
    echo "[ERROR] Existing ledger is not valid JSON — delete and re-run to reinitialize" >&2
    exit 2
  fi

  # Ensure round counter exists (may have been lost if driver was killed)
  if [[ ! -f "$COUNTER_FILE" ]]; then
    echo "0" > "$COUNTER_FILE"
    echo "[INIT] Round counter missing — reinitialized to 0"
  fi

  local_entries=$(jq '.entries | length' "$LEDGER_PATH")
  local_terminal=$(jq '[.entries[] | select(.status == "fixed" or .status == "escalated")] | length' "$LEDGER_PATH")
  local_remaining=$((local_entries - local_terminal))
  echo "[INIT] Ledger status: $local_entries total, $local_terminal terminal, $local_remaining remaining"
else
  init_ledger
fi

# ── Helper: Count Non-Terminal Entries ────────────────────────────────
count_non_terminal() {
  local total
  total=$(jq '.entries | length' "$LEDGER_PATH")
  local terminal
  terminal=$(jq '[.entries[] | select(.status == "fixed" or .status == "escalated")] | length' "$LEDGER_PATH")
  echo $((total - terminal))
}

# ── Helper: Count Terminal Entries ────────────────────────────────────
count_terminal() {
  jq '[.entries[] | select(.status == "fixed" or .status == "escalated")] | length' "$LEDGER_PATH"
}

# ── Helper: Read Round Counter ───────────────────────────────────────
read_round() {
  if [[ -f "$COUNTER_FILE" ]]; then
    cat "$COUNTER_FILE"
  else
    echo "0"
  fi
}

# ── Helper: Increment Round Counter ──────────────────────────────────
increment_round() {
  local current
  current=$(read_round)
  echo $((current + 1)) > "$COUNTER_FILE"
}

# ── Handle Timeout: Update In-Progress Entries ────────────────────────
# When the agent times out, any entry left in status="attempted" was being
# worked on. Increment attempt_count, record diagnosis, and escalate if
# max_attempts is reached (escalation_reason="timeout"), otherwise reset
# to "discovered" for retry.
handle_timeout() {
  local timeout_secs="$1"

  # Check for in-progress entries
  local attempted_count
  attempted_count=$(jq '[.entries[] | select(.status == "attempted")] | length' "$LEDGER_PATH" 2>/dev/null || echo "0")

  if [[ "$attempted_count" -eq 0 ]]; then
    echo "[TIMEOUT] No in-progress entries found — ledger unchanged"
    return
  fi

  echo "[TIMEOUT] Found $attempted_count in-progress entry/entries — updating ledger"

  local now
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  local updated
  updated=$(jq \
    --arg now "$now" \
    --arg msg "[TIMEOUT] Agent timed out after ${timeout_secs}s while attempting fix" \
    '
    .updated_at = $now |
    .entries = [.entries[] |
      if .status == "attempted" then
        .attempt_count += 1 |
        .diagnosis = $msg |
        if .attempt_count >= .max_attempts then
          .status = "escalated" |
          .escalation_reason = "timeout"
        else
          .status = "discovered"
        end
      else
        .
      end
    ]
    ' "$LEDGER_PATH")

  echo "$updated" > "$LEDGER_PATH"

  if ! jq empty "$LEDGER_PATH" 2>/dev/null; then
    echo "[ERROR] Ledger corrupted during timeout handling" >&2
    exit 2
  fi

  local escalated_count
  escalated_count=$(jq '[.entries[] | select(.escalation_reason == "timeout")] | length' "$LEDGER_PATH")
  echo "[TIMEOUT] $attempted_count timed-out entry/entries processed ($escalated_count escalated with reason=timeout)"
}

# ── FORCE_ESCALATE State ──────────────────────────────────────────────
# Set all non-terminal ledger entries to status='escalated' with
# escalation_reason='max_attempts_exceeded', then transition to REPORT.
force_escalate() {
  echo "[FORCE_ESCALATE] Escalating all remaining non-terminal entries..."

  local now
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  local updated
  updated=$(jq \
    --arg now "$now" \
    '
    .updated_at = $now |
    .entries = [.entries[] |
      if .status != "fixed" and .status != "escalated" then
        .status = "escalated" |
        .escalation_reason = "max_attempts_exceeded"
      else
        .
      end
    ]
    ' "$LEDGER_PATH")

  echo "$updated" > "$LEDGER_PATH"

  # Validate the updated ledger
  if ! jq empty "$LEDGER_PATH" 2>/dev/null; then
    echo "[ERROR] Ledger corrupted during force-escalate" >&2
    exit 2
  fi

  local escalated_count
  escalated_count=$(jq '[.entries[] | select(.escalation_reason == "max_attempts_exceeded")] | length' "$LEDGER_PATH")
  echo "[FORCE_ESCALATE] $escalated_count entry/entries force-escalated"
  echo "[FORCE_ESCALATE] Transitioning to REPORT"
}

# ── REPORT State ──────────────────────────────────────────────────────
# Invoke /test-fix-report to generate the final Markdown report from the ledger.
generate_report() {
  echo "[REPORT] Generating final report from ledger..."

  local report_log="$LOG_DIR/test-fix-report.log"

  local exit_code=0
  timeout "$ROUND_TIMEOUT" claude -p "/test-fix-report --ledger $LEDGER_PATH" \
    > "$report_log" 2>&1 || exit_code=$?

  if [[ $exit_code -eq 124 ]]; then
    echo "[WARN] /test-fix-report timed out after ${ROUND_TIMEOUT}s — report may be incomplete" >&2
  elif [[ $exit_code -ne 0 ]]; then
    echo "[WARN] /test-fix-report exited with code $exit_code — report may be incomplete" >&2
  else
    echo "[REPORT] Report generation complete. See $report_log"
  fi

  # Print ledger summary regardless of report generation outcome
  local total fixed escalated
  total=$(jq '.entries | length' "$LEDGER_PATH")
  fixed=$(jq '[.entries[] | select(.status == "fixed")] | length' "$LEDGER_PATH")
  escalated=$(jq '[.entries[] | select(.status == "escalated")] | length' "$LEDGER_PATH")
  echo "[REPORT] Final ledger: $total total, $fixed fixed, $escalated escalated"
}

# ── LOOP State: Round Invocation with Timeout ────────────────────────
echo ""
echo "[LOOP] Starting fix loop..."

stale_rounds=0
MAX_STALE_ROUNDS=3

while true; do
  local_round=$(read_round)
  local_remaining=$(count_non_terminal)

  echo ""
  echo "[LOOP] Round $local_round | $local_remaining non-terminal entries remaining | stale_rounds=$stale_rounds"

  # Termination: all entries are terminal
  if [[ "$local_remaining" -eq 0 ]]; then
    echo "[LOOP] All ledger entries are terminal — transitioning to REPORT"
    generate_report
    # Determine exit code: 0 if all fixed, 1 if any escalated
    local_escalated=$(jq '[.entries[] | select(.status == "escalated")] | length' "$LEDGER_PATH")
    if [[ "$local_escalated" -eq 0 ]]; then
      echo "[DONE] All failures fixed!"
      exit 0
    else
      echo "[DONE] $local_escalated failure(s) escalated for human review."
      exit 1
    fi
  fi

  # Termination: max rounds exceeded
  if [[ "$local_round" -ge "$MAX_ROUNDS" ]]; then
    echo "[LOOP] Round $local_round >= max rounds $MAX_ROUNDS — transitioning to FORCE_ESCALATE"
    force_escalate
    generate_report
    # Determine exit code: 0 if all fixed, 1 if any escalated
    local_escalated=$(jq '[.entries[] | select(.status == "escalated")] | length' "$LEDGER_PATH")
    if [[ "$local_escalated" -eq 0 ]]; then
      echo "[DONE] All failures fixed!"
      exit 0
    else
      echo "[DONE] $local_escalated failure(s) escalated for human review."
      exit 1
    fi
  fi

  # Termination: staleness detected (no progress for 3 consecutive rounds)
  if [[ "$stale_rounds" -ge "$MAX_STALE_ROUNDS" ]]; then
    echo "[LOOP] $stale_rounds consecutive rounds with no progress — transitioning to FORCE_ESCALATE"
    force_escalate
    generate_report
    # Determine exit code: 0 if all fixed, 1 if any escalated
    local_escalated=$(jq '[.entries[] | select(.status == "escalated")] | length' "$LEDGER_PATH")
    if [[ "$local_escalated" -eq 0 ]]; then
      echo "[DONE] All failures fixed!"
      exit 0
    else
      echo "[DONE] $local_escalated failure(s) escalated for human review."
      exit 1
    fi
  fi

  # Check if shutdown was requested between rounds
  if [[ "$SHUTDOWN_REQUESTED" -eq 1 ]]; then
    echo "[SIGNAL] Graceful shutdown — exiting after completing previous round"
    print_ledger_summary
    exit 1
  fi

  # Record terminal count before the round
  local_terminal_before=$(count_terminal)

  # Invoke Agent for one fix round
  local_log_file="$LOG_DIR/test-fix-round-${local_round}.log"
  echo "[LOOP] Invoking Agent: timeout ${ROUND_TIMEOUT}s claude -p '/test-fix-round --ledger $LEDGER_PATH'"
  echo "[LOOP] Log: $local_log_file"

  # Protect the Agent from SIGINT/SIGTERM: temporarily set "ignore"
  # disposition before forking so the child inherits it. Then restore
  # the handler in the parent. This ensures the Agent is NOT killed
  # mid-round when the user presses Ctrl+C.
  trap '' SIGINT SIGTERM
  timeout "$ROUND_TIMEOUT" claude -p "/test-fix-round --ledger $LEDGER_PATH" \
    > "$local_log_file" 2>&1 &
  agent_pid=$!
  trap 'handle_shutdown' SIGINT SIGTERM

  # Wait for agent completion — re-wait if interrupted by a signal
  local_exit_code=0
  while true; do
    if wait "$agent_pid" 2>/dev/null; then
      local_exit_code=0
      break
    fi
    local_exit_code=$?
    # If agent is still running (wait was interrupted by signal), re-wait
    kill -0 "$agent_pid" 2>/dev/null || break
  done

  if [[ "$local_exit_code" -eq 0 ]]; then
    echo "[LOOP] Agent completed successfully"
  elif [[ "$local_exit_code" -eq 124 ]]; then
    echo "[WARN] Agent timed out after ${ROUND_TIMEOUT}s"
    handle_timeout "$ROUND_TIMEOUT"
  else
    echo "[WARN] Agent exited with code $local_exit_code — retrying same ledger state"
  fi

  increment_round

  # Staleness detection: compare terminal count before and after the round
  local_terminal_after=$(count_terminal)
  if [[ "$local_terminal_after" -gt "$local_terminal_before" ]]; then
    echo "[LOOP] Progress detected: terminal entries $local_terminal_before → $local_terminal_after"
    stale_rounds=0
  else
    stale_rounds=$((stale_rounds + 1))
    echo "[LOOP] No progress: terminal entries unchanged at $local_terminal_after (stale_rounds=$stale_rounds/$MAX_STALE_ROUNDS)"
  fi
done
