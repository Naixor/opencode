import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Bus } from "@/bus"
import { BoardTask } from "./task"
import { BoardArtifact } from "./artifact"
import { BoardSignal } from "./signal"

export { BoardTask } from "./task"
export { BoardArtifact } from "./artifact"
export { BoardSignal } from "./signal"

export namespace SharedBoard {
  export const Event = {
    TaskCreated: BoardTask.Event.Created,
    TaskUpdated: BoardTask.Event.Updated,
    TaskDeleted: BoardTask.Event.Deleted,
    ArtifactCreated: BoardArtifact.Event.Created,
    Signal: BoardSignal.Event.Signal,
  }

  export interface Snapshot {
    tasks: BoardTask.Info[]
    artifacts: BoardArtifact.Info[]
    recentSignals: BoardSignal.Info[]
    stats: {
      total: number
      pending: number
      running: number
      completed: number
      failed: number
      workers: number
      last_updated: number
    }
  }

  let cache: { swarm: string; data: Snapshot; time: number } | undefined
  const TTL = 5000

  function invalidate() {
    cache = undefined
  }

  // Invalidate cache on any board event
  const subs: Array<() => void> = []
  export function startCacheInvalidation() {
    if (subs.length > 0) return
    subs.push(Bus.subscribe(Event.TaskCreated, invalidate))
    subs.push(Bus.subscribe(Event.TaskUpdated, invalidate))
    subs.push(Bus.subscribe(Event.TaskDeleted, invalidate))
    subs.push(Bus.subscribe(Event.ArtifactCreated, invalidate))
    subs.push(Bus.subscribe(Event.Signal, invalidate))
  }

  export async function snapshot(swarm: string): Promise<Snapshot> {
    if (cache && cache.swarm === swarm && Date.now() - cache.time < TTL) return cache.data
    const [tasks, artifacts, signals] = await Promise.all([
      BoardTask.list(swarm),
      BoardArtifact.list({ swarm_id: swarm }),
      BoardSignal.recent(swarm, undefined, 50),
    ])
    const workers = new Set(tasks.filter((t) => t.assignee && t.status === "in_progress").map((t) => t.assignee))
    const data: Snapshot = {
      tasks,
      artifacts,
      recentSignals: signals,
      stats: {
        total: tasks.length,
        pending: tasks.filter((t) => t.status === "pending").length,
        running: tasks.filter((t) => t.status === "in_progress").length,
        completed: tasks.filter((t) => t.status === "completed").length,
        failed: tasks.filter((t) => t.status === "failed").length,
        workers: workers.size,
        last_updated: Date.now(),
      },
    }
    cache = { swarm, data, time: Date.now() }
    return data
  }

  function boardDir(swarm: string): string {
    return path.join(Global.Path.data, "projects", Instance.project.id, "board", swarm)
  }

  export async function init(swarm: string): Promise<void> {
    const base = boardDir(swarm)
    await fs.mkdir(path.join(base, "tasks"), { recursive: true })
    await fs.mkdir(path.join(base, "artifacts"), { recursive: true })
  }
}
