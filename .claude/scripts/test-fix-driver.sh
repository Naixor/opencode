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
                         Default: /tmp/test-fix-ledger-<PID>.json
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
  .claude/scripts/test-fix-driver.sh --ledger-path /tmp/test-fix-ledger-12345.json
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

# Apply default ledger path if not specified
if [[ -z "$LEDGER_PATH" ]]; then
  LEDGER_PATH="/tmp/test-fix-ledger-$$.json"
fi

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

# ── Placeholder: LOOP, FORCE_ESCALATE, REPORT ────────────────────────
# US-011: LOOP state (round invocation with timeout)
# US-012: FORCE_ESCALATE and REPORT states
# US-013: Staleness detection
# US-014: Signal handling and concurrency safety

echo ""
echo "INIT complete. LOOP state implementation pending (US-011 through US-014)."
