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

function stepicon(status?: WorkflowScreenState["timeline"][number]["status"]) {
  if (status === "failed") return "✗"
  if (status === "blocked") return "!"
  if (status === "waiting") return "…"
  if (status === "retrying") return "↻"
  if (status === "pending") return "○"
  if (status === "completed") return "✓"
  return "•"
}

function stepstate(status?: WorkflowScreenState["timeline"][number]["status"]) {
  if (status === "completed") return "done"
  return status ?? "pending"
}

function agentstate(status?: WorkflowScreenState["agents"][number]["status"]) {
  if (status === "failed") return `${workflowicon("failed")} FAILED`
  if (status === "blocked") return `${workflowicon("blocked")} BLOCKED`
  if (status === "waiting") return `${workflowicon("waiting")} WAITING`
  if (status === "retrying") return `${workflowicon("retrying")} RETRYING`
  if (status === "completed") return `${workflowicon("done")} DONE`
  if (status === "pending") return `${workflowicon("pending")} PENDING`
  return `${workflowicon("running")} ACTIVE`
}

function agentlabel(item: WorkflowScreenState["agents"][number]) {
  const name = filled(item.name)
  if (name && name !== workflowfallback.agent) return name
  return filled(item.role) ?? name ?? workflowfallback.agent
}

function steptag(kind?: WorkflowScreenState["timeline"][number]["kind"]) {
  if (kind === "group") return "[group]"
  if (kind === "wait") return "[wait]"
  if (kind === "decision") return "[decision]"
  if (kind === "terminal") return "[terminal]"
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

function timeline(input: { note?: string; rows: WorkflowScreenState["timeline"] }) {
  const rows = input.rows.map((item) => {
    const depth = " ".repeat(Math.min(item.depth, 3) * 2)
    const mark = item.active ? ">" : "-"
    const label = [steptag(item.kind), item.label].filter(Boolean).join(" ")
    const bits = [
      stepstate(item.status),
      item.retry,
      item.reason !== workflowfallback.reason ? item.reason : undefined,
    ].filter(Boolean)
    return `${depth}${mark} ${stepicon(item.status)} ${label} · ${bits.join(" · ")}`
  })
  if (!input.note) return rows
  return [input.note, ...rows]
}

function agents(view: WorkflowScreenState) {
  return view.agents.slice(0, 4).map((item) => {
    return `Agent: ${agentlabel(item)} · ${agentstate(item.status)} · ${item.action ?? item.summary ?? workflowfallback.reason}`
  })
}

function history(view: WorkflowScreenState) {
  return view.history.slice(0, 4).map((item) => {
    const state = `${item.label} -> ${item.to_state}`
    if (item.kind === "round") {
      const bits = [item.round, state, item.reason].filter(Boolean)
      return `Round: ${bits.join(" · ")}`
    }
    const bits = [item.timestamp, state, item.reason].filter(Boolean)
    return `Latest: ${bits.join(" · ")}`
  })
}

function alertsummary(item: WorkflowScreenState["alerts"][number]) {
  const title = filled(item.title)
  const summary = filled(item.summary)
  if (title && summary && title !== summary) return `${title} · ${summary}`
  return summary ?? title ?? workflowfallback.reason
}

function waitkind(item: WorkflowScreenState["alerts"][number]) {
  if (item.waiter) return item.waiter
  if (item.level === "step") return "agent" as const
  return "user" as const
}

function alertline(item: WorkflowScreenState["alerts"][number]) {
  if (item.status === "waiting") {
    const source = filled(item.source)
    if (waitkind(item) === "agent") {
      if (source) return `${workflowicon("waiting")} Waiting for agent: ${source} · ${alertsummary(item)}`
      return `${workflowicon("waiting")} Waiting for agent: ${alertsummary(item)}`
    }
    return `${workflowicon("waiting")} Waiting for user: ${alertsummary(item)}`
  }
  if (item.status === "blocked") return `${workflowicon("blocked")} Blocked: ${alertsummary(item)}`
  if (item.status === "retrying") return `${workflowicon("retrying")} Retrying: ${alertsummary(item)}`
  if (item.status === "failed") return `${workflowicon("failed")} Failed: ${alertsummary(item)}`
  if (item.status === "done") return `${workflowicon("done")} Terminal: ${alertsummary(item)}`
  const bits = [item.status, item.title, item.summary].filter(Boolean)
  return `Alert: ${bits.join(" · ")}`
}

function alerts(view: WorkflowScreenState) {
  return view.alerts.slice(0, 7).map(alertline)
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
  const time = block(
    "timeline",
    timeline({ note: view.timeline_note, rows: view.timeline }),
    layout === "wide" ? Math.max(1, Math.floor((width - 3) / 2)) : width,
  )
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
