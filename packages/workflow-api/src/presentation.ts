import {
  readWorkflowProgress,
  workflowDisplayStatus,
  workflowPhaseLabel,
  workflowRoundLabel,
  type WorkflowAgentStatus,
  type WorkflowProgressRead,
  type WorkflowProgressTransitionLevel,
  type WorkflowStatus,
  type WorkflowStepKind,
  type WorkflowStepStatus,
} from "./index"

export type WorkflowToolStatus = "pending" | "running" | "completed" | "error"
export type WorkflowViewState = "pending" | "running" | "waiting" | "blocked" | "retrying" | "done" | "failed"

export type WorkflowProjectionHeader = {
  title: string
  status: WorkflowViewState
  phase?: string
  round?: string
  summary?: string
  input?: string
  started_at?: string
}

export type WorkflowProjectionTimelineItem = {
  id: string
  step_id: string
  run_id?: string
  parent_run_id?: string
  label: string
  kind?: WorkflowStepKind
  status: WorkflowStepStatus
  active: boolean
  depth: number
  summary?: string
  reason?: string
  round?: string
  retry?: string
  actor?: string
}

export type WorkflowProjectionAgentItem = {
  id: string
  name: string
  role?: string
  status: WorkflowAgentStatus
  summary?: string
  updated_at?: string
  round?: number
  active: boolean
}

export type WorkflowProjectionHistoryItem = {
  id: string
  timestamp: string
  level: WorkflowProgressTransitionLevel
  target_id: string
  run_id?: string
  label: string
  from_state?: WorkflowStatus | WorkflowStepStatus
  to_state: WorkflowStatus | WorkflowStepStatus
  reason?: string
  source?: string
  round?: string
}

export type WorkflowProjectionAlertItem = {
  id: string
  level: WorkflowProgressTransitionLevel
  status: Exclude<WorkflowViewState, "pending" | "running">
  title: string
  summary?: string
  target?: string
  source?: string
}

export type WorkflowProjection = {
  state: WorkflowViewState
  header: WorkflowProjectionHeader
  timeline: WorkflowProjectionTimelineItem[]
  agents: WorkflowProjectionAgentItem[]
  history: WorkflowProjectionHistoryItem[]
  alerts: WorkflowProjectionAlertItem[]
  latest?: WorkflowProjectionHistoryItem
}

function live(input?: string) {
  if (!input) return false
  return input === "active" || input === "running" || input === "waiting" || input === "blocked" || input === "retrying"
}

function signal(input?: string) {
  if (!input) return
  if (input === "waiting" || input === "blocked" || input === "retrying" || input === "failed" || input === "done")
    return input
}

function steptitle(input: {
  def?: WorkflowProgressRead["step_definitions"][number]
  run?: WorkflowProgressRead["step_runs"][number]
  step?: WorkflowProgressRead["steps"][number]
}) {
  return (
    input.run?.label ??
    input.def?.label ??
    input.step?.label ??
    input.def?.id ??
    input.run?.step_id ??
    input.step?.id ??
    "step"
  )
}

function actorname(input?: WorkflowProgressRead["step_runs"][number]["actor"]) {
  return input?.label ?? input?.name ?? input?.role ?? input?.id
}

function participantid(input: { id?: string; name?: string; role?: string }) {
  return input.id ?? input.name ?? input.role
}

function participantname(input: { label?: string; name?: string; role?: string; id?: string }) {
  return input.label ?? input.name ?? input.role ?? input.id
}

function runlabel(
  input?: WorkflowProgressRead["step_runs"][number]["round"] | WorkflowProgressRead["step_runs"][number]["retry"],
  title = "Round",
) {
  if (!input) return
  if (input.label) return input.label
  if (input.current !== undefined && input.max !== undefined) return `${title} ${input.current}/${input.max}`
  if (input.current !== undefined) return `${title} ${input.current}`
  return `${title} unknown`
}

function trail(defs: Map<string, WorkflowProgressRead["step_definitions"][number]>, id?: string) {
  if (!id) return []
  const seen = new Set<string>()
  const out: string[] = []
  let cur: string | undefined = id
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    out.unshift(cur)
    cur = defs.get(cur)?.parent_id
  }
  if (cur) return [id]
  return out
}

function pick(
  runs: Map<string, WorkflowProgressRead["step_runs"]>,
  id: string,
  run?: WorkflowProgressRead["step_runs"][number],
) {
  const list = runs.get(id) ?? []
  if (run?.step_id === id) return run
  const cur = [...list].reverse().find((item) => live(item.status))
  if (cur) return cur
  return list.at(-1)
}

function current(progress: WorkflowProgressRead, runs: Map<string, WorkflowProgressRead["step_runs"]>) {
  const run = progress.machine.active_run_id
    ? progress.step_runs.find((item) => item.id === progress.machine.active_run_id)
    : undefined
  const id =
    progress.machine.active_step_id ??
    run?.step_id ??
    [...progress.step_runs].reverse().find((item) => live(item.status))?.step_id ??
    progress.step_runs.at(-1)?.step_id ??
    progress.steps.find((item) => live(item.status))?.id ??
    progress.steps.at(-1)?.id
  return { id, run: id ? pick(runs, id, run) : run }
}

function row(input: {
  id: string
  depth: number
  active: boolean
  def?: WorkflowProgressRead["step_definitions"][number]
  run?: WorkflowProgressRead["step_runs"][number]
  step?: WorkflowProgressRead["steps"][number]
}): WorkflowProjectionTimelineItem {
  return {
    id: input.run?.id ?? input.id,
    step_id: input.id,
    ...(input.run?.id ? { run_id: input.run.id } : {}),
    ...(input.run?.parent_run_id ? { parent_run_id: input.run.parent_run_id } : {}),
    label: steptitle(input),
    ...(input.def?.kind ? { kind: input.def.kind } : {}),
    status: input.run?.status ?? input.step?.status ?? "pending",
    active: input.active,
    depth: input.depth,
    ...((input.run?.summary ?? input.step?.summary ?? input.def?.summary)
      ? { summary: input.run?.summary ?? input.step?.summary ?? input.def?.summary }
      : {}),
    ...((input.run?.reason ?? input.step?.reason) ? { reason: input.run?.reason ?? input.step?.reason } : {}),
    ...(runlabel(input.run?.round) ? { round: runlabel(input.run?.round) } : {}),
    ...(runlabel(input.run?.retry, "Retry") ? { retry: runlabel(input.run?.retry, "Retry") } : {}),
    ...(actorname(input.run?.actor) ? { actor: actorname(input.run?.actor) } : {}),
  }
}

function timeline(progress: WorkflowProgressRead) {
  const defs = new Map(progress.step_definitions.map((item) => [item.id, item]))
  const steps = new Map(progress.steps.map((item) => [item.id, item]))
  const runs = progress.step_runs.reduce<Map<string, WorkflowProgressRead["step_runs"]>>((map, item) => {
    const list = map.get(item.step_id) ?? []
    list.push(item)
    map.set(item.step_id, list)
    return map
  }, new Map())
  const cur = current(progress, runs)
  const list = trail(defs, cur.id).flatMap((id, ix) => {
    const def = defs.get(id)
    const run = pick(runs, id, cur.run)
    const step = steps.get(id)
    if (!def && !run && !step) return []
    return [row({ id, depth: ix, active: id === cur.id, def, run, step })]
  })
  const def = cur.id ? defs.get(cur.id) : undefined
  const kids =
    def?.children ?? progress.step_definitions.filter((item) => item.parent_id === def?.id).map((item) => item.id)
  if (def?.kind === "group" && kids?.length) {
    const rows = kids.flatMap((id) => {
      const child = defs.get(id)
      const run = (runs.get(id) ?? []).filter((item) => item.parent_run_id === cur.run?.id).at(-1) ?? pick(runs, id)
      if (!run) return []
      return [
        row({
          id,
          depth: list.length,
          active: run.id === cur.run?.id || id === cur.id,
          def: child,
          run,
          step: steps.get(id),
        }),
      ]
    })
    if (rows.length) return [...list, ...rows]
  }
  if (list.length) return list
  if (progress.step_runs.length) {
    return progress.step_runs.map((run) =>
      row({
        id: run.step_id,
        depth: 0,
        active: run.id === cur.run?.id || run.step_id === cur.id,
        def: defs.get(run.step_id),
        run,
        step: steps.get(run.step_id),
      }),
    )
  }
  return progress.steps.map((step) => row({ id: step.id, depth: 0, active: step.id === cur.id, step }))
}

function agentsview(progress: WorkflowProgressRead): WorkflowProjectionAgentItem[] {
  const out: WorkflowProjectionAgentItem[] = []
  const seen = new Map<string, number>()
  const runs = new Map(progress.step_runs.map((item) => [item.id, item]))
  const add = (item: WorkflowProjectionAgentItem) => {
    const ix = seen.get(item.id)
    if (ix === undefined) {
      seen.set(item.id, out.length)
      out.push(item)
      return
    }
    out[ix] = { ...out[ix], ...item, active: out[ix].active || item.active }
  }
  progress.agents.forEach((item, ix) => {
    const id = participantid(item) ?? `agent-${ix + 1}`
    add({
      id,
      name: participantname(item) ?? id,
      ...(item.role ? { role: item.role } : {}),
      status: item.status,
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.updated_at ? { updated_at: item.updated_at } : {}),
      ...(item.round !== undefined ? { round: item.round } : {}),
      active: live(item.status),
    })
  })
  progress.participants.forEach((item, ix) => {
    const id = participantid(item) ?? `participant-${ix + 1}`
    const run = item.run_id ? runs.get(item.run_id) : undefined
    const status =
      item.status ??
      (run?.status === "active" ? "running" : run?.status === "completed" ? "completed" : run?.status) ??
      "pending"
    add({
      id,
      name: participantname(item) ?? id,
      ...(item.role ? { role: item.role } : {}),
      status,
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.updated_at ? { updated_at: item.updated_at } : {}),
      ...(item.round !== undefined ? { round: item.round } : {}),
      active: live(status),
    })
  })
  progress.step_runs.forEach((run, ix) => {
    const id = participantid(run.actor ?? {}) ?? `agent-run-${ix + 1}`
    if (!run.actor) return
    add({
      id,
      name: participantname(run.actor) ?? id,
      ...(run.actor.role ? { role: run.actor.role } : {}),
      status:
        run.actor.status ??
        (run.status === "active" ? "running" : run.status === "completed" ? "completed" : run.status),
      ...(run.actor.summary ? { summary: run.actor.summary } : {}),
      ...(run.actor.updated_at ? { updated_at: run.actor.updated_at } : {}),
      ...(run.round?.current !== undefined ? { round: run.round.current } : {}),
      active: live(run.actor.status ?? run.status),
    })
  })
  return out
}

function historyview(progress: WorkflowProgressRead, title: string): WorkflowProjectionHistoryItem[] {
  const defs = new Map(progress.step_definitions.map((item) => [item.id, item]))
  const steps = new Map(progress.steps.map((item) => [item.id, item]))
  const runs = new Map(progress.step_runs.map((item) => [item.id, item]))
  return progress.transitions
    .flatMap((item) => (item.from_state && item.from_state === item.to_state ? [] : [item]))
    .sort((a, b) => {
      const seq = b.seq - a.seq
      if (seq !== 0) return seq
      const out = (b.timestamp ?? "").localeCompare(a.timestamp ?? "")
      if (out !== 0) return out
      return a.id.localeCompare(b.id)
    })
    .map((item) => ({
      id: item.id,
      timestamp: item.timestamp ?? "",
      level: item.level,
      target_id: item.target_id,
      ...(item.run_id ? { run_id: item.run_id } : {}),
      label:
        item.level === "workflow"
          ? title
          : steptitle({
              def: defs.get(item.target_id),
              run: item.run_id ? runs.get(item.run_id) : undefined,
              step: steps.get(item.target_id),
            }),
      ...(item.from_state ? { from_state: item.from_state } : {}),
      to_state: item.to_state,
      ...(item.reason ? { reason: item.reason } : {}),
      ...((participantname(item.source ?? {}) ?? item.source?.type)
        ? { source: participantname(item.source ?? {}) ?? item.source?.type }
        : {}),
      ...(item.run_id && runlabel(runs.get(item.run_id)?.round)
        ? { round: runlabel(runs.get(item.run_id)?.round) }
        : {}),
    }))
}

function alerts(
  progress: WorkflowProgressRead,
  title: string,
  state: WorkflowViewState,
): WorkflowProjectionAlertItem[] {
  const defs = new Map(progress.step_definitions.map((item) => [item.id, item]))
  const runs = progress.step_runs.reduce<Map<string, WorkflowProgressRead["step_runs"]>>((map, item) => {
    const list = map.get(item.step_id) ?? []
    list.push(item)
    map.set(item.step_id, list)
    return map
  }, new Map())
  const cur = current(progress, runs)
  const out: WorkflowProjectionAlertItem[] = []
  const add = (item: WorkflowProjectionAlertItem) => {
    if (out.some((row) => row.id === item.id)) return
    out.push(item)
  }
  const flow = signal(state)
  if (flow)
    add({
      id: `workflow:${flow}`,
      level: "workflow",
      status: flow,
      title,
      ...((progress.workflow.summary ?? progress.workflow.input)
        ? { summary: progress.workflow.summary ?? progress.workflow.input }
        : {}),
      target: progress.workflow.name ?? progress.machine.id ?? progress.machine.key,
    })
  const step = signal(cur.run?.status)
  if (step)
    add({
      id: `step:${cur.run?.id ?? cur.id ?? step}`,
      level: "step",
      status: step,
      title: steptitle({ def: cur.id ? defs.get(cur.id) : undefined, run: cur.run }),
      ...((cur.run?.reason ?? cur.run?.summary) ? { summary: cur.run?.reason ?? cur.run?.summary } : {}),
      ...(cur.id ? { target: cur.id } : {}),
      ...(actorname(cur.run?.actor) ? { source: actorname(cur.run?.actor) } : {}),
    })
  return out
}

export function workflowicon(status?: ReturnType<typeof workflowDisplayStatus>) {
  if (status === "failed") return "✗"
  if (status === "blocked") return "!"
  if (status === "waiting") return "…"
  if (status === "retrying") return "↻"
  if (status === "pending") return "○"
  if (status === "done") return "✓"
  return "•"
}

export function workflowproject(input: {
  progress?: WorkflowProgressRead
  name?: string
  tool_status?: WorkflowToolStatus
}): WorkflowProjection | undefined {
  const progress = input.progress
  if (!progress) return
  const title = progress.workflow.label ?? progress.workflow.name ?? (input.name?.trim() ? input.name : "workflow")
  const state = workflowDisplayStatus({ tool_status: input.tool_status, progress })
  const history = historyview(progress, title)
  const header = {
    title,
    status: state,
    ...(workflowPhaseLabel(progress) ? { phase: workflowPhaseLabel(progress) } : {}),
    ...(workflowRoundLabel(progress) ? { round: workflowRoundLabel(progress) } : {}),
    ...(progress.workflow.summary ? { summary: progress.workflow.summary } : {}),
    ...(progress.workflow.input ? { input: progress.workflow.input } : {}),
    ...(progress.workflow.started_at ? { started_at: progress.workflow.started_at } : {}),
  }
  return {
    state,
    header,
    timeline: timeline(progress),
    agents: agentsview(progress),
    history,
    alerts: alerts(progress, title, state),
    ...(history[0] ? { latest: history[0] } : {}),
  }
}

export function workflowview(input: {
  metadata?: Record<string, unknown>
  name?: string
  tool_status?: WorkflowToolStatus
}) {
  const view = workflowproject({
    progress: readWorkflowProgress(input.metadata),
    name: input.name,
    tool_status: input.tool_status,
  })
  if (!view) return
  const bits: string[] = [view.header.status]
  if (view.header.phase) bits.push(view.header.phase)
  if (view.header.round) bits.push(view.header.round)
  return {
    icon: workflowicon(view.state),
    title: `Workflow ${view.header.title}`,
    description: bits.join(" · "),
    state: view.state,
  }
}
