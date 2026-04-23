import { WorkflowProgressKey } from "@lark-opencode/workflow-api"
import { workflowscreen } from "../../src/cli/cmd/tui/routes/session/workflow-screen"
import { workflowshell } from "../../src/cli/cmd/tui/routes/session/workflow-shell"

type Fixture = {
  metadata?: Record<string, unknown>
  progress?: unknown
  name?: string
  tool_status?: "pending" | "running" | "completed" | "error"
}

function text(input: string) {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

const single = (
  state: "running" | "waiting" | "blocked" | "retrying" | "failed" | "done",
  kind: "task" | "wait" | "decision" | "terminal" = "task",
) => {
  const step = state === "running" ? "active" : state === "done" ? "completed" : state
  return {
    version: "workflow-progress.v2",
    workflow: {
      status: state,
      name: `flow-${state}`,
      label: `${state[0]?.toUpperCase()}${state.slice(1)} Flow`,
      summary: `Flow is ${state}`,
    },
    machine: {
      id: `flow-${state}`,
      active_step_id: "review",
      active_run_id: `run-${state}`,
    },
    phase: { status: "execute", label: "Execute" },
    round: { current: 2, max: 4 },
    step_definitions: [{ id: "review", kind, label: kind === "terminal" ? "Ship" : "Review" }],
    step_runs: [
      {
        id: `run-${state}`,
        seq: 0,
        step_id: "review",
        status: step,
        summary: `Review is ${state}`,
        reason: `${state} reason`,
        round: { current: 2, max: 4 },
        ...(state === "retrying" ? { retry: { current: 2 } } : {}),
      },
    ],
    transitions: [
      {
        id: `trans-${state}`,
        seq: 0,
        level: "step",
        target_id: "review",
        run_id: `run-${state}`,
        to_state: step,
        reason: `${state} reason`,
      },
    ],
    agents: [
      {
        id: `agent-${state}`,
        name: `${state}-agent`,
        role: "Worker",
        status: step === "active" ? "running" : step,
        summary: `Agent for ${state}`,
      },
    ],
    participants: [{ id: `agent-${state}`, name: `${state}-agent`, step_id: "review", run_id: `run-${state}` }],
  } as const
}

const grouped = {
  version: "workflow-progress.v2",
  workflow: {
    status: "running",
    name: "flow-running",
    label: "Running Flow",
    summary: "Flow is running",
  },
  machine: {
    id: "flow-running",
    active_step_id: "review",
    active_run_id: "run-review",
  },
  phase: { status: "execute", label: "Execute" },
  round: { current: 2, max: 4 },
  step_definitions: [
    { id: "plan", kind: "task", label: "Plan" },
    { id: "review", kind: "group", parent_id: "plan", label: "Review", children: ["lint", "test", "docs"] },
    { id: "lint", kind: "task", parent_id: "review", label: "Lint" },
    { id: "test", kind: "wait", parent_id: "review", label: "Await QA" },
    { id: "docs", kind: "task", parent_id: "review", label: "Docs" },
  ],
  step_runs: [
    { id: "run-plan", seq: 0, step_id: "plan", status: "completed", reason: "Plan approved" },
    {
      id: "run-review",
      seq: 1,
      step_id: "review",
      status: "active",
      parent_run_id: "run-plan",
      reason: "Parallel checks",
    },
    {
      id: "run-lint",
      seq: 2,
      step_id: "lint",
      status: "active",
      parent_run_id: "run-review",
      reason: "Linting changes",
    },
    {
      id: "run-test",
      seq: 3,
      step_id: "test",
      status: "waiting",
      parent_run_id: "run-review",
      reason: "Waiting for QA slot",
    },
  ],
  transitions: [
    {
      id: "trans-plan",
      seq: 0,
      level: "step",
      target_id: "plan",
      run_id: "run-plan",
      to_state: "completed",
      reason: "Plan approved",
    },
    {
      id: "trans-review",
      seq: 1,
      level: "step",
      target_id: "review",
      run_id: "run-review",
      to_state: "active",
      reason: "Parallel checks",
    },
    {
      id: "trans-lint",
      seq: 2,
      level: "step",
      target_id: "lint",
      run_id: "run-lint",
      to_state: "active",
      reason: "Linting changes",
    },
    {
      id: "trans-test",
      seq: 3,
      level: "step",
      target_id: "test",
      run_id: "run-test",
      to_state: "waiting",
      reason: "Waiting for QA slot",
    },
  ],
  agents: [
    { id: "agent-running", name: "running-agent", role: "Worker", status: "running", summary: "Agent for running" },
  ],
  participants: [{ id: "agent-running", name: "running-agent", step_id: "lint", run_id: "run-lint" }],
} as const

export const workflowfixtures: Record<string, Fixture> = {
  running: { name: "demo", tool_status: "running", progress: grouped },
  waiting: { name: "demo", tool_status: "running", progress: single("waiting", "wait") },
  blocked: { name: "demo", tool_status: "running", progress: single("blocked", "decision") },
  retrying: { name: "demo", tool_status: "running", progress: single("retrying") },
  failed: { name: "demo", tool_status: "error", progress: single("failed") },
  done: { name: "demo", tool_status: "completed", progress: single("done", "terminal") },
  v1: {
    name: "legacy",
    tool_status: "running",
    progress: {
      version: "workflow-progress.v1",
      workflow: { status: "waiting", label: "Legacy Flow", summary: "Legacy fallback" },
      steps: [{ id: "review", status: "waiting", label: "Review" }],
    },
  },
  partial: {
    name: "partial",
    tool_status: "running",
    metadata: {
      [WorkflowProgressKey]: {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", label: "Partial Flow" },
        machine: { active_step_id: "write" },
        step_definitions: [{ id: "write", label: "Write code" }],
        step_runs: [{ step_id: "write", status: "running" }],
        transitions: [{ level: "step", target_id: "write", reason: "Awaiting input" }],
      },
    },
  },
  empty: { name: "demo", tool_status: "running" },
  inactive: {},
}

export function renderfixture(name: keyof typeof workflowfixtures, width: 80 | 120) {
  const item = workflowfixtures[name]
  const view = workflowscreen({
    metadata: item.metadata,
    progress: item.progress,
    name: item.name,
    tool_status: item.tool_status,
  })
  return workflowshell({ view, width })
}

export function renderpage() {
  const body = (Object.keys(workflowfixtures) as Array<keyof typeof workflowfixtures>)
    .flatMap((name) =>
      ([80, 120] as const).map((width) => {
        const shell = renderfixture(name, width)
        return `<section data-fixture="${name}" data-width="${width}" style="width:${width}ch"><h2>${text(
          `${name} / ${width}`,
        )}</h2><pre>${text([shell.title, ...shell.lines].join("\n"))}</pre></section>`
      }),
    )
    .join("")
  return `<!doctype html><html><head><meta charset="utf-8"><title>workflow-screen-harness</title><style>body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;padding:24px;background:#f5f1e8;color:#1e1b16}main{display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px}section{flex:none;border:1px solid #cbbfa9;background:#fffaf1;padding:12px;overflow:auto}pre{white-space:pre;overflow-x:auto;overflow-y:hidden;margin:0}</style></head><body><main>${body}</main></body></html>`
}
