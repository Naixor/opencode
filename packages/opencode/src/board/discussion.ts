import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Lock } from "../util/lock"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { BoardSignal } from "./signal"

export namespace Discussion {
  export const Round = z.object({
    round: z.number(),
    max_rounds: z.number().default(3),
    channel: z.string(),
    swarm_id: z.string(),
    expected: z.array(z.string()),
    received: z.array(z.string()),
    complete: z.boolean(),
  })
  export type Round = z.infer<typeof Round>

  export const Tally = z.object({
    agree: z.number(),
    disagree: z.number(),
    modify: z.number(),
    total: z.number(),
    unanimous: z.boolean(),
    positions: z.array(
      z.object({
        from: z.string(),
        position: z.string(),
        summary: z.string(),
      }),
    ),
  })
  export type Tally = z.infer<typeof Tally>

  function filepath(swarm: string, channel: string): string {
    return path.join(Global.Path.data, "projects", Instance.project.id, "board", swarm, "discussion", `${channel}.json`)
  }

  function key(swarm: string, channel: string) {
    return `discussion-${swarm}-${channel}`
  }

  // Internal helpers that do NOT acquire locks — callers must hold write lock
  async function loadRaw(swarm: string, channel: string): Promise<Round | undefined> {
    const fp = filepath(swarm, channel)
    const file = Bun.file(fp)
    if (!(await file.exists())) return undefined
    return Round.parse(await file.json())
  }

  async function saveRaw(round: Round): Promise<void> {
    const fp = filepath(round.swarm_id, round.channel)
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await Bun.write(fp, JSON.stringify(round, null, 2))
  }

  export async function join(swarm: string, channel: string, participant: string): Promise<Round> {
    using _ = await Lock.write(key(swarm, channel))
    const current = await loadRaw(swarm, channel)
    if (!current) throw new Error(`No discussion found for channel ${channel}`)
    if (!current.expected.includes(participant)) {
      current.expected.push(participant)
      await saveRaw(current)
    }
    return current
  }

  export async function start(swarm: string, channel: string, workers: string[], max_rounds?: number): Promise<Round> {
    using _ = await Lock.write(key(swarm, channel))
    const round: Round = {
      round: 1,
      max_rounds: max_rounds ?? 3,
      channel,
      swarm_id: swarm,
      expected: workers,
      received: [],
      complete: false,
    }
    await saveRaw(round)
    return round
  }

  export async function record(swarm: string, channel: string, from: string, _round: number): Promise<Round> {
    using _ = await Lock.write(key(swarm, channel))
    const current = await loadRaw(swarm, channel)
    if (!current) throw new Error(`No discussion found for channel ${channel}`)
    if (current.round !== _round) return current
    if (!current.received.includes(from)) {
      current.received.push(from)
    }
    current.complete = current.expected.length > 0 && current.received.length >= current.expected.length
    await saveRaw(current)
    return current
  }

  export async function status(swarm: string, channel: string): Promise<Round | undefined> {
    using _ = await Lock.read(key(swarm, channel))
    return loadRaw(swarm, channel)
  }

  export async function advance(swarm: string, channel: string): Promise<Round> {
    using _ = await Lock.write(key(swarm, channel))
    const current = await loadRaw(swarm, channel)
    if (!current) throw new Error(`No discussion found for channel ${channel}`)
    current.round += 1
    current.received = []
    current.complete = false
    await saveRaw(current)
    return current
  }

  export async function tally(swarm: string, channel: string): Promise<Tally> {
    using _ = await Lock.read(key(swarm, channel))
    const signals = await BoardSignal.thread(swarm, channel)
    const votes = signals.filter((s) => s.type === "consensus")
    const positions = votes.map((v) => ({
      from: v.from,
      position: (v.payload.position as string) ?? "agree",
      summary: (v.payload.summary as string) ?? "",
    }))
    const agree = positions.filter((p) => p.position === "agree").length
    const disagree = positions.filter((p) => p.position === "disagree").length
    const modify = positions.filter((p) => p.position === "modify").length
    return {
      agree,
      disagree,
      modify,
      total: positions.length,
      unanimous: positions.length > 0 && agree === positions.length,
      positions,
    }
  }
}
