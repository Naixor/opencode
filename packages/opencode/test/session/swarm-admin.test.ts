import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { SharedBoard, BoardTask, BoardSignal } from "../../src/board"
import { BoardArtifact } from "../../src/board/artifact"
import { Discussion } from "../../src/board/discussion"
import { Global } from "../../src/global"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { SwarmAdmin } from "../../src/session/swarm-admin"
import { Swarm } from "../../src/session/swarm"
import { SwarmState } from "../../src/session/swarm-state"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
})

async function withInstance(fn: (dir: string) => Promise<void>) {
  await using tmp = await tmpdir({ git: true, config: {} })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fn(tmp.path)
    },
  })
}

async function seed(id: string, input?: { status?: Swarm.Status; stage?: Swarm.Stage; done?: boolean }) {
  await SharedBoard.init(id)
  const now = Date.now()
  await Swarm.save({
    id,
    goal: "Build a Swarm admin UI",
    conductor: "SE-conductor",
    workers: [
      {
        session_id: "SE-worker-1",
        agent: "sisyphus",
        role: "PM",
        task_id: "",
        status: "running",
        updated_at: now - 1_000,
        reason: null,
        evidence: [],
      },
    ],
    config: {
      max_workers: 4,
      auto_escalate: true,
      verify_on_complete: true,
      wait_timeout_seconds: 600,
    },
    status: input?.status ?? "failed",
    stage: input?.stage ?? (input?.status === "active" ? "executing" : "idle"),
    reason: null,
    resume: { stage: null },
    visibility: { archived_at: null },
    time: {
      created: now - 2_000,
      updated: now - 1_000,
      completed: input?.done ? now - 500 : undefined,
    },
  })
}

describe("Swarm admin", () => {
  test("archive hides swarms by default and preserves board files", async () => {
    await withInstance(async () => {
      const id = "SW-delete"
      await seed(id, { done: true })
      const task = await BoardTask.create({
        subject: "Write admin UI",
        type: "implement",
        swarm_id: id,
      })
      await BoardArtifact.post({
        type: "summary",
        task_id: task.id,
        swarm_id: id,
        author: "SE-conductor",
        content: "Plan summary",
      })
      await BoardSignal.send({
        channel: "general",
        type: "progress",
        from: "SE-worker-1",
        payload: { summary: "Task started" },
        swarm_id: id,
      })

      const gone = await Swarm.remove(id)

      expect(gone.visibility.archived_at).toBeDefined()
      expect(gone.status).toBe("failed")
      expect(gone.stage).toBe("idle")
      expect((await Swarm.list()).map((item) => item.id)).not.toContain(id)
      expect((await Swarm.list({ include_deleted: true })).map((item) => item.id)).toContain(id)
      expect(await Swarm.status(id, { include_deleted: true })).toMatchObject({ id })

      const base = path.join(Global.Path.data, "projects", Instance.project.id, "board", id)
      expect(await Bun.file(path.join(base, "tasks", `${task.id}.json`)).exists()).toBe(true)
      expect(await Bun.file(path.join(base, "signals.jsonl")).exists()).toBe(true)
      expect((await BoardTask.list(id)).length).toBe(1)
    })
  })

  test("cannot archive a running swarm", async () => {
    await withInstance(async () => {
      const id = "SW-running"
      await seed(id, { status: "active", stage: "executing" })
      await expect(Swarm.remove(id)).rejects.toThrow("Cannot archive running swarm")
    })
  })

  test("purge removes archived terminal swarms", async () => {
    await withInstance(async () => {
      const id = "SW-purge"
      await seed(id, { done: true })
      const info = await Swarm.load(id, { include_deleted: true })
      if (!info) throw new Error("Expected swarm info")
      info.workers = info.workers.map((worker) => ({ ...worker, status: "completed", updated_at: Date.now() }))
      await Swarm.save(info)
      await Swarm.remove(id)
      const base = path.join(Global.Path.data, "projects", Instance.project.id, "board", id)

      await Swarm.purge(id)

      expect((await Swarm.list({ include_deleted: true })).map((item) => item.id)).not.toContain(id)
      expect(await Bun.file(path.join(base, "state.json")).exists()).toBe(false)
    })
  })

  test("stop marks stop time for admin controls", async () => {
    await withInstance(async () => {
      const id = "SW-stop"
      await seed(id, { status: "active", stage: "executing" })

      const info = await Swarm.stop(id)

      expect(info.status).toBe("stopped")
      expect(info.stage).toBe("idle")
      expect(info.time.stopped).toBeDefined()
      expect(info.time.completed).toBeDefined()
    })
  })

  test("builds overview and detail read models with attention and discussion summaries", async () => {
    await withInstance(async () => {
      const id = "SW-detail"
      await seed(id, { status: "active", stage: "executing" })
      await SwarmState.mutate(id, {
        actor: "coordinator",
        reason: "seed alignment",
        fn: (state) => {
          state.alignment.contract = {
            goal: "Build a Swarm admin UI",
            scope: "Explain why the run is blocked",
            constraints: ["No raw prompts"],
            roles: [{ role_id: "pm", name: "PM", purpose: null, perspective: null, default_when: null }],
            mode: "execute",
            assumptions: ["Shared state is current"],
            risks: ["Workers may drift"],
            discussion_reason: null,
            created_at: Date.now(),
          }
          state.alignment.gate = {
            value: "G2",
            reason: "Material role delta requires review",
            input: {
              action_sensitive: false,
              material_role_delta: true,
              ambiguous: false,
              valid_options: 1,
              trade_offs: false,
              confidence: "high",
              routine: true,
            },
            evaluated_at: Date.now(),
          }
          state.alignment.role_delta = {
            material: true,
            roles: [{ role_id: "pm", name: "PM", state: "modified", fields: ["perspective"] }],
            updated_at: Date.now(),
          }
          state.alignment.summary = {
            goal: "Build a Swarm admin UI",
            scope: "Explain why the run is blocked",
            constraints: ["No raw prompts"],
            roles: ["PM"],
            role_deltas: [{ role_id: "pm", name: "PM", state: "modified", fields: ["perspective"] }],
            assumptions: ["Shared state is current"],
            next_phase: "Pause before delegation until the user confirms this run",
            ask: "Confirm the updated direction before delegation continues",
            created_at: Date.now(),
          }
          state.alignment.pending_confirmation = {
            kind: "run",
            gate: "G2",
            requested_at: Date.now(),
            requested_by: "coordinator",
            reason: "Confirm the updated direction before delegation continues",
            roles: ["pm"],
          }
        },
      })
      const done = await BoardTask.create({
        subject: "Prepare plan",
        type: "implement",
        assignee: "SE-worker-1",
        swarm_id: id,
      })
      await BoardTask.update(id, done.id, { status: "completed" })
      const stuck = await BoardTask.create({
        subject: "Ship overview page",
        type: "implement",
        assignee: "SE-worker-1",
        swarm_id: id,
      })
      await BoardSignal.send({
        channel: "general",
        type: "blocked",
        from: "SE-worker-1",
        payload: { task_id: stuck.id, summary: "Waiting on API contract" },
        swarm_id: id,
      })
      const chat = await BoardTask.create({
        subject: "Debate delete semantics",
        type: "discuss",
        scope: ["debate-delete"],
        metadata: { channel: "debate-delete" },
        swarm_id: id,
      })
      await Discussion.start(id, "debate-delete", ["PM", "RD"], 1)
      await BoardSignal.send({
        channel: "debate-delete",
        type: "consensus",
        from: "PM",
        payload: { round: 1, position: "agree", summary: "Keep safe delete" },
        swarm_id: id,
      })
      await BoardSignal.send({
        channel: "debate-delete",
        type: "consensus",
        from: "RD",
        payload: { round: 1, position: "disagree", summary: "Need hard delete later" },
        swarm_id: id,
      })
      await Discussion.record(id, "debate-delete", "PM", 1)
      await Discussion.record(id, "debate-delete", "RD", 1)
      await BoardArtifact.post({
        type: "decision",
        task_id: chat.id,
        swarm_id: id,
        author: "SE-conductor",
        content: "Plan: ship a read-only admin UI first.",
      })

      const overview = await SwarmAdmin.list({ needs_attention: true })
      const align = await SwarmAdmin.readAlignment(id)
      const detail = await SwarmAdmin.get(id)

      expect(overview).toHaveLength(1)
      expect(overview[0]).toMatchObject({
        swarm_id: id,
        status: "active",
        needs_attention: true,
      })
      expect(overview[0]?.attention).toContain("blocked_task")
      expect(overview[0]?.attention).toContain("no_consensus")
      expect(detail.plan_summary).toContain("read-only admin UI")
      expect(detail.risk_summary).toContain("Conductor note")
      expect(detail.actions[0]).toMatchObject({ kind: "decision" })
      expect(detail.task_filters.assignees).toContain("SE-worker-1")
      expect(align.gate.value).toBe("G2")
      expect(align.pending_confirmation?.kind).toBe("run")
      expect(detail.alignment.summary?.roles).toEqual(["PM"])
      expect(detail.alignment.role_delta.material).toBe(true)
      expect(detail.tasks.find((task) => task.id === stuck.id)?.blocked_reason).toContain("Waiting on API contract")
      expect(detail.agents.find((agent) => agent.label === "PM")?.discussion_channels).toContain("debate-delete")
      expect(detail.discussions[0]).toMatchObject({
        channel: "debate-delete",
        consensus_state: "no_consensus",
      })
      expect(detail.discussions[0]?.raw[0]?.entries.length).toBeGreaterThan(0)
    })
  })

  test("surfaces a stalled conductor as blocked attention", async () => {
    await withInstance(async (dir) => {
      const now = Date.now()
      const ses = await Session.create({ title: "Swarm conductor" })
      const user = Identifier.ascending("message")
      const msg = Identifier.ascending("message")
      await Session.updateMessage({
        id: user,
        role: "user",
        sessionID: ses.id,
        time: { created: now - 3_000 },
        agent: "conductor",
        model: { providerID: "openai", modelID: "gpt-5.4" },
      })
      await Session.updateMessage({
        id: msg,
        role: "assistant",
        sessionID: ses.id,
        time: { created: now - 2_000 },
        parentID: user,
        modelID: "gpt-5.4",
        providerID: "openai",
        mode: "conductor",
        agent: "conductor",
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: ses.id,
        messageID: msg,
        type: "tool",
        callID: "call-read",
        tool: "read",
        state: {
          status: "running",
          input: { filePath: "/tmp/claude-code" },
          time: { start: now - 2_000 },
        },
      })
      SessionStatus.set(ses.id, { type: "idle" })
      await Swarm.save({
        id: "SW-stalled-admin",
        goal: "Inspect a sibling repo before creating tasks",
        conductor: ses.id,
        workers: [],
        config: {
          max_workers: 4,
          auto_escalate: true,
          verify_on_complete: true,
          wait_timeout_seconds: 1,
        },
        status: "active",
        stage: "planning",
        reason: null,
        resume: { stage: null },
        visibility: { archived_at: null },
        time: { created: now - 3_000, updated: now - 3_000 },
      })

      const detail = await SwarmAdmin.get("SW-stalled-admin")

      expect(detail.overview.status).toBe("blocked")
      expect(detail.plan_empty).toBe(true)
      expect(detail.risk_summary).toContain("blocked agents")
      expect(detail.agents[0]).toMatchObject({
        id: "conductor",
        status: "blocked",
      })
      expect(detail.agents[0]?.reason).toContain("conductor stalled on read")
    })
  })

  test("reads approved alignment writeback state after role approval", async () => {
    await withInstance(async () => {
      const id = "SW-approved-read"
      const now = Date.now()
      await seed(id, { status: "active", stage: "planning" })
      await SwarmState.putRole({
        role: {
          id: "pm",
          name: "PM",
          purpose: "Own scope",
          perspective: "User impact first",
          default_when: "Trade-offs affect product direction",
          version: 1,
        },
        actor: "alice",
        run_id: id,
      })
      await SwarmState.mutate(id, {
        actor: "coordinator",
        reason: "seed approval flow",
        fn: (state) => {
          state.swarm.status = "paused"
          state.swarm.stage = "planning"
          state.swarm.resume.stage = "planning"
          state.swarm.reason = "Material role delta requires user review"
          state.alignment.contract = {
            goal: "Build a Swarm admin UI",
            scope: "Approve PM updates",
            constraints: [],
            roles: [
              { role_id: "pm", name: "PM", purpose: null, perspective: "Outcome-first trade-offs", default_when: null },
            ],
            mode: "execute",
            assumptions: [],
            risks: [],
            discussion_reason: null,
            created_at: now,
          }
          state.alignment.gate = {
            value: "G2",
            reason: "Material role delta requires user review",
            input: {
              action_sensitive: false,
              material_role_delta: true,
              ambiguous: false,
              valid_options: 1,
              trade_offs: false,
              confidence: "high",
              routine: true,
            },
            evaluated_at: now,
          }
          state.alignment.role_delta = {
            material: true,
            roles: [{ role_id: "pm", name: "PM", state: "modified", fields: ["perspective"] }],
            updated_at: now,
          }
          state.alignment.pending_confirmation = {
            kind: "run",
            gate: "G2",
            requested_at: now,
            requested_by: "coordinator",
            reason: "Confirm the updated direction before delegation continues",
            roles: ["pm"],
          }
          state.alignment.summary = SwarmState.summarize({
            contract: state.alignment.contract,
            role_delta: state.alignment.role_delta,
            gate: state.alignment.gate,
            pending_confirmation: state.alignment.pending_confirmation,
          })
        },
      })

      await Swarm.approveRoles(id, { actor: "bob", roles: ["pm"] })

      const detail = await SwarmAdmin.get(id)
      const align = await SwarmState.readAlignment()
      expect(detail.alignment.gate.value).toBe("G0")
      expect(detail.alignment.pending_confirmation).toBeNull()
      expect(detail.alignment.role_delta.material).toBe(false)
      expect(detail.alignment.summary).toBeNull()
      expect(align.catalog.roles.pm?.perspective).toBe("Outcome-first trade-offs")
      expect(align.catalog.roles.pm?.audit.actor).toBe("bob")
      expect(align.catalog.roles.pm?.audit.run_id).toBe(id)
      expect(align.confirmations.users.bob?.pm?.version).toBe(2)
    })
  })

  test("reads escalated alignment state after a later risky turn", async () => {
    await withInstance(async () => {
      const id = "SW-escalated-read"
      const now = Date.now()
      await seed(id, { status: "active", stage: "planning" })
      await SwarmState.putRole({
        role: {
          id: "pm",
          name: "PM",
          purpose: "Own scope",
          perspective: "User impact first",
          default_when: "Trade-offs affect product direction",
          version: 1,
        },
        actor: "alice",
        run_id: id,
      })
      const catalog = (await SwarmState.readAlignment()).catalog.roles
      await SwarmState.mutate(id, {
        actor: "coordinator",
        reason: "seed approved state",
        fn: (state) => {
          state.swarm.status = "active"
          state.swarm.stage = "planning"
          state.swarm.resume.stage = null
          state.swarm.reason = null
          state.alignment.contract = {
            goal: "Build a Swarm admin UI",
            scope: "Delegate PM analysis",
            constraints: [],
            roles: [{ role_id: "pm", name: "PM", purpose: null, perspective: null, default_when: null }],
            mode: "execute",
            assumptions: [],
            risks: [],
            discussion_reason: null,
            created_at: now,
          }
          state.alignment.gate = {
            value: "G1",
            reason: "Novel scope keeps the run visible without blocking",
            input: {
              action_sensitive: false,
              material_role_delta: false,
              ambiguous: false,
              valid_options: 1,
              trade_offs: false,
              confidence: "low",
              routine: true,
            },
            evaluated_at: now,
          }
          state.alignment.role_delta = {
            material: false,
            roles: [{ role_id: "pm", name: "PM", state: "unchanged", fields: [] }],
            updated_at: now,
          }
          state.alignment.run_confirmation = {
            gate: "G1",
            confirmed_at: now,
            confirmed_by: "alice",
          }
          state.alignment.pending_confirmation = null
          state.alignment.summary = SwarmState.summarize({
            contract: state.alignment.contract,
            role_delta: state.alignment.role_delta,
            gate: state.alignment.gate,
            pending_confirmation: null,
          })
        },
      })
      await SwarmState.mutate(id, {
        actor: "coordinator",
        reason: "simulate mid-run escalation",
        fn: (state) => {
          const next = SwarmState.preflight({
            goal: state.swarm.goal,
            scope: state.alignment.contract?.scope ?? "Delegate PM analysis",
            discussion: false,
            role: "PM",
            gate: { action_sensitive: true },
            catalog,
            current: state.alignment,
          })
          state.alignment.contract = next.contract
          state.alignment.role_delta = next.role_delta
          state.alignment.gate = next.gate
          state.alignment.run_confirmation = null
          state.alignment.summary = next.summary
          state.alignment.pending_confirmation = next.pending_confirmation
          state.swarm.resume.stage = state.swarm.resume.stage ?? state.swarm.stage
          state.swarm.status = "paused"
          state.swarm.reason = next.pending_confirmation?.reason ?? next.gate.reason
        },
      })

      const align = await SwarmAdmin.readAlignment(id)
      const detail = await SwarmAdmin.get(id)
      expect(align.gate.value).toBe("G3")
      expect(align.pending_confirmation?.kind).toBe("run")
      expect(align.pending_confirmation?.reason).toContain("Alignment gate escalated from G1 to G3")
      expect(align.run_confirmation).toBeNull()
      expect(detail.overview.status).toBe("paused")
      expect(detail.alignment.summary?.ask).toContain("Alignment gate escalated")
    })
  })
})
