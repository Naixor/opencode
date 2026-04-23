import { workflowfallback, workflowicon } from "@lark-opencode/workflow-api/presentation"
import { Locale } from "@/util/locale"
import type { WorkflowScreenState } from "./workflow-screen"

export type WorkflowShell = {
  title: string
  layout: "stacked" | "wide"
  lines: string[]
}

function filled(input?: string) {
  const out = input?.trim()
  if (!out) return
  return out
}

function fit(input: string, width: number) {
  if (width <= 0) return ""
  const out = Locale.truncate(input, width)
  if (out.length >= width) return out
  return out.padEnd(width, " ")
}

function panel(title: string, rows: string[], width: number) {
  return [fit(`[${title}]`, width), ...rows.map((row) => fit(row, width))]
}

function pair(left: string[], right: string[], width: number) {
  const gap = 3
  const cell = Math.max(1, Math.floor((width - gap) / 2))
  const size = Math.max(left.length, right.length)
  return Array.from({ length: size }, (_, ix) => {
    return `${fit(left[ix] ?? "", cell)}${" ".repeat(gap)}${fit(right[ix] ?? "", cell)}`
  })
}

function status(status?: WorkflowScreenState["header"]["status"]) {
  if (status === "failed") return `${workflowicon(status)} FAILED`
  if (status === "blocked") return `${workflowicon(status)} BLOCKED`
  if (status === "waiting") return `${workflowicon(status)} WAITING`
  if (status === "retrying") return `${workflowicon(status)} RETRYING`
  if (status === "pending") return `${workflowicon(status)} PENDING`
  if (status === "done") return `${workflowicon(status)} DONE`
  return `${workflowicon(status)} RUNNING`
}

function header(view: WorkflowScreenState) {
  const name = filled(view.header.title) ?? workflowfallback.workflow
  return [
    `Workflow: ${name}`,
    `Summary: ${view.header.summary}`,
    `Status: ${status(view.header.status)}`,
    `Phase: ${view.header.phase}`,
    `Started: ${view.header.started_at}`,
    ...(view.header.round ? [`Round: ${view.header.round}`] : []),
  ]
}

function timeline(view: WorkflowScreenState) {
  const rows = view.timeline.slice(0, 4).map((item) => {
    const depth = item.depth > 0 ? `${" ".repeat(Math.min(item.depth, 3) * 2)}- ` : ""
    const bits = [item.status, item.retry, item.reason !== workflowfallback.reason ? item.reason : undefined].filter(Boolean)
    return `Step: ${depth}${item.label} · ${bits.join(" · ")}`
  })
  if (!view.notice) return rows
  return [view.notice, ...rows]
}

function agents(view: WorkflowScreenState) {
  return view.agents.slice(0, 4).map((item) => {
    const bits = [item.status, item.action ?? item.summary].filter(Boolean)
    return `Agent: ${item.name} · ${bits.join(" · ")}`
  })
}

function history(view: WorkflowScreenState) {
  return view.history.slice(0, 4).map((item) => {
    const bits = [item.timestamp, `${item.label} -> ${item.to_state}`, item.reason].filter(Boolean)
    return `Latest: ${bits.join(" · ")}`
  })
}

function alerts(view: WorkflowScreenState) {
  return view.alerts.slice(0, 4).map((item) => {
    const bits = [item.status, item.title, item.summary].filter(Boolean)
    return `Alert: ${bits.join(" · ")}`
  })
}

function block(title: string, rows: string[], width: number) {
  return panel(title, rows, width)
}

export function workflowshell(input: { view: WorkflowScreenState; width?: number }): WorkflowShell {
  const width = Math.max(40, input.width ?? 80)
  const view = input.view
  const title = `# Workflow ${filled(view.header.title) ?? workflowfallback.workflow}`
  const layout = width >= 120 ? "wide" : "stacked"
  const head = block("header", header(view), width)
  const time = block("timeline", timeline(view), layout === "wide" ? Math.max(1, Math.floor((width - 3) / 2)) : width)
  const part = block("agents", agents(view), layout === "wide" ? Math.max(1, Math.floor((width - 3) / 2)) : width)
  const hist = block("history", history(view), layout === "wide" ? Math.max(1, Math.floor((width - 3) / 2)) : width)
  const warn = block("alerts", alerts(view), layout === "wide" ? Math.max(1, Math.floor((width - 3) / 2)) : width)
  if (layout === "wide") {
    return {
      title,
      layout,
      lines: [...head, ...pair(time, part, width), ...pair(hist, warn, width)],
    }
  }
  return {
    title,
    layout,
    lines: [...head, ...time, ...part, ...hist, ...warn],
  }
}
