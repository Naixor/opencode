import { afterEach, expect, mock, test } from "bun:test"
import { WorkflowProgressKey } from "@lark-opencode/workflow-api"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import "@opentui/solid/preload"
import { createElement, insert, testRender } from "@opentui/solid"

afterEach(() => {
  mock.restore()
})

function workflowpart(metadata: Record<string, unknown>): ToolPart {
  return {
    id: "part-route",
    sessionID: "sess-1",
    messageID: "msg-1",
    callID: "call-1",
    type: "tool",
    tool: "workflow",
    state: {
      status: "completed",
      title: "Workflow demo",
      input: { name: "demo" },
      output: "transcript fallback should stay hidden",
      metadata,
      time: { start: 0, end: 1 },
    },
  } as ToolPart
}

test("session tool route dispatches workflow parts to WorkflowTool", async () => {
  mock.module("../../src/cli/cmd/tui/routes/session/workflow-tool", async () => {
    const mod = await import("../../src/cli/cmd/tui/routes/session/workflow-tool-view")
    return {
      WorkflowTool(props: Parameters<typeof mod.workflowtoolview>[0]) {
        const view = mod.workflowtoolview(props)
        const el = createElement("text")
        insert(el, ["route-workflow", view.title, ...view.lines].join("\n"))
        return el
      },
    }
  })

  const { SessionToolRoute } = await import("../../src/cli/cmd/tui/routes/session/index")
  const data = {
    version: "workflow-progress.v2",
    workflow: {
      status: "running",
      name: "demo",
      label: "Demo Flow",
      summary: "Working through the plan",
    },
    machine: {
      id: "demo",
      active_step_id: "step-1",
      active_run_id: "run-1",
    },
    step_definitions: [{ id: "step-1", kind: "task", label: "Plan" }],
    step_runs: [{ id: "run-1", seq: 0, step_id: "step-1", status: "active", summary: "Planning" }],
    transitions: [{ id: "trans-1", seq: 0, level: "step", target_id: "step-1", run_id: "run-1", to_state: "active" }],
    participants: [],
  } as const
  const metadata = {
    [WorkflowProgressKey]: data,
  }
  const output = "transcript fallback should stay hidden"
  const part = workflowpart(metadata)

  const view = await testRender(
    () =>
      SessionToolRoute({
        input: { name: "demo" },
        metadata,
        permission: {},
        tool: "workflow",
        output,
        part,
      }),
    { width: 80, height: 20 },
  )

  try {
    await view.renderOnce()
    const frame = view.captureCharFrame()

    expect(frame).toContain("# Workflow Demo Flow")
    expect(frame).toContain("[header]")
    expect(frame).toContain("Workflow: Demo Flow")
    expect(frame).toContain("[timeline]")
    expect(frame).toContain("Step: Plan · active")
    expect(frame).toContain("route-workflow")
    expect(frame).not.toContain("transcript fallback should stay hidden")
    expect(frame).not.toContain("# workflow [name=demo]")
  } finally {
    view.renderer.destroy()
  }
})
