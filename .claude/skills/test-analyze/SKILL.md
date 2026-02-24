---
name: test-analyze
description: "Run tests, parse output, and produce a structured failure report with dual verification. Use when you need to analyze test failures, diagnose broken tests, or generate a failure report. Triggers on: test-analyze, analyze tests, test failures, test report, diagnose tests."
user-invocable: true
---

# Test Analyze

Run the project test suite, parse all output, and produce a structured Markdown failure report with dual-verification to ensure zero failures are missed.

---

## Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--scope` | No | `bun` | Test scope to run: `bun` (unit/integration), `e2e` (end-to-end), `all` (both) |
| `--file` | No | — | Run tests for a single file only (path relative to repo root) |
| `--output` | No | — | Save the raw test output to this file path |

---

## The Job

1. **Run the test suite** based on the provided scope and file arguments
2. **Capture the raw output** (stdout + stderr combined)
3. **Parse the output** to extract every test result
4. **Dual-verify** the failure count using two independent extraction methods
5. **Classify each failure** by error type and assign priority
6. **Generate a structured Markdown report**

---

## Step 1: Run Tests

Based on the `--scope` argument, run the appropriate test command:

- **`bun` (default):** `bun test --cwd packages/opencode`
- **`e2e`:** `bun run --cwd packages/app test:e2e`
- **`all`:** Run both commands sequentially

If `--file` is provided, append the file path to the bun test command:
- `bun test --cwd packages/opencode -- <file>`

Capture ALL stdout and stderr output. If `--output` is provided, save the raw output to that path.

---

## Step 2: Parse Test Output

Extract the following from the raw output:

- **Total test count**
- **Pass count**
- **Fail count**
- **Skip count**
- **Per-test results:** file path, test name, pass/fail/skip status, error message (if any), stack trace (if any)

---

## Step 3: Dual Verification

Use TWO independent methods to count failures and cross-check:

### Source A: Summary Line Extraction
Parse the bun test summary line (e.g., "X pass, Y fail, Z skip") to get the reported fail count.

### Source B: Individual Failure Counting
Count the number of individual test failure blocks in the output (lines matching `^(fail)` or equivalent bun test failure markers).

### Arithmetic Check
Verify: `pass + fail + skip = total`

If the equation does not balance, emit a `COMPLETENESS_WARNING`.

### Silent Skip Check
List all test files on disk matching `**/*.test.ts` and `**/*.test.tsx` in the test directories. Compare against test files that appear in the output. If any on-disk test files are absent from the output, emit a `COMPLETENESS_WARNING` noting the missing files.

If Source A and Source B disagree, or any check fails, prepend `COMPLETENESS_WARNING` to the report with details of the discrepancy.

---

## Step 4: Error Classification

Classify each failure into one of these categories based on the error message and stack trace:

| Error Type | Pattern Match |
|------------|--------------|
| `compile` | `SyntaxError`, `TypeError: ... is not a function`, `Cannot find module`, import/export errors |
| `runtime` | `ReferenceError`, `RangeError`, unhandled promise rejection, null/undefined access |
| `assertion` | `expect(...)`, `AssertionError`, `toBe`, `toEqual`, test matcher failures |
| `timeout` | `timed out`, `exceeded timeout`, `SIGTERM` in test context |
| `environment` | `ENOENT`, `EACCES`, `ECONNREFUSED`, missing env var, port-in-use errors |

---

## Step 5: Priority Assignment

Assign priority P0-P5 based on error type and source location:

| Priority | Rule |
|----------|------|
| P0 | `compile` errors in source files (blocks all other tests) |
| P1 | `compile` errors in test files |
| P2 | `runtime` errors in source files |
| P3 | `assertion` errors (test logic vs source logic mismatch) |
| P4 | `timeout` errors |
| P5 | `environment` errors |

### Correlation Grouping
Group failures that share the same source file (from stack trace) into a single correlation group. This helps identify root causes that affect multiple tests.

---

## Step 6: Structured Record Format

For each failure, produce a record with these fields:

```
- file: <test file path>
- test: <test name / describe block>
- error_type: compile | runtime | assertion | timeout | environment
- error_message: <first line of error>
- stack_trace: <relevant stack frames, max 5 lines>
- source_file: <source file from stack trace, if identifiable>
- source_line: <line number in source file, if identifiable>
- priority: P0 | P1 | P2 | P3 | P4 | P5
```

---

## Step 7: Generate Markdown Report

Output a Markdown report with these sections:

### Summary
```
## Summary

- **Total:** N tests
- **Pass:** N
- **Fail:** N
- **Skip:** N
- **Dual Verification:** PASS | FAIL (details if FAIL)
- **Completeness Warnings:** None | list of warnings
```

### Failure Table (sorted by priority, grouped by correlation)
```
## Failures

| # | Priority | File | Test | Error Type | Error Message | Source |
|---|----------|------|------|------------|---------------|--------|
| 1 | P0 | path/to/test.ts | test name | compile | Cannot find module | src/foo.ts:42 |
```

### Per-File Breakdown
```
## Per-File Breakdown

### path/to/test-file.test.ts (3 failures)
- test name 1: assertion - expected X, got Y
- test name 2: runtime - Cannot read property 'foo'
- test name 3: compile - Missing import
```

### Silent Skip Warnings (if any)
```
## Silent Skip Warnings

The following test files exist on disk but did not appear in test output:
- path/to/missed-test.test.ts
- path/to/another-missed.test.ts
```

### Raw Output Path
```
## Raw Output

Full test output saved to: <path>
```

If `--output` was not specified, note that raw output was not saved.

---

## Checklist

Before finalizing the report, verify:

- [ ] All tests were executed for the requested scope
- [ ] Dual verification was performed (Source A vs Source B)
- [ ] Arithmetic check passed (pass + fail + skip = total)
- [ ] Silent skip check performed (on-disk vs in-output)
- [ ] Every failure is classified with error_type and priority
- [ ] Failures are sorted by priority in the report
- [ ] Correlated failures (same source file) are grouped together
- [ ] Raw output saved if --output was specified
