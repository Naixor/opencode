import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { SwarmState } from "../../src/session/swarm-state"
import { Swarm } from "../../src/session/swarm"

describe("SwarmState", () => {
  test("requires schema version 2", () => {
    expect(() =>
      SwarmState.Snapshot.parse({
        ...SwarmState.Example,
        schema_version: 1,
      }),
    ).toThrow()
  })

  test("writes and reads the canonical state file", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const state = SwarmState.create({
          id: "SW-v2",
          goal: "Ship v2 state",
          conductor: "SE-conductor",
        })
        await SwarmState.write(state)
        const next = await SwarmState.read("SW-v2")
        expect(next?.schema_version).toBe(2)
        expect(next?.swarm.id).toBe("SW-v2")
        expect(next?.swarm.stage).toBe("planning")
      },
    })
  })

  test("rejects terminal lifecycle states with non-idle stages", () => {
    expect(() =>
      SwarmState.Snapshot.parse({
        ...SwarmState.Example,
        swarm: {
          ...SwarmState.Example.swarm,
          status: "completed",
          stage: "verifying",
        },
      }),
    ).toThrow("stage=idle")
  })

  test("restores the stored stage on paused to active", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const now = Date.now()
        await Swarm.save({
          id: "SW-stage",
          goal: "Keep lifecycle separate from stage",
          conductor: "SE-conductor",
          workers: [],
          config: { max_workers: 4, auto_escalate: true, verify_on_complete: true },
          status: "active",
          stage: "verifying",
          resume: { stage: null },
          visibility: { archived_at: null },
          time: { created: now, updated: now },
        })
        const paused = await Swarm.pause("SW-stage")
        const hold = await SwarmState.read("SW-stage")
        expect(paused.status).toBe("paused")
        expect(paused.resume.stage).toBe("verifying")
        expect(hold?.swarm.resume.stage).toBe("verifying")
        const active = await Swarm.resume("SW-stage")
        const next = await SwarmState.read("SW-stage")
        expect(active.status).toBe("active")
        expect(active.stage).toBe("verifying")
        expect(active.resume.stage).toBeNull()
        expect(next?.swarm.stage).toBe("verifying")
      },
    })
  })
})
