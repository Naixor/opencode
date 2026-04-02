# PRD: Loop Child Memory Inheritance

## Introduction

Improve `/ultrawork` and `/ralph-loop` child session continuity by inheriting the parent session's already-resolved `<memory>` block instead of recomputing memory injection from scratch for each new loop iteration.

Today, loop iterations already create a fresh child session and do not inherit the parent session's message history. That behavior should stay the same. The problem is that `<memory>` is currently regenerated for the new child session, which can change the injected memory view between iterations, reset recall behavior, and make the same task chain less stable than intended.

This feature keeps session history isolated while making `<memory>` inheritance explicit and deterministic for loop-created child sessions.

This PRD also preserves the current loop startup model: the initial `/ultrawork` or `/ralph-loop` command still begins in the current session, and only later loop-created child sessions participate in this inheritance behavior.

## Goals

- Preserve the current design where loop child sessions do not inherit parent message history.
- Ensure `/ultrawork` and `/ralph-loop` child sessions start with the exact `<memory>` content that was already resolved for the parent session.
- Avoid unnecessary memory re-recall or full-memory reinjection on the first turn of each loop child session.
- Recompute inherited memory only when the existing dirty or re-recall rules say it is necessary.
- Keep the change scoped to loop-created child sessions only.
- Preserve the current first-iteration loop behavior and Oracle verification behavior unless explicitly called out in this PRD.

## User Stories

### US-001: Capture resolved memory for a parent session

**Description:** As a loop system, I want to retain the parent session's resolved `<memory>` payload so that loop-created child sessions can reuse the same memory context.

**Acceptance Criteria:**

- [ ] When a session receives injected memory, the system stores the exact rendered `<memory>` block that was appended to the system prompt for that session.
- [ ] If memory conflicts were injected, the rendered conflict warning block is also stored with the same session.
- [ ] The stored payload reflects the final rendered text shown to the model, not just a list of memory IDs.
- [ ] If no memory was injected for the parent session, the stored payload records that state explicitly so child behavior is deterministic.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-002: Inherit parent memory into loop child sessions

**Description:** As a loop-created child session, I want to start with the parent session's resolved `<memory>` payload so that memory context stays stable across iterations without inheriting message history.

**Acceptance Criteria:**

- [ ] When `/ultrawork` or `/ralph-loop` creates a new child session, the child session receives the parent session's last resolved `<memory>` payload before its first LLM turn.
- [ ] The inherited payload includes both the rendered `<memory>` block and any rendered memory conflict block.
- [ ] The child session does not inherit the parent session's message history.
- [ ] The child session's first LLM turn uses the inherited memory payload instead of recomputing memory injection from the global memory store.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-003: Recompute memory only when normal refresh rules require it

**Description:** As the memory system, I want inherited loop memory to stay active until existing dirty or threshold rules require recomputation so that loop continuity improves without disabling normal memory refresh.

**Acceptance Criteria:**

- [ ] A loop child session uses inherited memory by default on its first LLM turn.
- [ ] The system recomputes memory for that child session only when the memory store becomes dirty or the normal re-recall threshold is reached.
- [ ] If recomputation happens, the child session updates its own stored resolved memory payload for future descendants.
- [ ] Existing non-loop sessions continue using the current memory injection flow.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-004: Preserve current scope boundaries

**Description:** As a maintainer, I want this change to stay narrowly scoped so that we improve loop memory continuity without silently changing unrelated session behavior.

**Acceptance Criteria:**

- [ ] The feature applies only to child sessions created by `/ultrawork` and `/ralph-loop`.
- [ ] The initial session where `/ultrawork` or `/ralph-loop` is invoked does not change behavior as part of this feature.
- [ ] Task tool and subagent-created child sessions do not inherit parent resolved memory as part of this change.
- [ ] Oracle verification sessions do not inherit parent resolved memory as part of this change unless they are later re-scoped by a separate PRD.
- [ ] Manual forks or other child-session flows do not change behavior as part of this change.
- [ ] No new mechanism is introduced that copies task-local work summaries into `<memory>`.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-005: Define deterministic empty-memory behavior

**Description:** As a loop system, I want child sessions to behave predictably when the parent session has no resolved `<memory>` payload so that inheritance does not create ambiguous first-turn behavior.

**Acceptance Criteria:**

- [ ] If a parent session has no resolved `<memory>` payload, the child session follows one explicit documented path rather than implementation-specific fallback behavior.
- [ ] The implementation chooses and documents one of these behaviors: inherit an explicit empty marker, or fall back to the normal injection flow on the child's first turn.
- [ ] The chosen behavior is covered by automated tests.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-006: Verify behavior with automated tests

**Description:** As a developer, I want automated tests for loop memory inheritance so that future changes do not accidentally reintroduce memory recomputation on loop children.

**Acceptance Criteria:**

- [ ] Add a test covering `/ralph-loop` child session creation and verifying inherited rendered `<memory>` on the first child turn.
- [ ] Add a test covering `/ultrawork` child session creation and verifying inherited rendered `<memory>` on the first child turn.
- [ ] Add a test showing loop child sessions do not inherit parent message history.
- [ ] Add a test showing the initial session where `/ultrawork` or `/ralph-loop` is invoked still uses existing behavior.
- [ ] Add a test showing Oracle verification sessions remain on existing behavior and do not inherit parent resolved memory in this change.
- [ ] Add a test showing recomputation occurs only after dirty or threshold conditions are met.
- [ ] Add a test covering the chosen empty-memory behavior.
- [ ] Relevant tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

## Functional Requirements

- FR-1: The system must persist the exact rendered `<memory>` block injected into a session's system prompt.
- FR-2: The system must persist the exact rendered memory conflict block injected into a session's system prompt, when present.
- FR-3: The stored inherited payload must represent rendered text, not only intermediate recall metadata.
- FR-4: When `/ultrawork` creates a loop child session, the child session must inherit the parent session's latest stored rendered memory payload.
- FR-5: When `/ralph-loop` creates a loop child session, the child session must inherit the parent session's latest stored rendered memory payload.
- FR-6: The inherited payload must be applied on the child session's first LLM turn without recomputing memory injection.
- FR-7: Loop child sessions must not inherit the parent session's message history.
- FR-8: After the first child turn, the child session may continue using inherited memory until existing memory dirty-state or re-recall threshold rules require recomputation.
- FR-9: If a child session recomputes memory, the child session must save its newly resolved rendered memory payload for its own future loop descendants.
- FR-10: The initial session where `/ultrawork` or `/ralph-loop` is invoked must keep its current behavior and must not be converted into a fresh inherited-memory child session by this change.
- FR-11: Oracle verification sessions must keep their current behavior and must not inherit parent resolved memory as part of this change.
- FR-12: The feature must not change memory behavior for non-loop sessions.
- FR-13: The feature must not change memory behavior for task tool, subagent, manual fork, or unrelated child-session flows.
- FR-14: The system must behave deterministically when the parent session had no resolved memory payload, including a defined empty-memory case.
- FR-15: The implementation must choose one session-linked storage location for the rendered inherited payload and use that location consistently for capture and child-session handoff.
- FR-16: The system must preserve inherited rendered memory across child turns until normal dirty-state or re-recall rules require recomputation; it must not silently drop inherited memory immediately after the first turn.

## Non-Goals

- Inheriting parent session message history into loop child sessions.
- Expanding this feature to task tool or subagent-created child sessions.
- Changing Oracle verification session behavior.
- Introducing a new task-local memory layer in `<memory>`.
- Changing the global memory extraction rules or memory scoring model.
- Reworking the existing loop temporary memory file or summary flow.

## Design Considerations

- The user-visible behavior should remain conceptually simple: loop iterations feel continuous in memory, but still run in fresh sessions.
- `<memory>` should continue to represent durable remembered context, not transient task notes.
- Task-local progress, failed attempts, and working notes should continue to live in the existing loop memory file or be fetched via tools such as `read`.

## Technical Considerations

- Current memory injection is session-scoped and is recomputed from the memory store for each session.
- Current recall caching is keyed by `sessionID`, so new child sessions start from an empty recall cache unless inheritance is added explicitly.
- The implementation needs one explicit session-linked storage location for the rendered inherited payload so loop code can transfer it when creating a child session.
- The inheritance contract should be explicit: parent resolved payload in, child first-turn system prompt out.
- The implementation should preserve existing refresh behavior instead of creating a second independent memory refresh policy.
- Oracle verification currently uses a separate session path; this PRD keeps that behavior unchanged.
- The implementation must define whether an empty parent payload is represented as an explicit empty marker or by an intentional fallback to normal injection.
- Tests should verify prompt composition behavior, not just metadata writes.

## Success Metrics

- Loop child sessions use the same resolved `<memory>` view as the parent on their first turn in 100% of covered test cases.
- No loop child session recomputes memory on its first turn unless the parent has no stored resolved memory payload.
- Existing non-loop memory injection tests continue to pass without behavior changes.
- Developers can reason about loop continuity without needing parent message history inheritance.
- Developers can reason about first-iteration and Oracle behavior without surprise scope expansion.

## Open Questions

- What is the best storage location for the rendered inherited payload: session metadata, memory subsystem cache with lineage support, or another session-linked store?
- Which empty-memory behavior should be the product decision: explicit empty marker inheritance or fallback to normal first-turn injection?
- Should observability logs show whether a loop child turn used inherited memory or recomputed memory?

## Clarifying Answers Incorporated

- Scope: loop children only.
- Inherited data: rendered `<memory>` block and rendered conflict block.
- Refresh policy: recompute only on dirty state or existing threshold rules.
- Out of scope: no session history inheritance; task-local details remain outside `<memory>`.
- Loop startup behavior: keep the initial `/ultrawork` or `/ralph-loop` session behavior unchanged.
- Oracle behavior: keep Oracle verification sessions on their current behavior in this change.
