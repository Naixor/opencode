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

Use TWO independent extraction methods to count failures, then cross-check with arithmetic and silent-skip checks. If **any** check fails, emit a `COMPLETENESS_WARNING` block at the top of the report.

---

### Source A: Summary Line Extraction

Extract failure count from the bun test summary line. Follow these steps exactly:

1. Search the raw output for the bun test summary line. It appears near the end and matches the pattern:
   ```
   N pass, N fail, N skip, N expect() calls
   ```
   or a subset (e.g., `N pass` only if there are no failures).
2. Extract the integer before `fail` as `source_a_fail`.
3. Also extract the integers for `pass` and `skip` as `source_a_pass` and `source_a_skip`.
4. If the summary line is missing or unparseable, set `source_a_fail = UNKNOWN` and flag for `COMPLETENESS_WARNING`.

---

### Source B: Individual Failure Counting

Independently count failure markers in the raw output. Follow these steps exactly:

1. Count all lines in the raw output that match the pattern `^(fail)` (bun test's individual failure prefix). Use:
   ```
   grep -c '^\(fail\)' <raw-output-file>
   ```
   or equivalent regex search on the captured output.
2. Store the result as `source_b_fail`.
3. If `source_b_fail` differs from `source_a_fail`, this is a discrepancy — flag for `COMPLETENESS_WARNING`.

---

### Arithmetic Check

Verify that the summary numbers are self-consistent:

1. Compute: `computed_total = source_a_pass + source_a_fail + source_a_skip`
2. Compare `computed_total` against the total test count reported in the summary line.
3. If `pass + fail + skip ≠ total`, emit a `COMPLETENESS_WARNING` with the expected vs actual values:
   ```
   COMPLETENESS_WARNING: Arithmetic mismatch — pass(X) + fail(Y) + skip(Z) = W, but total reported as T
   ```

---

### Silent Skip Check

Detect test files that exist on disk but were never executed:

1. List all test files on disk matching `**/*.test.ts` and `**/*.test.tsx` within the relevant test directories (e.g., `packages/opencode/test/`).
2. List all test file paths that appear in the raw test output (look for file paths in pass/fail/skip lines).
3. Compare the two lists. For each on-disk test file **not** present in the output, record it as a silently skipped file.
4. If any files are silently skipped, emit a `COMPLETENESS_WARNING` listing them:
   ```
   COMPLETENESS_WARNING: N test file(s) on disk were not executed:
   - path/to/missed-test.test.ts
   - path/to/another-missed.test.ts
   ```

---

### COMPLETENESS_WARNING Emission

If **any** of the following conditions are true, prepend a `COMPLETENESS_WARNING` block to the very top of the generated report:

- `source_a_fail ≠ source_b_fail` (Source A/B disagreement)
- `source_a_fail = UNKNOWN` (summary line missing or unparseable)
- `pass + fail + skip ≠ total` (arithmetic mismatch)
- Any on-disk test files are absent from the output (silent skips)

The warning block format:

```
> **⚠ COMPLETENESS_WARNING**
>
> Dual verification detected discrepancies:
> - [list each triggered condition with details]
>
> The failure counts in this report may be incomplete. Manual verification is recommended.
```

---

## Step 4: Error Classification

Classify each failure into **exactly one** of the 5 error_type categories below. Scan the error message and stack trace against the patterns in order — use the **first matching** category (higher rows take precedence).

### 4.1 `compile` — Code failed to parse or resolve

Match if the error message or stack trace contains **any** of these patterns:

- `SyntaxError` (any variant)
- `TypeError: <name> is not a function` or `TypeError: <name> is not a constructor`
- `Cannot find module` or `Module not found`
- `Cannot find name` or `is not defined` in a type context
- `import` or `export` paired with `unexpected token`, `not found`, or `does not provide`
- `Cannot resolve` or `Could not resolve`

### 4.2 `runtime` — Code compiled but crashed at runtime

Match if the error message or stack trace contains **any** of these patterns:

- `ReferenceError` (any variant)
- `RangeError` (any variant)
- `TypeError` **not** matching the compile patterns above (e.g., `Cannot read properties of undefined`, `is not iterable`)
- `Unhandled promise rejection` or `UnhandledPromiseRejection`
- `null` or `undefined` paired with access verbs (`read`, `property`, `call`)
- `Maximum call stack size exceeded`

### 4.3 `assertion` — Test expectation did not match

Match if the error message or stack trace contains **any** of these patterns:

- `expect(` or `expect.` (Bun/Jest matchers)
- `AssertionError` or `AssertionError`
- Matcher keywords: `toBe`, `toEqual`, `toMatch`, `toThrow`, `toContain`, `toHaveBeenCalled`, `toHaveLength`, `toStrictEqual`
- `Expected:` / `Received:` diff blocks
- `assert.` (Node.js assert module)

### 4.4 `timeout` — Test exceeded time limit

Match if the error message or stack trace contains **any** of these patterns:

- `timed out` or `Timeout`
- `exceeded timeout` or `exceeded the timeout`
- `SIGTERM` when it appears in a test execution context
- `Test timeout` or `test exceeded`

### 4.5 `environment` — External dependency or OS-level issue

Match if **none** of the above categories match, **or** if the error contains:

- `ENOENT` (file not found)
- `EACCES` or `EPERM` (permission denied)
- `ECONNREFUSED` or `ECONNRESET` (network issues)
- `EADDRINUSE` or `port` paired with `in use` or `already`
- Missing environment variable (`process.env.<VAR>` is `undefined`)
- `ENOMEM`, `EMFILE` (resource exhaustion)

### Precedence Rule

If a failure matches **multiple** categories, apply this precedence order: `compile` > `runtime` > `assertion` > `timeout` > `environment`. Always classify as the highest-precedence match.

---

## Step 5: Priority Assignment

Assign priority P0–P5 based on `error_type` and whether the fault originates in a **source file** or a **test file**:

| Priority | Rule | Rationale |
|----------|------|-----------|
| P0 | `compile` errors where `source_file` is under `src/` | Blocks compilation; likely cascades to many tests |
| P1 | `compile` errors where `source_file` is under `test/` | Only affects the test itself but must be loadable |
| P2 | `runtime` errors where `source_file` is under `src/` | Source code bug causing crashes |
| P3 | `assertion` errors (any location) | Test logic vs source logic mismatch |
| P4 | `timeout` errors (any location) | May be flaky or resource-related |
| P5 | `environment` errors (any location) | External dependency or setup issue |

**Source vs Test distinction:** Inspect the `source_file` field (extracted from the stack trace). If the deepest non-node_modules, non-test frame points to a file under `src/`, it's a source file error. If it points to a file under `test/`, or if `source_file` cannot be determined, treat it as a test file error (use the lower-priority variant for compile/runtime).

### Correlation Grouping

Group multiple failures that share the same root cause to avoid duplicate fix effort:

1. Extract the `source_file` from each failure's stack trace.
2. Group all failures where `source_file` is identical into a **correlation group**.
3. Name each group by its shared `source_file` (e.g., `src/provider/auth.ts`).
4. Within a group, sort failures by priority (P0 first).
5. Assign the group's overall priority as the **highest** (lowest number) priority among its members.
6. Failures with no identifiable `source_file` go into an `ungrouped` bucket.

In the final report, display correlated failures together under a group header so the fixer can address the root cause once.

---

## Step 6: Structured Record Format

For each failure, produce a record with **all** of these fields:

| Field | Type | Description |
|-------|------|-------------|
| `file` | string | Test file path relative to repo root |
| `test` | string | Full test name including `describe` block (e.g., `"describe > test name"`) |
| `error_type` | enum | One of: `compile`, `runtime`, `assertion`, `timeout`, `environment` |
| `error_message` | string | First line of the error (truncated to 200 chars) |
| `stack_trace` | string | Relevant stack frames, max 5 lines, trimmed of node_modules frames |
| `source_file` | string \| null | Source file path from stack trace (deepest non-test, non-node_modules frame), or `null` if not identifiable |
| `source_line` | number \| null | Line number in source_file, or `null` if not identifiable |
| `priority` | enum | One of: `P0`, `P1`, `P2`, `P3`, `P4`, `P5` |

Example record:
```
- file: test/security/access_control.test.ts
- test: checkAccess > rejects paths with null bytes
- error_type: runtime
- error_message: TypeError: Cannot read properties of undefined (reading 'length')
- stack_trace: |
    at resolveSymlink (src/security/symlink.ts:42)
    at checkAccess (src/security/access.ts:18)
    at Object.<anonymous> (test/security/access_control.test.ts:55)
- source_file: src/security/symlink.ts
- source_line: 42
- priority: P2
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
