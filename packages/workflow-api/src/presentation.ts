import {
  WorkflowProgressKey,
  normalizeWorkflowProgressInput,
  workflowDisplayStatus,
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

export const workflowfallback = {
  workflow: "workflow",
  step: "step",
  agent: "agent",
  timestamp: "time unknown",
  round: "Round unknown",
  reason: "No reason provided",
} as const

type WorkflowProjectionStepDef = WorkflowProgressRead["step_definitions"][number] & { title: string }
type WorkflowProjectionStep = WorkflowProgressRead["steps"][number] & { title: string; reason_text: string }
type WorkflowProjectionAgent = WorkflowProgressRead["agents"][number] & { id: string; title: string }
type WorkflowProjectionParticipant = WorkflowProgressRead["participants"][number] & { title: string }
type WorkflowProjectionActor = NonNullable<WorkflowProgressRead["step_runs"][number]["actor"]> & { title: string }
type WorkflowProjectionRun = WorkflowProgressRead["step_runs"][number] & {
  title: string
  reason_text: string
  round_text: string
  retry_text: string
  actor_title: string
  actor?: WorkflowProjectionActor
}
type WorkflowProjectionTransition = WorkflowProgressRead["transitions"][number] & {
  title: string
  timestamp_text: string
  reason_text: string
  source_text: string
  round_text: string
}

export type WorkflowProjectionInput = {
  version: WorkflowProgressRead["version"]
  workflow: WorkflowProgressRead["workflow"] & { title: string }
  machine: WorkflowProgressRead["machine"] & { title: string }
  step_definitions: WorkflowProjectionStepDef[]
  step_runs: WorkflowProjectionRun[]
  transitions: WorkflowProjectionTransition[]
  phase?: NonNullable<WorkflowProgressRead["phase"]> & { title: string }
  round?: NonNullable<WorkflowProgressRead["round"]> & { title: string }
  steps: WorkflowProjectionStep[]
  agents: WorkflowProjectionAgent[]
  participants: WorkflowProjectionParticipant[]
}

function filled(input?: string) {
  const out = input?.trim()
  if (!out) return
  return out
}

function title(input: Array<string | undefined>, fallback: string) {
  return input.map((item) => filled(item)).find((item) => item !== undefined) ?? fallback
}

function roundtext(
  input?:
    | WorkflowProgressRead["round"]
    | WorkflowProgressRead["step_runs"][number]["round"]
    | WorkflowProgressRead["step_runs"][number]["retry"],
  kind = "Round",
) {
  if (filled(input?.label)) return filled(input?.label) ?? workflowfallback.round
  if (input?.current !== undefined && input?.max !== undefined) return `${kind} ${input.current}/${input.max}`
  if (input?.current !== undefined) return `${kind} ${input.current}`
  return kind === "Round" ? workflowfallback.round : `${kind} unknown`
}

function runstatus(input: WorkflowProgressRead["step_runs"][number]["status"]) {
  if (input === "active") return "running" as const
  if (input === "completed") return "done" as const
  return input
}

function actorstatus(input: WorkflowProgressRead["step_runs"][number]["status"]) {
  if (input === "active") return "running" as const
  if (input === "completed") return "completed" as const
  return input
}

export function normalizeWorkflowProjectionInput(
  input: unknown,
  opts?: { name?: string },
): WorkflowProjectionInput | undefined {
  const progress = normalizeWorkflowProgressInput(input)
  if (!progress) return
  const flow = title([progress.workflow.label, progress.workflow.name, opts?.name], workflowfallback.workflow)
  const defs = progress.step_definitions.map((item, ix) => ({
    ...item,
    title: title([item.label, item.id], `${workflowfallback.step} ${ix + 1}`),
  }))
  const defmap = new Map(defs.map((item) => [item.id, item]))
  const steps = progress.steps.map((item, ix) => ({
    ...item,
    title: title([item.label, defmap.get(item.id)?.title, item.id], `${workflowfallback.step} ${ix + 1}`),
    reason_text: title([item.reason], workflowfallback.reason),
  }))
  const stepmap = new Map(steps.map((item) => [item.id, item]))
  const agents = progress.agents.map((item, ix) => {
    const id = title([item.id, item.name, item.label, item.role], `agent-${ix + 1}`)
    return {
      ...item,
      id,
      title: title([item.label, item.name, item.role, id], `${workflowfallback.agent} ${ix + 1}`),
    }
  })
  const parts = progress.participants.map((item, ix) => ({
    ...item,
    title: title(
      [item.label, item.name !== item.id ? item.name : undefined, item.role, item.id],
      `${workflowfallback.agent} ${ix + 1}`,
    ),
  }))
  const round_title = progress.round ? roundtext(progress.round) : workflowfallback.round
  const partmap = new Map(
    parts.map((item) => [item.run_id ? `${item.run_id}:${item.step_id ?? ""}` : `:${item.step_id ?? ""}`, item]),
  )
  const runs: WorkflowProjectionRun[] = progress.step_runs.map((item, ix) => {
    const part = partmap.get(`${item.id}:${item.step_id}`) ?? partmap.get(`:${item.step_id}`)
    const actor_title = title(
      [item.actor?.label, item.actor?.name, item.actor?.role, item.actor?.id, part?.title],
      `${workflowfallback.agent} ${ix + 1}`,
    )
    const out: WorkflowProjectionRun = {
      id: item.id,
      seq: item.seq,
      step_id: item.step_id,
      status: item.status,
      ...(item.label ? { label: item.label } : {}),
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.started_at ? { started_at: item.started_at } : {}),
      ...(item.ended_at ? { ended_at: item.ended_at } : {}),
      ...(item.parent_run_id ? { parent_run_id: item.parent_run_id } : {}),
      ...(item.round ? { round: item.round } : {}),
      ...(item.retry ? { retry: item.retry } : {}),
      title: title(
        [item.label, defmap.get(item.step_id)?.title, stepmap.get(item.step_id)?.title, item.step_id],
        `${workflowfallback.step} ${ix + 1}`,
      ),
      reason_text: title([item.reason, stepmap.get(item.step_id)?.reason], workflowfallback.reason),
      round_text: roundtext(item.round),
      retry_text: roundtext(item.retry, "Retry"),
      actor_title,
      ...(item.actor ? { actor: { ...item.actor, title: actor_title } } : {}),
    }
    return out
  })
  const runmap = new Map(runs.map((item) => [item.id, item]))
  const trans = progress.transitions.map((item, ix) => {
    const run = item.run_id ? runmap.get(item.run_id) : undefined
    return {
      ...item,
      title:
        item.level === "workflow"
          ? flow
          : title(
              [run?.title, defmap.get(item.target_id)?.title, stepmap.get(item.target_id)?.title, item.target_id],
              `${workflowfallback.step} ${ix + 1}`,
            ),
      timestamp_text: title([item.timestamp], workflowfallback.timestamp),
      reason_text: title([item.reason, run?.reason, stepmap.get(item.target_id)?.reason], workflowfallback.reason),
      source_text: title(
        [item.source?.label, item.source?.name, item.source?.role, item.source?.id, run?.actor_title],
        workflowfallback.agent,
      ),
      round_text: title([run?.round ? run.round_text : undefined, round_title], workflowfallback.round),
    }
  })
  return {
    version: progress.version,
    workflow: {
      ...progress.workflow,
      title: flow,
    },
    machine: {
      ...progress.machine,
      title: title([progress.machine.label, progress.machine.key, progress.machine.id, flow], flow),
    },
    step_definitions: defs,
    step_runs: runs,
    transitions: trans,
    ...(progress.phase
      ? {
          phase: {
            ...progress.phase,
            title: title([progress.phase.label, progress.phase.key, progress.phase.status], progress.phase.status),
          },
        }
      : {}),
    ...(progress.round
      ? {
          round: {
            ...progress.round,
            title: round_title,
          },
        }
      : {}),
    steps,
    agents,
    participants: parts,
  }
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

function trail(defs: Map<string, WorkflowProjectionStepDef>, id?: string) {
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

function pick(runs: Map<string, WorkflowProjectionRun[]>, id: string, run?: WorkflowProjectionRun) {
  const list = runs.get(id) ?? []
  if (run?.step_id === id) return run
  const cur = [...list].reverse().find((item) => live(item.status))
  if (cur) return cur
  return list.at(-1)
}

function current(progress: WorkflowProjectionInput, runs: Map<string, WorkflowProjectionRun[]>) {
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
  def?: WorkflowProjectionStepDef
  run?: WorkflowProjectionRun
  step?: WorkflowProjectionStep
}): WorkflowProjectionTimelineItem {
  return {
    id: input.run?.id ?? input.id,
    step_id: input.id,
    ...(input.run?.id ? { run_id: input.run.id } : {}),
    ...(input.run?.parent_run_id ? { parent_run_id: input.run.parent_run_id } : {}),
    label: input.run?.title ?? input.def?.title ?? input.step?.title ?? workflowfallback.step,
    ...(input.def?.kind ? { kind: input.def.kind } : {}),
    status: input.run?.status ?? input.step?.status ?? "pending",
    active: input.active,
    depth: input.depth,
    ...((input.run?.summary ?? input.step?.summary ?? input.def?.summary)
      ? { summary: input.run?.summary ?? input.step?.summary ?? input.def?.summary }
      : {}),
    reason: input.run?.reason_text ?? input.step?.reason_text ?? workflowfallback.reason,
    ...(input.run?.round ? { round: input.run.round_text } : {}),
    ...(input.run?.retry ? { retry: input.run.retry_text } : {}),
    ...(input.run?.actor ? { actor: input.run.actor_title } : {}),
  }
}

function timeline(progress: WorkflowProjectionInput) {
  const defs = new Map(progress.step_definitions.map((item) => [item.id, item]))
  const steps = new Map(progress.steps.map((item) => [item.id, item]))
  const runs = progress.step_runs.reduce<Map<string, WorkflowProjectionRun[]>>((map, item) => {
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

function agentsview(progress: WorkflowProjectionInput): WorkflowProjectionAgentItem[] {
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
    add({
      id: item.id,
      name: item.title,
      ...(item.role ? { role: item.role } : {}),
      status: item.status,
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.updated_at ? { updated_at: item.updated_at } : {}),
      ...(item.round !== undefined ? { round: item.round } : {}),
      active: live(item.status),
    })
  })
  progress.participants.forEach((item, ix) => {
    const run = item.run_id ? runs.get(item.run_id) : undefined
    const status = item.status ?? (run ? actorstatus(run.status) : undefined) ?? "pending"
    add({
      id: item.id,
      name: item.title,
      ...(item.role ? { role: item.role } : {}),
      status,
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.updated_at ? { updated_at: item.updated_at } : {}),
      ...(item.round !== undefined ? { round: item.round } : {}),
      active: live(status),
    })
  })
  progress.step_runs.forEach((run, ix) => {
    if (!run.actor) return
    add({
      id: run.actor.id ?? `agent-run-${ix + 1}`,
      name: run.actor.title,
      ...(run.actor.role ? { role: run.actor.role } : {}),
      status: run.actor.status ?? actorstatus(run.status),
      ...(run.actor.summary ? { summary: run.actor.summary } : {}),
      ...(run.actor.updated_at ? { updated_at: run.actor.updated_at } : {}),
      ...(run.round?.current !== undefined ? { round: run.round.current } : {}),
      active: live(run.actor.status ?? run.status),
    })
  })
  return out
}

function historyview(progress: WorkflowProjectionInput): WorkflowProjectionHistoryItem[] {
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
      timestamp: item.timestamp_text,
      level: item.level,
      target_id: item.target_id,
      ...(item.run_id ? { run_id: item.run_id } : {}),
      label: item.title,
      ...(item.from_state ? { from_state: item.from_state } : {}),
      to_state: item.to_state,
      reason: item.reason_text,
      source: item.source_text,
      round: item.round_text,
    }))
}

function alerts(progress: WorkflowProjectionInput, state: WorkflowViewState): WorkflowProjectionAlertItem[] {
  const runs = progress.step_runs.reduce<Map<string, WorkflowProjectionRun[]>>((map, item) => {
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
      title: progress.workflow.title,
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
      title: cur.run?.title ?? workflowfallback.step,
      summary: cur.run?.reason ?? cur.run?.summary ?? workflowfallback.reason,
      ...(cur.id ? { target: cur.id } : {}),
      ...(cur.run?.actor ? { source: cur.run.actor_title } : {}),
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
  progress: unknown
  name?: string
  tool_status?: WorkflowToolStatus
}): WorkflowProjection | undefined {
  const progress = normalizeWorkflowProjectionInput(input.progress, { name: input.name })
  if (!progress) return
  const state = workflowDisplayStatus({ tool_status: input.tool_status, progress })
  const history = historyview(progress)
  const header = {
    title: progress.workflow.title,
    status: state,
    ...(progress.phase ? { phase: progress.phase.title } : {}),
    ...(progress.round ? { round: progress.round.title } : {}),
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
    alerts: alerts(progress, state),
    ...(history[0] ? { latest: history[0] } : {}),
  }
}

export function workflowview(input: {
  metadata?: Record<string, unknown>
  name?: string
  tool_status?: WorkflowToolStatus
}) {
  const progress = normalizeWorkflowProjectionInput(input.metadata?.[WorkflowProgressKey], { name: input.name })
  if (!progress) return
  const view = workflowproject({
    progress,
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
