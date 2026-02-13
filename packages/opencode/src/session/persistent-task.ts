import z from "zod"
import path from "path"
import fs from "fs/promises"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "../project/instance"
import { Lock } from "../util/lock"
import { Log } from "../util/log"

export namespace PersistentTask {
  const log = Log.create({ service: "persistent-task" })

  export const Status = z.enum(["pending", "in_progress", "completed", "failed", "cancelled"])
  export type Status = z.infer<typeof Status>

  const VALID_TRANSITIONS: Record<string, string[]> = {
    pending: ["in_progress", "cancelled"],
    in_progress: ["completed", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  }

  export const Info = z.object({
    id: z.string(),
    subject: z.string(),
    description: z.string().optional(),
    status: Status,
    blockedBy: z.array(z.string()).default([]),
    blocks: z.array(z.string()).default([]),
    owner: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    activeForm: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Created: BusEvent.define(
      "persistent-task.created",
      z.object({ task: Info }),
    ),
    Updated: BusEvent.define(
      "persistent-task.updated",
      z.object({ task: Info }),
    ),
    Deleted: BusEvent.define(
      "persistent-task.deleted",
      z.object({ id: z.string() }),
    ),
  }

  function tasksDir(): string {
    return path.join(Instance.directory, ".opencode", "tasks")
  }

  function taskPath(id: string): string {
    return path.join(tasksDir(), `${id}.json`)
  }

  function lockKey(id: string): string {
    return `persistent-task:${id}`
  }

  function generateID(): string {
    return `T-${crypto.randomUUID()}`
  }

  async function ensureDir(): Promise<void> {
    await fs.mkdir(tasksDir(), { recursive: true })
  }

  export async function create(input: {
    subject: string
    description?: string
    owner?: string
    blockedBy?: string[]
    blocks?: string[]
    metadata?: Record<string, unknown>
    activeForm?: string
  }): Promise<Info> {
    await ensureDir()
    const id = generateID()
    const now = Date.now()
    const task: Info = {
      id,
      subject: input.subject,
      description: input.description,
      status: "pending",
      blockedBy: input.blockedBy ?? [],
      blocks: input.blocks ?? [],
      owner: input.owner,
      metadata: input.metadata ?? {},
      activeForm: input.activeForm,
      createdAt: now,
      updatedAt: now,
    }
    const filePath = taskPath(id)
    using _ = await Lock.write(lockKey(id))
    await Bun.write(filePath, JSON.stringify(task, null, 2))
    Bus.publish(Event.Created, { task })
    return task
  }

  export async function get(id: string): Promise<Info> {
    const filePath = taskPath(id)
    using _ = await Lock.read(lockKey(id))
    const exists = await Bun.file(filePath).exists()
    if (!exists) throw new Error(`Task not found: ${id}`)
    const data = await Bun.file(filePath).json()
    return Info.parse(data)
  }

  export async function list(): Promise<Info[]> {
    await ensureDir()
    const dir = tasksDir()
    const files = await fs.readdir(dir).catch(() => [] as string[])
    const tasks = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const filePath = path.join(dir, f)
          const id = f.slice(0, -5)
          using _ = await Lock.read(lockKey(id))
          return Bun.file(filePath)
            .json()
            .then((data) => Info.parse(data))
            .catch((e) => {
              log.warn("failed to read task file", { file: f, error: e })
              return undefined
            })
        }),
    )
    return tasks.filter((t): t is Info => t !== undefined)
  }

  export async function ready(): Promise<Info[]> {
    const all = await list()
    const statusMap = new Map(all.map((t) => [t.id, t.status]))
    return all.filter((t) => {
      if (t.status !== "pending") return false
      return t.blockedBy.every((depId) => statusMap.get(depId) === "completed")
    })
  }

  export async function update(
    id: string,
    changes: Partial<Pick<Info, "subject" | "description" | "status" | "blockedBy" | "blocks" | "owner" | "metadata" | "activeForm">>,
  ): Promise<Info> {
    const filePath = taskPath(id)
    using _ = await Lock.write(lockKey(id))
    const exists = await Bun.file(filePath).exists()
    if (!exists) throw new Error(`Task not found: ${id}`)
    const data = await Bun.file(filePath).json()
    const current = Info.parse(data)

    if (changes.status && changes.status !== current.status) {
      const allowed = VALID_TRANSITIONS[current.status]
      if (!allowed?.includes(changes.status))
        throw new Error(`Invalid status transition: ${current.status} -> ${changes.status}`)
    }

    const updated: Info = {
      ...current,
      ...changes,
      updatedAt: Date.now(),
    }
    await Bun.write(filePath, JSON.stringify(updated, null, 2))
    Bus.publish(Event.Updated, { task: updated })
    return updated
  }

  export async function remove(id: string): Promise<void> {
    const filePath = taskPath(id)
    using _ = await Lock.write(lockKey(id))
    await fs.unlink(filePath).catch(() => {
      throw new Error(`Task not found: ${id}`)
    })
    Bus.publish(Event.Deleted, { id })
  }
}
