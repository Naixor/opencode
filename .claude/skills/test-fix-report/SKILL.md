---
name: test-fix-report
description: "Generate a final Markdown fix report from the test-fix ledger. Reads the ledger JSON, summarizes fixes and escalations, verifies ledger integrity, and saves the report. Triggers on: test-fix-report, fix report, generate report, test report from ledger."
user-invocable: true
---

# Test Fix Report

Read the test-fix ledger and generate a comprehensive Markdown report summarizing all fixes applied, all failures escalated, and the iteration history.

---

## Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--ledger` | **Yes** | -- | Path to the test-fix ledger JSON file |

---

## The Job

1. **Read the ledger** from the `--ledger` path
2. **Verify ledger integrity** -- confirm all entries are in terminal state
3. **Generate the Markdown report** with all required sections
4. **Save the report** to `tasks/test-fix-report.md`

---

## Step 1: Read the Ledger

1. Read the JSON file at the `--ledger` path.
2. Validate that the file contains valid JSON with the required top-level fields: `session_id`, `created_at`, `updated_at`, `initial_failure_count`, `entries`.
3. If the file is missing or invalid, abort with: `ERROR: Ledger file not found or invalid at <path>`.

---

## Step 2: Verify Ledger Integrity

Perform the following integrity checks before generating the report:

### 2.1 No-Orphan Check

1. Count entries with `status: "discovered"` or `status: "attempted"`.
2. If the count is > 0, log a warning: `WARNING: <N> orphaned entries found (not in terminal state)`.
3. These entries will be listed in a special "Orphaned Entries" section in the report.

### 2.2 Arithmetic Invariant

1. Count entries with `status: "fixed"` -- store as `fixed_count`.
2. Count entries with `status: "escalated"` -- store as `escalated_count`.
3. Read `initial_failure_count` from the ledger top-level field.
4. Compute: `terminal_count = fixed_count + escalated_count`.
5. Compare `terminal_count` against `initial_failure_count`:
   - If `terminal_count == initial_failure_count`: integrity check PASSES (no regressions were added).
   - If `terminal_count > initial_failure_count`: integrity check PASSES with note (regressions were found and tracked).
   - If `terminal_count < initial_failure_count`: integrity check FAILS -- some entries were lost. Log a warning.

### 2.3 Record Integrity Status

Store the integrity result as a string for the report:
- `PASS` -- all entries terminal, arithmetic holds.
- `PASS (with regressions)` -- all entries terminal, new regressions were tracked.
- `FAIL (orphaned entries)` -- non-terminal entries remain.
- `FAIL (missing entries)` -- terminal count < initial_failure_count.

---

## Step 3: Generate Markdown Report

Generate a Markdown document with the following sections **in this exact order**.

---

### 3.1 Summary Section

```markdown
# Test Fix Report

## Summary

| Metric | Value |
|--------|-------|
| **Session** | <session_id> |
| **Started** | <created_at> |
| **Completed** | <updated_at> |
| **Initially Failing** | <initial_failure_count> |
| **Fixed** | <fixed_count> |
| **Escalated** | <escalated_count> |
| **Ledger Integrity** | <PASS or FAIL with details> |
```

Rules:
- `Ledger Integrity` shows the result from Step 2.3.
- If integrity is FAIL, add a blockquote warning immediately below the table:
  ```
  > **WARNING:** Ledger integrity check failed. See details above.
  ```

---

### 3.2 Fixes Applied Section

List every entry with `status: "fixed"`, sorted by ID.

```markdown
## Fixes Applied

| # | ID | Test File | Test Name | Root Cause | Fix Applied | Files Modified |
|---|-----|-----------|-----------|------------|-------------|----------------|
| 1 | F-001 | test/foo.test.ts | describe > test name | Source bug: ... | Fixed null check in ... | src/foo.ts |
| 2 | F-003 | test/bar.test.ts | bar > baz | Test bug: ... | Updated expected value ... | test/bar.test.ts |
```

Rules:
- **Root Cause** uses the entry's `diagnosis` field (truncated to 60 chars in the table).
- **Fix Applied** uses the entry's `fix_applied` field (truncated to 60 chars in the table).
- **Files Modified** lists the entry's `modified_files` array, joined with `, `.
- If there are no fixed entries, display: `No fixes were applied.`
- Distinguish source code fixes from test code fixes by checking if `modified_files` contains paths under `test/` vs `src/`.

---

### 3.3 Escalated Failures Section

List every entry with `status: "escalated"`, sorted by ID.

```markdown
## Escalated Failures (requires human review)

| # | ID | Test File | Test Name | Reason | Diagnosis | Attempts | Suggested Next Steps |
|---|-----|-----------|-----------|--------|-----------|----------|----------------------|
| 1 | F-002 | test/api.test.ts | api > auth | max_attempts_exceeded | Runtime error in auth... | 3 | Check auth provider config |
| 2 | F-005 | test/e2e/login.test.ts | login flow | external_dependency | Requires running API... | 1 | Set up mock API server |
```

Rules:
- **Reason** uses the entry's `escalation_reason` field.
- **Diagnosis** uses the entry's `diagnosis` field (truncated to 60 chars). If null, show `No diagnosis recorded`.
- **Attempts** uses the entry's `attempt_count` field.
- **Suggested Next Steps** -- provide actionable advice based on the escalation reason:
  - `design_decision` -- "Requires team discussion on architectural approach"
  - `external_dependency` -- "Set up mock/stub for the external service"
  - `flaky` -- "Investigate non-deterministic behavior; consider retry or quarantine"
  - `circular_regression` -- "Resolve mutual dependency between the conflicting tests"
  - `max_attempts_exceeded` -- "Manual investigation needed; review diagnosis for context"
  - `out_of_scope` -- "Requires changes outside the allowed scope; coordinate with relevant team"
- If there are no escalated entries, display: `No failures were escalated. All tests are passing!`

---

### 3.4 Iteration History Section

Reconstruct the iteration history from the ledger's entries. Since the ledger doesn't store per-round snapshots, provide a summary based on available data.

```markdown
## Iteration History

| Round | Action | Outcome |
|-------|--------|---------|
| 1 | Attempted F-001 | Fixed |
| 2 | Attempted F-002 | Retry (attempt 1/3) |
| 3 | Attempted F-002 | Retry (attempt 2/3) |
| 4 | Attempted F-002 | Escalated (max_attempts_exceeded) |
| 5 | Attempted F-003 | Fixed |
```

Rules:
- Reconstruct the history from entries' `attempt_count` and final `status` fields.
- For fixed entries with `attempt_count = 1`: show one row `Fixed`.
- For fixed entries with `attempt_count > 1`: show `attempt_count - 1` rows of `Retry` followed by one `Fixed` row.
- For escalated entries: show `attempt_count` rows, last one being `Escalated (<reason>)`.
- If reconstruction is not possible (no attempt data), note: `Detailed iteration history is not available.`
- Number rounds sequentially starting from 1.

---

### 3.5 Changes by File Section

Aggregate all `modified_files` across all fixed entries (deduplicated) and provide a brief description.

```markdown
## Changes by File

| File | Modified By | Description |
|------|-------------|-------------|
| src/foo.ts | F-001 | Fixed null check in parseConfig() |
| src/bar.ts | F-003, F-007 | Fixed return type, added validation |
| test/baz.test.ts | F-005 | Updated expected value after API change |
```

Rules:
- List every unique file path that appears in any entry's `modified_files` array.
- **Modified By** lists all entry IDs that modified this file.
- **Description** concatenates the `fix_applied` descriptions from all entries that modified this file.
- Sort alphabetically by file path.
- If no files were modified, display: `No files were modified.`

---

### 3.6 Orphaned Entries Section (conditional)

Include this section **only** if Step 2.1 found orphaned entries.

```markdown
## Orphaned Entries (WARNING)

The following entries are NOT in a terminal state. This indicates the workflow did not complete properly.

| # | ID | Test File | Test Name | Status | Attempts |
|---|-----|-----------|-----------|--------|----------|
| 1 | F-004 | test/util.test.ts | util > parse | discovered | 0 |
| 2 | F-006 | test/db.test.ts | db > connect | attempted | 2 |
```

Rules:
- List every entry with `status` that is NOT `"fixed"` or `"escalated"`.
- Sort by status (`discovered` first, then `attempted`), then by ID.
- If there are no orphaned entries, omit this entire section.

---

## Step 4: Save the Report

1. Write the generated Markdown to `tasks/test-fix-report.md` (relative to the project root).
2. Confirm the file was written successfully.
3. Print: `Report saved to tasks/test-fix-report.md`

---

## Checklist

Before exiting, verify:

- [ ] Ledger was read and validated successfully
- [ ] Integrity checks were performed (no-orphan, arithmetic)
- [ ] Summary section has correct counts
- [ ] All fixed entries appear in Fixes Applied table
- [ ] All escalated entries appear in Escalated Failures table
- [ ] Iteration history was reconstructed
- [ ] Changes by File lists all modified files
- [ ] Report saved to tasks/test-fix-report.md
