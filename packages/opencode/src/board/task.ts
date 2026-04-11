import z from "zod"
import path from "path"
import fs from "fs/promises"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Lock } from "../util/lock"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { ScopeLock } from "./scope-lock"
import { SwarmState } from "../session/swarm-state"

export namespace BoardTask {
  export const Type = z.enum(["implement", "review", "test", "investigate", "fix", "refactor", "discuss"])
  export type Type = z.infer<typeof Type>

  export const Status = z.enum([
    "pending",
    "ready",
    "in_progress",
    "verifying",
    "completed",
    "blocked",
    "failed",
    "cancelled",
  ])
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

  function fromState(task: SwarmState.Task, swarm: string): Info {
    return Info.parse({
      id: task.id,
      subject: task.subject,
      description: task.description ?? undefined,
      status: task.status,
      blockedBy: task.blocked_by,
      blocks: task.blocks,
      assignee: task.assignee ?? undefined,
      type: task.type,
      scope: task.scope,
      artifacts: task.artifacts,
      swarm_id: swarm,
      metadata: task.metadata,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
    })
  }

  async function writeRaw(task: Info) {
    using _ = await Lock.write(key(task.id))
    await Bun.write(filepath(task.swarm_id, task.id), JSON.stringify(task, null, 2))
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
    actor?: string
  }): Promise<Info> {
    await ensure(input.swarm_id)
    const id = `BT-${crypto.randomUUID()}`
    const now = Date.now()
    const task = Info.parse({
      id,
      subject: input.subject,
      description: input.description,
      status: (input.blockedBy ?? []).length > 0 ? "pending" : "ready",
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
    })
    await SwarmState.mutate(input.swarm_id, {
      actor: input.actor ?? "coordinator",
      reason: `create task ${id}`,
      fn: (state) => {
        state.tasks[id] = {
          id,
          subject: task.subject,
          description: task.description ?? null,
          status: task.status,
          blocked_by: task.blockedBy,
          blocks: task.blocks,
          assignee: task.assignee ?? null,
          type: task.type,
          scope: task.scope,
          artifacts: task.artifacts,
          verify_required: true,
          metadata: task.metadata,
          created_at: task.createdAt,
          updated_at: task.updatedAt,
          reason: null,
        }
      },
    })
    await writeRaw(task)
    Bus.publish(Event.Created, { task })
    return task
  }

  export async function get(swarm: string, id: string): Promise<Info> {
    const state = await SwarmState.read(swarm)
    if (!state?.tasks[id]) throw new Error(`Board task not found: ${id}`)
    return fromState(state.tasks[id]!, swarm)
  }

  export async function list(swarm: string): Promise<Info[]> {
    const state = await SwarmState.read(swarm)
    if (!state) return []
    return Object.values(state.tasks).map((task) => fromState(task, swarm))
  }

  export async function ready(swarm: string): Promise<Info[]> {
    return (await list(swarm)).filter((task) => task.status === "ready")
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
    actor = "coordinator",
  ): Promise<Info> {
    const current = await get(swarm, id)
    const updated: Info = {
      ...current,
      ...changes,
      updatedAt: Date.now(),
    }
    await SwarmState.mutate(swarm, {
      actor,
      reason: `update task ${id}`,
      fn: (state) => {
        const task = state.tasks[id]
        if (!task) throw new Error(`Board task not found: ${id}`)
        task.subject = updated.subject
        task.description = updated.description ?? null
        task.status = updated.status
        task.blocked_by = updated.blockedBy
        task.blocks = updated.blocks
        task.assignee = updated.assignee ?? null
        task.scope = updated.scope
        task.artifacts = updated.artifacts
        task.metadata = updated.metadata
        task.updated_at = updated.updatedAt
      },
    })
    await writeRaw(updated)
    if (updated.status === "completed" || updated.status === "cancelled" || updated.status === "failed") {
      ScopeLock.unlock(swarm, id)
    }
    Bus.publish(Event.Updated, { task: updated })
    return updated
  }

  export async function remove(swarm: string, id: string, actor = "coordinator"): Promise<void> {
    await SwarmState.mutate(swarm, {
      actor,
      reason: `remove task ${id}`,
      fn: (state) => {
        delete state.tasks[id]
      },
    })
    using _ = await Lock.write(key(id))
    await fs.unlink(filepath(swarm, id)).catch(() => {
      throw new Error(`Board task not found: ${id}`)
    })
    Bus.publish(Event.Deleted, { id, swarm_id: swarm })
  }
}
