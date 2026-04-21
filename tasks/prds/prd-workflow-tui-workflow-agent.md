# PRD: Workflow TUI Workflow Agent Visibility

## Introduction

`workflow` mode already produces useful output, but the TUI does not make in-flight progress readable enough during execution. Users can often see text streaming, yet still cannot answer two basic questions quickly: "what step is the workflow on right now" and "what did each agent do so far".

This feature adds a workflow-specific TUI visibility layer for multi-round runs, typically 3-20 rounds. The first release is read-only and focuses on visibility rather than control. Users should be able to understand the current phase, current round, active step, participating agents, completed work, and waiting states without reading raw logs.

The product decision is to support all built-in workflows and external workflows through one versioned rendering schema from day one. Workflows should emit structured progress payloads into a shared contract, and the TUI should render that contract through one merged projection rather than workflow-specific branches.

## Goals

- Let users identify the current workflow phase within 5 seconds
- Let users identify the current round and expected total rounds when available
- Let users see what each agent has done, is doing, or is waiting on
- Make waiting, blocked, retrying, and failed states visibly different
- Support all built-in workflows and external workflows through one versioned rendering schema
- Reduce the need to inspect raw logs to understand workflow progress
- Ship in small phases so value appears before every workflow emits full metadata
- Keep MVP implementation small by reusing existing workflow and task state where possible

## User Stories

### US-001: Show workflow progress header

**Description:** As a user running a workflow, I want a persistent workflow header so that I can immediately understand what is running and where it is now.

**Acceptance Criteria:**

- [ ] When a workflow starts, the TUI shows a dedicated workflow progress header
- [ ] The header displays workflow name, goal or input summary, current status, and start time
- [ ] The header shows current round and max rounds when the workflow is round-based
- [ ] The header shows a deterministic phase label such as `planning`, `role review`, `waiting for decision`, `writing PRD`, or `done`
- [ ] If round information is unavailable, the header shows a stable fallback such as `Round unknown`
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-002: Show current-run step timeline

**Description:** As a user, I want a visible step timeline so that I can tell which workflow steps are done, active, blocked, or still pending.

**Acceptance Criteria:**

- [ ] The TUI renders a step list or timeline for the current workflow run
- [ ] Each step shows one normalized state: pending, active, completed, blocked, failed, or waiting
- [ ] The active step is visually distinct from completed and pending steps
- [ ] Completed steps remain visible until the workflow run ends
- [ ] Failed, blocked, or waiting steps include a one-line reason when available
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-003: Show per-agent activity summary

**Description:** As a user, I want to see each agent's latest contribution so that I can understand progress without reading full transcripts.

**Acceptance Criteria:**

- [ ] The TUI shows one row or card per participating agent for the current workflow run
- [ ] Each agent entry shows role or agent name, current state, latest action summary, and last updated time
- [ ] If an agent is currently running, the UI marks it as active
- [ ] If an agent completed work in the current round, the UI marks it as completed for that round
- [ ] If no activity exists yet for an agent, the UI shows a clear empty state such as `not started`
- [ ] In early rounds, when certainty is low, the latest action summary prefers questions, hypotheses, or next decision points over overstated conclusions
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-004: Show compact round history

**Description:** As a user, I want a compact history of completed rounds so that I can understand how the workflow progressed over time without being flooded by raw output.

**Acceptance Criteria:**

- [ ] The TUI keeps a visible history section for completed rounds in the current workflow run
- [ ] Each round shows round number, status, participating agents, and a short summary of what changed
- [ ] The current round is expanded by default
- [ ] Older completed rounds are collapsed or compacted by default
- [ ] The history retains enough information to answer which agent contributed in each round
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-005: Surface waiting and decision states clearly

**Description:** As a user, I want waiting states to be explicit so that I do not mistake idle time for a broken workflow.

**Acceptance Criteria:**

- [ ] When the workflow is waiting on a user decision, the TUI shows `waiting for user` with the decision topic
- [ ] When the workflow is waiting on background agent work, the TUI shows `waiting for agents` with the relevant step or round
- [ ] When the workflow is retrying, the TUI shows retrying state and which step is being retried
- [ ] Waiting states are visually different from failed states
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-006: Gracefully degrade on partial metadata

**Description:** As a user, I want the TUI to remain understandable even when a workflow emits only partial progress metadata so that older or simpler workflows still render safely.

**Acceptance Criteria:**

- [ ] If a workflow emits only free-text status, the TUI still shows a basic progress panel
- [ ] Missing round, step, or agent data never crashes the TUI
- [ ] Unknown fields are omitted or replaced with stable fallback labels
- [ ] The fallback view still distinguishes `running`, `waiting`, `failed`, and `done`
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-007: Build a unified workflow progress read model

**Description:** As a developer, I want one stable workflow progress read model so that the TUI can render workflow state without reconstructing it from arbitrary transcript text.

**Acceptance Criteria:**

- [ ] The implementation defines a stable internal read model for workflow progress, steps, rounds, and agent activity
- [ ] The read model updates incrementally during a workflow run
- [ ] The read model reuses existing workflow execution state and task state where possible instead of creating a second source of truth
- [ ] The TUI reads from this unified projection instead of parsing transcript text on every paint
- [ ] Typecheck passes

### US-008: Define a versioned rendering schema for built-in and external workflows

**Description:** As a workflow author, I want a stable rendering schema so that built-in and external workflows can light up the same TUI experience without custom UI code.

**Acceptance Criteria:**

- [ ] The implementation defines a documented workflow rendering schema for workflow status, steps, rounds, and agent activity
- [ ] The schema includes an explicit version field from the first release
- [ ] The schema identifies required fields, optional fields, and fallback behavior for missing fields
- [ ] Built-in workflows can emit the schema without per-workflow UI branching
- [ ] External workflows can opt into the schema without modifying TUI code
- [ ] Compatibility guidance explains how older, newer, and partial schema payloads degrade safely in the TUI
- [ ] Typecheck passes

### US-009: Ship the MVP in phased rollout slices

**Description:** As a product team, we want to release visibility improvements in small slices so that users get value early and the rollout risk stays low.

**Acceptance Criteria:**

- [ ] Phase 1 MVP is explicitly defined as header plus active-step visibility plus waiting-state clarity
- [ ] Phase 2 is explicitly defined as per-agent activity summary using structured metadata
- [ ] Phase 3 is explicitly defined as compact round history and richer schema adoption
- [ ] Each phase can ship independently without requiring every workflow to emit the richest metadata
- [ ] The PRD distinguishes must-have MVP scope from post-MVP scope
- [ ] Typecheck passes

## Functional Requirements

1. FR-1: The system must display a workflow-specific progress region in the TUI whenever a workflow run is active.
2. FR-2: The progress region must show workflow identity, current status, current phase, and start time.
3. FR-3: The system must show round progress for workflows that execute in multiple rounds.
4. FR-4: The system must display a visible step list or equivalent progression model for the current run.
5. FR-5: Each visible workflow step must use a normalized status: pending, active, completed, waiting, blocked, or failed.
6. FR-6: The system must show a per-agent summary for agents involved in the current workflow run.
7. FR-7: Each agent summary must include the latest known action or contribution in concise text.
8. FR-8: The system must preserve enough round history for users to understand what changed between rounds.
9. FR-9: The system must explicitly distinguish waiting-for-user, waiting-for-agent, retrying, failed, and completed states.
10. FR-10: The system must gracefully degrade when workflows provide incomplete structured progress information.
11. FR-11: The first release must be read-only and must not add pause, resume, cancel, retry, or manual step-edit controls.
12. FR-12: The rendering model must prefer deterministic workflow metadata and task state over ad hoc parsing of free-text output.
13. FR-13: The system must support all built-in workflows and external workflows through a shared rendering schema rather than workflow-specific UI implementations.
14. FR-14: The schema must allow workflows to emit question-oriented summaries in early rounds when confidence is low.
15. FR-15: The MVP must derive agent contribution summaries from structured workflow or task metadata instead of synthesizing them from raw transcript text.
16. FR-16: The TUI must keep completed round history compact by default so the current round, active step, and active agents remain visible in standard terminal widths.
17. FR-17: The workflow rendering schema must include an explicit schema version from the first release.
18. FR-18: The TUI must degrade safely when it receives an older, newer, or partial schema payload by using documented fallback behavior instead of failing closed.
19. FR-19: The system must use one merged workflow progress projection as the render source for header, timeline, round history, and agent activity.
20. FR-20: The schema and projection must work for both built-in workflows and external workflows without requiring workflow-specific TUI branches.
21. FR-21: The MVP release must ship value before all workflows adopt the full schema by supporting a documented fallback mapping path.
22. FR-22: The MVP scope must prioritize current-step visibility and waiting-state clarity ahead of compact history or richer summaries.

## Non-Goals

- Do not add workflow editing, manual reordering, or operator control actions in the TUI
- Do not redesign the full TUI outside the workflow experience
- Do not require every existing workflow to be rewritten before the feature can ship
- Do not expose full raw transcripts by default as the primary workflow view
- Do not build a separate web admin page for workflow monitoring
- Do not generate AI-written agent summaries from arbitrary transcript output in the MVP
- Do not block MVP on external workflow adoption beyond schema compatibility and docs

## Design Considerations

- The UI should answer three questions first: where the workflow is, who is active, and what changed most recently
- The current round and active step should remain visible while new output streams in
- Per-agent activity should fit common terminal widths without forcing horizontal scanning
- Early rounds should surface open questions and uncertainty clearly rather than implying final conclusions
- The view should emphasize structured status and concise summaries before raw text
- The MVP should ship in phases: header and active-step visibility first, then agent summaries, then compact round history
- The TUI should favor stable labels and compact layouts over decorative complexity so users can scan quickly in terminal widths

## Technical Considerations

- Reuse existing workflow status updates, task metadata, and task results where possible instead of inventing a parallel execution engine
- Introduce a small unified workflow progress projection for the TUI rather than parsing rendered transcript text
- Define one schema contract that built-in and external workflows can emit, with explicit required fields, optional enrichments, and versioning from day one
- Add a fallback mapping layer so older or simpler workflows can still produce a safe basic progress view
- Keep text rendering compatible with existing TUI rendering constraints
- Treat the schema contract as the product boundary: built-in workflow emitters and external workflow docs target the same payload shape
- Keep schema adoption incremental so emitters can start with minimal required fields and add optional fields later

## Release Plan

### Phase 1: MVP Visibility

- Workflow header
- Active step or active phase visibility
- Waiting, retrying, failed, and done state clarity
- Safe fallback rendering for partial metadata

### Phase 2: Agent Visibility

- Per-agent activity summary
- Last updated time and current state per agent
- Early-round summaries that prefer questions and next decisions

### Phase 3: Rich History

- Compact round history
- Improved round summaries
- Broader external workflow adoption of richer schema fields

## Success Metrics

- In user testing, at least 80% of users can correctly identify the current workflow phase within 5 seconds
- In user testing, at least 80% of users can identify which agents contributed in the current round
- Users report fewer cases of mistaking waiting states for hangs or failures
- At least one external workflow adopts the schema and renders without custom TUI code before general release
- The feature ships without breaking older workflows that emit only partial status metadata
- Phase 1 can ship without waiting for every workflow to emit round history or per-agent summary data

## Open Questions

- None at this stage
