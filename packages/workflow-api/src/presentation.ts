import {
  WorkflowProgressKey,
  normalizeWorkflowProgressInput,
  workflowDisplayStatus,
  workflowStatusKind,
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
  action?: string
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
  status: Exclude<WorkflowViewState, "pending">
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

type WorkflowProjectionAgentSource = "transition" | "run" | "agent" | "participant"
type WorkflowProjectionAgentSeed = {
  id: string
  name?: string
  role?: string
  status?: WorkflowAgentStatus
  summary?: string
  action?: string
  updated_at?: string
  round?: number
  source: WorkflowProjectionAgentSource
  seq: number
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

function partkey(run?: string, step?: string) {
  if (!step) return
  return run ? `${run}:${step}` : `:${step}`
}

function partmap(parts: WorkflowProjectionParticipant[]) {
  return parts.reduce<Map<string, WorkflowProjectionParticipant[]>>((map, item) => {
    const key = partkey(item.run_id, item.step_id)
    if (!key) return map
    const list = map.get(key) ?? []
    list.push(item)
    map.set(key, list)
    return map
  }, new Map())
}

function partpick(parts: Map<string, WorkflowProjectionParticipant[]>, run?: string, step?: string) {
  const key = partkey(run, step)
  if (!key) return
  const list = parts.get(key)
  if (!list || list.length !== 1) return
  return list[0]
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
  const partid = new Map(parts.map((item) => [item.id, item]))
  const partby = partmap(parts)
  const runs: WorkflowProjectionRun[] = progress.step_runs.map((item, ix) => {
    const part = partpick(partby, item.id, item.step_id) ?? partpick(partby, undefined, item.step_id)
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
    const ref =
      (item.source?.participant_id ? partid.get(item.source.participant_id) : undefined) ??
      (item.source?.id ? partid.get(item.source.id) : undefined) ??
      partpick(partby, item.source?.run_id ?? item.run_id, item.source?.step_id ?? run?.step_id) ??
      partpick(partby, undefined, item.source?.step_id ?? run?.step_id)
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
        [item.source?.label, item.source?.name, item.source?.role, ref?.title, item.source?.id],
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
  if (
    input === "running" ||
    input === "waiting" ||
    input === "blocked" ||
    input === "retrying" ||
    input === "failed" ||
    input === "done"
  )
    return input
}

function rank(input?: WorkflowStatus | WorkflowStepStatus | WorkflowAgentStatus | WorkflowViewState) {
  const state = workflowStatusKind(input)
  if (state === "running") return 6
  if (state === "retrying") return 5
  if (state === "waiting") return 4
  if (state === "blocked") return 3
  if (state === "failed") return 2
  if (state === "done") return 1
  return 0
}

function stamp(input?: string) {
  return filled(input) ?? ""
}

function text(input?: string) {
  const out = filled(input)
  if (!out || out === workflowfallback.agent) return
  return out
}

function actor(run?: WorkflowProjectionRun) {
  if (!run?.actor) return
  return [run.actor.label, run.actor.name, run.actor.role, run.actor.id].find((item) => text(item) !== undefined)
}

function depth(defs: Map<string, WorkflowProjectionStepDef>, id?: string) {
  return trail(defs, id).length
}

function cmprun(defs: Map<string, WorkflowProjectionStepDef>, a: WorkflowProjectionRun, b: WorkflowProjectionRun) {
  const state = rank(b.status) - rank(a.status)
  if (state !== 0) return state
  const dep = depth(defs, b.step_id) - depth(defs, a.step_id)
  if (dep !== 0) return dep
  const seq = b.seq - a.seq
  if (seq !== 0) return seq
  const end = stamp(b.ended_at).localeCompare(stamp(a.ended_at))
  if (end !== 0) return end
  const start = stamp(b.started_at).localeCompare(stamp(a.started_at))
  if (start !== 0) return start
  const step = a.step_id.localeCompare(b.step_id)
  if (step !== 0) return step
  return a.id.localeCompare(b.id)
}

function cmpstep(defs: Map<string, WorkflowProjectionStepDef>, a: WorkflowProjectionStep, b: WorkflowProjectionStep) {
  const state = rank(b.status) - rank(a.status)
  if (state !== 0) return state
  const dep = depth(defs, b.id) - depth(defs, a.id)
  if (dep !== 0) return dep
  return a.id.localeCompare(b.id)
}

function cmptrans(a: WorkflowProjectionTransition, b: WorkflowProjectionTransition) {
  const seq = b.seq - a.seq
  if (seq !== 0) return seq
  const time = stamp(b.timestamp).localeCompare(stamp(a.timestamp))
  if (time !== 0) return time
  if (a.level !== b.level) return a.level === "step" ? -1 : 1
  const target = a.target_id.localeCompare(b.target_id)
  if (target !== 0) return target
  const run = stamp(a.run_id).localeCompare(stamp(b.run_id))
  if (run !== 0) return run
  return a.id.localeCompare(b.id)
}

function transkey(item: WorkflowProjectionTransition) {
  return [
    item.level,
    item.target_id,
    item.run_id ?? "",
    item.from_state ?? "",
    item.to_state,
    stamp(item.timestamp),
    filled(item.reason) ?? "",
    item.source?.type ?? "",
    item.source?.participant_id ?? "",
    item.source?.id ?? "",
    item.source?.label ?? "",
    item.source?.name ?? "",
    item.source?.role ?? "",
    item.source?.run_id ?? "",
    item.source?.step_id ?? "",
  ].join(":")
}

function transpath(item: WorkflowProjectionTransition) {
  if (!item.run_id) return
  return `${item.level}:${item.target_id}:${item.run_id}`
}

function changes(progress: WorkflowProjectionInput) {
  const uniq = new Set<string>()
  const seen = new Map<string, WorkflowStatus | WorkflowStepStatus>()
  const out = [...progress.transitions].sort(cmptrans).flatMap((item) => {
    if (item.from_state && item.from_state === item.to_state) return []
    const key = transkey(item)
    if (uniq.has(key)) return []
    uniq.add(key)
    const path = transpath(item)
    if (path && seen.get(path) === item.to_state) return []
    if (path) seen.set(path, item.to_state)
    return [item]
  })
  return out.sort(cmptrans)
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
  const cur = list.find((item) => live(item.status))
  if (cur) return cur
  return list[0]
}

function branch(defs: Map<string, WorkflowProjectionStepDef>, runs: Map<string, WorkflowProjectionRun[]>, id: string) {
  if (defs.get(id)?.kind !== "group") return
  return [...runs.values()]
    .flatMap((item) => item)
    .filter((item) => live(item.status) && item.step_id !== id && trail(defs, item.step_id).includes(id))
    .sort((a, b) => cmprun(defs, a, b))[0]
}

function current(
  progress: WorkflowProjectionInput,
  defs: Map<string, WorkflowProjectionStepDef>,
  runs: Map<string, WorkflowProjectionRun[]>,
) {
  if (progress.machine.active_step_id && defs.get(progress.machine.active_step_id)?.kind === "group") {
    const cur = branch(defs, runs, progress.machine.active_step_id)
    if (cur) return { id: cur.step_id, run: cur }
  }
  const run = progress.machine.active_run_id
    ? progress.step_runs.find((item) => item.id === progress.machine.active_run_id)
    : undefined
  if (run && live(run.status)) return { id: run.step_id, run }
  if (progress.machine.active_step_id) {
    const cur = branch(defs, runs, progress.machine.active_step_id)
    if (cur) return { id: cur.step_id, run: cur }
    return {
      id: progress.machine.active_step_id,
      run: pick(runs, progress.machine.active_step_id),
    }
  }
  const live_run = [...progress.step_runs].sort((a, b) => cmprun(defs, a, b)).find((item) => live(item.status))
  if (live_run) return { id: live_run.step_id, run: live_run }
  const latest = [...progress.step_runs].sort((a, b) => cmprun(defs, a, b))[0]
  if (latest) return { id: latest.step_id, run: latest }
  const step = [...progress.steps].sort((a, b) => cmpstep(defs, a, b))[0]
  if (step) return { id: step.id, run: pick(runs, step.id) }
  const id = progress.machine.root_step_id ?? [...progress.step_definitions].map((item) => item.id).sort()[0]
  return { id, run: id ? pick(runs, id) : undefined }
}

function alertchange(list: WorkflowProjectionTransition[], cur: ReturnType<typeof current>) {
  const hit = (item: WorkflowProjectionTransition) => item.level === "step" && signal(item.to_state)
  const run_id = cur.run?.id
  if (run_id) {
    const run = list.find((item) => hit(item) && item.run_id === run_id)
    return run
  }
  if (!cur.id) return
  return list.find((item) => hit(item) && item.target_id === cur.id)
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
  runs.forEach((list) => list.sort((a, b) => cmprun(defs, a, b)))
  const cur = current(progress, defs, runs)
  const list = trail(defs, cur.id).flatMap((id, ix) => {
    const def = defs.get(id)
    const run = pick(runs, id, cur.run)
    const step = steps.get(id)
    if (!def && !run && !step) return []
    return [row({ id, depth: ix, active: id === cur.id, def, run, step })]
  })
  const gid = [...trail(defs, cur.id)].reverse().find((id) => defs.get(id)?.kind === "group")
  const def = gid ? defs.get(gid) : undefined
  const kids = gid
    ? (def?.children ?? progress.step_definitions.filter((item) => item.parent_id === gid).map((item) => item.id))
    : undefined
  if (def?.kind === "group" && kids?.length) {
    const group = gid ? pick(runs, gid) : undefined
    const rows = kids.flatMap((id) => {
      const child = defs.get(id)
      const run = (runs.get(id) ?? []).find((item) => item.parent_run_id === group?.id) ?? pick(runs, id)
      if (!run && !steps.get(id)) return []
      if (list.some((item) => item.step_id === id)) return []
      return [
        row({
          id,
          depth: Math.max(0, trail(defs, id).length - 1),
          active: run?.id === cur.run?.id || id === cur.id,
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
    return [...progress.step_runs]
      .sort((a, b) => cmprun(defs, a, b))
      .map((run) =>
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
  return [...progress.steps]
    .sort((a, b) => cmpstep(defs, a, b))
    .map((step) => row({ id: step.id, depth: 0, active: step.id === cur.id, step }))
}

function agentsview(progress: WorkflowProjectionInput): WorkflowProjectionAgentItem[] {
  const defs = new Map(progress.step_definitions.map((item) => [item.id, item]))
  const runs = new Map(progress.step_runs.map((item) => [item.id, item]))
  const parts = partmap(progress.participants)
  const part = (run?: string, step?: string) => partpick(parts, run, step)
  const trans = changes(progress)
  const rows: WorkflowProjectionAgentSeed[] = []
  const add = (item: WorkflowProjectionAgentSeed) => rows.push(item)
  const runid = (item: WorkflowProjectionRun) => {
    return item.actor?.id ?? part(item.id, item.step_id)?.id ?? part(undefined, item.step_id)?.id
  }

  const source = (item: WorkflowProjectionAgentSource) => {
    if (item === "participant") return 4
    if (item === "agent") return 3
    if (item === "run") return 2
    return 1
  }

  const action = (item: WorkflowProjectionAgentSource) => {
    if (item === "transition") return 4
    if (item === "participant") return 3
    if (item === "agent") return 2
    return 1
  }

  const blank = (item?: string, id?: string) => {
    const text = filled(item)
    if (!text) return true
    if (id && text === id) return true
    if (text === workflowfallback.agent) return true
    return false
  }

  const cmp = (
    a: WorkflowProjectionAgentSeed,
    b: WorkflowProjectionAgentSeed,
    ranker: (item: WorkflowProjectionAgentSource) => number,
    read: (item: WorkflowProjectionAgentSeed) => string,
  ) => {
    const at = stamp(a.updated_at)
    const bt = stamp(b.updated_at)
    const time = at && bt ? bt.localeCompare(at) : 0
    if (time !== 0) return time
    const src = ranker(b.source) - ranker(a.source)
    if (src !== 0) return src
    const seq = b.seq - a.seq
    if (seq !== 0) return seq
    const raw = bt.localeCompare(at)
    if (raw !== 0) return raw
    const val = read(b).localeCompare(read(a))
    if (val !== 0) return val
    return a.id.localeCompare(b.id)
  }

  const pick = <T extends string | number>(
    list: WorkflowProjectionAgentSeed[],
    read: (item: WorkflowProjectionAgentSeed) => T | undefined,
    ranker: (item: WorkflowProjectionAgentSource) => number,
    text: (item: T) => string = (item) => `${item}`,
  ) => {
    return [...list]
      .filter((item) => read(item) !== undefined)
      .sort((a, b) => cmp(a, b, ranker, (item) => text(read(item) as T)))[0]
  }

  const status = (list: WorkflowProjectionAgentSeed[]) => {
    const rich = list.filter((item) => item.status && item.status !== "pending")
    const vals = rich.length ? rich : list.filter((item) => item.status)
    return pick(vals, (item) => item.status, source)
  }

  const name = (list: WorkflowProjectionAgentSeed[]) => {
    const rich = list.filter((item) => !blank(item.name, item.id))
    const vals = rich.length ? rich : list.filter((item) => item.name)
    return pick(vals, (item) => item.name, source)
  }

  const view = (list: WorkflowProjectionAgentSeed[]): WorkflowProjectionAgentItem => {
    const state = status(list)?.status ?? "pending"
    return {
      id: list[0]?.id ?? workflowfallback.agent,
      name: name(list)?.name ?? list[0]?.id ?? workflowfallback.agent,
      ...(pick(list, (item) => item.role, source)?.role ? { role: pick(list, (item) => item.role, source)?.role } : {}),
      status: state,
      ...(pick(list, (item) => item.summary, source)?.summary
        ? { summary: pick(list, (item) => item.summary, source)?.summary }
        : {}),
      ...(pick(list, (item) => item.action, action)?.action
        ? { action: pick(list, (item) => item.action, action)?.action }
        : {}),
      ...(pick(list, (item) => item.updated_at, source)?.updated_at
        ? { updated_at: pick(list, (item) => item.updated_at, source)?.updated_at }
        : {}),
      ...(pick(list, (item) => item.round, source)?.round !== undefined
        ? { round: pick(list, (item) => item.round, source)?.round }
        : {}),
      active: live(state),
    }
  }

  progress.step_runs
    .slice()
    .sort((a, b) => cmprun(defs, a, b))
    .forEach((run) => {
      const id = runid(run)
      if (!id) return
      add({
        id,
        source: "run",
        seq: run.seq,
        name: run.actor?.title ?? part(run.id, run.step_id)?.title ?? part(undefined, run.step_id)?.title ?? id,
        ...(run.actor?.role ? { role: run.actor.role } : {}),
        status: run.actor?.status ?? actorstatus(run.status),
        ...(run.actor?.summary ? { summary: run.actor.summary } : {}),
        ...((filled(run.reason) ?? filled(run.summary)) ? { action: filled(run.reason) ?? filled(run.summary) } : {}),
        ...((run.actor?.updated_at ?? run.ended_at ?? run.started_at)
          ? { updated_at: run.actor?.updated_at ?? run.ended_at ?? run.started_at }
          : {}),
        ...(run.round?.current !== undefined ? { round: run.round.current } : {}),
      })
    })
  trans.forEach((item) => {
    const step = item.source?.step_id ?? runs.get(item.run_id ?? "")?.step_id ?? item.target_id
    const ref = [
      item.source?.participant_id,
      item.source?.id,
      part(item.source?.run_id ?? item.run_id, step)?.id,
      part(undefined, step)?.id,
      (item.source?.run_id ? runs.get(item.source.run_id) : item.run_id ? runs.get(item.run_id) : undefined)?.actor?.id,
    ].flatMap((row) => (row ? [row] : []))
    const ids = [...new Set(ref)]
    ids.forEach((id) => {
      add({
        id,
        source: "transition",
        seq: item.seq,
        name: id,
        status: "pending",
        action: filled(item.reason) ?? `${item.title} ${workflowStatusKind(item.to_state) ?? item.to_state}`,
        ...(item.timestamp ? { updated_at: item.timestamp } : {}),
      })
    })
  })
  progress.agents.forEach((item, ix) => {
    add({
      id: item.id,
      source: "agent",
      seq: ix,
      name: item.title,
      ...(item.role ? { role: item.role } : {}),
      status: item.status,
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.updated_at ? { updated_at: item.updated_at } : {}),
      ...(item.round !== undefined ? { round: item.round } : {}),
    })
  })
  progress.participants.forEach((item, ix) => {
    const run = item.run_id ? runs.get(item.run_id) : undefined
    const status = item.status ?? (run ? actorstatus(run.status) : undefined) ?? "pending"
    add({
      id: item.id,
      source: "participant",
      seq: ix,
      name: item.title,
      ...(item.role ? { role: item.role } : {}),
      status,
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.updated_at ? { updated_at: item.updated_at } : {}),
      ...(item.round !== undefined ? { round: item.round } : {}),
      ...((filled(run?.reason) ?? filled(run?.summary)) ? { action: filled(run?.reason) ?? filled(run?.summary) } : {}),
    })
  })
  return [
    ...rows
      .reduce<Map<string, WorkflowProjectionAgentSeed[]>>((map, item) => {
        const list = map.get(item.id) ?? []
        list.push(item)
        map.set(item.id, list)
        return map
      }, new Map())
      .values(),
  ]
    .map((item) => view(item))
    .sort((a, b) => {
      const state = rank(b.status) - rank(a.status)
      if (state !== 0) return state
      const time = stamp(b.updated_at).localeCompare(stamp(a.updated_at))
      if (time !== 0) return time
      return a.id.localeCompare(b.id)
    })
}

function historyview(progress: WorkflowProjectionInput): WorkflowProjectionHistoryItem[] {
  return changes(progress).map((item) => ({
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
  const defs = new Map(progress.step_definitions.map((item) => [item.id, item]))
  const parts = partmap(progress.participants)
  runs.forEach((list) => list.sort((a, b) => cmprun(defs, a, b)))
  const cur = current(progress, defs, runs)
  const latest = alertchange(changes(progress), cur)
  const part = cur.run
    ? (partpick(parts, cur.run.id, cur.run.step_id) ?? partpick(parts, undefined, cur.run.step_id))
    : undefined
  const src = text(latest?.source_text) ?? text(part?.title) ?? text(actor(cur.run))
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
  const step = signal(cur.run?.status ?? latest?.to_state)
  if (step)
    add({
      id: `step:${cur.run?.id ?? latest?.run_id ?? cur.id ?? latest?.target_id ?? step}`,
      level: "step",
      status: step,
      title: cur.run?.title ?? latest?.title ?? workflowfallback.step,
      summary:
        cur.run?.reason ??
        cur.run?.summary ??
        latest?.reason ??
        progress.steps.find((item) => item.id === cur.id)?.reason ??
        workflowfallback.reason,
      ...((cur.id ?? latest?.target_id) ? { target: cur.id ?? latest?.target_id } : {}),
      ...(src ? { source: src } : {}),
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
