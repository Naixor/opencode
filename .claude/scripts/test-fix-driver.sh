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

# ── Timestamp & Logging ───────────────────────────────────────────────
# ts: ISO-8601 wall-clock timestamp for every log line.
ts() { date +"%Y-%m-%dT%H:%M:%S"; }
# log: timestamped echo — use instead of bare echo everywhere.
log() { echo "[$(ts)] $*"; }

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

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: Missing required dependencies:" >&2
    for dep in "${missing[@]}"; do
      echo "  - $dep" >&2
    done
    exit 2
  fi
}

check_dependencies

# ── Portable Timeout ─────────────────────────────────────────────────
# Detect available timeout command: GNU timeout, gtimeout (Homebrew coreutils),
# or fall back to a pure-bash implementation using background processes.
TIMEOUT_CMD=""
if command -v timeout &>/dev/null; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout &>/dev/null; then
  TIMEOUT_CMD="gtimeout"
fi

run_with_timeout() {
  local secs="$1"
  shift

  if [[ -n "$TIMEOUT_CMD" ]]; then
    "$TIMEOUT_CMD" "$secs" "$@"
    return $?
  fi

  # Fallback: run command in background with a sleep-based watcher.
  # If the command doesn't finish within $secs, the watcher kills it
  # and we return 124 (matching GNU timeout's convention).
  "$@" &
  local cmd_pid=$!
  (sleep "$secs" && kill "$cmd_pid" 2>/dev/null) &
  local watcher_pid=$!

  local exit_code=0
  wait "$cmd_pid" 2>/dev/null || exit_code=$?

  if kill -0 "$watcher_pid" 2>/dev/null; then
    # Command finished before timeout — kill the watcher
    kill "$watcher_pid" 2>/dev/null
    wait "$watcher_pid" 2>/dev/null
  else
    # Watcher exited first — timeout was triggered
    wait "$watcher_pid" 2>/dev/null
    exit_code=124
  fi

  return "$exit_code"
}

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
    log "[STATUS] Ledger: $total total, $fixed fixed, $escalated escalated, $discovered discovered, $attempted attempted"
  fi
}

handle_shutdown() {
  echo ""
  log "[SIGNAL] Shutdown requested — will exit after current round completes"
  SHUTDOWN_REQUESTED=1
}

trap handle_shutdown SIGINT SIGTERM

# ── Concurrency Safety: Directory-Based Locking ──────────────────────
# Use mkdir for portable atomic locking (works on macOS and Linux).
# mkdir is atomic on POSIX filesystems, so two concurrent mkdir calls
# for the same path will have exactly one succeed.
LOCK_DIR="${LEDGER_PATH}.lock"

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ >"$LOCK_DIR/pid"
    return 0
  fi
  # Lock exists — check if the owning process is still alive (stale lock detection)
  if [[ -f "$LOCK_DIR/pid" ]]; then
    local lock_pid
    lock_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")
    if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
      log "[WARN] Removing stale lock (PID $lock_pid no longer running)" >&2
      rm -rf "$LOCK_DIR"
      if mkdir "$LOCK_DIR" 2>/dev/null; then
        echo $$ >"$LOCK_DIR/pid"
        return 0
      fi
    fi
  fi
  echo "ERROR: Another test-fix-driver instance is already running (lock: $LOCK_DIR)" >&2
  echo "If you believe this is stale, remove the lock directory: rm -rf $LOCK_DIR" >&2
  exit 2
}

acquire_lock

# Release lock and print summary on exit (normal or signal)
cleanup() {
  rm -rf "$LOCK_DIR" 2>/dev/null || true
  print_ledger_summary
  log "[EXIT] Driver stopped."
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
  log "[INIT] No ledger found at $LEDGER_PATH"
  log "[INIT] Invoking /test-analyze to discover test failures..."

  local raw_output="/tmp/test-fix-raw-output-$$.txt"
  local report_file="$LOG_DIR/test-analyze-init.log"

  # Invoke claude with /test-analyze to get a structured failure report
  local exit_code=0
  run_with_timeout "$ROUND_TIMEOUT" claude -p "/test-analyze --scope bun --output $raw_output" \
    >"$report_file" 2>&1 || exit_code=$?

  if [[ $exit_code -eq 124 ]]; then
    log "[ERROR] /test-analyze timed out after ${ROUND_TIMEOUT}s" >&2
    exit 2
  fi

  if [[ ! -s "$report_file" ]]; then
    log "[ERROR] /test-analyze produced no output. See $report_file" >&2
    exit 2
  fi

  log "[INIT] /test-analyze complete. Parsing failure report..."

  # Cross-verify: count failure markers in raw bun test output as ground truth.
  # bun test uses (fail) prefix in non-TTY/piped mode and ✗ (U+2717) in TTY mode.
  # Take the max of both counts to handle either output format.
  local raw_fail_count=0
  if [[ -s "$raw_output" ]]; then
    local count_fail_prefix count_x_marker
    count_fail_prefix=$(grep -c '^(fail)' "$raw_output" 2>/dev/null || echo "0")
    count_x_marker=$(grep -c '✗' "$raw_output" 2>/dev/null || echo "0")
    if [[ "$count_fail_prefix" -ge "$count_x_marker" ]]; then
      raw_fail_count="$count_fail_prefix"
    else
      raw_fail_count="$count_x_marker"
    fi
    log "[INIT] Raw bun test output: $raw_fail_count failure marker(s) detected (fail-prefix=$count_fail_prefix, ✗=$count_x_marker)"
  else
    log "[WARN] Raw output file not found or empty — skipping raw failure cross-verification"
  fi

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

  # Cross-check: if ✗ count > report table count, Claude missed failures — abort and warn.
  if [[ "$raw_fail_count" -gt "$count" ]]; then
    log "[WARN] COMPLETENESS MISMATCH: raw output has $raw_fail_count ✗ failure(s) but report table has only $count row(s)." >&2
    log "[WARN] Claude may have missed failures. Re-running /test-analyze with explicit ✗ hint..." >&2

    local exit_code2=0
    run_with_timeout "$ROUND_TIMEOUT" claude -p \
      "/test-analyze --scope bun --output $raw_output

IMPORTANT: bun test marks every failing test with the ✗ character (U+2717) at the start of the line.
The raw output at $raw_output already contains $raw_fail_count lines with ✗.
Make sure your Failure Table has exactly $raw_fail_count rows — do NOT skip any ✗ line." \
      >"$report_file" 2>&1 || exit_code2=$?

    if [[ $exit_code2 -eq 0 ]]; then
      # Re-parse after retry
      entries_json="[]"
      count=0
      while IFS='|' read -r _ num priority file test error_type error_message source _rest; do
        num="$(echo "$num" | xargs)"
        priority="$(echo "$priority" | xargs)"
        file="$(echo "$file" | xargs)"
        test_name="$(echo "$test" | xargs)"
        error_type="$(echo "$error_type" | xargs)"
        [[ "$num" =~ ^[0-9]+$ ]] || continue
        count=$((count + 1))
        local entry_id2
        printf -v entry_id2 "F-%03d" "$count"
        if [[ ! "$priority" =~ ^P[0-5]$ ]]; then
          priority="P3"
        fi
        entries_json=$(echo "$entries_json" | jq \
          --arg id "$entry_id2" \
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
      log "[INIT] Retry complete: $count failure(s) parsed after re-run"
    else
      log "[WARN] Retry /test-analyze failed with code $exit_code2 — proceeding with $count entries from first run" >&2
    fi
  fi

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
    }' >"$LEDGER_PATH"

  # Validate the generated ledger is valid JSON
  if ! jq empty "$LEDGER_PATH" 2>/dev/null; then
    log "[ERROR] Generated ledger is not valid JSON" >&2
    exit 2
  fi

  log "[INIT] Ledger initialized: $count failure(s) in 'discovered' state"
  log "[INIT] Ledger written to $LEDGER_PATH"

  # Initialize round counter to 0
  echo "0" >"$COUNTER_FILE"
  log "[INIT] Round counter initialized at $COUNTER_FILE"
}

# ── State Machine Entry Point ─────────────────────────────────────────
if [[ -f "$LEDGER_PATH" ]]; then
  log "[INIT] Existing ledger found at $LEDGER_PATH — resuming"

  # Validate existing ledger is valid JSON
  if ! jq empty "$LEDGER_PATH" 2>/dev/null; then
    log "[ERROR] Existing ledger is not valid JSON — delete and re-run to reinitialize" >&2
    exit 2
  fi

  # Ensure round counter exists (may have been lost if driver was killed)
  if [[ ! -f "$COUNTER_FILE" ]]; then
    echo "0" >"$COUNTER_FILE"
    log "[INIT] Round counter missing — reinitialized to 0"
  fi

  local_entries=$(jq '.entries | length' "$LEDGER_PATH")
  local_terminal=$(jq '[.entries[] | select(.status == "fixed" or .status == "escalated")] | length' "$LEDGER_PATH")
  local_remaining=$((local_entries - local_terminal))
  log "[INIT] Ledger status: $local_entries total, $local_terminal terminal, $local_remaining remaining"
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

# ── Helper: Add New Failures From a Report File ────────────────────────
# Parses the Failure Table rows in a Markdown report and appends any failure
# not already tracked in the ledger as a new "discovered" entry.
# Prints the number of new entries added to stdout.
add_failures_from_report() {
  local report_file="$1"
  local new_count=0

  while IFS='|' read -r _ num priority file test _rest; do
    num="$(echo "$num" | xargs)"
    priority="$(echo "$priority" | xargs)"
    file="$(echo "$file" | xargs)"
    test_name="$(echo "$test" | xargs)"

    # Only process data rows (num must be an integer)
    [[ "$num" =~ ^[0-9]+$ ]] || continue

    # Skip if already tracked in ledger (match by file + test name)
    local exists
    exists=$(jq \
      --arg f "$file" \
      --arg t "$test_name" \
      '[.entries[] | select(.file == $f and .test == $t)] | length' \
      "$LEDGER_PATH")
    [[ "$exists" -gt 0 ]] && continue

    # Compute next sequential ID
    local last_num next_id
    last_num=$(jq -r '[.entries[].id | capture("F-(?P<n>[0-9]+)") | .n | tonumber] | max // 0' "$LEDGER_PATH")
    printf -v next_id "F-%03d" $((last_num + 1))

    if [[ ! "$priority" =~ ^P[0-5]$ ]]; then
      priority="P3"
    fi

    local now
    now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

    local updated
    updated=$(jq \
      --arg id "$next_id" \
      --arg f "$file" \
      --arg t "$test_name" \
      --arg priority "$priority" \
      --arg now "$now" \
      '
      .updated_at = $now |
      .entries += [{
        id: $id,
        file: $f,
        test: $t,
        priority: $priority,
        status: "discovered",
        attempt_count: 0,
        max_attempts: 3,
        diagnosis: null,
        fix_applied: null,
        escalation_reason: null,
        modified_files: []
      }]
      ' "$LEDGER_PATH")

    echo "$updated" >"$LEDGER_PATH"
    new_count=$((new_count + 1))
  done < <(grep -E '^\| *[0-9]' "$report_file" 2>/dev/null || true)

  echo "$new_count"
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
  echo $((current + 1)) >"$COUNTER_FILE"
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
    log "[TIMEOUT] No in-progress entries found — ledger unchanged"
    return
  fi

  log "[TIMEOUT] Found $attempted_count in-progress entry/entries — updating ledger"

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

  echo "$updated" >"$LEDGER_PATH"

  if ! jq empty "$LEDGER_PATH" 2>/dev/null; then
    log "[ERROR] Ledger corrupted during timeout handling" >&2
    exit 2
  fi

  local escalated_count
  escalated_count=$(jq '[.entries[] | select(.escalation_reason == "timeout")] | length' "$LEDGER_PATH")
  log "[TIMEOUT] $attempted_count timed-out entry/entries processed ($escalated_count escalated with reason=timeout)"
}

# ── FORCE_ESCALATE State ──────────────────────────────────────────────
# Set all non-terminal ledger entries to status='escalated' with
# escalation_reason='max_attempts_exceeded', then transition to REPORT.
force_escalate() {
  log "[FORCE_ESCALATE] Escalating all remaining non-terminal entries..."

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

  echo "$updated" >"$LEDGER_PATH"

  # Validate the updated ledger
  if ! jq empty "$LEDGER_PATH" 2>/dev/null; then
    log "[ERROR] Ledger corrupted during force-escalate" >&2
    exit 2
  fi

  local escalated_count
  escalated_count=$(jq '[.entries[] | select(.escalation_reason == "max_attempts_exceeded")] | length' "$LEDGER_PATH")
  log "[FORCE_ESCALATE] $escalated_count entry/entries force-escalated"
  log "[FORCE_ESCALATE] Transitioning to REPORT"
}

# ── REPORT State ──────────────────────────────────────────────────────
# Invoke /test-fix-report to generate the final Markdown report from the ledger.
generate_report() {
  log "[REPORT] Generating final report from ledger..."

  local report_log="$LOG_DIR/test-fix-report.log"

  local exit_code=0
  run_with_timeout "$ROUND_TIMEOUT" claude -p "/test-fix-report --ledger $LEDGER_PATH" \
    >"$report_log" 2>&1 || exit_code=$?

  if [[ $exit_code -eq 124 ]]; then
    log "[WARN] /test-fix-report timed out after ${ROUND_TIMEOUT}s — report may be incomplete" >&2
  elif [[ $exit_code -ne 0 ]]; then
    log "[WARN] /test-fix-report exited with code $exit_code — report may be incomplete" >&2
  else
    log "[REPORT] Report generation complete. See $report_log"
  fi

  # Print ledger summary regardless of report generation outcome
  local total fixed escalated
  total=$(jq '.entries | length' "$LEDGER_PATH")
  fixed=$(jq '[.entries[] | select(.status == "fixed")] | length' "$LEDGER_PATH")
  escalated=$(jq '[.entries[] | select(.status == "escalated")] | length' "$LEDGER_PATH")
  log "[REPORT] Final ledger: $total total, $fixed fixed, $escalated escalated"
}

# ── Helper: Heartbeat Watcher ────────────────────────────────────────
# Runs in background during an agent round. Every HEARTBEAT_INTERVAL seconds
# it prints elapsed time and the last line written to the round log file so
# the operator can see whether the agent is still making progress.
HEARTBEAT_INTERVAL=60
heartbeat_watcher() {
  local pid="$1"
  local log_file="$2"
  local start_ts="$3"
  local interval="${HEARTBEAT_INTERVAL}"

  while kill -0 "$pid" 2>/dev/null; do
    sleep "$interval"
    kill -0 "$pid" 2>/dev/null || break
    local elapsed=$(( $(date +%s) - start_ts ))
    local last_line=""
    [[ -f "$log_file" ]] && last_line=$(tail -1 "$log_file" 2>/dev/null | tr -d '\n' || true)
    log "[HEARTBEAT] Round still running — elapsed: ${elapsed}s / ${ROUND_TIMEOUT}s | last: ${last_line:0:150}"
  done
}

# ── Helper: Timeout Post-Mortem ────────────────────────────────────────
# Called immediately after timeout is detected. Dumps the last N lines of the
# round log so the operator can see exactly where the agent got stuck.
timeout_postmortem() {
  local log_file="$1"
  local elapsed="$2"

  log "[TIMEOUT] Agent ran for ${elapsed}s before being killed" >&2

  # Which ledger entry was in-progress when we timed out?
  if [[ -f "$LEDGER_PATH" ]] && jq empty "$LEDGER_PATH" 2>/dev/null; then
    local attempted_info
    attempted_info=$(jq -r \
      '.entries[] | select(.status == "attempted") | "  \(.id)  \(.priority)  \(.file)  \(.test)"' \
      "$LEDGER_PATH" 2>/dev/null || true)
    if [[ -n "$attempted_info" ]]; then
      log "[TIMEOUT] Entry being worked on when timeout fired:" >&2
      echo "$attempted_info" | while IFS= read -r line; do
        log "[TIMEOUT]   $line" >&2
      done
    fi
  fi

  # Dump last 30 lines of the round log for post-mortem analysis
  if [[ -f "$log_file" ]]; then
    local line_count
    line_count=$(wc -l <"$log_file" 2>/dev/null | tr -d ' ')
    log "[TIMEOUT] Round log has $line_count line(s). Last 30 lines of $log_file:" >&2
    tail -30 "$log_file" 2>/dev/null | while IFS= read -r line; do
      echo "  [TIMEOUT|LOG] $line" >&2
    done
  else
    log "[TIMEOUT] Round log not found: $log_file" >&2
  fi
}

# ── LOOP State: Round Invocation with Timeout ────────────────────────
echo ""
log "[LOOP] Starting fix loop..."

stale_rounds=0
MAX_STALE_ROUNDS=3
FINAL_CHECK_DONE=0

while true; do
  local_round=$(read_round)
  local_remaining=$(count_non_terminal)

  echo ""
  log "[LOOP] Round $local_round | $local_remaining non-terminal entries remaining | stale_rounds=$stale_rounds"

  # Termination: all entries are terminal
  if [[ "$local_remaining" -eq 0 ]]; then
    if [[ "$FINAL_CHECK_DONE" -eq 0 ]]; then
      log "[FINAL_CHECK] All known failures resolved — running full suite via test:parallel..."
      final_output="$LOG_DIR/test-fix-final-check.txt"
      local_fc_start=$(date +%s)
      bun run --cwd "$PROJECT_ROOT/packages/opencode" test:parallel >"$final_output" 2>&1 || true
      local_fc_elapsed=$(( $(date +%s) - local_fc_start ))

      # test:parallel summary uses "Fail: N" lines; also check ✗ markers for safety
      local_fc_a=$(grep -E '^Fail:\s+[0-9]' "$final_output" 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo "0")
      local_fc_b=$(grep -c '^\[.*\] ✗' "$final_output" 2>/dev/null || echo "0")
      final_fail_count=$(( local_fc_a > local_fc_b ? local_fc_a : local_fc_b ))
      log "[FINAL_CHECK] Full suite finished in ${local_fc_elapsed}s"
      log "[FINAL_CHECK] Full suite: $final_fail_count failure(s)"

      if [[ "$final_fail_count" -eq 0 ]]; then
        FINAL_CHECK_DONE=1
        log "[FINAL_CHECK] Suite is clean — proceeding to REPORT"
      else
        log "[FINAL_CHECK] $final_fail_count new failure(s) detected — invoking /test-analyze to catalog them..."
        final_analyze_log="$LOG_DIR/test-fix-final-analyze.log"
        local_fc_ec=0
        run_with_timeout "$ROUND_TIMEOUT" claude -p \
          "/test-analyze --scope bun --output $final_output" \
          >"$final_analyze_log" 2>&1 || local_fc_ec=$?

        if [[ "$local_fc_ec" -eq 0 ]]; then
          local_new_count=$(add_failures_from_report "$final_analyze_log")
          log "[FINAL_CHECK] $local_new_count new failure(s) added to ledger — continuing fix loop"
        else
          log "[WARN] /test-analyze failed (code $local_fc_ec) — skipping final check to avoid infinite loop" >&2
          FINAL_CHECK_DONE=1
        fi

        # Whether we added entries or hit an error, re-evaluate at top of loop
        continue
      fi
    fi

    log "[LOOP] All ledger entries are terminal and suite is clean — transitioning to REPORT"
    generate_report
    # Determine exit code: 0 if all fixed, 1 if any escalated
    local_escalated=$(jq '[.entries[] | select(.status == "escalated")] | length' "$LEDGER_PATH")
    if [[ "$local_escalated" -eq 0 ]]; then
      log "[DONE] All failures fixed!"
      exit 0
    else
      log "[DONE] $local_escalated failure(s) escalated for human review."
      exit 1
    fi
  fi

  # Termination: max rounds exceeded
  if [[ "$local_round" -ge "$MAX_ROUNDS" ]]; then
    log "[LOOP] Round $local_round >= max rounds $MAX_ROUNDS — transitioning to FORCE_ESCALATE"
    force_escalate
    generate_report
    # Determine exit code: 0 if all fixed, 1 if any escalated
    local_escalated=$(jq '[.entries[] | select(.status == "escalated")] | length' "$LEDGER_PATH")
    if [[ "$local_escalated" -eq 0 ]]; then
      log "[DONE] All failures fixed!"
      exit 0
    else
      log "[DONE] $local_escalated failure(s) escalated for human review."
      exit 1
    fi
  fi

  # Termination: staleness detected (no progress for 3 consecutive rounds)
  if [[ "$stale_rounds" -ge "$MAX_STALE_ROUNDS" ]]; then
    log "[LOOP] $stale_rounds consecutive rounds with no progress — transitioning to FORCE_ESCALATE"
    force_escalate
    generate_report
    # Determine exit code: 0 if all fixed, 1 if any escalated
    local_escalated=$(jq '[.entries[] | select(.status == "escalated")] | length' "$LEDGER_PATH")
    if [[ "$local_escalated" -eq 0 ]]; then
      log "[DONE] All failures fixed!"
      exit 0
    else
      log "[DONE] $local_escalated failure(s) escalated for human review."
      exit 1
    fi
  fi

  # Check if shutdown was requested between rounds
  if [[ "$SHUTDOWN_REQUESTED" -eq 1 ]]; then
    log "[SIGNAL] Graceful shutdown — exiting after completing previous round"
    print_ledger_summary
    exit 1
  fi

  # Record terminal count before the round
  local_terminal_before=$(count_terminal)

  # Log which ledger entry will be targeted this round (highest-priority discovered)
  local_target=$(jq -r \
    '[.entries[] | select(.status == "discovered")] | sort_by(.priority) | first | "\(.id)  \(.priority)  \(.file)  \(.test)"' \
    "$LEDGER_PATH" 2>/dev/null || echo "(unknown)")
  log "[LOOP] Target entry: $local_target"

  # Invoke Agent for one fix round
  local_log_file="$LOG_DIR/test-fix-round-${local_round}.log"
  log "[LOOP] Invoking Agent: timeout=${ROUND_TIMEOUT}s  pid=TBD  log=$local_log_file"

  # Protect the Agent from SIGINT/SIGTERM: temporarily set "ignore"
  # disposition before forking so the child inherits it. Then restore
  # the handler in the parent. This ensures the Agent is NOT killed
  # mid-round when the user presses Ctrl+C.
  trap '' SIGINT SIGTERM
  claude -p "/test-fix-round --ledger $LEDGER_PATH" \
    >"$local_log_file" 2>&1 &
  agent_pid=$!
  round_start_ts=$(date +%s)
  log "[LOOP] Agent started: pid=$agent_pid"

  # Timeout watcher: sends SIGTERM after ROUND_TIMEOUT seconds, then SIGKILL
  # after an additional 15s grace period if the agent ignores SIGTERM.
  (sleep "$ROUND_TIMEOUT" \
    && log "[TIMEOUT] Sending SIGTERM to agent pid=$agent_pid after ${ROUND_TIMEOUT}s" \
    && kill "$agent_pid" 2>/dev/null \
    && sleep 15 \
    && kill -0 "$agent_pid" 2>/dev/null \
    && log "[TIMEOUT] Agent still alive after 15s grace — sending SIGKILL to pid=$agent_pid" \
    && kill -9 "$agent_pid" 2>/dev/null) &
  watcher_pid=$!
  trap 'handle_shutdown' SIGINT SIGTERM

  # Start heartbeat watcher in background — prints progress every 60s
  heartbeat_watcher "$agent_pid" "$local_log_file" "$round_start_ts" &
  heartbeat_pid=$!

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
  round_elapsed=$(( $(date +%s) - round_start_ts ))

  # Shut down heartbeat watcher
  kill "$heartbeat_pid" 2>/dev/null || true
  wait "$heartbeat_pid" 2>/dev/null || true

  # Clean up timeout watcher and detect whether timeout occurred
  if kill -0 "$watcher_pid" 2>/dev/null; then
    # Watcher still alive → agent finished before timeout
    kill "$watcher_pid" 2>/dev/null
    wait "$watcher_pid" 2>/dev/null || true
  else
    # Watcher exited first → timeout was triggered
    wait "$watcher_pid" 2>/dev/null || true
    local_exit_code=124
  fi

  if [[ "$local_exit_code" -eq 0 ]]; then
    log "[LOOP] Agent completed successfully in ${round_elapsed}s"
  elif [[ "$local_exit_code" -eq 124 ]]; then
    timeout_postmortem "$local_log_file" "$round_elapsed"
    handle_timeout "$ROUND_TIMEOUT"
  else
    log "[WARN] Agent exited with code $local_exit_code after ${round_elapsed}s — retrying same ledger state"
  fi

  increment_round

  # Staleness detection: compare terminal count before and after the round
  local_terminal_after=$(count_terminal)
  if [[ "$local_terminal_after" -gt "$local_terminal_before" ]]; then
    log "[LOOP] Progress detected: terminal entries $local_terminal_before → $local_terminal_after"
    stale_rounds=0
  else
    stale_rounds=$((stale_rounds + 1))
    log "[LOOP] No progress: terminal entries unchanged at $local_terminal_after (stale_rounds=$stale_rounds/$MAX_STALE_ROUNDS)"
  fi
done
