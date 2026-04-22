# Workflow Progress Schema

`@lark-opencode/workflow-api` exposes the shared workflow progress contract under the metadata key `workflow_progress`.

## Version

- Current version: `workflow-progress.v2`
- Supported versions: `workflow-progress.v1`, `workflow-progress.v2`
- Every payload must include `version`
- Unsupported versions are ignored by `parseWorkflowProgress()` and `readWorkflowProgress()`
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

Workflow authors may omit those state-machine sections at loose read boundaries like `parseWorkflowProgress()` or `readWorkflowProgress()`, but canonical persistence through `validateWorkflowMetadata()` keeps the payload version and normalizes accepted v2 payloads to the explicit empty object/array form above.

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
- Missing v2 `machine`, `step_definitions`, `step_runs`, `transitions`, or `participants` is accepted by loose parser helpers and normalized to explicit empty sections in canonical v2 output
- Structurally empty v2 state-machine sections such as `machine: {}`, `step_definitions: []`, `step_runs: []`, `transitions: []`, and `participants: []` are valid but not richer than the workflow-only fallback
- UI and CLI consumers should apply the shared workflow renderer only to actual workflow tool parts (`tool: "workflow"`); attaching `workflow_progress` metadata to another tool does not implicitly opt that tool into workflow-specific rendering
- Missing workflow text uses `label`, then `name`, then the caller's stable workflow identifier when available
- Missing phase text uses `label`, then `key`, then `status`
- Missing round number renders `Round unknown`
- Missing step text uses `label`, then `id`
- Missing agent text uses `role`, then `name`; missing agent summary should render a stable empty state such as `not started`
- Unknown keys are ignored so newer payloads do not require workflow-specific TUI branches

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
