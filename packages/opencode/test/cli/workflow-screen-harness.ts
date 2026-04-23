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
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

const rich = (state: "running" | "waiting" | "blocked" | "retrying" | "failed" | "done") => {
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
    step_definitions: [{ id: "review", kind: "task", label: "Review" }],
    step_runs: [
      {
        id: `run-${state}`,
        seq: 0,
        step_id: "review",
        status: step,
        summary: `Review is ${state}`,
        reason: `${state} reason`,
        round: { current: 2, max: 4 },
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

export const workflowfixtures: Record<string, Fixture> = {
  running: { name: "demo", tool_status: "running", progress: rich("running") },
  waiting: { name: "demo", tool_status: "running", progress: rich("waiting") },
  blocked: { name: "demo", tool_status: "running", progress: rich("blocked") },
  retrying: { name: "demo", tool_status: "running", progress: rich("retrying") },
  failed: { name: "demo", tool_status: "error", progress: rich("failed") },
  done: { name: "demo", tool_status: "completed", progress: rich("done") },
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
