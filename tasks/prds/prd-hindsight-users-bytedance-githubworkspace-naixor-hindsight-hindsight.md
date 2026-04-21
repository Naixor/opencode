# PRD: Switch OpenCode Hindsight Integration to Local Source Build Artifacts

## Introduction

OpenCode currently runs Hindsight through a packaged dependency path that hides the exact source code behind runtime behavior. When Hindsight behaves incorrectly, maintainers lose time because they cannot quickly inspect the live implementation or patch it at the source.

This feature switches the current Hindsight integration to use build artifacts produced from the local repository at `/Users/bytedance/GithubWorkspace/@Naixor/hindsight`. The product goal is simple: make debugging and fixing Hindsight issues faster without changing user-visible Hindsight behavior.

This is an MVP infrastructure change for local development. The switch is not always on for every developer. It must be controlled by a clear on/off switch, and for the current requester's environment that switch should be enabled.

For this MVP, the preferred implementation is to point OpenCode directly at local Hindsight build artifacts instead of adding a copy or publish workflow. If the local repository or required artifacts are missing or stale, OpenCode should fail fast with a clear rebuild hint so the maintainer knows exactly how to recover.

## Goals

- Make OpenCode capable of running Hindsight from locally built artifacts in `/Users/bytedance/GithubWorkspace/@Naixor/hindsight`.
- Reduce maintainer time-to-debug by making the executing Hindsight implementation easy to inspect and modify.
- Preserve current Hindsight-backed behavior for end users.
- Keep the rollout low risk through a reversible switch.
- Avoid adding extra publish, copy, or release steps just to test local Hindsight changes.

## User Stories

### US-001: Enable local-source Hindsight via an explicit switch

**Description:** As a maintainer, I want a clear switch that makes OpenCode use local Hindsight artifacts so that I can debug against editable source without changing the default behavior for everyone.

**Acceptance Criteria:**

- [ ] OpenCode provides an explicit switch that selects local Hindsight artifacts from `/Users/bytedance/GithubWorkspace/@Naixor/hindsight`.
- [ ] The switch is discoverable in config or integration code, not hidden in an ad hoc script.
- [ ] For the requester's local setup, the switch is enabled as part of this work.
- [ ] Disabling the switch returns OpenCode to the prior packaged Hindsight path without data migration.
- [ ] Typecheck passes.

### US-002: Preserve current Hindsight behavior when the switch is on

**Description:** As a user, I want existing Hindsight-backed behavior to keep working after the dependency source changes so that the debugging improvement does not create regressions.

**Acceptance Criteria:**

- [ ] Existing Hindsight startup behavior still works when the local-source switch is enabled through a direct local artifact path.
- [ ] Existing recall and extraction flows continue to function through the local artifact path.
- [ ] No npm publish step is required to validate local Hindsight source changes.
- [ ] Relevant automated verification passes.
- [ ] Typecheck passes.

### US-003: Make the maintainer workflow obvious and fast

**Description:** As a maintainer, I want a documented rebuild workflow so that I can edit Hindsight source, rebuild artifacts, and verify the change quickly.

**Acceptance Criteria:**

- [ ] The repo documents the expected rebuild or refresh step after changing Hindsight source.
- [ ] The integration and documentation state that OpenCode expects local prebuilt artifacts and does not implicitly publish or copy packages for this workflow.
- [ ] A maintainer can tell which Hindsight source/artifact path OpenCode is currently using during debugging.
- [ ] Typecheck passes.

### US-004: Fail safely when the local repo or artifacts are unavailable

**Description:** As a maintainer, I want the local-source mode to fail in a predictable way so that I do not waste time debugging a broken environment.

**Acceptance Criteria:**

- [ ] If `/Users/bytedance/GithubWorkspace/@Naixor/hindsight` is missing while the switch is enabled, OpenCode surfaces a clear error message.
- [ ] If required local artifacts are missing or stale, OpenCode fails fast with a clear rebuild message that tells the maintainer what to do next.
- [ ] The failure mode does not corrupt existing memory data or silently fall back without telling the maintainer.
- [ ] Typecheck passes.

### US-005: Keep CI and non-local workflows unchanged in MVP

**Description:** As a team, we want this change scoped to local development first so that we gain debugging speed without expanding the rollout risk.

**Acceptance Criteria:**

- [ ] The MVP does not require CI to depend on `/Users/bytedance/GithubWorkspace/@Naixor/hindsight`.
- [ ] The default CI path continues using the existing packaged Hindsight dependency unless a future story changes it.
- [ ] The PRD and implementation notes make the local-only scope explicit.
- [ ] Typecheck passes.

## Functional Requirements

- FR-1: OpenCode must support running Hindsight from artifacts built from `/Users/bytedance/GithubWorkspace/@Naixor/hindsight`.
- FR-2: The local-source path must be controlled by an explicit switch rather than being forced on for all developers.
- FR-3: For the current requester's local environment, that switch must be enabled as part of delivery.
- FR-4: When the switch is off, OpenCode must continue using the existing packaged Hindsight path.
- FR-5: The integration must make the active Hindsight source path visible enough that a maintainer can quickly tell what code is executing.
- FR-6: The workflow must not require publishing a package to npm to test local Hindsight changes.
- FR-7: The MVP implementation must use a direct reference to local Hindsight build artifacts rather than a copy, sync, or publish workflow.
- FR-8: Existing Hindsight-backed startup, recall, and extraction behavior must continue to work when the switch is on.
- FR-9: The system must define how local artifacts are produced or refreshed before OpenCode uses them.
- FR-10: If the local Hindsight repository, build output, or expected artifact is missing or stale while the switch is on, the system must fail fast with a clear and actionable rebuild message.
- FR-11: The MVP scope must not require CI to consume the local repository path.
- FR-12: The change must remain reversible without modifying existing user memory data.

## Non-Goals

- No redesign of Hindsight recall, extraction, ranking, or product behavior.
- No new end-user memory features.
- No requirement to change CI to build from the external local repository in this MVP.
- No requirement to publish, version, or release the external Hindsight repo as part of this story.
- No remote deployment strategy changes beyond local developer workflow.

## Design Considerations

- Prefer the simplest implementation that clearly separates local debug mode from the normal dependency path.
- Favor explicit, easy-to-explain behavior over clever path indirection.
- The switch should optimize maintainer speed, not introduce a new setup burden for unaffected developers.

## Technical Considerations

- The external dependency lives outside this repository, so path assumptions must be deliberate and documented.
- MVP should use a direct build output reference to the local Hindsight artifacts instead of package link/workspace-style dependency or copy/sync.
- Build freshness matters. Maintainers must not unknowingly debug stale artifacts.
- Missing or stale local artifacts should block local-source startup and show a rebuild hint instead of silently continuing.
- Because this is local-only MVP scope, implementation should avoid broad packaging or CI coupling unless clearly justified.

## Success Metrics

- A maintainer can identify the executing Hindsight source path in under 2 minutes.
- A maintainer can edit Hindsight source, rebuild, and observe the change in OpenCode without publishing a package.
- Existing Hindsight-backed flows show no unexpected regression in local verification.
- Disabling the switch restores the prior dependency path within one development session.

## Open Questions

- None for MVP. Direct local artifact reference and fail-fast rebuild guidance are already decided.
