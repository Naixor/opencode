import { WorkflowProgressKey } from "@lark-opencode/workflow-api"
import {
  workflowfallback,
  workflowproject,
  type WorkflowProjection,
  type WorkflowToolStatus,
  type WorkflowViewState,
} from "@lark-opencode/workflow-api/presentation"

export type WorkflowScreenState = {
  mode: "projection" | "empty" | "inactive"
  empty: boolean
  notice?: string
  state: WorkflowViewState
  header: WorkflowProjection["header"]
  timeline: WorkflowProjection["timeline"]
  agents: WorkflowProjection["agents"]
  history: WorkflowProjection["history"]
  alerts: WorkflowProjection["alerts"]
  latest?: WorkflowProjection["latest"]
}

function fallback(input?: WorkflowToolStatus): WorkflowViewState {
  if (input === "error") return "failed"
  if (input === "completed") return "done"
  if (input === "pending") return "pending"
  if (!input) return "pending"
  return "running"
}

function filled(input?: string) {
  const out = input?.trim()
  if (!out) return
  return out
}

export function workflowscreen(input: {
  metadata?: Record<string, unknown>
  progress?: unknown
  name?: string
  tool_status?: WorkflowToolStatus
}): WorkflowScreenState {
  const projection = workflowproject({
    progress: input.progress ?? input.metadata?.[WorkflowProgressKey],
    name: input.name,
    tool_status: input.tool_status,
  })
  if (projection) {
    return {
      mode: "projection",
      empty: false,
      state: projection.state,
      header: projection.header,
      timeline: projection.timeline,
      agents: projection.agents,
      history: projection.history,
      alerts: projection.alerts,
      ...(projection.latest ? { latest: projection.latest } : {}),
    }
  }
  const state = fallback(input.tool_status)
  const title = filled(input.name) ?? workflowfallback.workflow
  const mode = filled(input.name) || input.tool_status ? "empty" : "inactive"
  const notice = mode === "inactive" ? `No active ${workflowfallback.workflow}.` : `No ${workflowfallback.workflow} state yet.`
  const timeline = [
    {
      id: `${mode}:step`,
      step_id: workflowfallback.step,
      label: workflowfallback.step,
      status: "pending",
      active: false,
      depth: 0,
      reason: workflowfallback.reason,
    } satisfies WorkflowProjection["timeline"][number],
  ]
  const agents = [
    {
      id: workflowfallback.agent,
      name: workflowfallback.agent,
      status: "pending",
      active: false,
    } satisfies WorkflowProjection["agents"][number],
  ]
  const history = [
    {
      id: `${mode}:history`,
      timestamp: workflowfallback.timestamp,
      level: "workflow",
      target_id: workflowfallback.workflow,
      label: workflowfallback.workflow,
      to_state: state,
      reason: workflowfallback.reason,
      source: workflowfallback.agent,
      round: workflowfallback.round,
    } satisfies WorkflowProjection["history"][number],
  ]
  const alerts =
    state === "pending"
      ? []
      : [
          {
            id: `${mode}:alert`,
            level: "workflow",
            status: state,
            title,
            summary: notice,
            target: workflowfallback.workflow,
          } satisfies WorkflowProjection["alerts"][number],
        ]
  return {
    mode,
    empty: true,
    notice,
    state,
    header: {
      title,
      status: state,
      phase: workflowfallback.phase,
      summary: workflowfallback.reason,
      started_at: workflowfallback.timestamp,
    },
    timeline,
    agents,
    history,
    alerts,
    latest: history[0],
  }
}
