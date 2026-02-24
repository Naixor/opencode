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

Follow these sub-steps to identify the root cause:

### 3.1 Read the Failing Test

1. Open the test file at the entry's `file` path.
2. Locate the specific `describe`/`test` block matching the entry's `test` name.
3. Understand what the test is asserting — what behavior does it expect?

### 3.2 Locate the Source

1. If the entry has a `source_file` and `source_line`, open that file and read the relevant code.
2. If no source location is available, use the error message and stack trace to locate the relevant source code.
3. Read surrounding context (the full function/method containing the failure point).

### 3.3 Compare Expected vs Actual

1. Based on the test's assertions and the source code, determine why the test fails.
2. Identify whether the issue is in the source code, the test code, or the environment.

### 3.4 Decision Tree

Classify the root cause and choose the fix strategy:

- **Source bug** — The source code has a defect. Fix the source code.
- **API change** — The source API changed intentionally but the test was not updated. Adapt the test to the new API.
- **Test bug** — The test itself has a logic error (wrong assertion, wrong setup). Fix the test and add a comment explaining the correction.
- **Environment issue** — Missing config, wrong paths, or external dependency. Fix the setup (e.g., add missing fixture, update config path).

Record the diagnosis as a short description (1-2 sentences) to be saved in the ledger's `diagnosis` field.

---

## Step 4: Apply the Fix

1. Make the minimal code change needed to fix the failure.
2. Follow all CLAUDE.md code conventions (no `try`/`catch`, no `any`, no `else`, prefer `const`, etc.).
3. Track every file you modify — these paths will be saved to the ledger's `modified_files` field.
4. Record a short description of the fix for the ledger's `fix_applied` field.

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
