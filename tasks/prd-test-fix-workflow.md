# PRD: Universal Test Fix Workflow

## Introduction

Design a universal, AI Agent-driven test fix workflow for automatically diagnosing and fixing bun test / Playwright test failures. The workflow is intended to be executed autonomously by AI Agents such as Claude Code, covering unit tests, integration tests, and E2E tests. The core principle is to prioritize fixing source code, and only modify test code when there is a clear bug in the test itself.

## Goals

- Provide a standardized test fix process that an AI Agent can execute step by step autonomously
- Cover all test types: bun test unit/integration tests + Playwright E2E tests
- Minimize code changes: prioritize fixing source code, preserve the assertion intent of test code
- Provide a repeatable fix-test loop that runs until all tests pass
- Output a structured fix report for developer review

## User Stories

### US-000: Test Failure Analysis Skill (`/test-analyze`)
**Description:** As an AI Agent or developer, I want a reusable skill that runs the test suite and outputs a structured, verified failure report so that any downstream workflow (test-fix, CI triage, PR review) can consume it reliably.

This skill is the **single source of truth** for test failure data. All other user stories in this workflow consume its output rather than parsing test output themselves.

**Acceptance Criteria:**
- [ ] Implemented as a Claude Code skill at `.claude/skills/test-analyze/`
- [ ] Invocable via `/test-analyze` with optional arguments:
  - `--scope <bun|e2e|all>` — which test suites to run (default: `all`)
  - `--file <path>` — run a single test file only
  - `--output <path>` — write structured report to file (default: stdout)
- [ ] Runs the test suite and captures full raw output to a temp file
- [ ] Parses output using **dual verification** to guarantee zero missed failures:
  1. **Source A**: Extract failure count from bun test summary line (`N fail`)
  2. **Source B**: Count all `(fail)` marker lines independently via grep
  3. **Arithmetic check**: Verify `pass + fail + skip = total`
  4. **Silent skip check**: Compare test files on disk vs files that appeared in output
  5. If any check fails, emit a `COMPLETENESS_WARNING` in the report
- [ ] For each failing test, extracts a structured record:
  ```
  {
    file: string,           // e.g. "test/tool/bash.test.ts"
    test: string,           // e.g. "bash tool > basic command execution"
    error_type: enum,       // "compile" | "runtime" | "assertion" | "timeout" | "environment"
    error_message: string,  // first line of error
    stack_trace: string,    // full stack trace
    source_file: string,    // source file from stack (if identifiable)
    source_line: number,    // line number from stack (if identifiable)
    priority: enum          // "P0" | "P1" | "P2" | "P3" | "P4" | "P5"
  }
  ```
- [ ] Groups correlated failures (multiple tests failing due to the same root source file)
- [ ] Outputs a Markdown report with:
  - Summary: total / pass / fail / skip counts, with dual-verification status
  - Failure table: sorted by priority, grouped by correlation
  - Per-file breakdown: which test files have failures and how many
  - Silent skip warnings (if any files didn't execute)
- [ ] Exit code: 0 if all tests pass, 1 if any failures, 2 if completeness check fails
- [ ] Typecheck passes

### US-001: Run Full Test Suite and Collect Failure Results
**Description:** As an AI Agent, I want to run all tests and collect structured failure information so that I can systematically diagnose each failure.

**Dependency:** Invokes the `/test-analyze` skill (US-000) as its implementation.

**Acceptance Criteria:**
- [ ] Invoke `/test-analyze --scope all` to collect results
- [ ] Verify the completeness check passes (no `COMPLETENESS_WARNING`)
- [ ] Consume the structured failure list for downstream diagnosis
- [ ] Generate a prioritized failure list ready for US-002 diagnosis

### US-002: Diagnose Root Cause of a Single Test Failure
**Description:** As an AI Agent, I want to diagnose the root cause of a failing test so that I can determine the correct fix strategy.

**Acceptance Criteria:**
- [ ] Read the failing test file to understand the test intent and assertion logic
- [ ] Read the source code under test to understand the actual implementation
- [ ] Compare "expected behavior" vs "actual behavior" to locate the discrepancy
- [ ] Classify the root cause:
  - **Source code bug** -> fix source code
  - **Source code API change (legitimate refactor)** -> adapt source code for compatibility, or flag for discussion
  - **Test code bug (wrong expected value, stale mock)** -> fix test code
  - **Environment issue (paths, permissions, temp files)** -> fix environment setup
  - **Type error** -> fix source code type definitions
- [ ] Record the diagnosis conclusion and fix strategy

### US-003: Execute Fixes in Priority Order
**Description:** As an AI Agent, I want to fix failures in the correct order so that upstream fixes naturally resolve downstream failures.

**Acceptance Criteria:**
- [ ] Follow the priority-based fix order:
  1. Compile/type errors (block other tests from running)
  2. Shared module/utility function errors (largest blast radius)
  3. Independent unit test failures
  4. Integration test failures
  5. E2E test failures
- [ ] Re-run tests after each batch of fixes to verify
- [ ] Follow project code conventions (CLAUDE.md / AGENTS.md) when fixing source code
- [ ] Do not introduce new test failures

### US-004: Fix Loop and Convergence
**Description:** As an AI Agent, I want to iterate fix-test cycles until all tests pass so that the task reaches completion.

**Dependency:** Reads and updates the failure tracking ledger (US-006) each round.

**Acceptance Criteria:**
- [ ] Run the full test suite after each fix round and compare failure counts
- [ ] If failure count does not decrease or increases, roll back changes and try an alternative approach
- [ ] Set a maximum iteration limit (recommended: 10 rounds); pause and report if exceeded
- [ ] **Ledger completeness invariant**: After the final round, every entry in the ledger is in either `fixed` or `escalated` state — no entry remains in `discovered` or `attempted`
- [ ] End with all tests passing, or present all `escalated` failures as a batch for human review

### US-005: Generate Fix Report
**Description:** As an AI Agent, I want to generate a structured fix report so that the developer can review all changes.

**Dependency:** Reads the final state of the failure tracking ledger (US-006).

**Acceptance Criteria:**
- [ ] Report includes: number of tests fixed, list of modified files, brief description of each fix
- [ ] Distinguish between "source code fixes" and "test code fixes" (if any)
- [ ] **Escalated failures section**: List all `escalated` failures as a batch, each with:
  - Test file and test name
  - Escalation reason (one of the defined categories from US-006)
  - Diagnosis summary (what was tried and why it failed)
  - Suggested next steps for the human reviewer
- [ ] **Ledger integrity check**: Report confirms `fixed + escalated = initially_failing` (no failures lost)
- [ ] Report output in Markdown format

### US-006: Failure Tracking Ledger
**Description:** As an AI Agent, I want a ledger that tracks every discovered failure through its full lifecycle so that no failure is forgotten, skipped, or silently dropped.

The ledger is the **central invariant** of the workflow: at termination, every entry must be in a terminal state (`fixed` or `escalated`). This is what transforms "best effort" into a guarantee.

**Acceptance Criteria:**
- [ ] Ledger is initialized from the `/test-analyze` output (US-000) — one entry per unique failing test
- [ ] Each ledger entry has a **status** field with the following lifecycle:
  ```
  discovered → attempted → fixed
                        → escalated(reason)
  ```
  No other transitions are allowed (no backwards movement).
- [ ] Each ledger entry tracks:
  ```
  {
    id: string,              // unique ID, e.g. "F-001"
    file: string,            // test file path
    test: string,            // test name
    priority: string,        // P0-P5
    status: enum,            // "discovered" | "attempted" | "attempted_N" | "fixed" | "escalated"
    attempt_count: number,   // how many fix attempts have been made
    max_attempts: 3,         // per-failure attempt limit
    diagnosis: string,       // root cause diagnosis
    fix_applied: string,     // description of fix (if fixed)
    escalation_reason: enum, // reason for escalation (if escalated)
    modified_files: string[] // files changed to fix this failure
  }
  ```
- [ ] **Escalation reasons** (exhaustive list):
  - `design_decision` — fix requires a product/architecture decision humans must make
  - `external_dependency` — depends on external service/API that cannot be mocked adequately
  - `flaky` — test passes/fails non-deterministically, needs human investigation
  - `circular_regression` — fixing this breaks another test, and vice versa
  - `max_attempts_exceeded` — 3 fix attempts failed, different approaches exhausted
  - `out_of_scope` — fix requires changes outside the allowed scope (e.g., third-party library)
- [ ] **Attempt limit**: Each failure gets at most 3 fix attempts. After 3 failed attempts, it is automatically escalated with reason `max_attempts_exceeded`
- [ ] **No-orphan invariant**: At workflow termination, `count(discovered) + count(attempted) = 0`. If this invariant is violated, the workflow must NOT produce a "success" report — it must error with the orphaned entries listed
- [ ] **Re-discovery handling**: If a new failure appears after a fix round (regression), it is added to the ledger as a new `discovered` entry and goes through the same lifecycle
- [ ] Ledger state is persisted to a temp file after each round for crash recovery

### US-007: Execution Driver (Outer Loop)
**Description:** As a developer, I want a shell script driver that keeps the fix workflow running until completion, surviving Agent crashes, context overflows, and session disconnects — so that I can start it and walk away.

The driver and the fix skill form a **two-layer architecture**:
- **Outer layer (driver)**: a shell script that loops, invokes the Agent, and monitors progress. It is crash-proof because it's a simple loop with no state beyond the ledger file.
- **Inner layer (skill)**: a Claude Code skill (`/test-fix-round`) that reads the ledger, picks ONE failure group, diagnoses it, fixes it, updates the ledger, and exits. Each invocation is stateless and short-lived.

**Acceptance Criteria:**
- [ ] Shell script `test-fix-driver.sh` located at `.claude/scripts/test-fix-driver.sh`
- [ ] Driver loop logic:
  ```
  1. If no ledger exists → invoke `/test-analyze`, initialize ledger
  2. Read ledger → count non-terminal entries
  3. If count = 0 → invoke report generation, exit success
  4. If round > max_rounds (10) → force-escalate remaining, generate report, exit
  5. Invoke Claude Code with `/test-fix-round` skill
  6. Wait for completion (with timeout per round)
  7. If Agent crashed / timed out → log warning, go to step 2 (retry same ledger state)
  8. Increment round counter, go to step 2
  ```
- [ ] **Per-round timeout**: Each Agent invocation has a configurable timeout (default: 10 minutes). If exceeded, the driver kills the Agent and retries
- [ ] **Crash recovery**: If the driver itself is killed (Ctrl+C, system restart), re-running the script resumes from the last persisted ledger — no work is lost
- [ ] **Progress watchdog**: If 3 consecutive rounds produce zero ledger state changes (no new `fixed` or `escalated` entries), the driver force-escalates all remaining entries with reason `max_attempts_exceeded` and exits
- [ ] **Logging**: Each round's stdout/stderr is logged to `.claude/logs/test-fix-round-<N>.log` for post-mortem analysis
- [ ] **Exit codes**:
  - `0` — all failures fixed
  - `1` — some failures escalated (partial success)
  - `2` — driver error (ledger corruption, script bug)

### US-008: Single-Round Fix Skill (`/test-fix-round`)
**Description:** As an AI Agent, I want a skill that executes exactly one fix round — pick one failure group from the ledger, diagnose it, fix it, verify it, update the ledger — so that each invocation is self-contained and crash-safe.

**Acceptance Criteria:**
- [ ] Implemented as a Claude Code skill at `.claude/skills/test-fix-round/`
- [ ] Invocable via `/test-fix-round --ledger <path>`
- [ ] Each invocation performs exactly these steps:
  1. Read ledger from disk
  2. Select the highest-priority `discovered` entry (or oldest `attempted` with `attempt_count < 3`)
  3. If the selected entry is part of a correlation group, include all entries in the group
  4. Diagnose the failure group (US-002 logic)
  5. Apply the fix (US-003 logic)
  6. Run targeted verification via `/test-analyze --file <path>`
  7. Update ledger entries: `fixed` or increment `attempt_count`
  8. Run `/test-analyze --scope all` for regression check
  9. If regression found: roll back fix, escalate with reason `circular_regression` if repeated
  10. Write updated ledger to disk
  11. Exit
- [ ] **Scope limit**: Each invocation touches at most ONE failure group (one correlated set of failures sharing a root cause). This keeps context small and each round resumable
- [ ] **Idempotent**: If the same round is invoked twice on the same ledger state (e.g., after a crash before ledger write), it produces the same result
- [ ] **No side effects on crash**: If the Agent crashes before step 10 (ledger write), the ledger is unchanged — the driver will retry the same failure group
- [ ] Typecheck passes

## Functional Requirements

### Phase 0: Test Failure Analysis Skill (`/test-analyze`)

- FR-0.1: The skill is a Claude Code skill located at `.claude/skills/test-analyze/`
- FR-0.2: Support three test scopes:
  - `bun` — runs `bun test --cwd packages/opencode`
  - `e2e` — starts dev server, runs `bun run --cwd packages/app test:e2e`, stops dev server
  - `all` — runs both sequentially
- FR-0.3: Support single-file mode: `--file <path>` runs only that test file
- FR-0.4: Capture full raw output to a temp file for auditability
- FR-0.5: **Dual verification** — the skill must perform all four completeness checks:

  | Check | Method | Fail Condition |
  |-------|--------|----------------|
  | Source A vs B | Bun summary `N fail` vs `grep -c "^(fail)"` count | Counts differ |
  | Arithmetic | `pass + fail + skip == total` | Sum doesn't match |
  | Silent skip | Count test files on disk vs files appearing in output | Disk has more files |
  | E2E parity | Playwright summary vs individual `FAIL` markers | Counts differ |

  If any check fails, the report must include a `COMPLETENESS_WARNING` with details of the discrepancy.

- FR-0.6: **Error type classification** — categorize each failure by matching error patterns:
  | error_type | Pattern Match |
  |------------|---------------|
  | `compile` | `Cannot find module`, `SyntaxError`, `is not a function` (at import time) |
  | `runtime` | `TypeError`, `ReferenceError`, `RangeError` (during test execution) |
  | `assertion` | `expect(` in stack, `Expected:` / `Received:` in message |
  | `timeout` | `timed out after`, `exceeded timeout` |
  | `environment` | `ENOENT`, `EACCES`, `EADDRINUSE`, path-related errors |

- FR-0.7: **Priority assignment** — based on error_type and source location:
  | Priority | Category | Indicators | Fix Strategy |
  |----------|----------|------------|--------------|
  | P0 | Compile/Import errors | `Cannot find module`, `SyntaxError`, type mismatch | Fix source code exports/types |
  | P1 | Shared module failures | Error originates from `src/util/`, `src/tool/`, `src/agent/` etc. | Fix first, may cascade-resolve other failures |
  | P2 | Assertion failures | `expect(...).toBe(...)` mismatch | Compare expected vs actual, fix source logic |
  | P3 | Runtime errors | `TypeError`, `ReferenceError`, etc. | Fix source code logic |
  | P4 | Timeouts | `timed out after 10000ms` | Check async logic, deadlocks, infinite loops |
  | P5 | Environment-related | Path not found, permission denied, port in use | Fix test setup or preload |

- FR-0.8: **Correlation grouping** — if multiple tests fail due to the same source file (identified from stack traces), group them under a single root cause entry
- FR-0.9: **Structured output** — the skill outputs a Markdown report with:
  1. Summary section (total/pass/fail/skip, dual-verification status)
  2. Failure table (sorted by priority, grouped by correlation)
  3. Per-file breakdown
  4. Silent skip warnings (if any)
  5. Raw output file path (for manual inspection)

### Phase 1: Test Discovery and Execution

- FR-1: US-001 invokes `/test-analyze --scope all` and consumes its structured output
- FR-2: For targeted re-runs during fix iterations, invoke `/test-analyze --file <path>`
- FR-3: The fix workflow never parses test output directly — all parsing is delegated to the skill

### Phase 3: Diagnosis and Fix

- FR-8: Execute the following diagnostic flow for each failing test:
  1. Read the test file to understand the `describe`/`test` block intent
  2. Locate the source code file and line number from the stack trace
  3. Read the source code to understand the current implementation
  4. Compare test expectations with actual behavior
  5. Determine the fix target (source code or test code)

- FR-9: Fix priority decision tree:
  ```
  Test Failure
  ├─ Source code bug (logic error, unhandled edge case) -> fix source code
  ├─ Source code API signature changed -> restore or adapt API
  ├─ Source code missing logic for new feature -> add source code logic
  ├─ Test expected value clearly wrong -> fix test (must document reason)
  ├─ Test references deleted/renamed export -> fix source export or adapt test
  └─ Environment/config issue -> fix preload or setup
  ```

- FR-10: Source code fixes must follow CLAUDE.md conventions:
  - No `try`/`catch` — use `.catch()` instead
  - No `any` types — use precise types
  - No `else` statements — use early returns
  - Use `const` — no `let`, use ternaries or early returns
  - Functional array methods over `for` loops

- FR-11: When modifying test code, add a comment explaining the reason (e.g., `// Fixed: updated expected value after API change`)

### Phase 3.5: Failure Tracking Ledger

- FR-12: Initialize the ledger from `/test-analyze` output: one entry per unique `(file, test)` pair, all in `discovered` state
- FR-13: When an Agent begins diagnosing a failure, transition it to `attempted` and record the diagnosis
- FR-14: When a fix is verified (targeted test passes), transition to `fixed` and record modified files
- FR-15: When a fix fails or cannot be determined, increment `attempt_count`:
  - If `attempt_count < 3`: keep in `attempted`, try a different approach next round
  - If `attempt_count >= 3`: transition to `escalated` with reason `max_attempts_exceeded`
- FR-16: When a fix causes circular regression (fixing A breaks B, fixing B breaks A), escalate both with reason `circular_regression`
- FR-17: **No-orphan check**: Before generating the final report, assert that every ledger entry is in `fixed` or `escalated`. If any entry is still `discovered` or `attempted`, the workflow must:
  1. Log the orphaned entries
  2. Force-escalate them with reason `max_attempts_exceeded`
  3. Include them in the escalated failures batch
- FR-18: After each round, diff the new `/test-analyze` output against the ledger:
  - Failures that disappeared → confirm `fixed` (the fix resolved it)
  - Failures that still exist → keep current status, increment attempt if applicable
  - **New failures not in ledger** → add as new `discovered` entries (regression detected)
  - This diff is how regressions are caught and tracked
- FR-19: Persist ledger state to a temp JSON file after each round (`/tmp/test-fix-ledger-<session>.json`) for crash recovery and auditability

### Phase 4: Verification and Iteration

- FR-20: After each fix round, run affected test files via `/test-analyze --file <path>` for quick verification
- FR-21: After quick verification passes, run `/test-analyze --scope all` for full regression check
- FR-22: If new failures are introduced (detected by FR-18 ledger diff), roll back changes and try alternative approach
- FR-23: Track failure count changes per round to ensure overall convergence (decreasing `discovered + attempted` count)
- FR-24: Maximum 10 iteration rounds. After round 10, force-escalate all remaining non-terminal entries (FR-17)
- FR-25: **Termination condition**: The workflow terminates when one of:
  - All ledger entries are `fixed` (success — all tests pass)
  - All ledger entries are `fixed` or `escalated` AND max iterations reached (partial success)
  - All ledger entries are `fixed` or `escalated` AND no more `discovered` entries can be attempted (convergence)

### Phase 5: Report Output

- FR-26: Generate a Markdown fix report with the following sections:
  ```markdown
  # Test Fix Report

  ## Summary
  - Total tests: X
  - Initially failing: Y
  - Fixed: Z
  - Escalated (requires human review): W
  - Ledger integrity: fixed + escalated = initially_failing ✓/✗

  ## Fixes Applied
  | # | Test File | Test Name | Root Cause | Fix Applied | File Modified |
  |---|-----------|-----------|------------|-------------|---------------|

  ## Escalated Failures (requires human review)
  | # | Test File | Test Name | Reason | Diagnosis | Attempts | Suggested Next Steps |
  |---|-----------|-----------|--------|-----------|----------|----------------------|

  ## Iteration History
  | Round | Failures (start) | Fixed | New Regressions | Failures (end) |
  |-------|-------------------|-------|-----------------|----------------|

  ## Changes by File
  - `src/foo/bar.ts` — Fixed return type, added null check
  - `src/util/format.ts` — Restored removed export
  ```

### Phase 6: Execution Driver

- FR-27: The driver is a shell script (`test-fix-driver.sh`) that implements the outer loop. It has **no dependency on AI** — it is pure bash logic reading the ledger JSON file
- FR-28: Driver state machine:
  ```
  INIT: ledger exists?
    NO  → run `/test-analyze --scope all`, initialize ledger, → LOOP
    YES → → LOOP

  LOOP: read ledger, count non-terminal entries
    count = 0        → REPORT
    round > 10       → FORCE_ESCALATE → REPORT
    stale_rounds > 3 → FORCE_ESCALATE → REPORT
    otherwise        → INVOKE_AGENT

  INVOKE_AGENT:
    spawn `claude -p "/test-fix-round --ledger <path>"` with timeout
    on success → increment round, → LOOP
    on timeout → log warning, → LOOP (retry same state)
    on crash   → log warning, → LOOP (retry same state)

  FORCE_ESCALATE:
    for each non-terminal entry in ledger:
      set status = "escalated", reason = "max_attempts_exceeded"
    write ledger
    → REPORT

  REPORT:
    spawn `claude -p "/test-fix-report --ledger <path>"`
    exit with appropriate code (0/1/2)
  ```
- FR-29: **Per-round timeout**: Configurable via `--round-timeout <seconds>` (default: 600s / 10 minutes). The driver uses `timeout` command to enforce this
- FR-30: **Staleness detection**: The driver compares the ledger's `fixed + escalated` count before and after each round. If 3 consecutive rounds produce zero new terminal entries, trigger `FORCE_ESCALATE`
- FR-31: **Round logging**: Redirect each Agent invocation's stdout/stderr to `.claude/logs/test-fix-round-<N>.log`
- FR-32: **Resumability**: The driver uses only the ledger file and a round counter file (`.claude/logs/test-fix-round-counter`) as state. Both are plain files on disk. Re-running the script after any interruption resumes from the last written state
- FR-33: **Concurrency safety**: The driver acquires a file lock (`flock`) on the ledger before each round to prevent multiple driver instances from conflicting
- FR-34: **Signal handling**: The driver traps `SIGINT` and `SIGTERM` to gracefully stop after the current round completes (do not kill the Agent mid-fix)

## Non-Goals

- Do not generate new test cases (only fix existing tests)
- Do not refactor test code structure (preserve test file organization)
- Do not modify test config files (bunfig.toml, playwright.config.ts) unless they are the root cause
- Do not handle flaky tests (unstable tests require manual tagging and separate handling)
- Do not perform performance optimization (not aimed at speeding up test runs)
- Do not auto-commit git changes (leave commit decisions to the user)

## Technical Considerations

### Project Test Architecture

- **Main test suite**: `packages/opencode/test/` — 119 test files using `bun:test`
- **E2E tests**: `packages/app/e2e/` — 30 spec files using Playwright
- **Other package tests**: `packages/console/`, `packages/enterprise/` — minimal tests
- **Test preload**: `packages/opencode/test/preload.ts` — sets up isolated environment variables and temp directories
- **Timeout config**: bun test defaults to 10s, Playwright defaults to 60s

### Known Test Pitfalls (from MEMORY.md)

- On macOS, `os.tmpdir()` returns `/var/folders/...` but `fs.realpathSync()` returns `/private/var/folders/...`
- `checkAccess()` does NOT normalize `../` in paths — callers must normalize themselves
- `minimatch` is case-sensitive — potential bypass vector on case-insensitive filesystems (macOS)
- Relative rules like `secrets/**` don't match absolute paths returned by `realpathSync`

### Key Command Reference

```bash
# Run full bun test suite
bun test --cwd packages/opencode

# Run a single test file
bun test --cwd packages/opencode -- test/tool/bash.test.ts

# Run tests matching a name pattern
bun test --cwd packages/opencode --test-name-pattern "formatDuration"

# Type checking
bun turbo typecheck

# E2E tests
bun run --cwd packages/app test:e2e
```

## Success Metrics

- All previously failing tests now pass (0 failures)
- Full test suite regression passes (no new failures introduced)
- Source code modifications comply with CLAUDE.md code conventions
- Test code modifications minimized (only when there is a clear bug, with explanatory comments)
- Fix report is clear and complete, with root cause and strategy documented for each fix
- `bun turbo typecheck` passes (no type errors)

## Verification Plan

Verification is performed via **live validation** — run the workflow against the current codebase's real test failures and validate each User Story's acceptance criteria.

### VP-000: Verify US-000 (Test Failure Analysis Skill)

**Method:** Run the skill and verify its output is complete and correct using independent manual checks.

**Steps:**
1. Run `/test-analyze --scope bun` and capture the structured report
2. Independently run `bun test --cwd packages/opencode` and capture raw output
3. Perform manual dual verification against the skill's output

**Pass Criteria:**
- [ ] **Source A vs B match**: Skill's reported failure count matches both bun summary line AND `grep -c "^(fail)"` count
- [ ] **Arithmetic check**: `pass + fail + skip = total` in the skill's summary
- [ ] **Silent skip check**: Skill detects any test files on disk that didn't appear in output (or confirms none)
- [ ] **No COMPLETENESS_WARNING**: If warnings exist, they accurately describe real discrepancies
- [ ] **Structured records**: Pick 5 random failures from the report. For each:
  - File path matches the actual test file
  - Test name matches the actual `test()` / `it()` description
  - Error type classification is correct (manually verify against raw output)
  - Stack trace is present and points to the right location
  - Priority assignment follows FR-0.7 rules
- [ ] **Correlation grouping**: Failures sharing the same root source file are grouped together
- [ ] **Single-file mode**: `/test-analyze --file test/tool/bash.test.ts` returns only failures from that file
- [ ] **All-pass scenario**: If a test file has 0 failures, the skill does not list it in the failure table

### VP-001: Verify US-001 (Run Full Test Suite and Collect Failures)

**Method:** Verify that US-001 correctly delegates to the `/test-analyze` skill and consumes its output.

**Steps:**
1. Execute US-001 which invokes `/test-analyze --scope all`
2. Verify no `COMPLETENESS_WARNING` in the output
3. Verify the failure list is passed downstream for diagnosis

**Pass Criteria:**
- [ ] US-001 invokes the skill (not raw test commands)
- [ ] The structured failure list from the skill is consumed without re-parsing
- [ ] Failure count matches VP-000's verified count
- [ ] Prioritized failure list is ready for US-002

### VP-002: Verify US-002 (Diagnose Root Cause)

**Method:** For each failure diagnosed by the workflow, manually verify the diagnosis is correct.

**Steps:**
1. Pick 3-5 representative failures (one from each priority category if possible)
2. For each, independently read the test file and source code
3. Compare your own diagnosis with the workflow's diagnosis

**Pass Criteria:**
- [ ] Root cause category (source bug / API change / test bug / env issue / type error) is correct for all sampled failures
- [ ] The identified source file and line number match the actual error origin
- [ ] The fix strategy (fix source vs fix test) is appropriate for the root cause
- [ ] No misdiagnosis that would lead to modifying the wrong file

### VP-003: Verify US-003 (Execute Fixes in Priority Order)

**Method:** Review the sequence of fixes applied and verify ordering correctness.

**Steps:**
1. Inspect the fix log or report to see the order of fixes
2. Verify P0 fixes (compile/import) were applied before P1 (shared modules), before P2 (assertions), etc.
3. Verify that no downstream test was fixed before its upstream dependency

**Pass Criteria:**
- [ ] Fix order strictly follows P0 > P1 > P2 > P3 > P4 > P5
- [ ] Correlated failures (grouped by shared root cause) were fixed together
- [ ] Source code changes comply with CLAUDE.md conventions (spot-check 3-5 modified files)
- [ ] No new test failures introduced by any fix (verified by intermediate test runs)

### VP-004: Verify US-004 (Fix Loop and Convergence)

**Method:** Inspect the iteration history and ledger state to verify convergence behavior.

**Steps:**
1. Review the failure count at each iteration round (from the iteration history table)
2. Review the ledger JSON file to verify state transitions
3. If any rollback occurred, verify the rollback was correct

**Pass Criteria:**
- [ ] `discovered + attempted` count is monotonically non-increasing across rounds
- [ ] No round introduced more new regressions than failures it fixed
- [ ] If max iterations (10) were reached, all remaining entries are force-escalated
- [ ] **Ledger completeness invariant**: `count(discovered) + count(attempted) = 0` at termination
- [ ] **Ledger arithmetic invariant**: `count(fixed) + count(escalated) >= initially_failing` (>= because regressions add new entries)
- [ ] Every `escalated` entry has a valid reason from the defined enum

### VP-006: Verify US-006 (Failure Tracking Ledger)

**Method:** Inspect the ledger file and verify its integrity independently.

**Steps:**
1. Read the persisted ledger JSON file
2. Cross-reference with the initial `/test-analyze` report and final test results
3. Verify every lifecycle transition was valid

**Pass Criteria:**
- [ ] **Initialization completeness**: Every failure from the initial `/test-analyze` report has a corresponding ledger entry
- [ ] **No orphans**: Zero entries in `discovered` or `attempted` state at termination
- [ ] **No phantom fixes**: Every `fixed` entry corresponds to a test that actually passes now (verified by running it)
- [ ] **No lost entries**: No failure from the initial report is missing from the ledger
- [ ] **Valid transitions only**: No entry went backwards (e.g., `fixed` -> `attempted`)
- [ ] **Attempt count accuracy**: `attempt_count` matches the actual number of fix attempts logged
- [ ] **Regression tracking**: Every regression (new failure introduced by a fix) was added to the ledger as a new entry
- [ ] **Escalation reasons valid**: Every `escalated` entry has a reason from the defined enum, not a free-text string
- [ ] **Crash recovery**: If the workflow was interrupted and resumed, the ledger correctly restored from the temp file

### VP-007: Verify US-007 (Execution Driver)

**Method:** Test the driver script under normal and failure conditions.

**Steps:**
1. Run the driver end-to-end on the current codebase
2. Simulate Agent crash (kill the Agent process mid-round)
3. Simulate staleness (mock a ledger with no progress for 3 rounds)
4. Verify signal handling (send SIGINT during a round)

**Pass Criteria:**
- [ ] **Normal execution**: Driver loops, invokes Agent per round, terminates when ledger is fully terminal
- [ ] **Crash recovery**: After killing the Agent mid-round, re-running the driver resumes from the same ledger state — no work lost, no ledger corruption
- [ ] **Staleness detection**: After 3 rounds with zero new terminal entries, driver force-escalates remaining and exits
- [ ] **Max rounds**: After 10 rounds, driver force-escalates remaining and exits (does not loop forever)
- [ ] **Timeout enforcement**: Agent invocation that exceeds `--round-timeout` is killed, round is retried
- [ ] **Signal handling**: SIGINT during a round waits for Agent to finish current round, then exits gracefully
- [ ] **Concurrency safety**: Running two driver instances simultaneously — second instance fails to acquire flock and exits with error
- [ ] **Logging**: Each round's output is written to `.claude/logs/test-fix-round-<N>.log`
- [ ] **Exit codes**: 0 when all fixed, 1 when some escalated, 2 on driver error
- [ ] **Resumability**: Driver can be stopped and restarted any number of times and always converges

### VP-008: Verify US-008 (Single-Round Fix Skill)

**Method:** Invoke the skill manually with a pre-populated ledger and verify it performs exactly one round.

**Steps:**
1. Create a ledger with multiple `discovered` entries at different priorities
2. Invoke `/test-fix-round --ledger <path>`
3. Verify it picked the correct entry and performed one fix cycle
4. Invoke again — verify it picks the next entry

**Pass Criteria:**
- [ ] **Single group scope**: Each invocation touches at most one failure group (verified by ledger diff before/after)
- [ ] **Priority ordering**: The skill selects the highest-priority `discovered` entry first
- [ ] **Correlation awareness**: If the selected entry is part of a group, all group members are attempted together
- [ ] **Ledger update**: After invocation, the targeted entries moved to `fixed` or incremented `attempt_count`
- [ ] **Non-targeted entries unchanged**: Entries not selected this round remain in their previous state
- [ ] **Idempotent**: Invoking twice on the same ledger state produces the same result (second invocation picks the same entry if first didn't write)
- [ ] **Regression detection**: If the fix introduces a new failure, it appears as a new `discovered` entry in the ledger
- [ ] **Clean exit**: Skill exits after one round — does not loop internally

### VP-005: Verify US-005 (Generate Fix Report)

**Method:** Inspect the generated report for completeness and accuracy.

**Steps:**
1. Read the generated Markdown report
2. Cross-reference each entry with the actual code changes (via `git diff`)
3. Verify unfixed tests (if any) have documented reasons

**Pass Criteria:**
- [ ] Report contains Summary section with correct total/failing/fixed/escalated counts
- [ ] **Ledger integrity line**: `fixed + escalated = initially_failing` is verified in the summary
- [ ] "Fixes Applied" table lists every `fixed` ledger entry with: test file, test name, root cause, fix description, modified file
- [ ] "Source code fixes" and "test code fixes" are clearly distinguished
- [ ] Each test code modification has an explanatory comment in the code itself
- [ ] "Escalated Failures" table lists every `escalated` ledger entry with: reason, diagnosis, attempt count, suggested next steps
- [ ] "Iteration History" table shows per-round failure count progression
- [ ] "Changes by File" section matches `git diff --stat` output
- [ ] Report is valid Markdown (renders correctly)

### VP-END: Final Acceptance Gate

After all VP-000 through VP-008 pass, run the following final checks:

```bash
# 1. Full bun test suite must pass
bun test --cwd packages/opencode
# Expected: 0 failures

# 2. Type checking must pass
bun turbo typecheck
# Expected: 0 errors

# 3. E2E tests must pass (if in scope)
bun run --cwd packages/app test:e2e
# Expected: 0 failures

# 4. No unintended file changes
git diff --stat
# Expected: only files listed in the fix report are modified
```

**Final pass criteria:**
- [ ] All test commands exit with code 0 (or only `escalated` failures remain)
- [ ] `git diff` shows only files documented in the fix report
- [ ] No secrets, credentials, or sensitive data in any modified file
- [ ] Ledger no-orphan invariant holds: `count(discovered) + count(attempted) = 0`
- [ ] Ledger arithmetic invariant holds: `count(fixed) + count(escalated) >= initially_failing`
- [ ] If any failures are `escalated`, they are presented as a batch with actionable next steps

## Design Decisions (Confirmed)

1. **Tests depending on external services** -> Attempt to fix by mocking external dependencies rather than skipping. Strategy:
   - Use `bun:test`'s `mock.module()` to mock external API calls
   - For provider tests requiring API keys, mock the network layer to return preset responses
   - Mocks should closely match the real API response structure to preserve test value

2. **Parallel fixing** -> Support multi-Agent parallel execution. Strategy:
   - Partition tasks by test module (directory), each Agent handles an independent module
   - Module granularity: `test/tool/`, `test/agent/`, `test/security/`, `test/server/`, etc.
   - Shared module fixes (`src/util/`, `src/tool/`) are handled by a dedicated Agent first; other Agents wait for completion
   - Use git worktree to isolate each Agent's workspace; merge fixes at the end

3. **Playwright E2E tests** -> Included in scope; workflow auto-manages dev server lifecycle. Strategy:
   - Automatically start the dev server (`bun dev serve`) during the E2E test phase
   - Wait for server readiness (detect port availability) before running Playwright tests
   - Automatically shut down the dev server after tests complete
   - If server startup fails, log the error and mark related E2E tests as "environment blocked"
