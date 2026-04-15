# PRD: Hindsight Local Memory Companion Integration

## Introduction

This feature adds a local Hindsight companion to the existing OpenCode memory system to improve memory extraction and memory recall quality without replacing the current local JSON-backed authority.

The problem today is not that OpenCode lacks a memory system. The problem is that the current system relies on local filtering and prompt-based selection, so it can miss relevant context during extraction and can rank recall candidates less accurately than a semantic retrieval layer.

This PRD defines an implementation-ready phase 1 plan with explicit technical choices:

1. OpenCode local memory remains the authoritative source of truth for lifecycle state, storage, and prompt injection eligibility.
2. Hindsight runs in local embedded mode only.
3. The default implementation path uses `@vectorize-io/hindsight-all` and `@vectorize-io/hindsight-client`.
4. Initial delivery includes `recall`, `extract`, and `backfill`.
5. Hindsight data is isolated per worktree by default.
6. Recall uses Hindsight ranking and OpenCode passes resolved authoritative local memories into `memory-recall` for final selection.

This is a companion integration, not a source-of-truth replacement.

For deeper implementation detail and architecture rationale, see `tasks/prds/tech-hindsight-local-memory-integration.md`.

## Goals

- Improve recall relevance by ranking local memory candidates with Hindsight before prompt injection.
- Improve extraction quality by retaining conversation slices and using Hindsight-derived context during memory extraction.
- Keep all memory data local-first and private, with no remote SaaS dependency.
- Preserve current lifecycle features such as `status`, `score`, `useCount`, `hitCount`, confirmation, decay, and existing memory UI behavior.
- Make the integration safe to enable, safe to disable, and safe to retry after failure.
- Support idempotent backfill of existing local memories into Hindsight.
- Provide enough logs and structured state to debug startup, query, retain, resolve, and backfill behavior.

## User Stories

### US-001: Add Hindsight config and feature gating

**Description:** As a maintainer, I want explicit config for Hindsight so that rollout is controlled and fallback behavior is predictable.

**Acceptance Criteria:**

- [ ] Add `memory.hindsight` config in `packages/opencode/src/config/config.ts`.
- [ ] Config includes at minimum `enabled`, `mode`, `extract`, `recall`, `backfill`, `workspace_scope`, `bank_prefix`, `startup_timeout_ms`, `query_timeout_ms`, `retain_limit`, `recall_limit`, `observation_limit`, `context_max_items`, `context_max_tokens`, and `log_level`.
- [ ] `mode` only allows `embedded` in phase 1.
- [ ] Default values are `enabled: false`, `mode: "embedded"`, `extract: true`, `recall: true`, `backfill: true`, `workspace_scope: "worktree"`, `context_max_items: 6`, and `context_max_tokens: 1200`.
- [ ] Invalid config fails during parsing instead of failing later at runtime.
- [ ] If `enabled: false`, memory behavior matches current behavior.
- [ ] Typecheck passes.

### US-002: Start and manage the local embedded Hindsight service

**Description:** As a user, I want Hindsight to run locally on demand so that semantic retrieval works without a cloud dependency.

**Acceptance Criteria:**

- [ ] Add a workspace-scoped service layer under `packages/opencode/src/memory/hindsight/`.
- [ ] The default implementation uses `@vectorize-io/hindsight-all` plus `@vectorize-io/hindsight-client`.
- [ ] The service starts lazily on first use and binds only to loopback, such as `127.0.0.1`.
- [ ] The same worktree reuses one in-process service handle instead of starting duplicate daemons.
- [ ] Health check, ready state, degraded state, and shutdown paths are implemented.
- [ ] Startup timeout and health timeout use config values.
- [ ] If startup or health check fails, OpenCode falls back to existing memory behavior without crashing the session.
- [ ] Build passes.
- [ ] Typecheck passes.

### US-003: Define stable bank identity and stable document ids

**Description:** As a developer, I want deterministic bank and document ids so that retain, recall, and backfill are idempotent.

**Acceptance Criteria:**

- [ ] Default bank scope is worktree-based, not project-wide global state.
- [ ] Bank id format is deterministic, for example `opencode:${worktreeHash}`.
- [ ] Local memory documents use a stable id format such as `mem:${worktreeHash}:${memoryId}`.
- [ ] Session slice documents use a stable id format such as `sess:${worktreeHash}:${sessionId}:${start}:${end}`.
- [ ] Observation documents use a stable id format such as `obs:${worktreeHash}:${sessionId}:${hash}`.
- [ ] Mapping functions reject cross-worktree hits during resolve.
- [ ] Re-retaining the same source updates the same Hindsight document instead of creating uncontrolled duplicates.
- [ ] Typecheck passes.
- [ ] Targeted mapping tests pass.

### US-004: Retain local memory and session slices into one worktree bank

**Description:** As a developer, I want memory records and conversation slices retained into Hindsight so that recall and extraction can use richer local context.

**Acceptance Criteria:**

- [ ] Use one Hindsight bank per worktree.
- [ ] Phase 1 does not split data into separate banks for `world`, `experience`, and `observation`.
- [ ] Retain items include string-only metadata fields at minimum for `workspace_id`, `project_root`, `session_id`, `memory_id`, `source_kind`, `created_at`, and `updated_at` when available.
- [ ] Categories and tags are normalized into Hindsight tags.
- [ ] Session slices are retained before or during extract flow.
- [ ] Authoritative local memories are retained after create or update, and during backfill.
- [ ] Retain failures are logged and do not block local memory writes.
- [ ] Typecheck passes.
- [ ] Relevant retain tests pass.

### US-005: Use Hindsight for recall ranking and `memory-recall` final selection

**Description:** As a user, I want more relevant memories injected into prompts so that the assistant remembers the right context more often.

**Acceptance Criteria:**

- [ ] `packages/opencode/src/memory/engine/recall.ts` queries Hindsight when `memory.hindsight.enabled` and `memory.hindsight.recall` are both true.
- [ ] Recall hits are resolved back to local authoritative memory ids using `document_id` first and `metadata.memory_id` as fallback.
- [ ] Only `mem:` documents can resolve directly into injected local memories.
- [ ] `sess:` and `obs:` hits are treated as ranking evidence only and are never injected directly.
- [ ] After resolve, OpenCode passes the ranked authoritative local memory candidates into the current `memory-recall` path for final selection instead of directly injecting top-k results.
- [ ] Hindsight raw relevance score and ranking order are both preserved as input signals to `memory-recall`.
- [ ] Missing, stale, or cross-worktree hits are dropped safely.
- [ ] On timeout, startup failure, or query failure, recall falls back to current behavior.
- [ ] Logs record hit count, resolved count, stale count, and fallback reason.
- [ ] Typecheck passes.
- [ ] Relevant recall tests pass.

### US-006: Use Hindsight context during memory extraction

**Description:** As a user, I want extraction to use semantically related context so that the system creates better new memories and updates existing ones more accurately.

**Acceptance Criteria:**

- [ ] `packages/opencode/src/memory/engine/extractor.ts` routes to a Hindsight-aware extraction path when `memory.hindsight.extract` is enabled.
- [ ] Extract flow retains the current session slice before or alongside context query.
- [ ] The Hindsight-assisted path aligns with the current `memory-extractor` contract by using a dedicated Hindsight-aware extractor variant, not an unbounded append-only prompt change.
- [ ] The Hindsight-aware extractor receives a bounded `Hindsight context` section with ranked related documents or structured observations.
- [ ] Hindsight context budget remains configurable through both `context_max_items` and `context_max_tokens` so prompt size stays bounded.
- [ ] Phase 1 default extractor context budget is `context_max_items: 6` and `context_max_tokens: 1200`.
- [ ] Local memory creation and update still go through current authoritative paths such as `Memory.create()` and `Memory.update()`.
- [ ] If Hindsight returns no results, times out, or fails to parse, extraction continues without the Hindsight section.
- [ ] Logs record whether Hindsight context was used and how many context items were supplied.
- [ ] Typecheck passes.
- [ ] Relevant extraction tests pass.

### US-007: Backfill existing local memories into Hindsight with resumable state

**Description:** As an existing user, I want old memories imported into Hindsight so that semantic recall is useful immediately after enablement.

**Acceptance Criteria:**

- [ ] Backfill reads existing local memories from the current authoritative store.
- [ ] Each local memory is retained with a stable `mem:` document id.
- [ ] Backfill uses idempotent upsert behavior, such as `update_mode: "replace"`.
- [ ] Backfill persists structured state in a sidecar file instead of changing the existing authority file shape.
- [ ] The sidecar file is stored in the project-isolated memory data directory and includes at minimum bank identity, scope, status, cursor, processed counts, operation ids, failure samples, and timestamps.
- [ ] Backfill starts automatically when Hindsight is enabled, unless explicitly disabled by config for testing or recovery scenarios.
- [ ] Backfill can resume safely after interruption.
- [ ] Re-running backfill does not create duplicate authoritative mappings.
- [ ] Disabling Hindsight after backfill does not break local memory reads or injection.
- [ ] Typecheck passes.
- [ ] Relevant backfill tests pass.

### US-008: Preserve authoritative local lifecycle boundaries

**Description:** As a maintainer, I want clear ownership boundaries so that this feature improves retrieval without rewriting the memory lifecycle system.

**Acceptance Criteria:**

- [ ] `packages/opencode/src/memory/storage.ts` remains the authoritative memory store in phase 1.
- [ ] Local memory continues to own `status`, `score`, `useCount`, `hitCount`, `meta`, confirmation, decay, and UI read behavior.
- [ ] `packages/opencode/src/memory/hooks/inject.ts` only consumes local authoritative memory records or ids and does not depend on raw Hindsight response schema.
- [ ] `packages/opencode/src/memory/hooks/hit-tracker.ts` continues to update only local authoritative records.
- [ ] `packages/opencode/src/memory/optimizer/decay.ts` behavior remains unchanged when Hindsight is enabled.
- [ ] Typecheck passes.
- [ ] Relevant regression tests pass.

### US-009: Add observability and degraded-mode behavior

**Description:** As a developer, I want structured logs and safe fallback so that I can debug rollout issues without breaking user sessions.

**Acceptance Criteria:**

- [ ] Add structured logs for service startup, health check, retain, recall query, extract assist, backfill progress, stale drop, and fallback.
- [ ] Logs include duration and count fields where applicable.
- [ ] Timeout behavior is configurable and treated as non-fatal.
- [ ] Startup failure marks Hindsight degraded for the current process window instead of retrying on every code path.
- [ ] Query and retain failures do not block local memory create, update, or injection.
- [ ] Add a minimal internal inspect or status command that reports service health, bank identity, scope, and backfill state without mutating data.
- [ ] Optional memory events may be added, but logs are the minimum required observability path.
- [ ] Typecheck passes.

### US-010: Verify the end-to-end companion flow

**Description:** As a developer, I want deterministic automated coverage so that future changes do not silently break mapping, fallback, or authority resolution.

**Acceptance Criteria:**

- [ ] Add unit tests for config parsing, bank id generation, document id generation, metadata normalization, and resolve rules.
- [ ] Add integration tests for recall with Hindsight enabled.
- [ ] Add integration tests for extract with Hindsight context enabled.
- [ ] Add integration tests for fallback on startup failure and query timeout.
- [ ] Add integration tests for backfill resume and idempotent rerun.
- [ ] Add behavior tests showing injection, hit tracking, and decay still operate on local authoritative records.
- [ ] Build passes.
- [ ] Typecheck passes.
- [ ] Relevant tests pass from the correct package directory.

## Functional Requirements

- FR-1: The system must support a local embedded Hindsight mode only in phase 1.
- FR-2: The default Hindsight implementation path must use `@vectorize-io/hindsight-all` and `@vectorize-io/hindsight-client`.
- FR-3: The system must keep local OpenCode memory as the only authoritative store for lifecycle state and final injected memory content.
- FR-4: The system must isolate Hindsight data by worktree by default.
- FR-5: The system must create one Hindsight bank per worktree and must not split phase 1 data into multiple banks by memory type.
- FR-6: The system must generate deterministic bank ids and deterministic document ids for memory records, session slices, and observation documents.
- FR-7: The system must retain local memory records and session slices into Hindsight with string-only metadata and normalized tags.
- FR-8: The system must query Hindsight during recall when the feature is enabled for recall.
- FR-9: The recall path must resolve Hindsight hits back to local authoritative memory ids before injection.
- FR-10: Only `mem:` documents may resolve directly into injected memories.
- FR-11: `sess:` and `obs:` documents must never be injected directly into prompts.
- FR-12: The recall path must pass resolved, Hindsight-ranked local authoritative memories into `memory-recall` for final selection.
- FR-13: The recall path must preserve both Hindsight raw relevance score and ranked order as input signals to `memory-recall`.
- FR-14: The system must fall back to current recall behavior if Hindsight is unavailable, unhealthy, times out, or returns unusable hits.
- FR-15: The extract path must retain the active session slice and query Hindsight for bounded context when the feature is enabled for extract.
- FR-16: The extract path must use a dedicated Hindsight-aware extractor variant aligned with the current `memory-extractor` contract.
- FR-17: The extract path must continue to use current authoritative memory write APIs.
- FR-18: The extract path must enforce both an item budget and a token budget for Hindsight context, with phase 1 defaults of `context_max_items: 6` and `context_max_tokens: 1200`.
- FR-19: The system must support backfill of existing local memories into Hindsight and start it automatically on enable unless explicitly disabled.
- FR-20: Backfill must be resumable and idempotent.
- FR-21: Backfill state must be persisted in a separate sidecar file, not by changing the existing authority file shape.
- FR-22: Hindsight failure must never block normal session execution, local memory creation, local memory updates, or prompt injection.
- FR-23: Logs must make service state, query timing, retain counts, resolution counts, fallback reasons, and backfill progress observable.
- FR-24: The system must provide a minimal read-only internal inspect or status command for Hindsight service and backfill state.

## Non-Goals

- No remote Hindsight SaaS integration.
- No change to `packages/opencode/src/memory/storage.ts` as the source of truth in phase 1.
- No migration of local lifecycle fields such as `score`, `status`, `useCount`, or `hitCount` into Hindsight.
- No direct injection of raw Hindsight documents, chunks, session slices, or observations into prompts.
- No multi-bank design by `world`, `experience`, or `observation` in phase 1.
- No cross-worktree shared bank by default.
- No redesign of the memory manager UI.
- No requirement to complete source-of-truth replacement planning in this PRD.

## Design Considerations

### Local-first privacy

All Hindsight execution must stay local. Phase 1 must not require remote credentials, remote tenancy, or a cloud control plane.

### Companion, not replacement

OpenCode already has lifecycle logic, decay logic, confirmation logic, and a local UI model. Replacing that authority now would turn a retrieval improvement into a storage migration. This PRD avoids that risk.

### One bank per worktree

Worktree scoping matches the user's chosen isolation model. It also reduces the chance that hits from another checked-out branch or worktree pollute recall.

### Hindsight ranking with `memory-recall` final selection

The chosen recall strategy is intentionally explicit. Hindsight is the ranking layer. OpenCode is the authority layer. After hits are resolved back to local memory ids, OpenCode passes the ranked authoritative candidates into `memory-recall` for final selection instead of injecting top-k records directly.

### Keep extractor context small

The extractor should benefit from semantic context, but only with a hard item limit, a hard token limit, and a clear prompt section. More context is not automatically better.

## Technical Considerations

### Technical selection

- **Deployment mode:** Local embedded mode only.
- **Primary SDK path:** `@vectorize-io/hindsight-all` + `@vectorize-io/hindsight-client`.
- **Authority model:** Local JSON-backed OpenCode memory remains authoritative.
- **Scope model:** One Hindsight bank per worktree.
- **Bank model:** Single bank per worktree; do not split by `world`, `experience`, or `observation`.
- **Recall model:** Hindsight ranks hits; OpenCode resolves hits to local memory ids and passes the ranked authoritative candidates into `memory-recall` for final selection, preserving both raw relevance score and ranked order.
- **Extract model:** Retain the active session slice, query Hindsight for related context, then execute a dedicated Hindsight-aware `memory-extractor` path with dual context budgets of `context_max_items` and `context_max_tokens`.
- **Backfill model:** Import current local memories through Hindsight retain APIs with stable document ids and sidecar recovery state, and start backfill automatically on enable unless explicitly disabled.

### Suggested module layout

Recommended new files:

- `packages/opencode/src/memory/hindsight/service.ts`
- `packages/opencode/src/memory/hindsight/client.ts`
- `packages/opencode/src/memory/hindsight/bank.ts`
- `packages/opencode/src/memory/hindsight/mapper.ts`
- `packages/opencode/src/memory/hindsight/retain.ts`
- `packages/opencode/src/memory/hindsight/recall.ts`
- `packages/opencode/src/memory/hindsight/backfill.ts`
- `packages/opencode/src/memory/hindsight/state.ts`

Recommended integration points:

- `packages/opencode/src/memory/engine/extractor.ts`
- `packages/opencode/src/memory/engine/recall.ts`
- `packages/opencode/src/memory/hooks/auto-extract.ts`
- `packages/opencode/src/memory/hooks/inject.ts`
- `packages/opencode/src/memory/hooks/hit-tracker.ts`
- `packages/opencode/src/memory/memory.ts`
- `packages/opencode/src/config/config.ts`

### Stable id examples

Examples for clarity:

- Local memory document: `mem:abc123:mem_001`
- Session slice document: `sess:abc123:sess_002:20:45`
- Observation document: `obs:abc123:sess_002:9f1d`

These ids must be deterministic so that reruns are safe.

### Metadata rules

Hindsight metadata input should be treated as string-only. If OpenCode needs to store arrays or objects for traceability, they must be normalized into tags or stringified JSON.

### Backfill state file

Backfill state should live in a separate sidecar file under the project-isolated memory data directory, for example a `hindsight.json` file next to the local memory authority file. This keeps phase 1 storage changes isolated and avoids reshaping the existing authority file.

### Fallback behavior

Failure handling must be specific:

- Startup failure: mark degraded and fall back.
- Health failure: recheck once, then fall back.
- Query timeout: skip Hindsight result and continue.
- Retain failure: log and continue.
- Stale hit: drop and log at debug level.
- Backfill interruption: resume from sidecar state.

### Testing expectations

- Unit tests for mapping and config.
- Wrapper-level integration tests for service and recall paths.
- Backfill resume and idempotency tests.
- Behavioral tests proving that authoritative local injection and lifecycle fields still work.

If CI cannot reliably run a real Hindsight daemon, wrapper-level fakes are acceptable for most tests, but there should still be a lightweight opt-in smoke path for the embedded daemon in opt-in CI and local manual verification.

## Success Metrics

- In targeted memory scenarios, recall returns more relevant local memories than the current baseline.
- Extraction produces fewer missed memory candidates in sessions that contain repeated or recoverable context.
- Enabling Hindsight does not introduce user-visible session failures when the service is unavailable.
- Re-running backfill does not create duplicate authoritative document mappings.
- The integration works without remote credentials or remote service dependencies.
- Logs are sufficient to identify whether a failure happened during startup, health check, retain, resolve, query, or backfill.

## Open Questions

- None for the phase 1 architecture decision.
- Exact tuned maxima beyond the phase 1 defaults may still be adjusted during implementation validation, but the mechanism is fixed: pass both raw score and ranked order into `memory-recall`, and enforce both item and token budgets in the Hindsight-aware extractor.
