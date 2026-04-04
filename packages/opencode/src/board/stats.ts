import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Lock } from "../util/lock"
import { Log } from "../util/log"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Bus } from "@/bus"
import { BoardTask } from "./task"

export namespace SwarmStats {
  const log = Log.create({ service: "board.stats" })

  export const AgentStats = z.object({
    tasks_completed: z.number().default(0),
    tasks_failed: z.number().default(0),
    avg_steps: z.number().default(0),
    avg_duration_ms: z.number().default(0),
    retry_rate: z.number().default(0),
    types_completed: z.record(z.string(), z.number()).default({}),
    escalation_count: z.number().default(0),
  })
  export type AgentStats = z.infer<typeof AgentStats>

  const KEY = "board-stats"

  function filepath(): string {
    return path.join(Global.Path.data, "projects", Instance.project.id, "board", "stats.json")
  }

  async function load(): Promise<Record<string, AgentStats>> {
    using _ = await Lock.read(KEY)
    const file = Bun.file(filepath())
    if (!(await file.exists())) return {}
    const data = await file.json().catch(() => ({}))
    return data as Record<string, AgentStats>
  }

  async function save(data: Record<string, AgentStats>) {
    await fs.mkdir(path.dirname(filepath()), { recursive: true })
    using _ = await Lock.write(KEY)
    await Bun.write(filepath(), JSON.stringify(data, null, 2))
  }

  export async function record(input: {
    agent: string
    type: string
    steps: number
    duration: number
    success: boolean
    escalated: boolean
  }) {
    const all = await load()
    const stats = all[input.agent] ?? AgentStats.parse({})
    const total = stats.tasks_completed + stats.tasks_failed
    if (input.success) {
      stats.tasks_completed++
      stats.types_completed[input.type] = (stats.types_completed[input.type] ?? 0) + 1
    } else {
      stats.tasks_failed++
    }
    if (input.escalated) stats.escalation_count++
    stats.avg_steps = (stats.avg_steps * total + input.steps) / (total + 1)
    stats.avg_duration_ms = (stats.avg_duration_ms * total + input.duration) / (total + 1)
    const done = stats.tasks_completed + stats.tasks_failed
    stats.retry_rate = done > 0 ? stats.escalation_count / done : 0
    all[input.agent] = stats
    await save(all)
  }

  export async function get(): Promise<Record<string, AgentStats>> {
    return load()
  }

  export async function recommend(type: string): Promise<string | undefined> {
    const all = await load()
    let best: string | undefined
    let rate = -1
    for (const [agent, stats] of Object.entries(all)) {
      const done = stats.tasks_completed + stats.tasks_failed
      if (done === 0) continue
      const success = stats.tasks_completed / done
      const typed = stats.types_completed[type] ?? 0
      const score = success * 0.7 + (typed > 0 ? 0.3 : 0)
      if (score > rate) {
        rate = score
        best = agent
      }
    }
    return best
  }

  export function subscribe() {
    Bus.subscribe(BoardTask.Event.Updated, async (evt) => {
      const task = evt.properties.task
      if (task.status !== "completed" && task.status !== "failed") return
      if (!task.assignee) return
      await record({
        agent: task.assignee,
        type: task.type,
        steps: 0,
        duration: task.updatedAt - task.createdAt,
        success: task.status === "completed",
        escalated: false,
      }).catch((e) => log.warn("failed to record stats", { error: e }))
    })
  }
}
