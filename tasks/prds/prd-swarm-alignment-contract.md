# PRD: Swarm Alignment Contract and Approval Gates

## Introduction

The current Swarm system already supports a Conductor, SharedBoard coordination, worker reuse, and a dedicated discussion mode. It does not yet have a clear model for when the system should proceed automatically, when it should pause for user input, and what level of planning the user should explicitly confirm.

This creates two opposite failure modes. The Conductor can interrupt the user too often by asking for approval on every task or worker prompt, or it can move too far on weak assumptions and execute in the wrong direction.

This PRD adds a lightweight alignment model for Swarm execution. The model is built around four ideas:

1. A stable, user-visible role catalog with long-lived confirmation
2. A run contract that captures the direction of one swarm run
3. Risk and confidence gates that decide auto-run vs user check-in
4. Discussion mode used only for real direction-setting choices with trade-offs

The design must fit the current repo architecture. Workers remain `sisyphus` sessions, role differences come from role overlays or perspectives, and the Conductor stays responsible for orchestration rather than asking for approval on every internal step.

## Goals

- Minimize user interruptions while still aligning early enough to avoid expensive wrong turns
- Prevent the Conductor from asking the user to approve every task, prompt, or worker assignment
- Make role selection and role definitions visible to the user at the right level of abstraction
- Keep workers as `sisyphus` sessions and express role differences through overlays or perspectives only
- Introduce a stable role catalog or charter that can be confirmed once and reused across runs
- Introduce a run contract and risk-confidence gates so the system can decide when to auto-run and when to ask
- Restrict discussion mode to decisions with multiple valid options and meaningful trade-offs
- Make the implementation explicit enough for junior engineers and AI agents to build incrementally

## User Stories

### US-001: Stable Role Catalog

**Description:** As a user, I want Swarm roles to come from a stable catalog so I do not need to re-approve the same PM/RD/QA definitions every run.

**Acceptance Criteria:**

- [ ] Add a persisted role catalog for Swarm discussion or planning runs
- [ ] Each role entry has at minimum: `id`, `name`, `purpose`, `perspective`, `default_when`, `version`, `confirmed_at`
- [ ] Role entries are user-visible through an existing or new read path
- [ ] A role can be marked as confirmed for reuse across future runs
- [ ] The stored catalog does not create new worker agent types; it stores only role overlay data
- [ ] Typecheck passes

### US-002: Role Delta Detection

**Description:** As a user, I want the system to ask me only when a run's roles differ meaningfully from my confirmed catalog, so routine runs stay uninterrupted.

**Acceptance Criteria:**

- [ ] Given a requested set of run roles, compare them against the confirmed role catalog
- [ ] Classify each role as one of: `unchanged`, `added`, `removed`, `modified`
- [ ] A `modified` role is triggered only by meaningful field changes such as `purpose` or `perspective`, not timestamp or formatting noise
- [ ] When all roles are `unchanged`, the Conductor may proceed without asking for role confirmation
- [ ] When any role is `added`, `removed`, or `modified`, the system creates a user-visible role delta summary
- [ ] Typecheck passes

### US-003: Run Contract

**Description:** As a user, I want each Swarm run to have a compact contract that states what the system is trying to do, so alignment happens at the direction level instead of at every task.

**Acceptance Criteria:**

- [ ] Define a `RunContract` schema with at minimum: `goal`, `scope`, `constraints`, `roles`, `mode`, `assumptions`, `risks`, `gates`, `discussion_reason`, `created_at`
- [ ] `mode` supports at least `execute` and `discussion`
- [ ] `roles` references catalog entries plus per-run overlay deltas if any
- [ ] The contract is stored for the run and retrievable during orchestration
- [ ] The contract is generated before worker delegation begins
- [ ] Typecheck passes

### US-004: Risk and Confidence Gates

**Description:** As a user, I want the system to use consistent gates for deciding whether to proceed or ask me, so behavior is predictable.

**Acceptance Criteria:**

- [ ] Define four gate levels `G0`, `G1`, `G2`, `G3` or equivalent documented enum values
- [ ] Each gate has explicit semantics:
  - `G0`: safe to auto-run without user interruption
  - `G1`: auto-run with visible contract or summary, no blocking question
  - `G2`: ask user for direction confirmation before execution continues
  - `G3`: ask user because risk is high, ambiguity is material, or action is sensitive
- [ ] Add a gate decision function that consumes run contract inputs such as ambiguity, risk, confidence, role delta status, and action sensitivity
- [ ] Gate decisions are logged or recorded so later debugging can explain why the system asked or proceeded
- [ ] Typecheck passes

### US-005: Conductor Approval Policy

**Description:** As a user, I want the Conductor to avoid asking for approval on every task or worker prompt, so Swarm remains useful and not bureaucratic.

**Acceptance Criteria:**

- [ ] Conductor prompt or strategy documentation explicitly forbids asking the user to approve every task breakdown or every worker prompt
- [ ] Internal worker prompts are generated from the run contract and role overlays without user approval by default
- [ ] User approval is requested only when the gate decision is `G2` or `G3`
- [ ] If the run is `G0` or `G1`, the Conductor proceeds directly to delegation or discussion kickoff
- [ ] Typecheck passes

### US-006: Role Overlay Execution

**Description:** As a developer, I want workers to remain `sisyphus` sessions with role overlays, so the new alignment model fits the current Swarm architecture.

**Acceptance Criteria:**

- [ ] Worker creation continues to use `sisyphus` sessions
- [ ] No new agent type is introduced for PM, RD, QA, or other discussion roles
- [ ] The worker prompt includes the selected role's `name`, `purpose`, and `perspective`
- [ ] Per-run role changes are applied as overlays on top of the stable role catalog entry
- [ ] Existing session reuse behavior remains compatible
- [ ] Typecheck passes

### US-007: Discussion Admission Rules

**Description:** As a user, I want discussion mode to trigger only for real direction-setting questions, so routine execution does not get slowed down by unnecessary debate.

**Acceptance Criteria:**

- [ ] Add explicit criteria for when discussion mode is appropriate
- [ ] Discussion mode is allowed only when at least two primary admission signals are present: multiple valid options, meaningful trade-offs, direction-changing consequences
- [ ] Discussion mode is not used for straightforward implementation tasks with a clearly preferred path
- [ ] The run contract records a `discussion_reason` when discussion mode is used
- [ ] If discussion mode is rejected by the admission rules, the run falls back to normal execution planning
- [ ] Typecheck passes

### US-008: User-Facing Alignment Summary

**Description:** As a user, I want to see one concise alignment summary before higher-risk runs, so I can confirm direction without reviewing every internal detail.

**Acceptance Criteria:**

- [ ] When the gate is `G2` or `G3`, generate a user-facing summary containing: goal, scope, constraints, selected roles, meaningful role deltas, major assumptions, and the proposed next phase
- [ ] The summary avoids raw worker prompts unless explicitly requested
- [ ] The summary makes the ask explicit, such as confirming direction, scope, or role changes
- [ ] The Conductor uses this summary instead of asking piecemeal follow-up questions
- [ ] Typecheck passes

### US-009: Runtime Delta Confirmation

**Description:** As a user, I want to confirm only what changed for this run, so I do not repeatedly review unchanged role definitions.

**Acceptance Criteria:**

- [ ] If the role catalog is already confirmed and the current run only changes one or more role overlays, show only the delta fields
- [ ] If there is no role delta and the gate is below `G2`, no confirmation is required
- [ ] If a role is new or materially changed, the confirmation message clearly identifies that change
- [ ] Confirmation updates the stored role catalog or stored run state as appropriate
- [ ] Typecheck passes

### US-010: Swarm State and API Exposure

**Description:** As a developer, I want alignment state to be inspectable through Swarm state, so the UI and debug flows can explain current behavior.

**Acceptance Criteria:**

- [ ] Swarm state includes the current run contract and current gate level
- [ ] Swarm state includes role delta status and whether user confirmation is pending
- [ ] There is a server-side read path for alignment state suitable for web and CLI consumers
- [ ] Phase-one rollout may delete legacy Swarm runs without alignment metadata instead of preserving compatibility loaders
- [ ] Typecheck passes

### US-011: Web Alignment Panel

**Description:** As a user, I want the web UI to show alignment state clearly, so I can understand why the system proceeded or paused.

**Acceptance Criteria:**

- [ ] Add a web panel or section showing current gate, mode, selected roles, role delta summary, and run contract summary
- [ ] If confirmation is pending, the panel highlights what needs approval
- [ ] If the run is auto-running, the panel explains why, for example `G0` or `G1`
- [ ] The panel does not display raw internal worker prompts by default
- [ ] Typecheck passes
- [ ] Verify in browser using available browser tooling

### US-012: Tests for Gate Decisions

**Description:** As a developer, I want deterministic tests for the gate policy, so future changes do not make Swarm more interruptive or too permissive.

**Acceptance Criteria:**

- [ ] Add tests covering at least:
  - unchanged confirmed roles + low risk => `G0` or `G1`
  - material role delta => `G2`
  - sensitive or high-risk action => `G3`
  - clear single-path task => execution mode, not discussion mode
  - task with at least two primary discussion signals => discussion mode allowed
  - task with fewer than two primary discussion signals => execution mode
- [ ] Tests assert both gate output and whether user confirmation is required
- [ ] Typecheck passes
- [ ] Relevant tests pass from the correct package directory

## Functional Requirements

- FR-1: Swarm roles must come from a persisted role catalog or from an explicit per-run delta on top of catalog entries
- FR-2: Role entries must remain overlay data only; workers continue to use `sisyphus`
- FR-3: The Conductor must not ask the user to approve every task, worker, or worker prompt
- FR-4: Before execution or discussion begins, each run must produce a run contract
- FR-5: Every run contract must include enough information for a junior engineer to understand why the run is happening and how it will proceed
- FR-6: The system must evaluate a gate level before worker delegation starts
- FR-7: Gate level must be derived from explicit inputs, not hidden prompt-only heuristics
- FR-8: If gate level is `G0` or `G1`, the run may continue without blocking on user approval
- FR-9: If gate level is `G2` or `G3`, the run must pause for user confirmation
- FR-10: Meaningful role changes must be shown to the user as deltas, not as a full role re-review every time
- FR-11: Discussion mode must only be used for direction-setting questions with multiple valid options and meaningful trade-offs
- FR-12: Discussion mode must not be the default planning path for ordinary implementation tasks
- FR-13: Alignment state must be inspectable by server, CLI, and web consumers
- FR-14: Alignment decisions must be recorded so debugging can explain why the system auto-ran or asked
- FR-15: Phase one may delete pre-alignment Swarm data during rollout; compatibility with legacy runs is not required

## Non-Goals

- No new worker agent types for PM, RD, QA, or any other role
- No requirement for the user to approve every subtask or every worker prompt
- No worker-to-worker direct messaging outside the existing Swarm communication model
- No automatic role marketplace or role recommendation engine in this phase
- No attempt to solve all orchestration quality problems through discussion mode
- No replacement of existing SharedBoard or session reuse architecture
- No final implementation of weighted voting or role authority scoring in this phase

## Design Considerations

### 1. Align at the right level

The system should align on direction, not on micro-operations. Users care about goals, scope, constraints, and major trade-offs more than the exact wording of a worker prompt.

This means the main confirmation unit should be the run contract plus meaningful role deltas. It should not be a list of every internal action the Conductor plans to take.

### 2. Confirm once, reuse often

Roles influence direction, so they deserve visibility. At the same time, asking for PM/RD/QA approval on every run would become noise.

The role catalog solves this by separating long-lived role charters from per-run deltas. The user confirms the baseline once, then only reviews changes when something materially differs.

### 3. Keep architecture simple

This repo already treats workers as reusable `sisyphus` sessions. The new model should extend that pattern rather than creating specialized role-specific agents.

A role is not a new runtime type. It is a perspective overlay that changes how a `sisyphus` worker evaluates the problem.

### 4. Make discussion mode special

Discussion mode is valuable, but only when there are real trade-offs. If every task turns into a PM/RD/QA debate, the system becomes slow and noisy.

The Conductor should admit a run into discussion mode only when multiple valid paths exist and each path has meaningful product, engineering, quality, or risk implications.

### 5. Make gate behavior predictable

A user should be able to learn the system's interruption behavior. Hidden prompt-only judgment makes that hard to trust.

The gate model should therefore be explicit, documented, and testable. Even if the LLM helps score risk or confidence later, the final policy must remain inspectable and deterministic enough to test.

## Technical Considerations

### Current architecture fit

This PRD should build on existing Swarm primitives instead of replacing them:

- `Swarm.discuss()` and discussion tracking already exist
- SharedBoard tasks, artifacts, and signals already exist
- Worker reuse through `session_id` already exists
- Discussion roles already use `name` and `perspective`
- Workers already remain `sisyphus` sessions

The new work should layer alignment policy on top of these foundations.

### Suggested data model

A minimal implementation can introduce the following persisted shapes:

```ts
type RoleCatalogEntry = {
  id: string
  name: string
  purpose: string
  perspective: string
  default_when: string
  version: number
  confirmed_at?: number
}

type RoleDelta = {
  role_id?: string
  name: string
  change: "unchanged" | "added" | "removed" | "modified"
  fields?: string[]
  overlay?: {
    purpose?: string
    perspective?: string
  }
}

type Gate = "G0" | "G1" | "G2" | "G3"

type RunContract = {
  goal: string
  scope: string
  constraints: string[]
  roles: RoleDelta[]
  mode: "execute" | "discussion"
  assumptions: string[]
  risks: string[]
  discussion_reason?: string
  gate: Gate
  created_at: number
}
```

These names can change, but the concepts should remain.

### Gate decision inputs

The gate decision should consume explicit signals. Phase one should use a deterministic policy with this precedence order:

1. action sensitivity, such as destructive changes, security impact, or permission boundary changes
2. material role delta
3. ambiguity, number of valid approaches, and trade-off strength
4. confidence
5. whether the scope is routine or novel

The implementation can source `confidence` from a bounded LLM estimate, but the final gate mapping must remain deterministic and testable.

The explicit inputs for that policy are:

- role delta present or absent
- task ambiguity low or high
- number of valid approaches
- action sensitivity, such as destructive changes or security impact
- conductor confidence low or high
- whether the scope is routine or novel

A simple scoring model is acceptable in phase one. It is more important that it be understandable, deterministic, and easy to test than sophisticated.

### Discussion admission heuristic

Phase one should treat the first three criteria below as the primary admission signals and require at least two of them to be true:

1. There are multiple valid options
2. The options have meaningful trade-offs
3. The trade-offs change direction, not just implementation detail

The additional signal below is advisory rather than mandatory:

4. A role-based debate is likely to improve the decision

If fewer than two primary signals are present, normal execution mode should be used.

### Prompt and hook integration

The Conductor prompt should be updated so it understands:

- it must generate a run contract first
- it must check role deltas against the catalog
- it must evaluate the gate before starting delegation
- it must not ask for approval on every task or worker prompt
- it should reserve discussion mode for direction-setting questions

Worker prompts should continue to be derived from the role overlay and the contract, not from user-approved raw text.

### Persistence and compatibility

Alignment data should be stored in Swarm-owned persistent state adjacent to swarm metadata. The role catalog should be project-scoped, while role confirmation records should be user-scoped. The implementation should avoid introducing disconnected state that the UI cannot access.

Phase one does not need compatibility loaders for pre-alignment Swarm runs. Legacy runs may be deleted during rollout instead.

### API and UI surface

At minimum, the implementation likely needs:

- a read path for role catalog entries
- a read path for run contract and current gate
- a way to record role confirmation
- a way to record run-level confirmation when `G2` or `G3` is triggered

The web UI does not need to expose every internal object. It only needs enough information to explain direction, deltas, and why the run is paused or auto-running.

### Implementation order

A practical incremental order is:

1. Persisted role catalog
2. Role delta detection
3. Run contract schema and storage
4. Gate policy
5. Conductor policy update
6. Discussion admission logic
7. API exposure
8. Web alignment panel
9. Tests and hardening

This order keeps the risk low and makes each story independently verifiable.

## Success Metrics

- Fewer unnecessary user interruptions during Swarm runs
- Fewer cases where Swarm executes deeply before discovering a direction mismatch
- Role confirmation frequency drops after the initial catalog is established
- Discussion mode is used for a smaller, more intentional set of runs
- Gate decisions are explainable in logs or UI state
- Junior engineers can trace a run from role catalog -> run contract -> gate -> execution behavior without hidden assumptions

## Resolved Implementation Decisions

The following phase-one decisions are resolved and should be reflected in the implementation, tests, and prompt updates.

- **Storage scope:** Store the role catalog in Swarm-owned persistent state as project-scoped data. Store role confirmation records as user-scoped data adjacent to alignment metadata.
- **Meaningful role deltas:** Treat `purpose`, `perspective`, and `default_when` as material changes. Ignore timestamps, formatting-only edits, and other metadata-only noise.
- **Approval writeback:** If a user approves a modified role for a run, automatically write that approved role back to the long-lived catalog. Record enough audit metadata to explain which run and user caused the update.
- **Gate policy:** Use deterministic gate evaluation with explicit precedence: sensitivity > material role delta > ambiguity or valid options or trade-off strength > confidence > routine versus novel scope. LLM input may inform `confidence`, but not replace deterministic mapping.
- **Mid-run escalation:** If a later phase crosses into a higher-risk gate, pause the run, record the new gate state, and require fresh user confirmation before delegation continues.
- **Discussion admission threshold:** Allow discussion mode when at least two of these three primary signals are true: multiple valid options, meaningful trade-offs, direction-changing consequences. Treat likely benefit from role-based debate as a supporting signal rather than a hard requirement.
- **Legacy data:** Phase one may delete pre-alignment Swarm data during rollout instead of supporting compatibility loaders.
- **G1 visibility:** Show a non-blocking alignment summary in both web and CLI. The web UI should show a visible panel or notice, and the CLI should emit a concise summary without asking for confirmation.

## Open Questions

None for phase one. The decisions above are sufficient to begin implementation.

## Implementation Plan

Use the existing Swarm architecture and ship this in small phases. Each phase should leave the system in a usable, testable state before the next one begins.

### Phase 1: Add alignment state models

- Define the phase-one schemas for `RoleCatalogEntry`, `RoleDelta`, `RunContract`, `Gate`, confirmation state, and audit metadata
- Store the role catalog in Swarm-owned persistent state as project-scoped data
- Store confirmation records as user-scoped data next to the alignment state
- Allow rollout code to delete legacy swarm records that do not match the new shape

**Depends on:** none

**Risk:** mixing project-scoped and user-scoped data in one store can make later reads confusing

**Verify:** create one project with multiple users and confirm catalog data is shared while confirmations remain user-specific

### Phase 2: Add role delta detection and approval writeback

- Build a deterministic comparer for requested roles vs confirmed catalog roles
- Treat only `purpose`, `perspective`, and `default_when` as material changes
- Classify each role as `unchanged`, `added`, `removed`, or `modified`
- When a user approves a modified role for a run, write the approved version back into the long-lived catalog
- Record audit fields so the system can explain which run and which user caused the update

**Depends on:** Phase 1

**Risk:** accidental writeback from non-material changes or noisy formatting edits

**Verify:** approve one modified role and confirm the catalog updates, audit metadata is stored, and unchanged roles do not trigger writeback

### Phase 3: Build run contract creation and gate evaluation

- Generate a `RunContract` before any worker delegation starts
- Add deterministic gate evaluation with fixed precedence: sensitivity > material role delta > ambiguity or valid options or trade-off strength > confidence > routine versus novel scope
- Let LLM output inform only the `confidence` input, not the final mapping logic
- Persist the selected gate, inputs used, and a short reason string for debugging
- Treat `G1` as non-blocking but always visible to both web and CLI

**Depends on:** Phase 2

**Risk:** hidden prompt logic leaking into gate behavior and making decisions hard to test

**Verify:** inspect stored state for one `G0`, one `G1`, one `G2`, and one `G3` run and confirm each decision is explainable from explicit inputs

### Phase 4: Add execution pause and discussion admission rules

- Enforce that `G2` and `G3` pause the run until the user confirms
- Add mid-run escalation handling so a later higher-risk decision pauses the run before more delegation happens
- Add discussion admission logic that allows discussion mode only when at least two of the three primary signals are true
- Treat likely benefit from role debate as supporting context only, not a required gate

**Depends on:** Phase 3

**Risk:** letting delegation continue after a higher-risk condition appears mid-run

**Verify:** start a low-risk run, trigger a higher-risk condition later, and confirm the run pauses with the updated gate stored in state

### Phase 5: Expose alignment state in server, CLI, and web

- Add read paths for role catalog, deltas, run contract, gate, pause state, and pending confirmation state
- Add write paths for role approval and run-level confirmation
- Show `G1` summaries in CLI as concise non-blocking output
- Add a visible web alignment panel that shows gate, mode, selected roles, deltas, summary, and pause reason
- Keep raw worker prompts hidden by default

**Depends on:** Phase 4

**Risk:** CLI and web rendering different alignment facts from the same run

**Verify:** compare one active swarm in CLI and web and confirm both surfaces show the same gate, mode, deltas, and pending action

### Phase 6: Update conductor flow and harden rollout

- Update conductor logic so it always creates the contract first, then evaluates the gate, then decides whether to execute, discuss, or pause
- Remove any behavior that asks the user to approve every task breakdown or worker prompt
- Add migration or cleanup code that deletes legacy swarm data during rollout
- Add logging around alignment transitions so regressions are easy to debug

**Depends on:** Phase 5

**Risk:** partial rollout where old runs and new runs coexist with different expectations

**Verify:** run the full swarm flow on a fresh project after cleanup and confirm no legacy loaders are required

## Testing Requirements

- Add unit tests for role delta detection, especially material vs non-material field changes
- Add unit tests for gate precedence to prove sensitivity always wins, role delta outranks ambiguity, and confidence only affects lower-priority branches
- Add unit tests for discussion admission with `0/3`, `1/3`, `2/3`, and `3/3` primary signals
- Add integration tests for approval writeback so run approval updates the catalog and records audit metadata
- Add integration tests for mid-run escalation so the swarm pauses, stores the higher gate, and waits for fresh confirmation
- Add API or state-read tests to confirm alignment data is available to both web and CLI consumers
- Verify the web alignment panel in browser tooling and verify CLI output for `G1` is visible but non-blocking
- Run typecheck plus the relevant package-level test suites for swarm state, conductor flow, and web UI touched by this work
