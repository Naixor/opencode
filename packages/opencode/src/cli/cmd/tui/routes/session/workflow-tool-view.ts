import { workflowicon } from "@lark-opencode/workflow-api/presentation"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { workflowscreen } from "./workflow-screen"
import { workflowshell } from "./workflow-shell"

export function workflowtoolview(props: {
  input: {
    name?: string
  }
  metadata?: Record<string, unknown>
  part: ToolPart
  width?: number
}) {
  const view = workflowscreen({
    metadata: props.metadata,
    name: props.input.name,
    tool_status: props.part.state.status,
  })
  const shell = workflowshell({ view, width: props.width })
  return {
    title: shell.title,
    lines: shell.lines,
    layout: shell.layout,
    empty: view.empty,
    error: props.part.state.status === "error" ? props.part.state.error : undefined,
    icon: workflowicon(view.state),
  }
}
