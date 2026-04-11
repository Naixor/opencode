import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { SwarmState } from "../../src/session/swarm-state"
import { Swarm } from "../../src/session/swarm"
import { BoardTask } from "../../src/board"
import { Discussion } from "../../src/board/discussion"

describe("SwarmState", () => {
  test("requires schema version 3", () => {
    expect(() =>
      SwarmState.Snapshot.parse({
        ...SwarmState.Example,
        schema_version: 2,
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
          goal: "Ship v3 state",
          conductor: "SE-conductor",
        })
        await SwarmState.write(state)
        const next = await SwarmState.read("SW-v2")
        expect(next?.schema_version).toBe(3)
        expect(next?.swarm.id).toBe("SW-v2")
        expect(next?.swarm.stage).toBe("planning")
        expect(next?.alignment.catalog.scope).toBe("project")
        expect(next?.alignment.catalog.roles).toEqual({})
        expect(next?.alignment.confirmations.scope).toBe("user")
        expect(next?.alignment.confirmations.users).toEqual({})
        expect(next?.alignment.contract).toBeNull()
        expect(next?.alignment.gate.value).toBeNull()
        expect(next?.alignment.role_delta.roles).toEqual([])
        expect(next?.alignment.pending_confirmation).toBeNull()
      },
    })
  })

  test("persists populated alignment state in the canonical snapshot", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const state = SwarmState.create({
          id: "SW-align",
          goal: "Store alignment state",
          conductor: "SE-conductor",
        })
        state.alignment.catalog.roles.pm = {
          id: "pm",
          name: "PM",
          purpose: "Own scope",
          perspective: "User impact first",
          default_when: "Trade-offs affect product direction",
          version: 1,
          created_at: 10,
          updated_at: 10,
          audit: {
            created_at: 10,
            updated_at: 10,
            actor: "SE-conductor",
            run_id: "SW-align",
          },
        }
        state.alignment.confirmations.users.user_1 = {
          pm: {
            role_id: "pm",
            version: 1,
            confirmed_at: 11,
            run_id: "SW-align",
          },
        }
        state.alignment.contract = {
          goal: "Plan a risky swarm",
          scope: "Swarm alignment rollout",
          constraints: ["Do not add compatibility loaders"],
          roles: [
            {
              role_id: "pm",
              name: "PM",
              purpose: "Own scope",
              perspective: "User impact first",
              default_when: "Trade-offs affect product direction",
            },
          ],
          mode: "discussion",
          assumptions: ["Catalog already exists"],
          risks: ["Gate policy may pause the run"],
          discussion_reason: "Direction changes are possible",
          created_at: 12,
        }
        state.alignment.gate = {
          value: "G2",
          reason: "Material role delta requires review",
          input: {
            action_sensitive: false,
            material_role_delta: true,
            ambiguous: true,
            valid_options: 2,
            trade_offs: true,
            confidence: "low",
            routine: false,
          },
          evaluated_at: 13,
        }
        state.alignment.role_delta = {
          material: true,
          roles: [
            {
              role_id: "pm",
              name: "PM",
              state: "modified",
              fields: ["purpose", "perspective"],
            },
          ],
          updated_at: 14,
        }
        state.alignment.pending_confirmation = {
          kind: "run",
          gate: "G2",
          requested_at: 15,
          requested_by: "SE-conductor",
          reason: "Confirm the updated contract",
          roles: ["pm"],
        }
        state.alignment.audit.contract = {
          created_at: 12,
          updated_at: 15,
          actor: "SE-conductor",
          run_id: "SW-align",
        }
        await SwarmState.write(state)
        const next = await SwarmState.read("SW-align")
        expect(next?.alignment.catalog.scope).toBe("project")
        expect(next?.alignment.confirmations.scope).toBe("user")
        expect(next?.alignment.catalog.roles.pm?.purpose).toBe("Own scope")
        expect(next?.alignment.confirmations.users.user_1?.pm?.confirmed_at).toBe(11)
        expect(next?.alignment.contract?.mode).toBe("discussion")
        expect(next?.alignment.gate.value).toBe("G2")
        expect(next?.alignment.role_delta.roles[0]?.fields).toEqual(["purpose", "perspective"])
        expect(next?.alignment.pending_confirmation?.roles).toEqual(["pm"])
        expect(next?.alignment.audit.contract.actor).toBe("SE-conductor")
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

  test("persists role catalog entries separately from user confirmations", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = await SwarmState.putRole({
          role: {
            id: "pm",
            name: "PM",
            purpose: "Own scope",
            perspective: "User impact first",
            default_when: "Trade-offs affect product direction",
            version: 1,
          },
          actor: "alice",
          run_id: "SW-role-1",
        })
        const mark = await SwarmState.confirmRole({
          user: "alice",
          role_id: "pm",
          version: 1,
          run_id: "SW-role-1",
        })
        const next = await SwarmState.readAlignment()
        expect(next.catalog.scope).toBe("project")
        expect(next.catalog.roles.pm).toMatchObject({
          id: "pm",
          name: "PM",
          version: 1,
        })
        expect(next.catalog.roles.pm?.audit.actor).toBe("alice")
        expect(next.confirmations.scope).toBe("user")
        expect(next.confirmations.users.alice?.pm).toEqual(mark)
        await SwarmState.putRole({
          role: {
            id: "pm",
            name: "PM",
            purpose: "Own final scope",
            perspective: "User impact first",
            default_when: "Trade-offs affect product direction",
            version: 2,
          },
          actor: "bob",
          run_id: "SW-role-2",
        })
        const last = await SwarmState.readAlignment()
        expect(last.catalog.roles.pm?.purpose).toBe("Own final scope")
        expect(last.catalog.roles.pm?.version).toBe(2)
        expect(last.catalog.roles.pm?.audit.created_at).toBe(first.audit.created_at)
        expect(last.catalog.roles.pm?.audit.actor).toBe("bob")
        expect(last.catalog.roles.pm?.audit.run_id).toBe("SW-role-2")
        expect(last.audit.catalog.actor).toBe("bob")
        expect(last.confirmations.users.alice?.pm?.version).toBe(1)
      },
    })
  })

  test("classifies requested roles using only material fields", () => {
    const now = Date.now()
    const out = SwarmState.classify({
      catalog: {
        pm: {
          id: "pm",
          name: "PM",
          purpose: "Own scope",
          perspective: "User impact first",
          default_when: "Trade-offs affect product direction",
          version: 1,
          created_at: now,
          updated_at: now,
          audit: { created_at: now, updated_at: now, actor: "alice", run_id: "SW-role-1" },
        },
        qa: {
          id: "qa",
          name: "QA",
          purpose: "Protect release quality",
          perspective: "Failure modes first",
          default_when: "Risk is unclear",
          version: 1,
          created_at: now,
          updated_at: now,
          audit: { created_at: now, updated_at: now, actor: "alice", run_id: "SW-role-1" },
        },
      },
      roles: [
        {
          role_id: "pm",
          name: "PM",
          purpose: "  Own   scope  ",
          perspective: "User impact first",
          default_when: "Trade-offs affect product direction",
        },
        {
          role_id: "qa",
          name: "QA",
          purpose: "Protect release quality",
          perspective: "Critical path first",
          default_when: "Risk is unclear",
        },
        {
          role_id: null,
          name: "RD",
          purpose: "Evaluate implementation options",
          perspective: "Delivery and maintainability",
          default_when: "Trade-offs affect architecture",
        },
      ],
    })
    expect(out.material).toBe(true)
    expect(out.roles).toEqual([
      {
        role_id: "pm",
        name: "PM",
        state: "unchanged",
        fields: [],
      },
      {
        role_id: "qa",
        name: "QA",
        state: "modified",
        fields: ["perspective"],
      },
      {
        role_id: null,
        name: "RD",
        state: "added",
        fields: [],
      },
    ])
    expect(typeof out.updated_at).toBe("number")
  })

  test("marks missing catalog roles as removed", () => {
    const now = Date.now()
    const out = SwarmState.classify({
      catalog: {
        pm: {
          id: "pm",
          name: "PM",
          purpose: "Own scope",
          perspective: "User impact first",
          default_when: "Trade-offs affect product direction",
          version: 1,
          created_at: now,
          updated_at: now,
          audit: { created_at: now, updated_at: now, actor: "alice", run_id: "SW-role-1" },
        },
      },
      roles: [],
    })
    expect(out.material).toBe(true)
    expect(out.roles).toEqual([
      {
        role_id: "pm",
        name: "PM",
        state: "removed",
        fields: [],
      },
    ])
  })

  test("drafts a run contract before delegation and preserves catalog role references", () => {
    const now = Date.now()
    const first = SwarmState.draft({
      goal: "Ship the alignment flow",
      scope: "Plan the first delegation step",
      discussion: false,
      role: "PM",
      catalog: {
        pm: {
          id: "pm",
          name: "PM",
          purpose: "Own scope",
          perspective: "User impact first",
          default_when: "Trade-offs affect product direction",
          version: 1,
          created_at: now,
          updated_at: now,
          audit: { created_at: now, updated_at: now, actor: "alice", run_id: "SW-role-1" },
        },
      },
    })
    expect(first).toMatchObject({
      goal: "Ship the alignment flow",
      scope: "Plan the first delegation step",
      mode: "execute",
      discussion_reason: null,
      roles: [
        {
          role_id: "pm",
          name: "PM",
          purpose: null,
          perspective: null,
          default_when: null,
        },
      ],
    })

    const next = SwarmState.draft({
      goal: "ignored",
      scope: "ignored",
      discussion: true,
      reason: "Need a role-based trade-off review",
      role: "RD",
      catalog: {
        pm: {
          id: "pm",
          name: "PM",
          purpose: "Own scope",
          perspective: "User impact first",
          default_when: "Trade-offs affect product direction",
          version: 1,
          created_at: now,
          updated_at: now,
          audit: { created_at: now, updated_at: now, actor: "alice", run_id: "SW-role-1" },
        },
      },
      current: first,
    })
    expect(next.created_at).toBe(first.created_at)
    expect(next.mode).toBe("discussion")
    expect(next.discussion_reason).toBe("Need a role-based trade-off review")
    expect(next.roles).toEqual([
      {
        role_id: "pm",
        name: "PM",
        purpose: null,
        perspective: null,
        default_when: null,
      },
      {
        role_id: null,
        name: "RD",
        purpose: null,
        perspective: null,
        default_when: null,
      },
    ])
  })

  test("evaluates deterministic gates with the documented precedence", () => {
    const sensitive = SwarmState.decide({
      action_sensitive: true,
      material_role_delta: true,
      ambiguous: true,
      valid_options: 3,
      trade_offs: true,
      confidence: "low",
      routine: false,
    })
    expect(sensitive.value).toBe("G3")

    const delta = SwarmState.decide({
      action_sensitive: false,
      material_role_delta: true,
      ambiguous: true,
      valid_options: 2,
      trade_offs: true,
      confidence: "high",
      routine: true,
    })
    expect(delta.value).toBe("G2")

    const debate = SwarmState.decide({
      action_sensitive: false,
      material_role_delta: false,
      ambiguous: true,
      valid_options: 2,
      trade_offs: true,
      confidence: "high",
      routine: true,
    })
    expect(debate.value).toBe("G1")

    const uncertain = SwarmState.decide({
      action_sensitive: false,
      material_role_delta: false,
      ambiguous: false,
      valid_options: 1,
      trade_offs: false,
      confidence: "low",
      routine: true,
    })
    expect(uncertain.value).toBe("G1")

    const routine = SwarmState.decide({
      action_sensitive: false,
      material_role_delta: false,
      ambiguous: false,
      valid_options: 1,
      trade_offs: false,
      confidence: "high",
      routine: true,
    })
    expect(routine.value).toBe("G0")
    expect(routine.input.confidence).toBe("high")
    expect(typeof routine.evaluated_at).toBe("number")
    expect(routine.reason).toContain("Routine")
  })

  test("admits discussion mode only when at least two primary signals are true", () => {
    const zero = SwarmState.admit({
      multiple_valid_options: false,
      meaningful_trade_offs: false,
      direction_change: false,
      role_benefit: true,
    })
    expect(zero.mode).toBe("execute")
    expect(zero.primary).toBe(0)

    const one = SwarmState.admit({
      multiple_valid_options: true,
      meaningful_trade_offs: false,
      direction_change: false,
      role_benefit: true,
    })
    expect(one.mode).toBe("execute")
    expect(one.primary).toBe(1)

    const two = SwarmState.admit({
      multiple_valid_options: true,
      meaningful_trade_offs: true,
      direction_change: false,
      role_benefit: false,
    })
    expect(two.mode).toBe("discussion")
    expect(two.primary).toBe(2)

    const three = SwarmState.admit({
      multiple_valid_options: true,
      meaningful_trade_offs: true,
      direction_change: true,
      role_benefit: false,
    })
    expect(three.mode).toBe("discussion")
    expect(three.primary).toBe(3)
  })

  test("builds alignment preflight state before delegation", () => {
    const now = Date.now()
    const flagged = SwarmState.preflight({
      goal: "Ship the alignment flow",
      scope: "Delegate PM analysis",
      discussion: false,
      role: "PM",
      catalog: {
        pm: {
          id: "pm",
          name: "PM",
          purpose: "Own scope",
          perspective: "User impact first",
          default_when: "Trade-offs affect product direction",
          version: 1,
          created_at: now,
          updated_at: now,
          audit: { created_at: now, updated_at: now, actor: "alice", run_id: "SW-role-1" },
        },
      },
      current: SwarmState.Example.alignment,
    })
    expect(flagged.proceed).toBe(true)
    expect(flagged.gate.value).toBe("G0")
    expect(flagged.pending_confirmation).toBeNull()

    const blocked = SwarmState.preflight({
      goal: "Ship the alignment flow",
      scope: "Delegate RD analysis",
      discussion: false,
      role: "RD",
      catalog: {
        pm: {
          id: "pm",
          name: "PM",
          purpose: "Own scope",
          perspective: "User impact first",
          default_when: "Trade-offs affect product direction",
          version: 1,
          created_at: now,
          updated_at: now,
          audit: { created_at: now, updated_at: now, actor: "alice", run_id: "SW-role-1" },
        },
      },
      current: SwarmState.Example.alignment,
    })
    expect(blocked.proceed).toBe(false)
    expect(blocked.gate.value).toBe("G2")
    expect(blocked.pending_confirmation?.kind).toBe("run")
    expect(blocked.pending_confirmation?.roles).toEqual(["RD"])
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
          status: "failed",
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

  test("tracks discussion rounds explicitly and blocks extra rounds", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const now = Date.now()
        await Swarm.save({
          id: "SW-discuss",
          goal: "Model discussion rounds",
          conductor: "SE-conductor",
          workers: [],
          config: { max_workers: 4, auto_escalate: true, verify_on_complete: true, wait_timeout_seconds: 600 },
          status: "active",
          stage: "discussing",
          reason: null,
          resume: { stage: null },
          visibility: { archived_at: null },
          time: { created: now, updated: now },
        })
        const first = await Discussion.start("SW-discuss", "design", ["PM", "RD"], 2)
        expect(first.round).toBe(1)
        await Discussion.record("SW-discuss", "design", "PM", 1)
        const done = await Discussion.record("SW-discuss", "design", "RD", 1)
        expect(done.complete).toBe(true)
        const second = await Discussion.advance("SW-discuss", "design")
        expect(second.round).toBe(2)
        await Discussion.record("SW-discuss", "design", "PM", 2)
        const last = await Discussion.record("SW-discuss", "design", "RD", 2)
        expect(last.complete).toBe(true)
        await expect(Discussion.advance("SW-discuss", "design")).rejects.toThrow("max rounds")
      },
    })
  })

  test("requires waiver evidence before verify can be skipped", () => {
    const prev = SwarmState.create({ id: "SW-verify", goal: "Verify state", conductor: "SE-conductor" })
    const next = structuredClone(prev)
    next.verify.status = "skipped"
    expect(() => SwarmState.check(prev, next)).toThrow("Verify.skipped requires explicit waiver evidence")
  })

  test("keeps swarm active and verifying while verify is pending", () => {
    const state = SwarmState.create({ id: "SW-verify-pending", goal: "Verify state", conductor: "SE-conductor" })
    state.swarm.stage = "executing"
    state.verify.status = "pending"
    SwarmState.align(state)
    expect(state.swarm.status).toBe("active")
    expect(String(state.swarm.stage)).toBe("verifying")
  })

  test("requires verify success before swarm completion", () => {
    const prev = SwarmState.create({ id: "SW-complete", goal: "Complete safely", conductor: "SE-conductor" })
    prev.tasks.t_1 = {
      id: "t_1",
      subject: "Required task",
      description: null,
      status: "completed",
      blocked_by: [],
      blocks: [],
      assignee: null,
      type: "implement",
      scope: [],
      artifacts: [],
      verify_required: true,
      metadata: {},
      created_at: 1,
      updated_at: 1,
      reason: null,
    }
    const next = structuredClone(prev)
    next.swarm.status = "completed"
    next.swarm.stage = "idle"
    expect(() => SwarmState.check(prev, next)).toThrow("Swarm completion requires verify passed or skipped with waiver")
    prev.verify.status = "running"
    next.verify.status = "passed"
    expect(() => SwarmState.check(prev, next)).not.toThrow()
  })

  test("records rev, seq, and audit info on successful commits", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const now = Date.now()
        await Swarm.save({
          id: "SW-audit",
          goal: "Track authoritative commits",
          conductor: "SE-conductor",
          workers: [],
          config: { max_workers: 4, auto_escalate: true, verify_on_complete: true, wait_timeout_seconds: 600 },
          status: "active",
          stage: "planning",
          reason: null,
          resume: { stage: null },
          visibility: { archived_at: null },
          time: { created: now, updated: now },
        })
        const first = await SwarmState.read("SW-audit")
        expect(first?.rev).toBe(1)
        expect(first?.seq).toBe(1)
        expect(first?.audit.entries).toHaveLength(1)
        await BoardTask.create({ subject: "Audit task", type: "implement", swarm_id: "SW-audit" })
        const next = await SwarmState.read("SW-audit")
        expect(next?.rev).toBe(2)
        expect(next?.seq).toBe(2)
        expect(next?.audit.entries.at(-1)).toMatchObject({
          actor: "coordinator",
          reason: expect.stringContaining("create task"),
          rev: 2,
          seq: 2,
        })
      },
    })
  })
})
