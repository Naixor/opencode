import z from "zod"
import path from "path"
import fs from "fs/promises"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "../util/log"
import { Global } from "../global"
import { Instance } from "../project/instance"

export namespace BoardSignal {
  const log = Log.create({ service: "board.signal" })

  export const Type = z.enum([
    "progress",
    "conflict",
    "question",
    "done",
    "blocked",
    "need_review",
    "failed",
    "proposal",
    "opinion",
    "objection",
    "consensus",
  ])
  export type Type = z.infer<typeof Type>

  export const Info = z.object({
    id: z.string(),
    channel: z.string(),
    type: Type,
    from: z.string(),
    payload: z.record(z.string(), z.unknown()),
    timestamp: z.number(),
    swarm_id: z.string(),
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Signal: BusEvent.define("board.signal", z.object({ signal: Info })),
  }

  function filepath(swarm: string): string {
    return path.join(Global.Path.data, "projects", Instance.project.id, "board", swarm, "signals.jsonl")
  }

  function dir(swarm: string): string {
    return path.join(Global.Path.data, "projects", Instance.project.id, "board", swarm)
  }

  export async function send(input: {
    channel: string
    type: Type
    from: string
    payload: Record<string, unknown>
    swarm_id: string
  }): Promise<Info> {
    await fs.mkdir(dir(input.swarm_id), { recursive: true })
    const signal: Info = {
      id: crypto.randomUUID(),
      channel: input.channel,
      type: input.type,
      from: input.from,
      payload: input.payload,
      timestamp: Date.now(),
      swarm_id: input.swarm_id,
    }
    const line = JSON.stringify(signal) + "\n"
    await fs.appendFile(filepath(input.swarm_id), line)
    Bus.publish(Event.Signal, { signal })
    return signal
  }

  export function watch(swarm: string, channel: string | undefined, callback: (signal: Info) => void): () => void {
    return Bus.subscribe(Event.Signal, (evt) => {
      if (evt.properties.signal.swarm_id !== swarm) return
      if (channel && evt.properties.signal.channel !== channel) return
      callback(evt.properties.signal)
    })
  }

  export async function recent(swarm: string, channel?: string, limit = 50): Promise<Info[]> {
    const fp = filepath(swarm)
    const content = await fs.readFile(fp, "utf-8").catch(() => "")
    if (!content) return []
    const lines = content.trim().split("\n").filter(Boolean)
    const signals = lines
      .map((line) => {
        const parsed = Info.safeParse(JSON.parse(line))
        return parsed.success ? parsed.data : undefined
      })
      .filter((s): s is Info => s !== undefined)
      .filter((s) => !channel || s.channel === channel)
    return signals.slice(-limit)
  }

  export async function thread(swarm: string, channel: string): Promise<Info[]> {
    return recent(swarm, channel, Infinity)
  }
}
