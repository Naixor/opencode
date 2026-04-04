import z from "zod"
import path from "path"
import fs from "fs/promises"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Lock } from "../util/lock"
import { Log } from "../util/log"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { ScopeLock } from "./scope-lock"

export namespace BoardTask {
  const log = Log.create({ service: "board.task" })

  export const Type = z.enum(["implement", "review", "test", "investigate", "fix", "refactor", "discuss"])
  export type Type = z.infer<typeof Type>

  export const Status = z.enum(["pending", "in_progress", "completed", "failed", "cancelled"])
  export type Status = z.infer<typeof Status>

  export const Info = z.object({
    id: z.string(),
    subject: z.string(),
    description: z.string().optional(),
    status: Status,
    blockedBy: z.array(z.string()).default([]),
    blocks: z.array(z.string()).default([]),
    assignee: z.string().optional(),
    type: Type,
    scope: z.array(z.string()).default([]),
    artifacts: z.array(z.string()).default([]),
    swarm_id: z.string(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Created: BusEvent.define("board.task.created", z.object({ task: Info })),
    Updated: BusEvent.define("board.task.updated", z.object({ task: Info })),
    Deleted: BusEvent.define("board.task.deleted", z.object({ id: z.string(), swarm_id: z.string() })),
  }

  function dir(swarm: string): string {
    return path.join(Global.Path.data, "projects", Instance.project.id, "board", swarm, "tasks")
  }

  function filepath(swarm: string, id: string): string {
    return path.join(dir(swarm), `${id}.json`)
  }

  function key(id: string): string {
    return `board-task:${id}`
  }

  async function ensure(swarm: string) {
    await fs.mkdir(dir(swarm), { recursive: true })
  }

  export async function create(input: {
    subject: string
    description?: string
    type: Type
    scope?: string[]
    swarm_id: string
    blockedBy?: string[]
    blocks?: string[]
    assignee?: string
    metadata?: Record<string, unknown>
  }): Promise<Info> {
    await ensure(input.swarm_id)
    const id = `BT-${crypto.randomUUID()}`
    const now = Date.now()
    const task: Info = {
      id,
      subject: input.subject,
      description: input.description,
      status: "pending",
      blockedBy: input.blockedBy ?? [],
      blocks: input.blocks ?? [],
      assignee: input.assignee,
      type: input.type,
      scope: input.scope ?? [],
      artifacts: [],
      swarm_id: input.swarm_id,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    }
    using _ = await Lock.write(key(id))
    await Bun.write(filepath(input.swarm_id, id), JSON.stringify(task, null, 2))
    Bus.publish(Event.Created, { task })
    return task
  }

  export async function get(swarm: string, id: string): Promise<Info> {
    using _ = await Lock.read(key(id))
    const file = Bun.file(filepath(swarm, id))
    if (!(await file.exists())) throw new Error(`Board task not found: ${id}`)
    return Info.parse(await file.json())
  }

  export async function list(swarm: string): Promise<Info[]> {
    await ensure(swarm)
    const files = await fs.readdir(dir(swarm)).catch(() => [] as string[])
    const tasks = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const id = f.slice(0, -5)
          using _ = await Lock.read(key(id))
          return Bun.file(path.join(dir(swarm), f))
            .json()
            .then((data) => Info.parse(data))
            .catch((e) => {
              log.warn("failed to read board task", { file: f, error: e })
              return undefined
            })
        }),
    )
    return tasks.filter((t): t is Info => t !== undefined)
  }

  export async function ready(swarm: string): Promise<Info[]> {
    const all = await list(swarm)
    const map = new Map(all.map((t) => [t.id, t.status]))
    return all.filter((t) => {
      if (t.status !== "pending") return false
      return t.blockedBy.every((dep) => map.get(dep) === "completed")
    })
  }

  export async function update(
    swarm: string,
    id: string,
    changes: Partial<
      Pick<
        Info,
        "subject" | "description" | "status" | "blockedBy" | "blocks" | "assignee" | "scope" | "artifacts" | "metadata"
      >
    >,
  ): Promise<Info> {
    const fp = filepath(swarm, id)
    using _ = await Lock.write(key(id))
    const file = Bun.file(fp)
    if (!(await file.exists())) throw new Error(`Board task not found: ${id}`)
    const current = Info.parse(await file.json())
    const updated: Info = {
      ...current,
      ...changes,
      updatedAt: Date.now(),
    }
    await Bun.write(fp, JSON.stringify(updated, null, 2))
    if (updated.status === "completed" || updated.status === "cancelled" || updated.status === "failed") {
      ScopeLock.unlock(swarm, id)
    }
    Bus.publish(Event.Updated, { task: updated })
    return updated
  }

  export async function remove(swarm: string, id: string): Promise<void> {
    using _ = await Lock.write(key(id))
    await fs.unlink(filepath(swarm, id)).catch(() => {
      throw new Error(`Board task not found: ${id}`)
    })
    Bus.publish(Event.Deleted, { id, swarm_id: swarm })
  }
}
