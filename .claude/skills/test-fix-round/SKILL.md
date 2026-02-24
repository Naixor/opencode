---
name: test-fix-round
description: "Execute a single test-fix cycle: read ledger, select highest-priority discovered failure, diagnose and fix it, verify, and update ledger. Use when you need to fix one test failure at a time. Triggers on: test-fix-round, fix one test, fix next test, single fix round."
user-invocable: true
---

# Test Fix Round

Execute a single test-fix cycle. Read the ledger, select the highest-priority `discovered` entry, diagnose and fix it, verify the fix, and update the ledger.

---

## Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--ledger` | **Yes** | — | Path to the test-fix ledger JSON file (must conform to `.claude/schemas/test-fix-ledger.schema.json`) |

---

## The Job

1. **Read the ledger** from the `--ledger` path
2. **Select ONE entry** — the highest-priority entry with `status: "discovered"`
3. **Diagnose the failure** — read the failing test, locate the source, identify root cause
4. **Apply the fix** — modify source or test code following project conventions
5. **Verify the fix** — run `/test-analyze --file <path>` on the specific test file
6. **Update the ledger** — set status to `fixed` or increment `attempt_count`
7. **Regression check** — run `/test-analyze --scope bun` to detect new failures
8. **Write ledger to disk** — persist the updated ledger as the final action

---

## Step 1: Read the Ledger

1. Read the JSON file at the `--ledger` path.
2. Validate that the file conforms to the ledger schema (required top-level fields: `session_id`, `created_at`, `updated_at`, `initial_failure_count`, `entries`).
3. If the file is missing or invalid, abort with an error message: `ERROR: Ledger file not found or invalid at <path>`.

---

## Step 2: Select ONE Entry

1. Filter entries to only those with `status: "discovered"`.
2. Sort by `priority` ascending (P0 first, P5 last).
3. If multiple entries share the same priority, prefer the one with the lowest `attempt_count`.
4. Select the **first** entry from the sorted list — this is the target for this round.
5. Update the selected entry's `status` to `"attempted"`.
6. If no `discovered` entries remain, print `NO_WORK: All ledger entries are terminal (fixed or escalated). Nothing to do.` and exit.

---

## Step 3: Diagnose the Failure

Follow these sub-steps in order to identify the root cause. Do not skip ahead — each sub-step builds on the previous one.

### 3.1 Read the Failing Test

1. Open the test file at the entry's `file` path.
2. Read the **imports** at the top of the file — identify which modules the test depends on.
3. Read any **`beforeAll`/`beforeEach`/`afterEach`/`afterAll`** blocks — understand the test setup and teardown (fixtures, mocks, temp dirs, config).
4. Locate the specific `describe`/`test`/`it` block matching the entry's `test` name:
   - Match by exact test name string.
   - If the test name is nested (e.g., `"outer > inner > test name"`), traverse the `describe` nesting to find the correct block.
5. Read the assertion(s) in the test block:
   - **`expect(x).toBe(y)`** — strict equality check; note both the expression and expected value.
   - **`expect(x).toEqual(y)`** — deep equality; note the full expected structure.
   - **`expect(fn).toThrow()`** — the test expects an error to be thrown.
   - **`expect(x).toContain(y)`** — substring or array-member check.
   - **`expect(x).toBeTruthy()`/`toBeFalsy()`** — boolean coercion check.
6. Summarize the test's intent in one sentence: "This test verifies that `<function/method>` returns/does `<expected behavior>` when given `<inputs/conditions>`."

---

### 3.2 Locate the Source

1. **If the entry has `source_file` and `source_line`:**
   - Open `source_file` and jump to `source_line`.
   - Read the full function/method containing that line (from its signature to its closing brace).
   - If the function is short (< 50 lines), read the entire function. If longer, read the 30 lines above and below the failure line.

2. **If `source_file` is null or missing — use the stack trace:**
   - Parse the entry's `stack_trace` field line by line.
   - Skip frames from `node_modules/`, `bun:`, and test runner internals.
   - The first non-test, non-library frame is the likely source location.
   - Extract the file path and line number from that frame (format: `at functionName (path/to/file.ts:line:col)` or `path/to/file.ts:line:col`).
   - Open that file and read the surrounding function.

3. **If neither source location nor stack trace is available:**
   - Look at the test's imports to determine which module is under test.
   - Open that module's source file and locate the function/method being tested (match by name from the test).
   - Read the full function.

4. **Read related context** — if the source function calls other internal functions, read those too (one level deep only).

---

### 3.3 Compare Expected vs Actual

1. From the **error message** in the entry's `error_message` field, extract the actual value produced (e.g., `Expected: X, Received: Y` or `TypeError: cannot read property Z of undefined`).
2. Trace through the source code mentally:
   - What inputs does the test provide?
   - What code path does execution follow with those inputs?
   - What value does the source code actually produce?
3. Identify the **discrepancy** — where does the code's behavior diverge from the test's expectation?
4. Determine the **root cause category**:
   - Is the source code wrong (produces incorrect output)?
   - Did the source API change (function signature, return type, or behavior changed intentionally)?
   - Is the test wrong (incorrect assertion, outdated expectation, bad setup)?
   - Is it an environment issue (missing file, wrong path, unset variable)?

---

### 3.4 Decision Tree

Based on the root cause identified in 3.3, select exactly ONE fix strategy:

#### Source Bug
**Criteria:** The source code has a defect — it does not implement its intended behavior correctly.
- The test's expected behavior is correct per the project's design.
- The source code produces wrong output, crashes, or has a logic error.
- **Action:** Fix the source code. Do not modify the test.
- **Example:** A function returns `null` instead of an empty array because of a missing early return.

#### API Change
**Criteria:** The source API was intentionally changed (new parameter, renamed method, changed return type) but the test was not updated.
- Check recent git history (`git log --oneline -10 -- <source_file>`) to confirm the change was intentional.
- The source code's current behavior is correct per the new design.
- **Action:** Adapt the test to match the new API. Update assertions, imports, and setup as needed.
- **Example:** A function was refactored to return `Result<T>` instead of `T | null`, and the test still expects null-checking.

#### Test Bug
**Criteria:** The test itself has a logic error — wrong assertion, incorrect setup, or flawed test data.
- The source code is correct and produces the expected output.
- The test's assertion or setup does not match the source's actual contract.
- **Action:** Fix the test. Add a `// Fixed: <reason>` comment on the corrected line explaining what was wrong.
- **Example:** Test uses `toBe()` (reference equality) instead of `toEqual()` (deep equality) for object comparison.

#### Environment Issue
**Criteria:** The failure is caused by missing configuration, wrong paths, missing fixtures, or external dependency problems.
- The source code and test logic are both correct.
- The failure is caused by something outside the code itself.
- **Action:** Fix the environment setup — add missing fixtures, correct paths, update config. If the fix requires changes outside the codebase (e.g., installing a system dependency), escalate instead of fixing.
- **Example:** Test expects a temp directory that was not created in `beforeEach`.

---

### 3.5 Record the Diagnosis

1. Write a 1-2 sentence description of the root cause. Include:
   - Which decision tree branch was selected (source bug / API change / test bug / environment issue).
   - What specifically is wrong (e.g., "Source bug: `parseConfig()` does not handle empty string input, returns undefined instead of default config").
2. This description will be saved to the ledger's `diagnosis` field.

---

## Step 4: Apply the Fix

1. Make the **minimal** code change needed to fix the failure — do not refactor surrounding code, add features, or "improve" unrelated logic.
2. **Follow CLAUDE.md code conventions strictly** when modifying source code:
   - No `try`/`catch` — use `.catch()` instead.
   - No `any` types — use precise types.
   - No `else` statements — use early returns.
   - Prefer `const` — no `let`; use ternaries or early returns.
   - No unnecessary destructuring — use dot notation (`obj.a` not `const { a } = obj`).
   - Prefer single-word names for variables and functions.
   - Inline single-use values — don't create intermediate variables.
   - Use functional array methods (`flatMap`, `filter`, `map`) over `for` loops.
   - Use Bun APIs where applicable (e.g., `Bun.file()`).
   - Rely on type inference — avoid explicit type annotations unless needed for exports.
3. When fixing **test code**, follow the same conventions but also:
   - Avoid mocks — test actual implementations.
   - Do not duplicate source logic into tests.
   - If the decision tree chose "Test bug", add a `// Fixed: <reason>` comment on the corrected line.
4. Track every file you modify — these paths will be saved to the ledger's `modified_files` field.
5. Record a short description of the fix for the ledger's `fix_applied` field (e.g., "Fixed off-by-one in parseConfig() boundary check").

---

## Step 5: Verify the Fix

1. Run `/test-analyze --file <test-file-path>` targeting the specific test file from the entry.
2. Check the report: does the previously failing test now pass?
3. If **yes** — the fix is verified. Proceed to update the ledger with `status: "fixed"`.
4. If **no** — the test still fails. Proceed to update the ledger with incremented `attempt_count`.

---

## Step 6: Update the Ledger

### If the fix succeeded (test passes):

1. Set the entry's `status` to `"fixed"`.
2. Set `fix_applied` to the description of what was changed.
3. Set `diagnosis` to the root cause description.
4. Set `modified_files` to the list of files that were changed.
5. Update the ledger's `updated_at` to the current ISO 8601 timestamp.

### If the fix failed (test still fails):

1. Increment the entry's `attempt_count` by 1.
2. Set `diagnosis` to the attempted root cause description.
3. If `attempt_count >= max_attempts` (default 3), set `status` to `"escalated"` and `escalation_reason` to the most appropriate reason:
   - `"design_decision"` — Fix requires an architectural choice beyond the agent's scope
   - `"external_dependency"` — Failure depends on an external service or package
   - `"flaky"` — Test passes intermittently / non-deterministic
   - `"circular_regression"` — Fixing this test breaks other tests
   - `"max_attempts_exceeded"` — No clear root cause found after max attempts
   - `"out_of_scope"` — Fix requires changes outside the allowed scope
4. If `attempt_count < max_attempts`, set `status` back to `"discovered"` so it can be retried in a future round.
5. Update the ledger's `updated_at` to the current ISO 8601 timestamp.

---

## Step 7: Regression Check

1. Run `/test-analyze --scope bun` to check for regressions across the full test suite.
2. Compare the new failure list against existing ledger entries.
3. If new failures are found (test names not already in the ledger):
   - Add each as a new entry with `status: "discovered"`, `attempt_count: 0`, `max_attempts: 3`.
   - Assign priority using the same classification rules from `/test-analyze`.
   - Use sequential IDs continuing from the highest existing ID (e.g., if last is `F-012`, new ones start at `F-013`).
4. If no new failures are found, no changes needed.

---

## Step 8: Write Ledger to Disk

1. Serialize the updated ledger to JSON with 2-space indentation.
2. Write the JSON to the `--ledger` path, overwriting the existing file.
3. This must be the **final action** before exiting — no further code changes after this point.

---

## Checklist

Before exiting, verify:

- [ ] Exactly ONE entry was selected and worked on
- [ ] The diagnosis and fix follow CLAUDE.md conventions
- [ ] The fix was verified with a targeted test run
- [ ] The ledger entry was updated with the correct status
- [ ] Regression check was performed
- [ ] Any new failures were added to the ledger
- [ ] The ledger was written to disk as the final action
