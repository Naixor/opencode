import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { SwarmState } from "../../src/session/swarm-state"
import { Swarm } from "../../src/session/swarm"
import { BoardTask } from "../../src/board"

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

  test("rejects non-coordinator task writes and records audit output", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const now = Date.now()
        await Swarm.save({
          id: "SW-auth",
          goal: "Keep snapshot writes coordinator-only",
          conductor: "SE-conductor",
          workers: [],
          config: { max_workers: 4, auto_escalate: true, verify_on_complete: true },
          status: "active",
          stage: "executing",
          resume: { stage: null },
          visibility: { archived_at: null },
          time: { created: now, updated: now },
        })
        await expect(
          BoardTask.create({
            subject: "Worker should not commit snapshot state",
            type: "implement",
            swarm_id: "SW-auth",
            actor: "SE-worker-1",
          }),
        ).rejects.toThrow("Only the coordinator")
        const state = await SwarmState.read("SW-auth")
        expect(state?.audit.illegal.at(-1)?.actor).toBe("SE-worker-1")
        expect(state?.audit.illegal.at(-1)?.reason).toContain("create task")
      },
    })
  })

  test("rejects invalid lifecycle transitions", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const now = Date.now()
        await Swarm.save({
          id: "SW-matrix",
          goal: "Honor the lifecycle matrix",
          conductor: "SE-conductor",
          workers: [],
          config: { max_workers: 4, auto_escalate: true, verify_on_complete: true },
          status: "completed",
          stage: "idle",
          resume: { stage: null },
          visibility: { archived_at: null },
          time: { created: now, updated: now, completed: now },
        })
        await expect(
          Swarm.save({
            id: "SW-matrix",
            goal: "Honor the lifecycle matrix",
            conductor: "SE-conductor",
            workers: [],
            config: { max_workers: 4, auto_escalate: true, verify_on_complete: true },
            status: "active",
            stage: "executing",
            resume: { stage: null },
            visibility: { archived_at: null },
            time: { created: now, updated: now + 1, completed: now },
          }),
        ).rejects.toThrow("Invalid swarm status transition")
      },
    })
  })

  test("requires explicit unblock evidence for blocked recovery", () => {
    const prev = SwarmState.Snapshot.parse({
      ...SwarmState.Example,
      swarm: {
        ...SwarmState.Example.swarm,
        status: "blocked",
        stage: "executing",
        reason: "timed out waiting for dependency",
      },
    })
    const next = SwarmState.Snapshot.parse({
      ...prev,
      swarm: {
        ...prev.swarm,
        status: "active",
        stage: "executing",
        reason: null,
      },
    })
    expect(() => SwarmState.check(prev, next)).toThrow("Blocked swarm recovery requires explicit unblock evidence")
  })

  test("rejects invalid stage transitions", () => {
    const prev = SwarmState.Snapshot.parse({
      ...SwarmState.Example,
      swarm: {
        ...SwarmState.Example.swarm,
        status: "active",
        stage: "verifying",
      },
    })
    const next = SwarmState.Snapshot.parse({
      ...prev,
      swarm: {
        ...prev.swarm,
        stage: "planning",
      },
    })
    expect(() => SwarmState.check(prev, next)).toThrow("Invalid swarm stage transition")
  })
})
