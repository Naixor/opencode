import z from "zod"
import path from "path"
import fs from "fs/promises"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Lock } from "../util/lock"
import { Log } from "../util/log"
import { Global } from "../global"
import { Instance } from "../project/instance"

export namespace BoardArtifact {
  const log = Log.create({ service: "board.artifact" })

  export const Type = z.enum([
    "analysis",
    "code_change",
    "test_result",
    "decision",
    "finding",
    "checkpoint",
    "proposal",
    "review_comment",
    "summary",
  ])
  export type Type = z.infer<typeof Type>

  export const Info = z.object({
    id: z.string(),
    type: Type,
    task_id: z.string(),
    swarm_id: z.string(),
    author: z.string(),
    content: z.string(),
    files: z.array(z.string()).default([]),
    created_at: z.number(),
    supersedes: z.string().optional(),
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Created: BusEvent.define("board.artifact.created", z.object({ artifact: Info })),
  }

  function dir(swarm: string): string {
    return path.join(Global.Path.data, "projects", Instance.project.id, "board", swarm, "artifacts")
  }

  function filepath(swarm: string, id: string): string {
    return path.join(dir(swarm), `${id}.json`)
  }

  function key(id: string): string {
    return `board-artifact:${id}`
  }

  async function ensure(swarm: string) {
    await fs.mkdir(dir(swarm), { recursive: true })
  }

  export async function post(input: {
    type: Type
    task_id: string
    swarm_id: string
    author: string
    content: string
    files?: string[]
    supersedes?: string
  }): Promise<Info> {
    await ensure(input.swarm_id)
    const id = `A-${crypto.randomUUID()}`
    const artifact: Info = {
      id,
      type: input.type,
      task_id: input.task_id,
      swarm_id: input.swarm_id,
      author: input.author,
      content: input.content,
      files: input.files ?? [],
      created_at: Date.now(),
      supersedes: input.supersedes,
    }
    using _ = await Lock.write(key(id))
    await Bun.write(filepath(input.swarm_id, id), JSON.stringify(artifact, null, 2))
    Bus.publish(Event.Created, { artifact })
    return artifact
  }

  export async function get(swarm: string, id: string): Promise<Info> {
    using _ = await Lock.read(key(id))
    const file = Bun.file(filepath(swarm, id))
    if (!(await file.exists())) throw new Error(`Board artifact not found: ${id}`)
    return Info.parse(await file.json())
  }

  export async function list(filter: {
    swarm_id: string
    task_id?: string
    type?: Type
    author?: string
  }): Promise<Info[]> {
    await ensure(filter.swarm_id)
    const d = dir(filter.swarm_id)
    const files = await fs.readdir(d).catch(() => [] as string[])
    const results = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const id = f.slice(0, -5)
          using _ = await Lock.read(key(id))
          return Bun.file(path.join(d, f))
            .json()
            .then((data) => Info.parse(data))
            .catch((e) => {
              log.warn("failed to read board artifact", { file: f, error: e })
              return undefined
            })
        }),
    )
    return results
      .filter((a): a is Info => a !== undefined)
      .filter((a) => {
        if (filter.task_id && a.task_id !== filter.task_id) return false
        if (filter.type && a.type !== filter.type) return false
        if (filter.author && a.author !== filter.author) return false
        return true
      })
  }
}
