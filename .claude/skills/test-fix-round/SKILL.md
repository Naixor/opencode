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
6. **Immediately write the ledger to disk** (flush) so that the driver can
   detect which entry is in-progress if the agent times out before Step 8.
   Write the same format as Step 8 (JSON, 2-space indent). Do not validate
   or do regression checks at this point — this is a checkpoint write only.
7. If no `discovered` entries remain, print `NO_WORK: All ledger entries are terminal (fixed or escalated). Nothing to do.` and exit.

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

After applying the fix in Step 4, run a targeted test to confirm the specific failure is resolved. Do not run the full suite yet — that happens in Step 7.

### 5.1 Run Targeted Test

1. Invoke `/test-analyze --file <test-file-path>` where `<test-file-path>` is the entry's `file` field.
2. Wait for the analysis to complete and produce a Markdown report.
3. If `/test-analyze` itself fails to run (e.g., syntax error in modified code prevents test execution), treat this as a **failed fix** — proceed to Step 6 failure path.

### 5.2 Parse the Verification Report

1. In the report's **Summary** section, read the `fail` count.
2. In the report's **Failure Table**, search for the entry's `test` name (exact match).
3. Determine the outcome:
   - **Fix verified:** The entry's test name does **not** appear in the Failure Table (it now passes).
   - **Fix failed:** The entry's test name **still** appears in the Failure Table (it still fails).
   - **Fix caused new failures in the same file:** The entry's test passes, but other tests in the same file now fail. Treat the fix as **verified** for the original entry, but note the new failures for Step 7.

### 5.3 Collect Modified Files

1. List every file you modified during Step 4 (source files, test files, config files).
2. Use absolute paths relative to the project root (e.g., `packages/opencode/src/foo.ts`, not `./src/foo.ts`).
3. Keep this list for the ledger update in Step 6.

---

## Step 6: Update the Ledger

Update the selected entry based on the verification outcome from Step 5. Exactly one of the two paths below applies.

### 6.1 Success Path — Fix Verified

If the targeted test from Step 5.2 shows the entry's test now passes:

1. Set the entry's `status` to `"fixed"`.
2. Set `fix_applied` to a concise description of what was changed (e.g., `"Added null check in parseConfig() before accessing .name property"`).
3. Set `diagnosis` to the root cause description from Step 3.5.
4. Set `modified_files` to the list of file paths collected in Step 5.3.
5. Update the top-level `updated_at` field to the current ISO 8601 timestamp (e.g., `2026-02-24T14:30:00Z`).

**Example of a fixed entry:**
```json
{
  "id": "F-003",
  "file": "test/security/access_control.test.ts",
  "test": "access control > checkAccess > denies access to paths outside project root",
  "priority": "P1",
  "status": "fixed",
  "attempt_count": 1,
  "max_attempts": 3,
  "diagnosis": "Source bug: checkAccess() did not normalize ../  in paths before matching against rules",
  "fix_applied": "Added path normalization via path.resolve() before rule matching in checkAccess()",
  "escalation_reason": null,
  "modified_files": ["packages/opencode/src/security/access_control.ts"]
}
```

### 6.2 Failure Path — Fix Did Not Work

If the targeted test from Step 5.2 shows the entry's test still fails:

1. Increment the entry's `attempt_count` by 1.
2. Set `diagnosis` to the attempted root cause description from Step 3.5 (preserve it even though the fix didn't work — it provides context for the next attempt).
3. Set `fix_applied` to a description of what was tried, prefixed with `"[FAILED] "` (e.g., `"[FAILED] Tried adding null check in parseConfig()"`).
4. **Check escalation threshold:** compare `attempt_count` against `max_attempts` (default 3):

   **If `attempt_count >= max_attempts` — Escalate:**
   - Set `status` to `"escalated"`.
   - Set `escalation_reason` to the most specific applicable reason:
     - `"design_decision"` — The fix requires an architectural choice or product decision beyond the agent's authority (e.g., "should this function return null or throw?").
     - `"external_dependency"` — The failure depends on an external service, package version, or system configuration that the agent cannot change.
     - `"flaky"` — The test passes intermittently; the failure is non-deterministic (e.g., timing-dependent, random seed).
     - `"circular_regression"` — Fixing this test causes other tests to fail, and fixing those breaks this one again.
     - `"max_attempts_exceeded"` — Use this as the default when none of the above reasons clearly apply.
     - `"out_of_scope"` — The fix requires changes to files, services, or infrastructure outside the allowed scope.
   - Set `modified_files` to the list of files changed (even though the fix failed — this documents what was tried).

   **If `attempt_count < max_attempts` — Retry later:**
   - Set `status` back to `"discovered"` so a future round can pick it up.
   - **Revert the failed fix:** Undo the code changes made in Step 4 so they don't interfere with future attempts or cause regressions. Use `git checkout -- <file>` for each modified file.

5. Update the top-level `updated_at` field to the current ISO 8601 timestamp.

---

## Step 7: Regression Check

After updating the ledger entry, run targeted tests on the files you modified to detect direct regressions. Do **not** run the full suite here — the outer driver runs a full sweep once all failures are resolved. Running the full suite on every fix round is the main cause of per-round timeouts.

### 7.1 Identify Test Files to Check

1. Collect all files from Step 5.3's `modified_files` list.
2. For each file:
   - If it IS a test file (path contains `/test/` or ends in `.test.ts`) → include it directly.
   - If it is a source file (path contains `/src/`) → derive the corresponding test path by replacing `/src/` with `/test/` and appending `.test` before the extension (e.g., `src/foo/bar.ts` → `test/foo/bar.test.ts`). Include it only if the file exists on disk.
3. Always include the current entry's `file` field (the test being fixed).
4. Deduplicate — if the same path appears more than once, only check it once.
5. If the final list is empty, skip to Step 8.

### 7.2 Run Targeted Tests

1. For each file in the list from 7.1, invoke `/test-analyze --file <path>`.
2. Wait for each analysis to complete and produce a Markdown report.
3. If any invocation fails to run, log a warning and continue with the remaining files.

### 7.3 Compare Against Existing Ledger

1. Extract the list of failing test names from all `/test-analyze` reports' Failure Tables.
2. For each failure in the reports, check if a matching entry already exists in the ledger:
   - Match by **both** `file` (test file path) **and** `test` (test name) — both must match.
   - If a match exists, the failure is already tracked — no action needed.
3. Collect any failures that do **not** match existing ledger entries — these are **new regressions**.

### 7.4 Add New Regression Entries

If new regressions were found in Step 7.3:

1. For each new failure, create a new ledger entry:
   - `id`: Sequential ID continuing from the highest existing ID. Parse the numeric suffix from the last entry's ID (e.g., `F-012` → `12`) and increment (e.g., `F-013`, `F-014`, ...).
   - `file`: The test file path from the report.
   - `test`: The full test name from the report.
   - `priority`: Use the priority assigned by `/test-analyze` in its report.
   - `status`: `"discovered"`.
   - `attempt_count`: `0`.
   - `max_attempts`: `3`.
   - `diagnosis`: `null`.
   - `fix_applied`: `null`.
   - `escalation_reason`: `null`.
   - `modified_files`: `[]`.
2. Append the new entries to the ledger's `entries` array.

### 7.5 Handle Circular Regression

If a new failure involves a test that was previously `"fixed"` in the ledger (i.e., an earlier round fixed it, but this round's fix broke it again):

1. Find the previously fixed entry in the ledger.
2. Set its `status` back to `"discovered"`.
3. Increment its `attempt_count` by 1.
4. Append a note to its `diagnosis`: `" [REGRESSION: re-broken by fix to <current-entry-id>]"`.
5. If the current entry's fix is the cause, consider escalating the **current** entry with `escalation_reason: "circular_regression"`.

---

## Step 8: Write Ledger to Disk

This is the **final action** of the round. No code changes, test runs, or other modifications may occur after this step.

### 8.1 Validate Before Writing

1. Verify that every entry in the ledger has all required fields: `id`, `file`, `test`, `priority`, `status`, `attempt_count`, `max_attempts`.
2. Verify that the `status` field of every entry is one of: `"discovered"`, `"attempted"`, `"fixed"`, `"escalated"`.
3. Verify that `escalation_reason` is set for all entries with `status: "escalated"`, and is `null` for all other entries.
4. Verify that `updated_at` has been refreshed to the current timestamp.

### 8.2 Write the File

1. Serialize the full ledger object to JSON with 2-space indentation.
2. Write the JSON to the `--ledger` path, overwriting the existing file.
3. Confirm the write succeeded by reading back the file and verifying it parses as valid JSON.

### 8.3 Print Round Summary

Print a brief summary of what happened this round:

```
ROUND COMPLETE:
  Entry: <id> (<test name>)
  Outcome: <fixed | escalated | retry>
  New regressions: <count>
  Ledger: <fixed-count> fixed, <escalated-count> escalated, <discovered-count> remaining
```

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
