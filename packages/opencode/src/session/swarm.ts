import z from "zod"
import path from "path"
import fs from "fs/promises"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Lock } from "../util/lock"
import { Log } from "../util/log"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { SharedBoard, BoardSignal } from "../board"
import { Discussion } from "../board/discussion"
import { Session } from "."
import { SessionPrompt } from "./prompt"
import { SessionStatus } from "./status"
import { SessionMetadata } from "./session-metadata"
import { SwarmState } from "./swarm-state"
import { Config } from "../config/config"

export namespace Swarm {
  const log = Log.create({ service: "swarm" })

  export const WorkerStatus = SwarmState.WorkerStatus

  export const Worker = z.object({
    session_id: z.string(),
    agent: z.string(),
    role: z.string().optional(),
    task_id: z.string(),
    status: WorkerStatus,
    updated_at: z.number().default(() => Date.now()),
    reason: z.string().nullable().default(null),
    evidence: z.array(z.string()).default([]),
  })
  export type Worker = z.infer<typeof Worker>

  export const Status = SwarmState.Status
  export type Status = z.infer<typeof Status>

  export const Stage = SwarmState.Stage
  export type Stage = z.infer<typeof Stage>

  export const Info = z.object({
    id: z.string(),
    goal: z.string(),
    conductor: z.string(),
    workers: z.array(Worker).default([]),
    config: z.object({
      max_workers: z.number().default(4),
      auto_escalate: z.boolean().default(true),
      verify_on_complete: z.boolean().default(true),
      wait_timeout_seconds: z.number().int().positive().default(600),
    }),
    status: Status,
    stage: Stage,
    reason: z.string().nullable().default(null),
    resume: z.object({ stage: Stage.nullable().default(null) }).default({ stage: null }),
    visibility: z.object({ archived_at: z.number().nullable().default(null) }).default({ archived_at: null }),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      completed: z.number().optional(),
      stopped: z.number().optional(),
      deleted: z.number().optional(),
    }),
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Created: BusEvent.define("swarm.created", z.object({ swarm: Info })),
    Updated: BusEvent.define("swarm.updated", z.object({ swarm: Info })),
    Completed: BusEvent.define("swarm.completed", z.object({ swarm: Info })),
    Failed: BusEvent.define("swarm.failed", z.object({ swarm: Info })),
  }

  const KEY = "swarm-registry"

  function filepath(): string {
    return path.join(Global.Path.data, "projects", Instance.project.id, "board", "swarms.json")
  }

  async function ensure() {
    await fs.mkdir(path.dirname(filepath()), { recursive: true })
  }

  async function loadAll(): Promise<Info[]> {
    await ensure()
    using _ = await Lock.read(KEY)
    const file = Bun.file(filepath())
    if (!(await file.exists())) return []
    const data = await file.json().catch(() => [])
    return z.array(Info).parse(data)
  }

  async function saveAll(swarms: Info[]) {
    await ensure()
    using _ = await Lock.write(KEY)
    await Bun.write(filepath(), JSON.stringify(swarms, null, 2))
  }

  async function sync(info: Info) {
    const state =
      (await SwarmState.read(info.id)) ??
      SwarmState.create({
        id: info.id,
        goal: info.goal,
        conductor: info.conductor,
        config: info.config,
        time: { created: info.time.created, updated: info.time.updated },
      })
    const prev = structuredClone(state)
    state.swarm.goal = info.goal
    state.swarm.conductor = info.conductor
    state.swarm.config = info.config
    state.swarm.status = info.status
    state.swarm.stage = info.stage
    state.swarm.reason = info.reason
    state.swarm.resume.stage = info.resume.stage
    state.swarm.visibility.archived_at = info.visibility.archived_at
    state.swarm.time.created = info.time.created
    state.swarm.time.updated = info.time.updated
    state.swarm.time.completed = info.time.completed ?? null
    state.swarm.time.stopped = info.time.stopped ?? null
    state.swarm.time.deleted = info.time.deleted ?? null
    state.workers = Object.fromEntries(
      info.workers.map((worker) => [
        worker.session_id,
        {
          id: worker.session_id,
          session_id: worker.session_id,
          agent: worker.agent,
          role: worker.role ?? null,
          task_id: worker.task_id || null,
          status: worker.status,
          updated_at: worker.updated_at,
          reason: worker.reason,
          evidence: worker.evidence,
        },
      ]),
    )
    SwarmState.align(state)
    if (prev.schema_version === state.schema_version) SwarmState.check(prev, state)
    let transition: SwarmState.Transition | undefined
    if (prev.schema_version === state.schema_version) {
      state.rev = prev.rev + 1
      state.seq = prev.seq + 1
      state.audit.last_txn = crypto.randomUUID()
      transition = {
        txn: state.audit.last_txn,
        actor: "coordinator",
        reason: "sync swarm info",
        at: Date.now(),
        rev: state.rev,
        seq: state.seq,
      }
      state.audit.entries.push(transition)
    }
    const checked = SwarmState.Snapshot.parse(state)
    await SwarmState.write(checked)
    if (transition) {
      Bus.publish(SwarmState.Event.Transition, { swarm_id: checked.swarm.id, snapshot: checked, transition })
      log.info("swarm transition", { swarmID: checked.swarm.id, ...transition })
    }
  }

  export async function save(info: Info) {
    const all = await loadAll()
    const idx = all.findIndex((s) => s.id === info.id)
    if (idx >= 0) all[idx] = info
    else all.push(info)
    await sync(info)
    await saveAll(all)
  }

  function visible(info: Info, include_deleted?: boolean) {
    if (include_deleted) return true
    return info.visibility.archived_at === null
  }

  export async function load(id: string, input?: { include_deleted?: boolean }): Promise<Info | undefined> {
    const all = await loadAll()
    const info = all.find((s) => s.id === id)
    if (!info || !visible(info, input?.include_deleted)) return undefined
    return info
  }

  export async function list(input?: { include_deleted?: boolean }): Promise<Info[]> {
    return (await loadAll()).filter((info) => visible(info, input?.include_deleted))
  }

  export async function replaceWorkerSession(swarmID: string, old: string, next: string): Promise<void> {
    const info = await load(swarmID)
    if (!info) throw new Error(`Swarm not found: ${swarmID}`)

    // Copy metadata from old session to new session
    const meta = SessionMetadata.get(old)
    if (meta) {
      for (const key of ["swarm_id", "task_id", "discussion_channel"] as const) {
        if (meta[key] !== undefined) SessionMetadata.set(next, key, meta[key])
      }
    }

    // Replace conductor or worker reference
    if (info.conductor === old) {
      info.conductor = next
    } else {
      const worker = info.workers.find((w) => w.session_id === old)
      if (worker) worker.session_id = next
    }

    info.time.updated = Date.now()
    await save(info)
    Bus.publish(Event.Updated, { swarm: info })
    log.info("replaced session", { swarmID, old, next })
  }

  export async function launch(input: { goal: string; config?: Partial<Info["config"]> }): Promise<Info> {
    const id = `SW-${crypto.randomUUID()}`
    await SharedBoard.init(id)
    const cfg = await Config.get()

    const session = await Session.create({
      title: `Swarm: ${input.goal.slice(0, 50)}`,
    })

    SessionMetadata.set(session.id, "swarm_id", id)

    const now = Date.now()
    const info: Info = {
      id,
      goal: input.goal,
      conductor: session.id,
      workers: [],
      config: {
        max_workers: input.config?.max_workers ?? cfg.swarm?.max_workers ?? 4,
        auto_escalate: input.config?.auto_escalate ?? cfg.swarm?.auto_escalate ?? true,
        verify_on_complete: input.config?.verify_on_complete ?? cfg.swarm?.verify_on_complete ?? true,
        wait_timeout_seconds: input.config?.wait_timeout_seconds ?? cfg.swarm?.wait_timeout_seconds ?? 600,
      },
      status: "active",
      stage: "planning",
      reason: null,
      resume: { stage: null },
      visibility: { archived_at: null },
      time: { created: now, updated: now },
    }
    await save(info)

    // Send goal to conductor (async — don't await completion)
    SessionPrompt.prompt({
      sessionID: session.id,
      agent: "conductor",
      parts: [{ type: "text" as const, text: input.goal }],
    }).catch((e) => log.error("conductor prompt failed", { error: e }))

    Bus.publish(Event.Created, { swarm: info })
    monitor(id).catch((e) => log.warn("monitor setup failed", { error: e }))
    return info
  }

  export async function status(id: string, input?: { include_deleted?: boolean }): Promise<Info> {
    const info = await load(id, input)
    if (!info) throw new Error(`Swarm not found: ${id}`)
    const now = Date.now()
    let changed = false
    // Merge live session status for workers
    for (const w of info.workers) {
      const ss = SessionStatus.get(w.session_id)
      if (ss && ss.type === "idle" && w.status === "running") {
        w.status = "waiting"
        w.updated_at = now
        changed = true
      }
      if (w.status === "waiting" && now - w.updated_at >= info.config.wait_timeout_seconds * 1000) {
        w.status = "blocked"
        w.reason = `wait timeout after ${info.config.wait_timeout_seconds}s`
        w.updated_at = now
        changed = true
      }
    }
    if (info.workers.some((worker) => worker.status === "blocked") && info.status === "active") {
      info.status = "blocked"
      info.reason = info.reason ?? "worker blocked"
      changed = true
    }
    if (changed) {
      info.time.updated = now
      await save(info)
    }
    return info
  }

  export async function pause(id: string): Promise<Info> {
    const info = await load(id)
    if (!info) throw new Error(`Swarm not found: ${id}`)
    for (const w of info.workers) {
      if (["queued", "starting", "running", "waiting"].includes(w.status)) SessionPrompt.cancel(w.session_id)
    }
    info.resume.stage = info.stage
    info.status = "paused"
    info.stage = info.resume.stage ?? info.stage
    info.time.updated = Date.now()
    await save(info)
    Bus.publish(Event.Updated, { swarm: info })
    return info
  }

  export async function resume(id: string): Promise<Info> {
    const info = await load(id)
    if (!info) throw new Error(`Swarm not found: ${id}`)
    info.status = "active"
    info.stage = info.resume.stage ?? info.stage
    info.resume.stage = null
    info.time.updated = Date.now()
    await save(info)
    Bus.publish(Event.Updated, { swarm: info })
    return info
  }

  export async function stop(id: string): Promise<Info> {
    const info = await load(id)
    if (!info) throw new Error(`Swarm not found: ${id}`)
    for (const w of info.workers) {
      if (["queued", "starting", "running", "waiting", "blocked"].includes(w.status)) {
        SessionPrompt.cancel(w.session_id)
        w.status = "stopped"
        w.updated_at = Date.now()
      }
    }
    SessionPrompt.cancel(info.conductor)
    const now = Date.now()
    info.status = "stopped"
    info.stage = "idle"
    info.resume.stage = null
    info.time.updated = now
    info.time.completed = now
    info.time.stopped = now
    await save(info)
    Bus.publish(Event.Failed, { swarm: info })
    cleanup(id)
    return info
  }

  export async function remove(id: string): Promise<Info> {
    const info = await load(id, { include_deleted: true })
    if (!info) throw new Error(`Swarm not found: ${id}`)
    if (info.status === "active" || info.status === "paused" || info.status === "blocked") {
      throw new Error(`Cannot archive running swarm: ${id}`)
    }
    if (info.visibility.archived_at) return info
    info.visibility.archived_at = Date.now()
    info.time.updated = info.visibility.archived_at
    await save(info)
    Bus.publish(Event.Updated, { swarm: info })
    return info
  }

  export async function unarchive(id: string): Promise<Info> {
    const info = await load(id, { include_deleted: true })
    if (!info) throw new Error(`Swarm not found: ${id}`)
    if (!info.visibility.archived_at) return info
    info.visibility.archived_at = null
    info.time.updated = Date.now()
    await save(info)
    Bus.publish(Event.Updated, { swarm: info })
    return info
  }

  export async function purge(id: string): Promise<void> {
    const info = await load(id, { include_deleted: true })
    if (!info) throw new Error(`Swarm not found: ${id}`)
    if (!["completed", "failed", "stopped"].includes(info.status)) {
      throw new Error(`Cannot purge non-terminal swarm: ${id}`)
    }
    const state = await SwarmState.read(id)
    if (!state) throw new Error(`Swarm state not found: ${id}`)
    if (
      Object.values(state.workers).some(
        (worker) => !["completed", "failed", "cancelled", "stopped"].includes(worker.status),
      )
    ) {
      throw new Error(`Cannot purge swarm with active workers: ${id}`)
    }
    if (["pending", "running", "repair_required"].includes(state.verify.status)) {
      throw new Error(`Cannot purge swarm with active verify state: ${id}`)
    }
    if (
      Object.values(state.discussions).some(
        (item) => !["idle", "decided", "exhausted", "failed", "cancelled"].includes(item.status),
      )
    ) {
      throw new Error(`Cannot purge swarm with active discussions: ${id}`)
    }
    const all = await loadAll()
    await saveAll(all.filter((item) => item.id !== id))
    await fs.rm(path.join(Global.Path.data, "projects", Instance.project.id, "board", id), {
      recursive: true,
      force: true,
    })
  }

  export async function intervene(id: string, message: string): Promise<void> {
    const info = await load(id)
    if (!info) throw new Error(`Swarm not found: ${id}`)
    SessionPrompt.prompt({
      sessionID: info.conductor,
      parts: [{ type: "text" as const, text: message }],
    }).catch((e) => log.error("intervene failed", { error: e }))
  }

  // Monitor state
  const monitors = new Map<string, Array<() => void>>()

  function cleanup(id: string) {
    const subs = monitors.get(id)
    if (subs) {
      for (const unsub of subs) unsub()
      monitors.delete(id)
    }
  }

  export async function discuss(input: {
    topic: string
    roles: Array<{ name: string; perspective: string }>
    max_rounds?: number
    config?: Partial<Info["config"]>
  }): Promise<Info> {
    const rounds = input.max_rounds ?? 3
    const channel = "discuss-" + crypto.randomUUID().slice(0, 8)
    const roleList = input.roles.map((r, i) => `${i + 1}. Role: "${r.name}" — Perspective: ${r.perspective}`).join("\n")
    const goal = [
      `## Discussion: ${input.topic}`,
      "",
      "Orchestrate a structured multi-role discussion on this topic.",
      "",
      "### Steps",
      `1. Create a "discuss" task on the board with channel name "${channel}"`,
      `2. When calling delegate_task for each role, set role_name="{name}" and discussion_channel="${channel}". All Workers use the default sisyphus agent.`,
      '   Include the role perspective and instruct the Worker to read the channel and post "proposal" signals (round 1), then "opinion"/"objection" signals (round 2+).',
      "3. After each round, check the channel for signals. Relay summaries to Workers for the next round.",
      `4. After ${rounds} rounds or when all Workers post "consensus" signals, summarize and create a "decision" artifact.`,
      "",
      "### Roles",
      roleList,
      "",
      `### Max Rounds: ${rounds}`,
    ].join("\n")
    const info = await launch({ goal, config: input.config })
    // Initialize discussion tracker (workers populated as Conductor delegates)
    await Discussion.start(info.id, channel, [], rounds).catch((e) => log.warn("discussion init failed", { error: e }))
    return info
  }

  async function monitor(id: string) {
    const info = await load(id)
    if (!info) return

    const subs: Array<() => void> = []
    monitors.set(id, subs)

    // Watch for done/failed/blocked/conflict and discussion signals
    const relayed = ["done", "failed", "blocked", "conflict", "proposal", "opinion", "objection", "consensus"]
    subs.push(
      BoardSignal.watch(id, undefined, async (signal) => {
        if (!relayed.includes(signal.type)) return
        const snap = await SharedBoard.snapshot(id)
        const isDiscussion = ["proposal", "opinion", "objection", "consensus"].includes(signal.type)
        const current = await load(id)
        if (!current || current.status === "completed" || current.status === "failed" || current.status === "stopped")
          return

        if (isDiscussion && signal.channel) {
          const round = (signal.payload.round as number) ?? 1
          const roundState = await Discussion.record(id, signal.channel, signal.from, round).catch(() => null)
          const summary = (signal.payload.summary as string) ?? JSON.stringify(signal.payload).slice(0, 200)
          let text = `[Discussion] ${signal.from} posted ${signal.type}: ${summary}`
          if (roundState?.complete) {
            const max = roundState.max_rounds
            const final = round >= max
            const thread = await BoardSignal.thread(id, signal.channel)
            const opinions = thread
              .filter((s) => (s.payload.round as number) === round)
              .map((s) => `  [${s.from}] ${s.type}: ${((s.payload.summary as string) ?? "").slice(0, 200)}`)
              .join("\n")
            text = `[Discussion Round ${round} Complete — round ${round}/${max}${final ? ", FINAL" : ""}] All ${roundState.expected.length} roles have spoken:\n${opinions}`
            if (signal.type === "consensus" || final) {
              const votes = await Discussion.tally(id, signal.channel)
              text += `\n\nConsensus tally: ${votes.agree} agree, ${votes.disagree} disagree, ${votes.modify} modify (${votes.unanimous ? "UNANIMOUS" : "NOT unanimous"})`
            }
            if (!final) {
              text += `\n\nNext action: call board_write advance_round, then prompt each role for round ${round + 1}.`
            }
            if (final) {
              text += `\n\nAll rounds exhausted. Make final decision and post decision artifact.`
            }
          }
          SessionPrompt.prompt({
            sessionID: current.conductor,
            parts: [{ type: "text" as const, text }],
          }).catch((e) => log.warn("monitor signal relay failed", { error: e }))
          return
        }

        const text = `[Swarm Signal] ${signal.type} from ${signal.from}: ${JSON.stringify(signal.payload)}\n\nBoard stats: ${snap.stats.completed}/${snap.stats.total} completed, ${snap.stats.failed} failed, ${snap.stats.running} running`
        SessionPrompt.prompt({
          sessionID: current.conductor,
          parts: [{ type: "text" as const, text }],
        }).catch((e) => log.warn("monitor signal relay failed", { error: e }))
      }),
    )
  }
}
