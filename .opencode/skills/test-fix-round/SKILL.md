---
name: test-fix-round
description: "Run an ultrawork test-fix loop: read the ledger, select the highest-priority unresolved failure, diagnose and fix it, verify it, update the ledger, and continue until all entries are fixed or a blocking escalation stops the run. Use when you need to keep fixing test failures from a ledger. Triggers on: test-fix-round, test-fix-loop, fix test ledger, fix next test, ultrawork test fix."
user-invocable: true
---

# Test Fix Loop

Run an `/ultrawork`-style loop over the ledger. Keep selecting unresolved entries, fixing them, verifying them, updating the ledger, and continuing until the ledger is fully resolved or a blocking escalation stops the run.

---

## Arguments

| Argument   | Required | Default | Description                                                                                           |
| ---------- | -------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `--ledger` | **Yes**  | —       | Path to the test-fix ledger JSON file (must conform to `.claude/schemas/test-fix-ledger.schema.json`) |

---

## Run the loop

1. Read the ledger from `--ledger`.
2. Repeatedly select the highest-priority unresolved entry.
3. Checkpoint the ledger as soon as an entry is claimed.
4. Diagnose the failure, apply the minimal fix, and run build/typecheck plus targeted verification.
5. Update the ledger entry, add regressions back into the ledger, and continue to the next unresolved entry.
6. Finish only when every ledger entry is `fixed`.
7. If any entry becomes `escalated`, treat that as a blocking condition. Stop the loop and report the ledger as blocked, not successful.

The loop is successful only when there are zero unresolved entries and zero escalated entries.

---

## Read the ledger

1. Read the JSON file at the `--ledger` path.
2. Validate that it has the expected top-level fields: `session_id`, `created_at`, `updated_at`, `initial_failure_count`, and `entries`.
3. If the file is missing or invalid, abort with `ERROR: Ledger file not found or invalid at <path>`.
4. Treat `status: "discovered"` and `status: "attempted"` as unresolved work.

---

## Select the next entry

1. Filter entries to unresolved items.
2. Sort by `priority` ascending, then by `attempt_count` ascending.
3. Select the first entry from the sorted list.
4. Set that entry's `status` to `"attempted"`.
5. Immediately write the ledger to disk as a checkpoint before doing diagnosis or edits.
6. If no unresolved entries remain, move to the final completion check instead of doing another iteration.

This checkpoint lets the outer ultrawork driver resume cleanly if the run is interrupted.

---

## Diagnose the failure

Follow the existing ledger discipline for each selected entry.

### Check `.test-failures.json`

1. If `packages/opencode/.test-failures.json` exists, read it first.
2. Match the current entry by `file` and inspect the `error` field.
3. Use that raw bun output to anchor the current failure before reading source.

### Read the failing test

1. Open the test file from the entry's `file` field.
2. Read imports plus any `beforeAll`, `beforeEach`, `afterEach`, or `afterAll` blocks.
3. Find the exact `describe` / `test` / `it` block for the entry's `test` name.
4. Read the assertions and summarize the test's intent in one sentence.

### Locate the source

1. If `source_file` and `source_line` exist, read the surrounding function there.
2. Otherwise, use the first non-test, non-library frame from `stack_trace`.
3. If neither exists, infer the target module from the test imports and read the function under test.
4. Read one level of related internal calls when needed.

### Compare expected and actual

1. Extract the actual behavior from `error_message` or the raw test output.
2. Trace the code path for the test inputs.
3. Identify where behavior diverges from the expectation.
4. Choose one root cause branch: source bug, API change, test bug, or environment issue.

### Record the diagnosis

1. Write a 1-2 sentence diagnosis for the ledger.
2. State both the root cause category and the concrete problem.

---

## Apply the fix

1. Make the smallest change that addresses the diagnosed failure.
2. Follow repo conventions strictly when editing source or tests.
3. Avoid unrelated refactors, broad cleanup, or speculative improvements.
4. Track every modified file for the ledger's `modified_files` field.
5. Record a short `fix_applied` note describing what changed.

When the root cause is a test bug, add a `// Fixed: <reason>` comment on the corrected line.

---

## Verify the change

Use targeted verification inside the loop. Do not run a full-suite sweep after every single iteration unless the current situation clearly requires it.

### Run build and typecheck

1. Invoke `/build-verify --scope typecheck` first.
2. If it fails, treat the attempt as a failed fix and update the ledger accordingly.

### Run the targeted test

1. Invoke `/test-analyze --file <test-file-path>` for the current entry's file.
2. Confirm whether the target test still appears in the failure table.
3. If the target test passes but other tests in the same file fail, count the original entry as verified and handle the other failures as regressions.

### Collect modified files

1. Keep the list of every file changed during the iteration.
2. Store paths relative to the project root.

---

## Update the ledger

### Mark a verified fix

If the target test now passes:

1. Set the entry's `status` to `"fixed"`.
2. Save `diagnosis`, `fix_applied`, and `modified_files`.
3. Refresh the top-level `updated_at` timestamp.

### Handle a failed attempt

If the target test still fails or verification cannot run cleanly:

1. Increment `attempt_count`.
2. Preserve the attempted `diagnosis`.
3. Prefix `fix_applied` with `[FAILED] `.
4. If `attempt_count >= max_attempts`, set `status` to `"escalated"` and record the most specific `escalation_reason`.
5. If attempts remain, set `status` back to `"discovered"` and revert the failed code changes before continuing.
6. Refresh the top-level `updated_at` timestamp.

An `escalated` entry is not a win condition. It blocks final success and should stop the ultrawork loop for human review unless the caller explicitly wants to continue collecting more blocked items.

---

## Check regressions

1. Build a targeted regression list from `modified_files` plus the current entry's test file.
2. Run `/test-analyze --file <path>` for those files.
3. Compare new failures against existing ledger entries by both `file` and `test`.
4. Add unmatched failures as new `discovered` entries with fresh IDs.
5. If a previously `fixed` entry breaks again, move it back to `"discovered"`, increment its `attempt_count`, and note the regression source.

Targeted regression checks happen during the loop. Use a broader sweep near the end of the ultrawork run, or when targeted checks suggest wider fallout.

---

## Continue iterating

After each iteration:

1. Validate the ledger structure and write it back to `--ledger` with 2-space indentation.
2. Print a short iteration summary with the entry ID, outcome, regressions added, and remaining unresolved count.
3. Re-read the ledger state if needed, then select the next unresolved entry.
4. Keep looping until one of the end conditions is reached.

Do not treat a single fixed entry as completion. The skill owns the whole ledger until it is resolved or blocked.

---

## Finish correctly

Before exiting the ultrawork loop, evaluate the whole ledger.

### Succeed

Complete successfully only when all entries are `fixed`.

1. Confirm there are no `discovered` entries.
2. Confirm there are no `attempted` entries.
3. Confirm there are no `escalated` entries.
4. Run a broader verification sweep if the loop has accumulated enough changes that targeted checks are no longer sufficient.

### Block

Stop as blocked when any entry is `escalated`.

1. Leave the escalated entry in the ledger.
2. Explain why it is blocked and cite the `escalation_reason`.
3. Report that the ledger is not fully resolved.
4. Do not claim success just because no more safe iterations remain.

---

## Checklist

- [ ] The ledger was read from `--ledger`
- [ ] Each claimed entry was checkpointed before diagnosis work
- [ ] Every iteration ran build/typecheck plus targeted verification
- [ ] Regressions were added back into the ledger when discovered
- [ ] The loop continued through unresolved entries instead of stopping after one fix
- [ ] Final success was declared only when every entry was `fixed`
- [ ] Any `escalated` entry was treated as a blocking condition
