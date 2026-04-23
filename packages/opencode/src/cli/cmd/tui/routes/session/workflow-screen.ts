import { WorkflowProgressKey } from "@lark-opencode/workflow-api"
import {
  workflowproject,
  type WorkflowProjection,
  type WorkflowToolStatus,
  type WorkflowViewState,
} from "@lark-opencode/workflow-api/presentation"

export type WorkflowScreenState = {
  empty: boolean
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
  const title = filled(input.name) ?? "workflow"
  return {
    empty: true,
    state,
    header: {
      title,
      status: state,
    },
    timeline: [],
    agents: [],
    history: [],
    alerts: [],
  }
}
