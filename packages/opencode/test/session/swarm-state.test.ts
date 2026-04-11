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
          config: { max_workers: 4, auto_escalate: true, verify_on_complete: true, wait_timeout_seconds: 600 },
          status: "active",
          stage: "verifying",
          reason: null,
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
          config: { max_workers: 4, auto_escalate: true, verify_on_complete: true, wait_timeout_seconds: 600 },
          status: "active",
          stage: "executing",
          reason: null,
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
          config: { max_workers: 4, auto_escalate: true, verify_on_complete: true, wait_timeout_seconds: 600 },
          status: "completed",
          stage: "idle",
          reason: null,
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
            config: { max_workers: 4, auto_escalate: true, verify_on_complete: true, wait_timeout_seconds: 600 },
            status: "active",
            stage: "executing",
            reason: null,
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

  test("promotes waiting workers to blocked after the timeout", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const now = Date.now()
        await Swarm.save({
          id: "SW-timeout",
          goal: "Surface stalled workers",
          conductor: "SE-conductor",
          workers: [
            {
              session_id: "SE-worker-1",
              agent: "sisyphus",
              role: "RD",
              task_id: "BT-1",
              status: "waiting",
              updated_at: now - 2_000,
              reason: null,
              evidence: [],
            },
          ],
          config: { max_workers: 4, auto_escalate: true, verify_on_complete: true, wait_timeout_seconds: 1 },
          status: "active",
          stage: "executing",
          reason: null,
          resume: { stage: null },
          visibility: { archived_at: null },
          time: { created: now, updated: now },
        })
        const info = await Swarm.status("SW-timeout")
        expect(info.status).toBe("blocked")
        expect(info.workers[0]?.status).toBe("blocked")
        expect(info.workers[0]?.reason).toContain("wait timeout")
      },
    })
  })

  test("allows only one non-terminal worker per task", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const now = Date.now()
        await expect(
          Swarm.save({
            id: "SW-dup-worker",
            goal: "Prevent duplicate task ownership",
            conductor: "SE-conductor",
            workers: [
              {
                session_id: "SE-worker-1",
                agent: "sisyphus",
                role: "RD",
                task_id: "BT-1",
                status: "running",
                updated_at: now,
                reason: null,
                evidence: [],
              },
              {
                session_id: "SE-worker-2",
                agent: "sisyphus",
                role: "QA",
                task_id: "BT-1",
                status: "waiting",
                updated_at: now,
                reason: null,
                evidence: [],
              },
            ],
            config: { max_workers: 4, auto_escalate: true, verify_on_complete: true, wait_timeout_seconds: 600 },
            status: "active",
            stage: "executing",
            reason: null,
            resume: { stage: null },
            visibility: { archived_at: null },
            time: { created: now, updated: now },
          }),
        ).rejects.toThrow("Only one non-terminal worker may own task")
      },
    })
  })

  test("moves dependent tasks to ready only after completed dependencies", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const now = Date.now()
        await Swarm.save({
          id: "SW-ready",
          goal: "Keep task readiness explicit",
          conductor: "SE-conductor",
          workers: [],
          config: { max_workers: 4, auto_escalate: true, verify_on_complete: true, wait_timeout_seconds: 600 },
          status: "active",
          stage: "executing",
          reason: null,
          resume: { stage: null },
          visibility: { archived_at: null },
          time: { created: now, updated: now },
        })
        const a = await BoardTask.create({ subject: "Upstream", type: "implement", swarm_id: "SW-ready" })
        const b = await BoardTask.create({
          subject: "Downstream",
          type: "implement",
          swarm_id: "SW-ready",
          blockedBy: [a.id],
        })
        expect((await BoardTask.get("SW-ready", a.id)).status).toBe("ready")
        expect((await BoardTask.get("SW-ready", b.id)).status).toBe("pending")
        await BoardTask.update("SW-ready", a.id, { status: "completed" })
        expect((await BoardTask.get("SW-ready", b.id)).status).toBe("ready")
        await BoardTask.update("SW-ready", a.id, { status: "failed" })
        expect((await BoardTask.get("SW-ready", b.id)).status).toBe("pending")
      },
    })
  })

  test("maps worker outcomes onto task state", () => {
    const base = SwarmState.create({ id: "SW-link", goal: "Link workers to tasks", conductor: "SE-conductor" })
    base.tasks.t_1 = {
      id: "t_1",
      subject: "Ship task",
      description: null,
      status: "ready",
      blocked_by: [],
      blocks: [],
      assignee: "SE-worker-1",
      type: "implement",
      scope: [],
      artifacts: [],
      verify_required: true,
      metadata: {},
      created_at: 1,
      updated_at: 1,
      reason: null,
    }
    base.workers.w_1 = {
      id: "w_1",
      session_id: "SE-worker-1",
      agent: "sisyphus",
      role: null,
      task_id: "t_1",
      status: "running",
      updated_at: 1,
      reason: null,
      evidence: [],
    }
    SwarmState.align(base)
    expect(base.tasks.t_1?.status).toBe("in_progress")
    base.workers.w_1.status = "blocked"
    base.workers.w_1.reason = "waiting on dependency"
    SwarmState.align(base)
    expect(base.tasks.t_1?.status).toBe("blocked")
    base.workers.w_1.status = "completed"
    base.verify.status = "running"
    SwarmState.align(base)
    expect(base.tasks.t_1?.status).toBe("verifying")
    base.verify.status = "passed"
    SwarmState.align(base)
    expect(base.tasks.t_1?.status).toBe("completed")
  })
})
