import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Lock } from "../util/lock"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { BoardSignal } from "./signal"
import { SwarmState } from "../session/swarm-state"

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

  async function saveRaw(round: Round): Promise<void> {
    const fp = filepath(round.swarm_id, round.channel)
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await Bun.write(fp, JSON.stringify(round, null, 2))
  }

  function fromState(swarm: string, channel: string, item: SwarmState.Discussion): Round {
    return Round.parse({
      round: item.current_round,
      max_rounds: item.max_rounds,
      channel,
      swarm_id: swarm,
      expected: item.participants,
      received: item.received,
      complete:
        item.status === "round_complete" ||
        item.status === "consensus_ready" ||
        item.status === "decided" ||
        item.status === "exhausted",
    })
  }

  export async function join(swarm: string, channel: string, participant: string): Promise<Round> {
    const round = await SwarmState.mutate(swarm, {
      actor: "coordinator",
      reason: `join discussion ${channel}`,
      fn: (state) => {
        const item = state.discussions[channel]
        if (!item) throw new Error(`No discussion found for channel ${channel}`)
        if (!item.participants.includes(participant)) item.participants.push(participant)
        item.updated_at = Date.now()
      },
    })
    const current = round.discussions[channel]
    if (!current) throw new Error(`No discussion found for channel ${channel}`)
    const next = fromState(swarm, channel, current)
    await saveRaw(next)
    return next
  }

  export async function start(swarm: string, channel: string, workers: string[], max_rounds?: number): Promise<Round> {
    const state = await SwarmState.mutate(swarm, {
      actor: "coordinator",
      reason: `start discussion ${channel}`,
      fn: (next) => {
        next.discussions[channel] = {
          id: channel,
          channel,
          topic: channel,
          status: "collecting",
          current_round: 1,
          max_rounds: max_rounds ?? 3,
          participants: workers,
          received: [],
          updated_at: Date.now(),
        }
      },
    })
    const current = state.discussions[channel]
    if (!current) throw new Error(`No discussion found for channel ${channel}`)
    const round = fromState(swarm, channel, current)
    await saveRaw(round)
    return round
  }

  export async function record(swarm: string, channel: string, from: string, _round: number): Promise<Round> {
    const state = await SwarmState.mutate(swarm, {
      actor: "coordinator",
      reason: `record discussion ${channel}`,
      fn: (next) => {
        const item = next.discussions[channel]
        if (!item) throw new Error(`No discussion found for channel ${channel}`)
        if (item.current_round !== _round) return
        if (!item.received.includes(from)) item.received.push(from)
        const done = item.participants.length > 0 && item.received.length >= item.participants.length
        item.status = done ? (item.current_round >= item.max_rounds ? "exhausted" : "round_complete") : "collecting"
        item.updated_at = Date.now()
      },
    })
    const current = state.discussions[channel]
    if (!current) throw new Error(`No discussion found for channel ${channel}`)
    const round = fromState(swarm, channel, current)
    await saveRaw(round)
    return round
  }

  export async function status(swarm: string, channel: string): Promise<Round | undefined> {
    const state = await SwarmState.read(swarm)
    if (!state?.discussions[channel]) return undefined
    return fromState(swarm, channel, state.discussions[channel]!)
  }

  export async function advance(swarm: string, channel: string, actor = "coordinator"): Promise<Round> {
    const state = await SwarmState.mutate(swarm, {
      actor,
      reason: `advance discussion ${channel}`,
      fn: (next) => {
        const item = next.discussions[channel]
        if (!item) throw new Error(`No discussion found for channel ${channel}`)
        if (item.current_round >= item.max_rounds) {
          throw new Error(`Discussion ${channel} already reached max rounds`)
        }
        item.current_round += 1
        item.received = []
        item.status = "collecting"
        item.updated_at = Date.now()
      },
    })
    const current = state.discussions[channel]
    if (!current) throw new Error(`No discussion found for channel ${channel}`)
    const round = fromState(swarm, channel, current)
    await saveRaw(round)
    return round
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
