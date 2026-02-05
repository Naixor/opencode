#!/usr/bin/env bash
#
# Run all integration test scripts and aggregate results
# Output format: TAP (Test Anything Protocol) with aggregated summary
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_SCRIPTS=0
FAILED_SCRIPTS=()

echo "=============================================="
echo " Security Access Control Integration Tests"
echo "=============================================="
echo ""

run_test_script() {
  local script="$1"
  local name
  name="$(basename "$script" .sh)"

  echo "----------------------------------------------"
  echo " Running: $name"
  echo "----------------------------------------------"

  TOTAL_SCRIPTS=$((TOTAL_SCRIPTS + 1))

  local output
  local exit_code=0
  output=$("$script" 2>&1) || exit_code=$?

  echo "$output"
  echo ""

  # Parse pass/fail counts from TAP output
  local passed
  local failed
  passed=$(echo "$output" | grep -c "^ok " || true)
  failed=$(echo "$output" | grep -c "^not ok " || true)

  TOTAL_PASS=$((TOTAL_PASS + passed))
  TOTAL_FAIL=$((TOTAL_FAIL + failed))

  if [ "$exit_code" -ne 0 ]; then
    FAILED_SCRIPTS+=("$name")
  fi
}

# Run all test-*.sh scripts in alphabetical order
for script in "$SCRIPT_DIR"/test-*.sh; do
  if [ -f "$script" ] && [ -x "$script" ]; then
    run_test_script "$script"
  fi
done

# ============================================================================
# Aggregated Summary
# ============================================================================
echo "=============================================="
echo " Integration Test Summary"
echo "=============================================="
echo " Scripts run:  $TOTAL_SCRIPTS"
echo " Total passed: $TOTAL_PASS"
echo " Total failed: $TOTAL_FAIL"

if [ ${#FAILED_SCRIPTS[@]} -gt 0 ]; then
  echo ""
  echo " Failed scripts:"
  for s in "${FAILED_SCRIPTS[@]}"; do
    echo "   - $s"
  done
fi

echo "=============================================="

if [ "$TOTAL_FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
