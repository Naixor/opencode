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

export namespace Swarm {
  const log = Log.create({ service: "swarm" })

  export const WorkerStatus = z.enum(["active", "idle", "done", "failed"])

  export const Worker = z.object({
    session_id: z.string(),
    agent: z.string(),
    role: z.string().optional(),
    task_id: z.string(),
    status: WorkerStatus,
  })
  export type Worker = z.infer<typeof Worker>

  export const Status = z.enum(["planning", "running", "paused", "completed", "failed"])
  export type Status = z.infer<typeof Status>

  export const Info = z.object({
    id: z.string(),
    goal: z.string(),
    conductor: z.string(),
    workers: z.array(Worker).default([]),
    config: z.object({
      max_workers: z.number().default(4),
      auto_escalate: z.boolean().default(true),
      verify_on_complete: z.boolean().default(true),
    }),
    status: Status,
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

  export async function save(info: Info) {
    const all = await loadAll()
    const idx = all.findIndex((s) => s.id === info.id)
    if (idx >= 0) all[idx] = info
    else all.push(info)
    await saveAll(all)
  }

  function visible(info: Info, include_deleted?: boolean) {
    if (include_deleted) return true
    return info.time.deleted === undefined
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
        max_workers: input.config?.max_workers ?? 4,
        auto_escalate: input.config?.auto_escalate ?? true,
        verify_on_complete: input.config?.verify_on_complete ?? true,
      },
      status: "planning",
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
    // Merge live session status for workers
    for (const w of info.workers) {
      const ss = SessionStatus.get(w.session_id)
      if (ss && ss.type === "idle" && w.status === "active") {
        w.status = "idle"
      }
    }
    return info
  }

  export async function pause(id: string): Promise<Info> {
    const info = await load(id)
    if (!info) throw new Error(`Swarm not found: ${id}`)
    for (const w of info.workers) {
      if (w.status === "active") SessionPrompt.cancel(w.session_id)
    }
    info.status = "paused"
    info.time.updated = Date.now()
    await save(info)
    Bus.publish(Event.Updated, { swarm: info })
    return info
  }

  export async function resume(id: string): Promise<Info> {
    const info = await load(id)
    if (!info) throw new Error(`Swarm not found: ${id}`)
    info.status = "running"
    info.time.updated = Date.now()
    await save(info)
    Bus.publish(Event.Updated, { swarm: info })
    return info
  }

  export async function stop(id: string): Promise<Info> {
    const info = await load(id)
    if (!info) throw new Error(`Swarm not found: ${id}`)
    for (const w of info.workers) {
      SessionPrompt.cancel(w.session_id)
    }
    SessionPrompt.cancel(info.conductor)
    const now = Date.now()
    info.status = "failed"
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
    if (info.status === "planning" || info.status === "running" || info.status === "paused") {
      throw new Error(`Cannot delete running swarm: ${id}`)
    }
    if (info.time.deleted) return info
    info.time.deleted = Date.now()
    info.time.updated = info.time.deleted
    await save(info)
    Bus.publish(Event.Updated, { swarm: info })
    return info
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
        if (!current || current.status === "completed" || current.status === "failed") return

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
