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

# ── Placeholder: State Machine ────────────────────────────────────────
# US-010: INIT state (ledger initialization)
# US-011: LOOP state (round invocation with timeout)
# US-012: FORCE_ESCALATE and REPORT states
# US-013: Staleness detection
# US-014: Signal handling and concurrency safety

echo "Driver scaffold ready. State machine implementation pending (US-010 through US-014)."
