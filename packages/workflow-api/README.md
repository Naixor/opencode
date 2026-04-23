# Workflow Progress Schema

`@lark-opencode/workflow-api` exposes the shared workflow progress contract under the metadata key `workflow_progress`.

## Public Contract

- `workflow-progress.v2` is the public workflow progress contract for both built-in workflows and external workflows
- The contract is the metadata payload stored at `workflow_progress`; any helper around `ctx.status({ progress })` is transport only
- Helpers such as `WorkflowStatusUpdateInput`, `coerceWorkflowProgress()`, and `mergeWorkflowProgress()` are optional convenience APIs for emitters, not a separate contract
- The MVP renderer is read-only: it shows state, history, agents, and alerts, but it does not add pause, resume, cancel, retry, or manual step controls

## Version

- Current version: `workflow-progress.v2`
- Supported versions: `workflow-progress.v1`, `workflow-progress.v2`
- Every payload must include `version`
- `parseWorkflowProgress()` is the strict reader for already-complete supported payloads
- `readWorkflowProgress()` drops unsupported versions from metadata and returns canonical reads for accepted payloads
- `validateWorkflowMetadata()` rejects unsupported versions when callers need strict persistence validation

## v2 Payload Shape

Minimum viable v2 payload:

```ts
{
  version: "workflow-progress.v2",
  workflow: {
    status: "running",
  },
  machine: {},
  step_definitions: [],
  step_runs: [],
  transitions: [],
  participants: [],
}
```

Workflow authors may omit those state-machine sections only at tolerant read boundaries such as `readWorkflowProgress()`, `normalizeWorkflowProgressInput()`, or `coerceWorkflowProgress()`. `parseWorkflowProgress()` remains strict and expects a complete supported payload shape. Canonical persistence through `validateWorkflowMetadata()` keeps the payload version and normalizes accepted v2 payloads to the explicit empty object/array form above.

```ts
{
  version: "workflow-progress.v2",
  workflow: {
    status: "pending" | "running" | "waiting" | "blocked" | "failed" | "retrying" | "done",
    name?: string,
    label?: string,
    summary?: string,
    input?: string,
    started_at?: string,
    ended_at?: string,
  },
  machine: {
    id?: string,
    key?: string,
    label?: string,
    summary?: string,
    root_step_id?: string,
    active_step_id?: string,
    active_run_id?: string,
    started_at?: string,
    updated_at?: string,
  },
  step_definitions: Array<{
    id: string,
    kind: "task" | "group" | "wait" | "decision" | "terminal",
    parent_id?: string,
    label?: string,
    summary?: string,
    description?: string,
    children?: string[],
    next?: string[],
  }>,
  step_runs: Array<{
    id: string,
    seq: number,
    step_id: string,
    status: "pending" | "active" | "waiting" | "blocked" | "retrying" | "completed" | "failed",
    label?: string,
    summary?: string,
    reason?: string,
    started_at?: string,
    ended_at?: string,
    parent_run_id?: string,
    round?: {
      current: number,
      max?: number,
      label?: string,
      summary?: string,
    },
    retry?: {
      current: number,
      max?: number,
      label?: string,
      summary?: string,
    },
    actor?: {
      id?: string,
      name?: string,
      role?: string,
      status?: "pending" | "running" | "completed" | "waiting" | "blocked" | "failed" | "retrying",
      summary?: string,
      updated_at?: string,
    },
  }>,
  transitions: Array<{
    id: string,
    seq: number,
    timestamp?: string,
    level: "workflow" | "step",
    target_id: string,
    run_id?: string,
    reason?: string,
    source?: {
      type?: string,
      id?: string,
      name?: string,
    },
  } & (
    | {
        level: "workflow",
        from_state?: "pending" | "running" | "waiting" | "blocked" | "failed" | "retrying" | "done",
        to_state: "pending" | "running" | "waiting" | "blocked" | "failed" | "retrying" | "done",
      }
    | {
        level: "step",
        from_state?: "pending" | "active" | "waiting" | "blocked" | "retrying" | "completed" | "failed",
        to_state: "pending" | "active" | "waiting" | "blocked" | "retrying" | "completed" | "failed",
      }
  )>,
  phase?: {
    status: "pending" | "active" | "completed" | "waiting" | "blocked" | "failed" | "retrying",
    key?: string,
    label?: string,
    summary?: string,
  },
  round?: {
    status: "pending" | "active" | "completed" | "waiting" | "blocked" | "failed" | "retrying",
    current?: number,
    max?: number,
    label?: string,
    summary?: string,
  },
  steps?: Array<{
    id: string,
    status: "pending" | "active" | "completed" | "waiting" | "blocked" | "failed" | "retrying",
    label?: string,
    summary?: string,
    reason?: string,
  }>,
  agents?: Array<{
    name: string,
    status: "pending" | "running" | "completed" | "waiting" | "blocked" | "failed" | "retrying",
    role?: string,
    summary?: string,
    updated_at?: string,
    round?: number,
  }>,
  participants: Array<{
    id: string,
    label?: string,
    name?: string,
    role?: string,
    status?: "pending" | "running" | "completed" | "waiting" | "blocked" | "failed" | "retrying",
    summary?: string,
    updated_at?: string,
    round?: number,
    step_id?: string,
    run_id?: string,
  }>,
}
```

## v1 Compatibility

- `workflow-progress.v1` remains supported during migration
- v1 keeps the simpler `workflow`, `phase`, `round`, `steps`, and `agents` shape
- Shared readers accept both versions through one `WorkflowProgress` union
- Persistence through `validateWorkflowMetadata()` preserves accepted `workflow-progress.v1` payloads as v1
- Workflow runtime metadata may also remain `workflow-progress.v1` when the workflow only emits v1 progress, so consumers must keep the ingestion boundary v1-compatible during migration

## Fallback Behavior

- Missing `phase`, `round`, `steps`, or `agents` degrades to a workflow-only view
- Missing v2 `machine`, `step_definitions`, `step_runs`, `transitions`, or `participants` is accepted by tolerant read helpers and normalized to explicit empty sections in canonical v2 output
- Structurally empty v2 state-machine sections such as `machine: {}`, `step_definitions: []`, `step_runs: []`, `transitions: []`, and `participants: []` are valid but not richer than the workflow-only fallback
- UI and CLI consumers should apply the shared workflow renderer only to actual workflow tool parts (`tool: "workflow"`); attaching `workflow_progress` metadata to another tool does not implicitly opt that tool into workflow-specific rendering
- Missing workflow text uses `label`, then `name`, then the caller's stable workflow identifier when available
- Missing phase text uses `label`, then `key`, then `status`
- Missing round number renders `Round unknown`
- Missing step text uses `label`, then `id`
- Missing agent text uses `role`, then `name`; missing agent summary should render a stable empty state such as `not started`
- Unknown keys are ignored so newer payloads do not require workflow-specific TUI branches

## Safe Degradation By Surface

- `workflow-progress.v1`: header uses `workflow`, `phase`, and `round`; timeline uses `steps`; agents uses `agents`; history and alerts derive from the shared workflow and step statuses, so legacy workflows still show running, waiting, blocked, retrying, failed, and done without graph data
- Partial `workflow-progress.v2`: header still renders from workflow text, timeline uses any available `step_definitions` plus `step_runs`, agents derive from `agents`, `participants`, and run actors, history uses explicit `transitions` with fallback timestamp, round, and reason tokens, and alerts continue to reflect workflow or active-step state even when some metadata is omitted
- Rich `workflow-progress.v2`: header, timeline, agents, history, and alerts all render from the shared normalizer and reducer without workflow-specific UI code
- Missing text degrades to stable fallbacks: header uses `label`, then `name`, then caller name; timeline uses step label or id; agents use role or name plus an empty-state summary; history uses fallback timestamp, round, and reason strings; alerts keep the same status taxonomy even when labels are sparse

## External Adoption

- External workflows should emit `workflow-progress.v2` as soon as they can provide deterministic step definitions, step runs, and transitions
- During migration, `workflow-progress.v1` remains safe for shipping because the same ingestion boundary accepts both versions
- Rich helper fields like `phase`, `round`, `steps`, and `agents` remain optional in v2; the shared reducer uses them when present and degrades safely when absent
- The repo includes an executable external-style example at `packages/workflow-api/src/example.ts`; it is repo-internal documentation and test coverage, not a published package export. It emits incremental v2 updates, feeds the shared normalizer and reducer with the same public payload shape, and the TUI test renders that metadata without custom workflow UI logic

```ts
import { externalexample } from "./src/example"

const demo = externalexample()

await ctx.status(demo.updates[0])
await ctx.status(demo.updates[1])
await ctx.status(demo.updates[2])

// Shared normalization + reducer output.
demo.normalized
demo.projection

// The TUI reads the same metadata payload through the shared workflow screen.
demo.metadata.workflow_progress
```

## v2 Reference Semantics

- `machine.root_step_id` and `machine.active_step_id` must reference `step_definitions[].id` when present
- `machine.active_run_id` must reference `step_runs[].id`; if `machine.active_step_id` is also present, that run must point at the same `step_id`
- `step_definitions[].parent_id`, `children[]`, and `next[]` must reference `step_definitions[].id`
- `step_runs[].step_id` must reference `step_definitions[].id`
- `step_runs[].parent_run_id` must reference `step_runs[].id`
- Step-level `transitions[].target_id` must reference `step_definitions[].id`
- Step-level `transitions[].run_id`, when present, must reference `step_runs[].id`, and that run must point at the same `target_id`
- Workflow-level `transitions[].target_id` must use the reserved workflow sentinel `"workflow"`
- `step_definitions[].children[]`, when present, must be unique, cannot reference the step itself, and must agree with each child step's `parent_id`
- Broken references fail schema validation instead of degrading silently; only missing or empty rich sections should fall back to workflow-only rendering

## Transition Rules

- `transitions` is a level-discriminated union
- `level: "workflow"` only accepts workflow states in `from_state` and `to_state`
- `level: "step"` only accepts step-run states in `from_state` and `to_state`
- Emitters should not mix workflow states like `running` or `done` into step transitions, or step states like `active` or `completed` into workflow transitions
