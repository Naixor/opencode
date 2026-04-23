import { describe, expect, test } from "bun:test"
import { WorkflowProgressKey } from "@lark-opencode/workflow-api"
import { workflowfallback } from "@lark-opencode/workflow-api/presentation"
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
    expect(view.mode).toBe("empty")
    expect(view.notice).toBe("No workflow state yet.")
    expect(view.header).toEqual({
      title: "demo",
      status: "running",
      phase: workflowfallback.phase,
      summary: workflowfallback.reason,
      started_at: workflowfallback.timestamp,
    })
    expect(view.timeline[0]).toMatchObject({ label: workflowfallback.step, reason: workflowfallback.reason })
    expect(view.agents[0]).toMatchObject({ name: workflowfallback.agent, status: "pending" })
    expect(view.history[0]).toMatchObject({ timestamp: workflowfallback.timestamp, reason: workflowfallback.reason })
    expect(view.alerts[0]).toMatchObject({ status: "running", title: "demo", summary: "No workflow state yet." })
  })

  test("keeps shared fallback tokens available for empty shell states", () => {
    const view = workflowscreen({
      tool_status: "running",
    })

    expect(view.header.title).toBe(workflowfallback.workflow)
    expect(view.empty).toBe(true)
  })

  test("fills projection header gaps with shared fallback tokens", () => {
    const view = workflowscreen({
      name: "demo",
      tool_status: "running",
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "running", label: "Demo Flow", input: "Ship the header" },
        machine: { active_step_id: "plan" },
        step_definitions: [{ id: "plan", label: "Plan" }],
        step_runs: [{ step_id: "plan", status: "active" }],
        transitions: [{ level: "step", target_id: "plan", to_state: "active" }],
      },
    })

    expect(view.header).toMatchObject({
      title: "Demo Flow",
      status: "running",
      phase: workflowfallback.phase,
      summary: "Ship the header",
      started_at: workflowfallback.timestamp,
    })
  })

  test("distinguishes inactive fallback state from named empty state", () => {
    const view = workflowscreen({})

    expect(view.mode).toBe("inactive")
    expect(view.notice).toBe(`No active ${workflowfallback.workflow}.`)
    expect(view.header.title).toBe(workflowfallback.workflow)
    expect(view.timeline[0]).toMatchObject({ label: workflowfallback.step })
  })
})
