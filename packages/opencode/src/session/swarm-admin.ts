import z from "zod"
import { BoardArtifact } from "../board/artifact"
import { BoardSignal } from "../board/signal"
import { BoardTask } from "../board/task"
import { Discussion } from "../board/discussion"
import { SessionStatus } from "./status"
import { Swarm } from "./swarm"

export namespace SwarmAdmin {
  const stale = 15 * 60 * 1000

  export const Status = z.enum([
    "planning",
    "running",
    "blocked",
    "paused",
    "completed",
    "failed",
    "stopped",
    "deleted",
  ])
  export type Status = z.infer<typeof Status>

  export const Attention = z.enum(["blocked_task", "failed_task", "stale_worker", "no_consensus"])
  export type Attention = z.infer<typeof Attention>

  export const TaskCount = z.object({
    total: z.number(),
    pending: z.number(),
    running: z.number(),
    blocked: z.number(),
    failed: z.number(),
    completed: z.number(),
  })

  export const DiscussionCount = z.object({
    active: z.number(),
    consensus: z.number(),
    no_consensus: z.number(),
  })

  export const Overview = z.object({
    swarm_id: z.string(),
    goal: z.string(),
    goal_summary: z.string(),
    conductor_label: z.string(),
    conductor_session: z.string(),
    status: Status,
    current_phase: z.string(),
    updated_at: z.number(),
    deleted_at: z.number().optional(),
    task_counts: TaskCount,
    discussion_counts: DiscussionCount,
    needs_attention: z.boolean(),
    attention: z.array(Attention),
  })
  export type Overview = z.infer<typeof Overview>

  export const Action = z.object({
    id: z.string(),
    time: z.number(),
    kind: z.string(),
    summary: z.string(),
    ref: z.string().optional(),
  })

  export const TaskInfo = z.object({
    id: z.string(),
    summary: z.string(),
    type: BoardTask.Type,
    status: BoardTask.Status,
    blocked_by: z.array(z.string()),
    assignee: z.string().nullable(),
    created_at: z.number(),
    updated_at: z.number(),
    blocked_reason: z.string().nullable(),
    task_link: z.string(),
    assignee_link: z.string().nullable(),
  })
  export type TaskInfo = z.infer<typeof TaskInfo>

  export const AgentInfo = z.object({
    id: z.string(),
    label: z.string(),
    session_id: z.string(),
    status: z.enum(["active", "idle", "blocked", "failed", "done"]),
    task_count: z.number(),
    recent_activity_at: z.number().nullable(),
    current_task: z.string().nullable(),
    recent_progress: z.string().nullable(),
    reason: z.string().nullable(),
    task_ids: z.array(z.string()),
    discussion_channels: z.array(z.string()),
  })
  export type AgentInfo = z.infer<typeof AgentInfo>

  export const Ref = z.object({
    id: z.string(),
    from: z.string(),
    round: z.number(),
  })

  export const Point = z.object({
    text: z.string(),
    refs: z.array(Ref),
  })

  export const Raw = z.object({
    id: z.string(),
    round: z.number(),
    from: z.string(),
    source: z.enum(["signal", "artifact", "summary", "decision"]),
    label: z.string(),
    summary: z.string(),
    content: z.string(),
    timestamp: z.number(),
  })

  export const DiscussionInfo = z.object({
    id: z.string(),
    channel: z.string(),
    topic: z.string(),
    current_round: z.number(),
    max_rounds: z.number(),
    participants: z.array(z.string()),
    tally: z.object({
      agree: z.number(),
      disagree: z.number(),
      modify: z.number(),
      total: z.number(),
    }),
    consensus_state: z.enum(["active", "consensus", "partial_consensus", "no_consensus"]),
    conflict_summary: z.object({
      supporters: z.array(Ref),
      objectors: z.array(Ref),
      modify: z.array(Ref),
      points: z.array(Point),
    }),
    refs: z.array(Ref),
    raw: z.array(
      z.object({
        round: z.number(),
        entries: z.array(Raw),
      }),
    ),
  })
  export type DiscussionInfo = z.infer<typeof DiscussionInfo>

  export const Detail = z.object({
    overview: Overview,
    goal: z.string(),
    current_phase: z.string(),
    plan_summary: z.string(),
    risk_summary: z.string(),
    plan_empty: z.boolean(),
    plan_empty_copy: z.string(),
    last_decision_at: z.number().nullable(),
    actions: z.array(Action),
    tasks: z.array(TaskInfo),
    task_filters: z.object({
      assignees: z.array(z.string()),
      statuses: z.array(z.string()),
      types: z.array(z.string()),
    }),
    agents: z.array(AgentInfo),
    discussions: z.array(DiscussionInfo),
    recent_signals: z.array(BoardSignal.Info),
  })
  export type Detail = z.infer<typeof Detail>

  function text(value: unknown, size = 180) {
    if (typeof value !== "string") return ""
    return value.replace(/\s+/g, " ").trim().slice(0, size)
  }

  function goal(value: string) {
    const line = value
      .split("\n")
      .map((item) => item.trim())
      .find(Boolean)
    return text(line ?? value, 140)
  }

  function sum(signal: BoardSignal.Info) {
    return text(signal.payload.summary) || text(signal.payload.message) || text(JSON.stringify(signal.payload), 180)
  }

  function note(task: BoardTask.Info, map: Map<string, BoardTask.Info>, sigs: BoardSignal.Info[]) {
    if (["completed", "failed", "cancelled"].includes(task.status)) return undefined
    const dep = task.blockedBy.find((id) => map.get(id)?.status !== "completed")
    if (dep) return `Waiting on ${dep}`
    const hit = sigs
      .filter((sig) => sig.type === "blocked" || sig.type === "conflict" || sig.type === "failed")
      .find((sig) => sig.payload.task_id === task.id || sig.payload.taskID === task.id)
    if (!hit) return undefined
    return sum(hit) || `Task ${task.id} is blocked`
  }

  function phase(info: Swarm.Info, tasks: BoardTask.Info[], disc: DiscussionInfo[]) {
    if (info.time.deleted) return "deleted"
    if (info.time.stopped) return "stopped"
    if (info.status === "completed") return "completed"
    if (info.status === "failed") return "failed"
    if (info.status === "paused") return "paused"
    if (tasks.length === 0) return "planning"
    if (disc.some((item) => item.consensus_state === "active")) return "discussing"
    if (tasks.some((task) => task.status === "pending" && !task.assignee)) return "assigning"
    if (tasks.some((task) => task.status === "in_progress")) return "running"
    if (tasks.length > 0 && tasks.every((task) => task.status === "completed" || task.status === "cancelled"))
      return "verifying"
    return info.status === "planning" ? "planning" : "running"
  }

  function state(info: Swarm.Info, count: z.infer<typeof TaskCount>) {
    if (info.time.deleted) return Status.enum.deleted
    if (info.time.stopped) return Status.enum.stopped
    if (info.status === "completed") return Status.enum.completed
    if (info.status === "failed" || count.failed > 0) return Status.enum.failed
    if (info.status === "paused") return Status.enum.paused
    if (count.blocked > 0) return Status.enum.blocked
    if (info.status === "planning") return Status.enum.planning
    return Status.enum.running
  }

  function refs(raw: z.infer<typeof Raw>[], from: string) {
    return raw.filter((item) => item.from === from).map((item) => ({ id: item.id, from: item.from, round: item.round }))
  }

  function conflict(raw: z.infer<typeof Raw>[], tally: Awaited<ReturnType<typeof Discussion.tally>>) {
    const supporters = tally.positions
      .filter((item) => item.position === "agree")
      .flatMap((item) => refs(raw, item.from))
    const objectors = tally.positions
      .filter((item) => item.position === "disagree")
      .flatMap((item) => refs(raw, item.from))
    const modify = tally.positions.filter((item) => item.position === "modify").flatMap((item) => refs(raw, item.from))
    const points = raw
      .filter((item) => item.label === "objection" || item.label === "conflict")
      .map((item) => ({
        text: item.summary,
        refs: [{ id: item.id, from: item.from, round: item.round }],
      }))
      .filter((item, idx, arr) => item.text && arr.findIndex((other) => other.text === item.text) === idx)
      .slice(0, 3)
    return { supporters, objectors, modify, points }
  }

  function consensus(
    round: Awaited<ReturnType<typeof Discussion.status>>,
    tally: Awaited<ReturnType<typeof Discussion.tally>>,
    raw: z.infer<typeof Raw>[],
  ) {
    const done = round && round.complete && round.round >= round.max_rounds
    if (!done && raw.length > 0) return "active" as const
    if (tally.total === 0 && done) return "no_consensus" as const
    if (tally.total > 0 && tally.unanimous) return "consensus" as const
    if (tally.disagree > 0) return "no_consensus" as const
    if (tally.modify > 0) return "partial_consensus" as const
    return raw.length > 0 ? ("active" as const) : ("no_consensus" as const)
  }

  async function discussions(id: string, tasks: BoardTask.Info[], arts: BoardArtifact.Info[]) {
    const list = tasks.filter((task) => task.type === "discuss")
    return Promise.all(
      list.map(async (task) => {
        const channel = typeof task.metadata.channel === "string" ? task.metadata.channel : (task.scope[0] ?? task.id)
        const [round, tally, sigs] = await Promise.all([
          Discussion.status(id, channel),
          Discussion.tally(id, channel),
          BoardSignal.thread(id, channel),
        ])
        const more = arts.filter((art) => art.task_id === task.id)
        const raw = [
          ...sigs.map((sig, idx) => ({
            id: `${channel}:${sig.timestamp}:${idx}`,
            round: typeof sig.payload.round === "number" ? sig.payload.round : 1,
            from: sig.from,
            source: "signal" as const,
            label: sig.type,
            summary: sum(sig),
            content: JSON.stringify(sig.payload, null, 2),
            timestamp: sig.timestamp,
          })),
          ...more.map((art, idx) => ({
            id: `${channel}:artifact:${art.id}:${idx}`,
            round: round?.round ?? 1,
            from: art.author,
            source:
              art.type === "decision"
                ? ("decision" as const)
                : art.type === "summary"
                  ? ("summary" as const)
                  : ("artifact" as const),
            label: art.type,
            summary: text(art.content, 180),
            content: art.content,
            timestamp: art.created_at,
          })),
        ].toSorted((a, b) => a.timestamp - b.timestamp)
        const view = raw.reduce(
          (acc, item) => {
            const last = acc[acc.length - 1]
            if (last && last.round === item.round) {
              last.entries.push(item)
              return acc
            }
            acc.push({ round: item.round, entries: [item] })
            return acc
          },
          [] as Array<{ round: number; entries: z.infer<typeof Raw>[] }>,
        )
        const kind = consensus(round, tally, raw)
        return DiscussionInfo.parse({
          id: task.id,
          channel,
          topic: task.subject,
          current_round: round?.round ?? 1,
          max_rounds: round?.max_rounds ?? 1,
          participants: round?.expected ?? [],
          tally: {
            agree: tally.agree,
            disagree: tally.disagree,
            modify: tally.modify,
            total: tally.total,
          },
          consensus_state: kind,
          conflict_summary: conflict(raw, tally),
          refs: raw.map((item) => ({ id: item.id, from: item.from, round: item.round })),
          raw: view,
        })
      }),
    )
  }

  function counts(tasks: TaskInfo[]) {
    return TaskCount.parse({
      total: tasks.length,
      pending: tasks.filter((task) => task.status === "pending").length,
      running: tasks.filter((task) => task.status === "in_progress").length,
      blocked: tasks.filter((task) => task.blocked_reason).length,
      failed: tasks.filter((task) => task.status === "failed").length,
      completed: tasks.filter((task) => task.status === "completed").length,
    })
  }

  function discussionCounts(list: DiscussionInfo[]) {
    return DiscussionCount.parse({
      active: list.filter((item) => item.consensus_state === "active" || item.consensus_state === "partial_consensus")
        .length,
      consensus: list.filter((item) => item.consensus_state === "consensus").length,
      no_consensus: list.filter((item) => item.consensus_state === "no_consensus").length,
    })
  }

  function updated(info: Swarm.Info, tasks: BoardTask.Info[], arts: BoardArtifact.Info[], sigs: BoardSignal.Info[]) {
    return [
      info.time.updated,
      ...tasks.map((task) => task.updatedAt),
      ...arts.map((art) => art.created_at),
      ...sigs.map((sig) => sig.timestamp),
    ].reduce((max, item) => (item > max ? item : max), info.time.updated)
  }

  function conductor(info: Swarm.Info, arts: BoardArtifact.Info[]) {
    const list = arts.filter((art) => art.author === info.conductor || art.author === "conductor")
    return list.length > 0 ? list : arts
  }

  function planArt(info: Swarm.Info, arts: BoardArtifact.Info[]) {
    return conductor(info, arts)
      .filter((art) => art.type === "decision" || art.type === "summary" || art.type === "proposal")
      .toSorted((a, b) => b.created_at - a.created_at)[0]
  }

  function riskArt(info: Swarm.Info, arts: BoardArtifact.Info[]) {
    const pick = planArt(info, arts)
    if (!pick) return undefined
    const lines = pick.content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => /risk|blocked|failure|concern|consensus/i.test(line))
    if (lines.length > 0) return lines.slice(0, 3).join(" ")
    return `Conductor note: ${text(pick.content, 220)}`
  }

  function actions(info: Swarm.Info, tasks: BoardTask.Info[], arts: BoardArtifact.Info[], sigs: BoardSignal.Info[]) {
    const list = [
      ...conductor(info, arts).map((art) => ({
        id: `conductor:${art.id}`,
        time: art.created_at,
        kind: art.type,
        summary: `${art.type.replaceAll("_", " ")}: ${text(art.content, 140)}`,
        ref: art.id,
      })),
      ...tasks.map((task) => ({
        id: `task:${task.id}:create`,
        time: task.createdAt,
        kind: "task_created",
        summary: `Conductor created task ${task.id}: ${text(task.subject, 120)}`,
        ref: task.id,
      })),
      ...tasks
        .filter((task) => task.updatedAt !== task.createdAt)
        .map((task) => ({
          id: `task:${task.id}:update`,
          time: task.updatedAt,
          kind: "task_updated",
          summary: `Conductor task update ${task.id}: ${task.status.replace("_", " ")}`,
          ref: task.id,
        })),
      ...sigs.map((sig) => ({
        id: `signal:${sig.id}`,
        time: sig.timestamp,
        kind: sig.type === "blocked" || sig.type === "conflict" ? "risk_signal" : "board_signal",
        summary: `${sig.type} from ${sig.from}: ${sum(sig)}`,
        ref: sig.id,
      })),
      info.time.stopped
        ? {
            id: `swarm:${info.id}:stop`,
            time: info.time.stopped,
            kind: "stop",
            summary: `Swarm ${info.id} was stopped`,
            ref: info.id,
          }
        : undefined,
    ].filter((item) => item !== undefined) as Array<z.infer<typeof Action>>
    return list.toSorted((a, b) => b.time - a.time).slice(0, 5)
  }

  function plan(
    info: Swarm.Info,
    arts: BoardArtifact.Info[],
    tasks: BoardTask.Info[],
    disc: DiscussionInfo[],
    sigs: BoardSignal.Info[],
  ) {
    const pick = planArt(info, arts)
    if (pick) return text(pick.content, 500)
    if (tasks.length === 0) return "No conductor plan is available yet."
    const list = [
      `${tasks.length} tasks on board`,
      `${tasks.filter((task) => task.assignee).length} assigned`,
      `${disc.length} discussions tracked`,
      ...sigs
        .toSorted((a, b) => b.timestamp - a.timestamp)
        .slice(0, 3)
        .map((sig) => `${sig.type} from ${sig.from}: ${sum(sig)}`),
    ]
    return `${list.join(", ")}.`
  }

  function risk(
    info: Swarm.Info,
    arts: BoardArtifact.Info[],
    tasks: TaskInfo[],
    disc: DiscussionInfo[],
    agents: AgentInfo[],
  ) {
    const note = riskArt(info, arts)
    const list = [
      note,
      tasks.some((task) => task.blocked_reason)
        ? `${tasks.filter((task) => task.blocked_reason).length} blocked tasks`
        : undefined,
      tasks.some((task) => task.status === "failed")
        ? `${tasks.filter((task) => task.status === "failed").length} failed tasks`
        : undefined,
      agents.some((agent) => agent.status === "blocked")
        ? `${agents.filter((agent) => agent.status === "blocked").length} blocked agents`
        : undefined,
      disc.some((item) => item.consensus_state === "no_consensus")
        ? `${disc.filter((item) => item.consensus_state === "no_consensus").length} unresolved discussions`
        : undefined,
    ].filter((item): item is string => Boolean(item))
    if (list.length === 0) return "No immediate risks detected from tasks, agents, or discussions."
    return list.join(", ") + "."
  }

  async function collect(id: string, include_deleted = false) {
    const info = await Swarm.status(id, { include_deleted })
    const [tasks, arts, sigs] = await Promise.all([
      BoardTask.list(id),
      BoardArtifact.list({ swarm_id: id }),
      BoardSignal.recent(id, undefined, 200),
    ])
    const map = new Map(tasks.map((task) => [task.id, task]))
    const taskList = tasks.map((task) =>
      TaskInfo.parse({
        id: task.id,
        summary: task.subject,
        type: task.type,
        status: task.status,
        blocked_by: task.blockedBy,
        assignee: task.assignee ?? null,
        created_at: task.createdAt,
        updated_at: task.updatedAt,
        blocked_reason: note(task, map, sigs) ?? null,
        task_link: task.id,
        assignee_link: task.assignee ?? null,
      }),
    )
    const disc = await discussions(id, tasks, arts)
    const taskCount = counts(taskList)
    const talkCount = discussionCounts(disc)
    const last = updated(info, tasks, arts, sigs)
    const attention = [
      taskCount.blocked > 0 ? Attention.enum.blocked_task : undefined,
      taskCount.failed > 0 || info.status === "failed" ? Attention.enum.failed_task : undefined,
      info.workers.some((worker) => {
        const time = [
          ...taskList
            .filter((task) => task.assignee === worker.session_id || task.assignee === worker.role)
            .map((task) => task.updated_at),
          ...sigs
            .filter((sig) => sig.from === worker.session_id || sig.from === worker.role || sig.from === worker.agent)
            .map((sig) => sig.timestamp),
        ].reduce((max, item) => (item > max ? item : max), 0)
        return Boolean(time) && Date.now() - time > stale && worker.status === "active"
      })
        ? Attention.enum.stale_worker
        : undefined,
      talkCount.no_consensus > 0 ? Attention.enum.no_consensus : undefined,
    ].filter((item): item is Attention => item !== undefined)
    const item = Overview.parse({
      swarm_id: info.id,
      goal: info.goal,
      goal_summary: goal(info.goal),
      conductor_label: "Conductor",
      conductor_session: info.conductor,
      status: state(info, taskCount),
      current_phase: phase(info, tasks, disc),
      updated_at: last,
      deleted_at: info.time.deleted,
      task_counts: taskCount,
      discussion_counts: talkCount,
      needs_attention: attention.length > 0,
      attention,
    })
    return { info, tasks, arts, sigs, taskList, disc, item }
  }

  function agents(info: Swarm.Info, tasks: TaskInfo[], sigs: BoardSignal.Info[], disc: DiscussionInfo[]) {
    const list = [
      {
        id: "conductor",
        label: "Conductor",
        session_id: info.conductor,
        role: "Conductor",
        task_id: undefined,
        status: "active" as const,
        agent: "conductor",
      },
      ...info.workers.map((worker) => ({
        id: worker.session_id,
        label: worker.role ?? worker.agent,
        session_id: worker.session_id,
        role: worker.role,
        task_id: worker.task_id,
        status: worker.status,
        agent: worker.agent,
      })),
    ]
    return list.map((item) => {
      const task_ids = tasks
        .filter(
          (task) =>
            task.assignee === item.session_id ||
            task.assignee === item.role ||
            task.assignee === item.agent ||
            task.id === item.task_id,
        )
        .map((task) => task.id)
      const current = tasks.find((task) => task.id === item.task_id)
      const recent = sigs
        .filter((sig) => sig.from === item.session_id || sig.from === item.role || sig.from === item.agent)
        .toSorted((a, b) => b.timestamp - a.timestamp)[0]
      const reason =
        current?.blocked_reason ?? (recent?.type === "failed" || recent?.type === "blocked" ? sum(recent) : undefined)
      const recent_activity_at = [
        ...(current ? [current.updated_at] : []),
        ...(recent ? [recent.timestamp] : []),
      ].reduce((max, value) => (value > max ? value : max), 0)
      const state =
        current?.status === "failed" || item.status === "failed"
          ? "failed"
          : reason
            ? "blocked"
            : current?.status === "completed" || item.status === "done"
              ? "done"
              : SessionStatus.get(item.session_id).type === "idle" || item.status === "idle"
                ? "idle"
                : "active"
      return AgentInfo.parse({
        id: item.id,
        label: item.label,
        session_id: item.session_id,
        status: state,
        task_count: task_ids.length,
        recent_activity_at: recent_activity_at || null,
        current_task: current?.id ?? null,
        recent_progress: recent
          ? sum(recent)
          : current
            ? `${current.summary} is ${current.status.replace("_", " ")}`
            : null,
        reason: reason ?? null,
        task_ids,
        discussion_channels: disc
          .filter((entry) => entry.participants.includes(item.label) || task_ids.includes(entry.id))
          .map((entry) => entry.channel),
      })
    })
  }

  export async function list(input?: { status?: string; include_deleted?: boolean; needs_attention?: boolean }) {
    const info = await Swarm.list({ include_deleted: input?.include_deleted })
    const list = await Promise.all(info.map((item) => collect(item.id, input?.include_deleted)))
    return list
      .map((item) => item.item)
      .filter((item) => {
        if (input?.status && input.status !== "all" && item.status !== input.status) return false
        if (input?.needs_attention && !item.needs_attention) return false
        return true
      })
      .toSorted((a, b) => b.updated_at - a.updated_at)
  }

  export async function get(
    id: string,
    input?: {
      include_deleted?: boolean
      assignee?: string
      status?: string
      type?: string
    },
  ) {
    const base = await collect(id, input?.include_deleted)
    const people = agents(base.info, base.taskList, base.sigs, base.disc)
    const tasks = base.taskList.filter((task) => {
      if (input?.assignee && task.assignee !== input.assignee) return false
      if (input?.status && task.status !== input.status) return false
      if (input?.type && task.type !== input.type) return false
      return true
    })
    const plan_summary = plan(base.info, base.arts, base.tasks, base.disc, base.sigs)
    return Detail.parse({
      overview: base.item,
      goal: base.info.goal,
      current_phase: base.item.current_phase,
      plan_summary,
      risk_summary: risk(base.info, base.arts, base.taskList, base.disc, people),
      plan_empty: plan_summary === "No conductor plan is available yet.",
      plan_empty_copy: "No conductor plan is available yet.",
      last_decision_at: planArt(base.info, base.arts)?.created_at ?? null,
      actions: actions(base.info, base.tasks, base.arts, base.sigs),
      tasks,
      task_filters: {
        assignees: [
          ...new Set(base.taskList.map((task) => task.assignee).filter((item): item is string => Boolean(item))),
        ].toSorted(),
        statuses: [...new Set(base.taskList.map((task) => task.status))].toSorted(),
        types: [...new Set(base.taskList.map((task) => task.type))].toSorted(),
      },
      agents: people,
      discussions: base.disc,
      recent_signals: base.sigs.toSorted((a, b) => b.timestamp - a.timestamp).slice(0, 20),
    })
  }
}
