---
name: build-verify
description: "Run typecheck and build, extract only errors, and return a concise pass/fail report. Use before tests to catch compile/resolve errors early. Triggers on: build-verify, verify build, check build, typecheck."
user-invocable: true
---

# Build Verify

Run typecheck and build for the project, capture only error output, and return a concise structured report. This catches compile/resolve errors early — before spending time on tests.

---

## Arguments

| Argument   | Required | Default | Description                                             |
| ---------- | -------- | ------- | ------------------------------------------------------- |
| `--scope`  | No       | `all`   | What to verify: `typecheck`, `build`, `all` (both)      |
| `--single` | No       | false   | Pass `--single` to build script (current platform only) |

---

## The Job

1. **Run typecheck** (unless `--scope build`)
2. **Run build** (unless `--scope typecheck`)
3. **Extract errors only** from raw output — discard success lines
4. **Return a concise report** to the caller

---

## Step 1: Run Typecheck

If scope is `typecheck` or `all`:

```bash
bun run --cwd packages/opencode typecheck 2>&1
```

Capture the exit code and full output.

### Error Extraction

Typecheck (tsgo) output can be very large. Extract only error-relevant lines:

1. Lines matching `error TS\d+:` — these are TypeScript errors
2. The file path + line number that precedes each error (format: `path(line,col): error TS...`)
3. If zero errors, record `typecheck: PASS`
4. If errors found, record `typecheck: FAIL` with error count and the extracted error lines

Discard all non-error output (progress indicators, file lists, etc.).

---

## Step 2: Run Build

If scope is `build` or `all`:

```bash
bun run --cwd packages/opencode build [--single] 2>&1
```

Capture the exit code and full output.

### Error Extraction

Build output contains per-target status lines (`building lark-opencode-linux-arm64`, etc.) and may contain errors. Extract only:

1. Lines containing `error:` — Bun build errors
2. Lines containing `Could not resolve:` — module resolution failures
3. The 2 lines above each error line for context (file path, import line)
4. If exit code is 0, record `build: PASS`
5. If exit code is non-zero, record `build: FAIL` with error count and the extracted error lines

Discard all `building ...` progress lines and successful target output.

---

## Step 3: Generate Report

Output a concise structured report. The report is designed to be short — a caller (like sisyphus or test-analyze) should be able to read it without being overwhelmed.

### All Pass

```
BUILD-VERIFY: PASS
  typecheck: PASS
  build: PASS (N targets)
```

### Failures

```
BUILD-VERIFY: FAIL

## Typecheck: FAIL (N errors)

path/to/file.ts(line,col): error TS2345: Argument of type 'X' is not assignable...
path/to/file.ts(line,col): error TS2307: Cannot find module 'X'...
[... only error lines, max 50 ...]

## Build: FAIL (N errors)

error: Could not resolve: "./cli/cmd/log-viewer"
    at /path/to/file.ts:40:34

[... only error lines with context, max 50 ...]
```

### Rules

- **Max 50 error lines** per section. If more, append: `... and N more errors (truncated)`
- **No success output** — do not include `building ...` lines, file counts, or timing unless there's an error
- **Exit code summary** — always include whether each step passed or failed
- **Error dedup** — if the same error appears for multiple build targets, show it once with a note: `(repeated across N targets)`
- The report MUST fit in a single screen — if the caller is a subagent reporting back, only errors matter

---

## Checklist

Before finalizing the report, verify:

- [ ] Typecheck was run (if scope includes it)
- [ ] Build was run (if scope includes it)
- [ ] Only error lines are included in the report
- [ ] Error count matches the actual extracted errors
- [ ] Report is concise — no progress/success noise
