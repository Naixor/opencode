import { describe, expect, test } from "bun:test"
import { WorkflowProgressKey } from "@lark-opencode/workflow-api"
import { workflowscreen } from "../../src/cli/cmd/tui/routes/session/workflow-screen"

const progress = {
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

describe("workflowscreen", () => {
  test("uses one projection boundary for fixture progress and runtime metadata", () => {
    const fixture = workflowscreen({
      progress,
      name: "demo",
      tool_status: "running",
    })
    const runtime = workflowscreen({
      metadata: {
        [WorkflowProgressKey]: progress,
      },
      name: "demo",
      tool_status: "running",
    })

    expect(runtime).toEqual(fixture)
    expect(runtime.empty).toBe(false)
    expect(runtime.header.title).toBe("Demo Flow")
    expect(runtime.timeline[0]?.label).toBe("Plan")
  })

  test("renders a zero-data state without crashing or transcript fallback", () => {
    const view = workflowscreen({
      name: "demo",
      tool_status: "running",
    })

    expect(view.empty).toBe(true)
    expect(view.header).toEqual({
      title: "demo",
      status: "running",
    })
    expect(view.timeline).toEqual([])
    expect(view.agents).toEqual([])
    expect(view.history).toEqual([])
    expect(view.alerts).toEqual([])
  })
})
