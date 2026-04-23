import { workflowicon } from "@lark-opencode/workflow-api/presentation"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { workflowscreen } from "./workflow-screen"

export function workflowtoolview(props: {
  input: {
    name?: string
  }
  metadata?: Record<string, unknown>
  part: ToolPart
}) {
  const view = workflowscreen({
    metadata: props.metadata,
    name: props.input.name,
    tool_status: props.part.state.status,
  })
  const step = view.timeline.find((item) => item.active) ?? view.timeline[0]
  const alert = view.alerts[0]
  const latest = view.latest ?? view.history[0]
  const status = [view.header.status, view.header.phase, view.header.round].filter(Boolean).join(" · ") || view.state
  const note = view.header.summary ?? view.header.input
  const counts = [
    `${view.timeline.length} step${view.timeline.length === 1 ? "" : "s"}`,
    `${view.agents.length} agent${view.agents.length === 1 ? "" : "s"}`,
    `${view.history.length} change${view.history.length === 1 ? "" : "s"}`,
    `${view.alerts.length} alert${view.alerts.length === 1 ? "" : "s"}`,
  ].join(" · ")
  const lines = [`${workflowicon(view.state)} ${view.header.title}`, status]
  if (view.empty) lines.push("No workflow state yet.")
  if (!view.empty && note) lines.push(note)
  if (!view.empty && step) lines.push(`Step: ${step.label} · ${step.status}`)
  if (!view.empty && latest) lines.push(`Latest: ${latest.label} -> ${latest.to_state}`)
  if (!view.empty && alert) {
    lines.push(`Alert: ${alert.status} · ${alert.title}${alert.summary ? ` · ${alert.summary}` : ""}`)
  }
  if (!view.empty) lines.push(counts)
  return {
    title: `# Workflow ${view.header.title}`,
    lines,
    empty: view.empty,
    error: props.part.state.status === "error" ? props.part.state.error : undefined,
  }
}
