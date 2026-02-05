#!/usr/bin/env bash
#
# Unified Security Access Control Test Runner
# Runs all unit tests (bun test) and integration tests, produces structured reports.
#
# Usage:
#   ./run-all.sh              # Run all tests and generate reports
#   ./run-all.sh --fix-check  # Also cross-reference findings with git branches/PRs
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCODE_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
REPORT_DIR="$SCRIPT_DIR/report"
INTEGRATION_DIR="$SCRIPT_DIR/integration"

FIX_CHECK=false
if [ "${1:-}" = "--fix-check" ]; then
  FIX_CHECK=true
fi

mkdir -p "$REPORT_DIR"

# ============================================================================
# Known case registry — maps CASE-* IDs to category, severity, description
# ============================================================================

# Each entry: ID|CATEGORY|SEVERITY|DESCRIPTION|STATUS_OVERRIDE
# STATUS_OVERRIDE: KNOWN_LIMITATION if the test documents a known limitation
# Empty STATUS_OVERRIDE means status comes from test pass/fail

CASE_REGISTRY=(
  # Config manipulation (CASE-CFG)
  "CASE-CFG-001|config|INFO|Malformed JSON config causes fail-open|KNOWN_LIMITATION"
  "CASE-CFG-002|config|INFO|Truncated config file causes fail-open, not crash|"
  "CASE-CFG-003|config|INFO|Config deletion after load — cached config continues to protect|"
  "CASE-CFG-004|config|INFO|Child config cannot REMOVE restrictions from parent|"
  "CASE-CFG-005|config|INFO|Conflicting role definitions across nested configs throws error|"
  "CASE-CFG-006|config|INFO|Config with empty rules means no protection|"
  "CASE-CFG-007|config|INFO|Config with 1000+ rules does not crash or timeout|"

  # Role authentication (CASE-AUTH)
  "CASE-AUTH-001|auth|CRITICAL|All tools use getDefaultRole() instead of SecurityRole.getCurrentRole()|KNOWN_LIMITATION"
  "CASE-AUTH-002|auth|INFO|Token signed with wrong key is rejected|"
  "CASE-AUTH-003|auth|INFO|Expired token is rejected|"
  "CASE-AUTH-004|auth|INFO|Revoked token is rejected|"
  "CASE-AUTH-005|auth|INFO|Token with non-existent role falls back to lowest role|"
  "CASE-AUTH-006|auth|MEDIUM|Token without exp claim is accepted (not rejected)|KNOWN_LIMITATION"
  "CASE-AUTH-007|auth|INFO|Role with Number.MAX_SAFE_INTEGER level does not overflow|"
  "CASE-AUTH-008|auth|INFO|Empty role name does not accidentally match defaults|"
  "CASE-AUTH-009|auth|INFO|Role name matching is case-sensitive|"

  # Path traversal (CASE-PATH)
  "CASE-PATH-001|path|HIGH|Path traversal bypasses minimatch (no normalization)|KNOWN_LIMITATION"
  "CASE-PATH-002|path|INFO|URL-encoded paths do not bypass checks|"
  "CASE-PATH-003|path|MEDIUM|Null byte in path causes unhandled TypeError|KNOWN_LIMITATION"
  "CASE-PATH-004|path|HIGH|Symlink resolution returns absolute paths not matching relative rules|KNOWN_LIMITATION"
  "CASE-PATH-005|path|HIGH|Symlink chain fully resolved|"
  "CASE-PATH-006|path|MEDIUM|Directory symlinks may bypass protection|KNOWN_LIMITATION"
  "CASE-PATH-007|path|INFO|Circular symlink does not cause infinite loop|"
  "CASE-PATH-008|path|INFO|Case sensitivity on case-insensitive FS|KNOWN_LIMITATION"
  "CASE-PATH-009|path|LOW|Unicode normalization edge cases|KNOWN_LIMITATION"
  "CASE-PATH-010|path|INFO|Absolute path vs relative rule matching|KNOWN_LIMITATION"

  # Read bypass (CASE-READ)
  "CASE-READ-001|read|INFO|Reading fully protected file returns access denied|"
  "CASE-READ-002|read|INFO|Segment redaction replaces content|"
  "CASE-READ-003|read|INFO|Partial read with offset/limit still applies redaction|"
  "CASE-READ-004|read|INFO|Protected file with image extension checks security|KNOWN_LIMITATION"
  "CASE-READ-005|read|MEDIUM|Premature @secure-end truncates protection|KNOWN_LIMITATION"
  "CASE-READ-006|read|INFO|@secure-start inside string literal detected|"
  "CASE-READ-007|read|INFO|Unicode lookalike markers do NOT create false matches|"
  "CASE-READ-008|read|MEDIUM|Nested marker mismatch stack-based handling|KNOWN_LIMITATION"

  # Write/Edit bypass (CASE-WRITE, CASE-EDIT)
  "CASE-WRITE-001|write|INFO|Direct write to protected file returns access denied|"
  "CASE-WRITE-002|write|INFO|Creating new file in protected directory is blocked|"
  "CASE-WRITE-003|write|MEDIUM|.opencode-security.json not self-protected|KNOWN_LIMITATION"
  "CASE-EDIT-001|write|INFO|Edit overlapping protected region is blocked|"
  "CASE-EDIT-002|write|INFO|Edit deleting marker is blocked|"
  "CASE-EDIT-003|write|INFO|Edit adjacent to protected segment is allowed|"
  "CASE-EDIT-004|write|INFO|Injecting new markers via write is allowed|"

  # Grep/Glob bypass (CASE-GREP, CASE-GLOB)
  "CASE-GREP-001|grep|INFO|Grep for protected file excludes from results|"
  "CASE-GREP-002|grep|INFO|Grep match inside protected region is redacted|"
  "CASE-GREP-003|grep|INFO|Grep include glob targeting protected dir is filtered|"
  "CASE-GLOB-001|glob|INFO|Glob protected directory returns no results|"
  "CASE-GLOB-002|glob|INFO|Glob .env* excludes protected files|"
  "CASE-GLOB-003|glob|INFO|Glob does not leak filtered file count|"

  # Bash bypass (CASE-BASH)
  "CASE-BASH-001|bash|INFO|cat/head/tail blocked by BashScanner|"
  "CASE-BASH-002|bash|HIGH|15 common commands NOT in scanner allowlist|KNOWN_LIMITATION"
  "CASE-BASH-003|bash|INFO|Path traversal resolved by BashScanner|"
  "CASE-BASH-004|bash|HIGH|Command substitution not parsed|KNOWN_LIMITATION"
  "CASE-BASH-005|bash|HIGH|Process substitution not parsed|KNOWN_LIMITATION"
  "CASE-BASH-006|bash|HIGH|Here-string/heredoc not parsed|KNOWN_LIMITATION"
  "CASE-BASH-007|bash|HIGH|Pipeline first command detected|"
  "CASE-BASH-008|bash|HIGH|xargs bypass not detected|KNOWN_LIMITATION"
  "CASE-BASH-009|bash|HIGH|Interpreter one-liners not detected|KNOWN_LIMITATION"
  "CASE-BASH-010|bash|HIGH|curl/wget exfiltration not detected|KNOWN_LIMITATION"
  "CASE-BASH-011|bash|HIGH|Archive commands not detected|KNOWN_LIMITATION"
  "CASE-BASH-012|bash|INFO|git history access out of scope|KNOWN_LIMITATION"
  "CASE-BASH-013|bash|HIGH|Environment variable exfiltration not detected|KNOWN_LIMITATION"
  "CASE-BASH-014|bash|MEDIUM|Background/prefix command bypass|KNOWN_LIMITATION"
  "CASE-BASH-015|bash|HIGH|Full path basename extraction works|"

  # LLM leakage (CASE-LLM)
  "CASE-LLM-001|llm|INFO|LLMScanner detects protected markers in plain text|"
  "CASE-LLM-002|llm|INFO|Scanner catches protected content in tool result|"
  "CASE-LLM-003|llm|INFO|Scanner catches protected content in system prompt|"
  "CASE-LLM-004|llm|MEDIUM|Scanner limits with obfuscated content|KNOWN_LIMITATION"
  "CASE-LLM-005|llm|MEDIUM|Base64-encoded content not detected|KNOWN_LIMITATION"
  "CASE-LLM-006|llm|INFO|Marker boundaries detected in arbitrary text|"
  "CASE-LLM-007|llm|INFO|Path pattern matching catches file path references|"
  "CASE-LLM-008|llm|INFO|extractLiteralFromGlob handles partial matches|"

  # Segment evasion (CASE-SEG)
  "CASE-SEG-001|segment|INFO|Extra whitespace in markers still detected|"
  "CASE-SEG-002|segment|INFO|Bare markers without comment prefix not detected|"
  "CASE-SEG-003|segment|INFO|Block comment style detected|"
  "CASE-SEG-004|segment|INFO|Multi-line block comment marker detection|KNOWN_LIMITATION"
  "CASE-SEG-005|segment|MEDIUM|eval wrapping evades AST detection|KNOWN_LIMITATION"
  "CASE-SEG-006|segment|INFO|Function alias evasion — original protected|"
  "CASE-SEG-007|segment|INFO|Computed method name detection|KNOWN_LIMITATION"
  "CASE-SEG-008|segment|INFO|Re-export aliasing behavior|"
  "CASE-SEG-009|segment|MEDIUM|AST rules for unsupported languages|KNOWN_LIMITATION"

  # MCP bypass (CASE-MCP)
  "CASE-MCP-001|mcp|INFO|getMcpPolicy returns blocked for blocked-server|"
  "CASE-MCP-002|mcp|INFO|getMcpPolicy returns enforced for enforced-server|"
  "CASE-MCP-003|mcp|INFO|getMcpPolicy returns trusted for trusted-server|"
  "CASE-MCP-004|mcp|INFO|Unlisted server falls back to defaultMcpPolicy|"
  "CASE-MCP-005|mcp|MEDIUM|Base64-encoded paths in MCP output bypass scanner|KNOWN_LIMITATION"
  "CASE-MCP-006|mcp|INFO|Server identity based on config key name|"

  # Inheritance bypass (CASE-INH)
  "CASE-INH-001|inheritance|INFO|Child config cannot weaken parent|"
  "CASE-INH-002|inheritance|INFO|Inheritance applies 7+ levels deep|"
  "CASE-INH-003|inheritance|INFO|Overlapping rules — most restrictive wins|"
  "CASE-INH-004|inheritance|INFO|Glob edge cases|"

  # Race condition (CASE-RACE)
  "CASE-RACE-001|race|INFO|TOCTOU timing window — config loaded once|KNOWN_LIMITATION"
  "CASE-RACE-002|race|INFO|Config cached in memory|"
  "CASE-RACE-003|race|INFO|Symlink swap timing window|KNOWN_LIMITATION"

  # Audit evasion (CASE-LOG)
  "CASE-LOG-001|audit|INFO|Logging to /dev/null or non-writable does not crash|"
  "CASE-LOG-002|audit|LOW|Content hash preview leaks up to 50 chars|"
  "CASE-LOG-003|audit|INFO|Control characters in paths handled by JSON|"
  "CASE-LOG-004|audit|HIGH|Audit log deletion via rm not detected by BashScanner|KNOWN_LIMITATION"
  "CASE-LOG-005|audit|HIGH|Audit log truncation not detected by BashScanner|KNOWN_LIMITATION"
  "CASE-LOG-006|audit|MEDIUM|Audit log symlink redirect attack surface|KNOWN_LIMITATION"

  # Agent interaction (CASE-AGENT)
  "CASE-AGENT-001|agent|INFO|Permission layering order documented|"
  "CASE-AGENT-002|agent|INFO|Security protects plan file paths|"
  "CASE-AGENT-003|agent|INFO|checkAccess blocks reads for lowest role|"
  "CASE-AGENT-004|agent|INFO|BashScanner detects cat on protected paths|"
  "CASE-AGENT-005|agent|INFO|SecurityAccess independent of agent permission|"
  "CASE-AGENT-006|agent|INFO|Session overrides independent from SecurityAccess|"
  "CASE-AGENT-007|agent|INFO|checkAccess blocks writes regardless of agent|"

  # Skill/Subagent bypass (CASE-SKILL, CASE-SUB)
  "CASE-SKILL-001|skill|HIGH|Skill scanner follows symlinks to protected files|KNOWN_LIMITATION"
  "CASE-SKILL-002|skill|HIGH|Skill scanner discovers inside protected directories|KNOWN_LIMITATION"
  "CASE-SKILL-003|skill|HIGH|Skill content with canary fully accessible|KNOWN_LIMITATION"
  "CASE-SUB-001|subagent|HIGH|InstructionPrompt loads from protected paths|KNOWN_LIMITATION"
  "CASE-SUB-002|subagent|MEDIUM|LLMScanner second defense line limited|KNOWN_LIMITATION"
  "CASE-SUB-003|subagent|HIGH|Resolve walk-up enters protected directories|KNOWN_LIMITATION"
  "CASE-SUB-004|subagent|INFO|Subagent sessions resolve security-wrapped tools|"
  "CASE-SUB-005|subagent|HIGH|Config instructions path loads while checkAccess denies|KNOWN_LIMITATION"

  # Access-guard integration (CASE-GUARD)
  "CASE-GUARD-001|guard|HIGH|OS-level evidence of skill symlink bypass|"
  "CASE-GUARD-002|guard|HIGH|OS-level evidence of InstructionPrompt bypass|"
  "CASE-GUARD-003|guard|INFO|Read tool blocks before file I/O|"
  "CASE-GUARD-004|guard|INFO|BashScanner blocks before execution|"
  "CASE-GUARD-005|guard|INFO|Unprivileged mode fallback and limitations|"
)

TOTAL_CASES=${#CASE_REGISTRY[@]}

# ============================================================================
# Helper functions
# ============================================================================

# Parse a registry entry: sets ENTRY_ID, ENTRY_CATEGORY, ENTRY_SEVERITY, ENTRY_DESCRIPTION, ENTRY_OVERRIDE
parse_entry() {
  local entry="$1"
  IFS='|' read -r ENTRY_ID ENTRY_CATEGORY ENTRY_SEVERITY ENTRY_DESCRIPTION ENTRY_OVERRIDE <<< "$entry"
}

# ============================================================================
# Phase 1: Run unit tests
# ============================================================================

echo "=============================================="
echo " Security Access Control — Unified Test Runner"
echo "=============================================="
echo ""
echo "Phase 1: Running unit tests (bun test)..."
echo "----------------------------------------------"

UNIT_OUTPUT_FILE="$REPORT_DIR/.unit-output.txt"

# Run bun test and capture output + exit code
UNIT_EXIT=0
cd "$OPENCODE_DIR"
bun test --cwd packages/opencode -- test/security/access_control_cases/unit/ 2>&1 | tee "$UNIT_OUTPUT_FILE" || UNIT_EXIT=$?

echo ""
echo "Unit tests exit code: $UNIT_EXIT"
echo ""

# ============================================================================
# Phase 2: Run integration tests
# ============================================================================

echo "Phase 2: Running integration tests..."
echo "----------------------------------------------"

INTEGRATION_OUTPUT_FILE="$REPORT_DIR/.integration-output.txt"
INTEGRATION_EXIT=0

if [ -x "$INTEGRATION_DIR/run-all.sh" ]; then
  "$INTEGRATION_DIR/run-all.sh" 2>&1 | tee "$INTEGRATION_OUTPUT_FILE" || INTEGRATION_EXIT=$?
  echo ""
  echo "Integration tests exit code: $INTEGRATION_EXIT"
else
  echo "No integration runner found at $INTEGRATION_DIR/run-all.sh"
  echo "" > "$INTEGRATION_OUTPUT_FILE"
fi

echo ""

# ============================================================================
# Phase 3: Parse results and determine per-case status
# ============================================================================

echo "Phase 3: Generating per-case report..."
echo "----------------------------------------------"

# Use a temp file to track which CASE-* IDs failed
FAILED_CASES_FILE="$REPORT_DIR/.failed-cases.txt"
: > "$FAILED_CASES_FILE"

# If unit tests had failures, extract which CASE-* blocks failed
if [ "$UNIT_EXIT" -ne 0 ]; then
  grep -E '(fail|FAIL|Error)' "$UNIT_OUTPUT_FILE" 2>/dev/null | grep -oE 'CASE-[A-Z]+-[0-9]+' | sort -u >> "$FAILED_CASES_FILE" || true
fi

# ============================================================================
# Phase 4: Compute final status and print per-category summary
# ============================================================================

UNEXPECTED_FAILS=0
TOTAL_PASS=0
TOTAL_KNOWN=0
TOTAL_FAIL=0

echo ""
echo "=============================================="
echo " Per-Case Results"
echo "=============================================="

CURRENT_CATEGORY=""

# Also build the JSON cases array incrementally
JSON_CASES=""

for entry in "${CASE_REGISTRY[@]}"; do
  parse_entry "$entry"

  # Determine test result
  test_failed=false
  if grep -qx "$ENTRY_ID" "$FAILED_CASES_FILE" 2>/dev/null; then
    test_failed=true
  fi

  # Compute final status
  if [ "$ENTRY_OVERRIDE" = "KNOWN_LIMITATION" ]; then
    status="KNOWN_LIMITATION"
    TOTAL_KNOWN=$((TOTAL_KNOWN + 1))
  elif [ "$test_failed" = true ]; then
    status="FAIL"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    UNEXPECTED_FAILS=$((UNEXPECTED_FAILS + 1))
  else
    status="PASS"
    TOTAL_PASS=$((TOTAL_PASS + 1))
  fi

  # Print category header
  if [ "$ENTRY_CATEGORY" != "$CURRENT_CATEGORY" ]; then
    CURRENT_CATEGORY="$ENTRY_CATEGORY"
    echo ""
    echo "--- $CURRENT_CATEGORY ---"
  fi

  # Print status line
  case "$status" in
    PASS)
      printf "  [PASS]              %-18s %s\n" "$ENTRY_ID" "$ENTRY_DESCRIPTION"
      ;;
    FAIL)
      printf "  [FAIL]              %-18s %s\n" "$ENTRY_ID" "$ENTRY_DESCRIPTION"
      ;;
    KNOWN_LIMITATION)
      printf "  [KNOWN_LIMITATION]  %-18s (%s) %s\n" "$ENTRY_ID" "$ENTRY_SEVERITY" "$ENTRY_DESCRIPTION"
      ;;
  esac

  # Append to JSON (escape description for JSON)
  escaped_desc=$(printf '%s' "$ENTRY_DESCRIPTION" | sed 's/\\/\\\\/g; s/"/\\"/g')
  if [ -n "$JSON_CASES" ]; then
    JSON_CASES="$JSON_CASES,"
  fi
  JSON_CASES="$JSON_CASES
    {
      \"id\": \"$ENTRY_ID\",
      \"category\": \"$ENTRY_CATEGORY\",
      \"severity\": \"$ENTRY_SEVERITY\",
      \"status\": \"$status\",
      \"description\": \"$escaped_desc\"
    }"
done

echo ""
echo "=============================================="
echo " Summary"
echo "=============================================="
echo "  Total cases:        $TOTAL_CASES"
echo "  PASS:               $TOTAL_PASS"
echo "  KNOWN_LIMITATION:   $TOTAL_KNOWN"
echo "  FAIL (unexpected):  $TOTAL_FAIL"
echo "  Unit test exit:     $UNIT_EXIT"
echo "  Integration exit:   $INTEGRATION_EXIT"
echo "=============================================="

# ============================================================================
# Phase 5: Generate report/summary.json
# ============================================================================

echo ""
echo "Generating report/summary.json..."

cat > "$REPORT_DIR/summary.json" <<ENDJSON
{
  "generated": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "unitTestExit": $UNIT_EXIT,
  "integrationTestExit": $INTEGRATION_EXIT,
  "totalCases": $TOTAL_CASES,
  "pass": $TOTAL_PASS,
  "knownLimitation": $TOTAL_KNOWN,
  "fail": $TOTAL_FAIL,
  "cases": [$JSON_CASES
  ]
}
ENDJSON

echo "  -> $REPORT_DIR/summary.json"

# ============================================================================
# Phase 6: Include access-guard report
# ============================================================================

GUARD_REPORT="$SCRIPT_DIR/access-guard/report"
if [ -d "$GUARD_REPORT" ]; then
  echo ""
  echo "Copying access-guard reports..."
  cp -r "$GUARD_REPORT"/* "$REPORT_DIR/" 2>/dev/null || true
  echo "  -> access-guard reports included in $REPORT_DIR/"
elif [ -f "$REPORT_DIR/access-guard-report.json" ]; then
  echo ""
  echo "Access-guard report already present in $REPORT_DIR/"
else
  echo ""
  echo "No access-guard report found. Run access-guard integration tests to generate."
  cat > "$REPORT_DIR/access-guard-report.json" <<GUARDEOF
{
  "note": "Access-guard report not yet generated. Run CASE-GUARD tests with sudo for privileged mode.",
  "generated": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
GUARDEOF
  echo "  -> Placeholder written to $REPORT_DIR/access-guard-report.json"
fi

# ============================================================================
# Phase 7: --fix-check mode
# ============================================================================

if [ "$FIX_CHECK" = true ]; then
  echo ""
  echo "=============================================="
  echo " Fix-Check: Cross-referencing findings with git"
  echo "=============================================="

  FIX_JSON=""

  for entry in "${CASE_REGISTRY[@]}"; do
    parse_entry "$entry"

    # Only check CRITICAL and HIGH severity findings
    case "$ENTRY_SEVERITY" in
      CRITICAL|HIGH) ;;
      *) continue ;;
    esac

    fix_branch=""
    fix_pr=""
    fix_status="unfixed"

    # Search for branches referencing this case ID
    case_kebab=$(printf '%s' "$ENTRY_ID" | tr '[:upper:]' '[:lower:]')

    # Check git branches for references to this finding
    branch_match=$(git -C "$OPENCODE_DIR" branch -a 2>/dev/null | grep -i "$case_kebab" | head -1 | sed 's/^[* ]*//' || true)
    if [ -z "$branch_match" ]; then
      # Try broader category match
      category_kebab=$(printf '%s' "$ENTRY_CATEGORY" | tr '[:upper:]' '[:lower:]')
      branch_match=$(git -C "$OPENCODE_DIR" branch -a 2>/dev/null | grep -iE "(fix|patch|security).*$category_kebab" | head -1 | sed 's/^[* ]*//' || true)
    fi

    if [ -n "$branch_match" ]; then
      fix_branch="$branch_match"
      fix_status="in_progress"
    fi

    # Check for PRs if gh is available
    if command -v gh >/dev/null 2>&1; then
      remote_url=$(git -C "$OPENCODE_DIR" remote get-url origin 2>/dev/null || true)
      if [ -n "$remote_url" ]; then
        pr_match=$(gh pr list --repo "$remote_url" \
          --search "$ENTRY_ID" --state all --json number,state,title --limit 1 2>/dev/null || true)
        if [ -n "$pr_match" ] && [ "$pr_match" != "[]" ]; then
          pr_number=$(printf '%s' "$pr_match" | grep -oE '"number":[0-9]+' | head -1 | cut -d: -f2)
          pr_state=$(printf '%s' "$pr_match" | grep -oE '"state":"[^"]*"' | head -1 | sed 's/"state":"//;s/"//')
          if [ -n "$pr_number" ]; then
            fix_pr="PR #$pr_number"
            if [ "$pr_state" = "MERGED" ]; then
              fix_status="fixed"
            elif [ "$pr_state" = "OPEN" ]; then
              fix_status="in_progress"
            fi
          fi
        fi
      fi
    fi

    if [ -n "$FIX_JSON" ]; then
      FIX_JSON="$FIX_JSON,"
    fi

    escaped_desc=$(printf '%s' "$ENTRY_DESCRIPTION" | sed 's/\\/\\\\/g; s/"/\\"/g')

    FIX_JSON="$FIX_JSON
    {
      \"findingId\": \"$ENTRY_ID\",
      \"severity\": \"$ENTRY_SEVERITY\",
      \"description\": \"$escaped_desc\",
      \"fixBranch\": \"$fix_branch\",
      \"fixPR\": \"$fix_pr\",
      \"status\": \"$fix_status\"
    }"

    printf "  %-18s %-8s %-14s %-20s %s\n" "$ENTRY_ID" "$ENTRY_SEVERITY" "$fix_status" "$fix_branch" "$fix_pr"
  done

  cat > "$REPORT_DIR/fix-coverage.json" <<FIXEOF
[$FIX_JSON
]
FIXEOF

  echo ""
  echo "  -> $REPORT_DIR/fix-coverage.json"
fi

# ============================================================================
# Clean up temp files
# ============================================================================

rm -f "$REPORT_DIR/.unit-output.txt" "$REPORT_DIR/.integration-output.txt" "$FAILED_CASES_FILE"

# ============================================================================
# Exit code: non-zero if any unexpected FAIL exists
# KNOWN_LIMITATION does not fail the build
# ============================================================================

echo ""
if [ "$UNEXPECTED_FAILS" -gt 0 ]; then
  echo "RESULT: FAILED — $UNEXPECTED_FAILS unexpected failure(s)"
  exit 1
fi

echo "RESULT: PASSED — All $TOTAL_CASES cases accounted for ($TOTAL_PASS pass, $TOTAL_KNOWN known limitations)"
exit 0
