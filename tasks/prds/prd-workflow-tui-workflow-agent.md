# PRD: Workflow State Machine

## Introduction

The current workflow TUI improves visibility, but it still depends too much on reading streamed text and inferred progress. Users can see activity, yet still struggle to answer where the workflow is, who is active, what changed, and whether the run is waiting, blocked, retrying, or failed.

This PRD re-centers the feature on a step-based state machine. The workflow runtime owns explicit step runs and transitions, and the TUI renders a stable projection of that state instead of reconstructing meaning from transcript text or drawing an abstract graph directly.

One shared contract must serve built-in workflows and external workflows. The contract should be product-friendly for workflow authors, stable for the TUI, and specific enough that users get fast, trustworthy answers during execution.

---

## Goals

- Let users identify the active path within 5 seconds
- Show which step is active, which steps already completed, and what caused the latest transition
- Show who is currently working, waiting, blocked, retrying, or done
- Make waiting, decision, blocked, failed, and terminal states visibly distinct
- Support rounds, retries, and parallel work without losing scanability in terminal widths
- Give built-in and external workflows one shared progress contract
- Keep the first release read-only and focused on understanding, not control

---

## Product principles

- Model workflow progress as a state machine, not as free-form narration
- Render a projection of current state, not the full workflow graph
- Keep the TUI layout stable so users always know where to look
- Favor explicit transition records over inferred summaries
- Use the same contract for built-in and external workflows
- Degrade safely when only partial metadata is available

---

## User stories

### US-001: Define workflow-progress v2 schema

**Description:** As a workflow author, I want a versioned workflow progress schema so built-in and external workflows can emit one shared state-machine contract. The schema should make step structure, step runs, transitions, and projection fields explicit so the TUI does not need workflow-specific parsing.

**Acceptance Criteria:**

- [ ] The implementation defines `workflow-progress.v2` as a versioned workflow progress contract
- [ ] The contract includes workflow metadata, machine metadata, step definitions, step run instances, and transition records
- [ ] Step definitions support `task`, `group`, `wait`, `decision`, and `terminal` kinds
- [ ] Step run instances support statuses such as pending, active, waiting, blocked, retrying, completed, and failed
- [ ] The contract supports round and retry metadata without overwriting prior step run history
- [ ] Existing `workflow-progress.v1` payloads remain supported during migration
- [ ] Typecheck passes

### US-002: Build a runtime projection reducer

**Description:** As a TUI developer, I want the runtime to reduce workflow state into one stable projection so the TUI can render a simple read model. This projection should hide state-machine complexity while preserving enough detail to explain where the workflow is and what changed.

**Acceptance Criteria:**

- [ ] The runtime can derive a stable projection from workflow progress data without parsing transcript text on each paint
- [ ] The projection exposes stable regions for header, timeline, agents, history, and alerts
- [ ] The projection can surface the latest meaningful transition that changed workflow or step status
- [ ] Missing step, transition, round, or agent fields degrade safely to a simpler projection instead of crashing the TUI
- [ ] Typecheck passes

### US-003: Render workflow header and active-path timeline

**Description:** As a user running a workflow, I want the TUI to show the current workflow state and active path so I can understand progress quickly. The timeline should focus on the chosen execution path instead of trying to draw the full workflow graph.

**Acceptance Criteria:**

- [ ] When a workflow is active, the TUI shows a stable header with workflow name, goal or input summary, overall status, current phase, and start time when available
- [ ] The TUI renders a timeline from the runtime projection rather than reconstructing state from free-text output
- [ ] The timeline highlights the active step run and keeps completed path steps visible
- [ ] Pending branches that are not part of the current active path are omitted or de-emphasized in MVP
- [ ] Group steps can render nested child steps when the active path enters parallel work
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-004: Render agents, history, and alerts

**Description:** As a user, I want to know who is active, what changed recently, and whether the workflow is waiting or blocked so I can trust the run. The TUI should answer these questions without making me read raw logs.

**Acceptance Criteria:**

- [ ] The agents region shows participating agents or roles, current state, and latest action summary
- [ ] The history region shows recent transitions and compact round summaries when round metadata exists
- [ ] The alerts region clearly distinguishes waiting, blocked, retrying, failed, and terminal signals
- [ ] Waiting-for-user and waiting-for-agent states show the relevant topic or reason when available
- [ ] The latest meaningful change is visible without reading raw transcripts
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-005: Migrate the implement workflow to v2 progress emission

**Description:** As a developer, I want one real workflow to emit the new contract end to end so the runtime and TUI can be validated against production-like behavior. The `implement` workflow should become the reference emitter for grouped review steps, rounds, retries, and final verification.

**Acceptance Criteria:**

- [ ] `.opencode/workflows/implement.ts` emits `workflow-progress.v2` data during execution
- [ ] The emitted data covers at least convert, story selection, implement or fix, review group, review gate, final verify, final fix when needed, and retrospective or done
- [ ] Review work can emit grouped parallel child steps for reviewer and test activity
- [ ] Repair rounds and final verification retries produce distinct step run instances instead of overwriting prior runs
- [ ] Typecheck passes

### US-006: Document fallback and external workflow adoption

**Description:** As a workflow author, I want clear migration and fallback guidance so I can adopt the contract incrementally. Older or partial workflows should still render safely while richer workflows get the full TUI experience.

**Acceptance Criteria:**

- [ ] Documentation explains how built-in and external workflows emit the shared contract
- [ ] Documentation explains how `workflow-progress.v1`, `workflow-progress.v2`, and partial metadata degrade safely in the TUI
- [ ] At least one documented example shows how a workflow emits step definitions, step runs, and transitions without workflow-specific TUI code
- [ ] The implementation preserves safe fallback rendering for workflows that have not adopted the full v2 schema
- [ ] Typecheck passes

---

## Functional requirements

1. FR-1: The system must model each workflow execution as a step-based state machine.
2. FR-2: The state machine must distinguish step definitions from step run instances.
3. FR-3: The system must record explicit transition events for workflow-level and step-level state changes.
4. FR-4: The transition record must support timestamp, from-state, to-state, reason, and source when available.
5. FR-5: The model must support step kinds for standard work, parallel group, wait, decision, and terminal states.
6. FR-6: The model must support grouped steps for parallel execution.
7. FR-7: The model must support rounds and retries without losing prior run history.
8. FR-8: The TUI must render a projection of the state machine rather than a full abstract graph.
9. FR-9: The projection must expose stable regions for header, timeline, agents, history, and alerts.
10. FR-10: The header must show workflow identity, overall status, current phase label, and start time.
11. FR-11: The timeline must show the active path, active step run, completed path steps, and current waiting or blocked state.
12. FR-12: The agents region must show participating agents or roles, current state, and latest action summary.
13. FR-13: The history region must show recent transitions and compact round summaries.
14. FR-14: The alerts region must surface waiting, blocked, retrying, failed, and terminal signals distinctly.
15. FR-15: The MVP must prefer active-path rendering over full-graph rendering.
16. FR-16: The MVP must be read-only and must not add pause, resume, cancel, retry, or manual step controls.
17. FR-17: The TUI must read from a stable projection-first view model instead of reconstructing workflow state from transcript text.
18. FR-18: The contract must support both built-in and external workflows through one versioned schema.
19. FR-19: The TUI must degrade safely when some step, transition, round, or agent metadata is missing.
20. FR-20: The fallback view must still distinguish running, waiting, blocked, failed, and done.
21. FR-21: The system must preserve enough data for users to answer where the workflow is, who is active, what changed, and whether it is blocked.

---

## Non-goals

- Do not add workflow editing or operator controls in this release
- Do not render the entire workflow graph as the primary TUI view
- Do not depend on transcript parsing as the main source of truth
- Do not require every workflow to adopt the richest schema before MVP ships
- Do not build a separate monitoring product outside the existing TUI

---

## Technical considerations

- Treat the state machine as the source of truth and the TUI projection as a read model derived from it
- Keep the projection stable so TUI components read a single view model instead of inferring state from message text
- Use explicit step definitions for structure and step runs for execution history
- Record transitions directly so history, alerts, and round summaries can be generated from durable events
- Model parallel work as grouped steps rather than disconnected visual branches
- Support wait, decision, and terminal step kinds as first-class concepts instead of UI-only labels
- Keep active-path rendering small and fast for terminal use, even when the underlying workflow graph is larger
- Define one schema boundary for built-in and external workflows, with versioning and documented fallback behavior from day one
- Reuse existing workflow execution state where practical, but do not make the TUI reconstruct progress from raw transcript output

---

## Release plan

### Phase 1: Schema and projection foundation

- Deliver `US-001` and `US-002`
- Lock the shared `workflow-progress.v2` contract and runtime projection reducer
- Preserve safe fallback behavior for `workflow-progress.v1` and partial metadata

### Phase 2: Core TUI workflow rendering

- Deliver `US-003` and `US-004`
- Ship workflow header, active-path timeline, agents, history, and alerts in stable TUI regions
- Make waiting, blocked, retrying, failed, and terminal states easy to distinguish in terminal widths

### Phase 3: Real workflow adoption and external guidance

- Deliver `US-005` and `US-006`
- Migrate the `implement` workflow as the first full v2 emitter
- Publish migration guidance and examples for built-in and external workflow authors

---

## Success metrics

- In user testing, at least 80% of users can identify the active path within 5 seconds
- In user testing, at least 80% of users can identify who is active and what changed most recently
- Users report fewer false hang reports during waiting and retry states
- At least one external workflow adopts the shared contract without custom TUI code before general release
- MVP ships without requiring full-graph rendering or transcript-based reconstruction

---

## Open questions

- None at this stage
