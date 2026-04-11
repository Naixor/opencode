import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { SharedBoard, BoardTask, BoardSignal } from "../../src/board"
import { BoardArtifact } from "../../src/board/artifact"
import { Discussion } from "../../src/board/discussion"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { SwarmAdmin } from "../../src/session/swarm-admin"
import { Swarm } from "../../src/session/swarm"
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
  test("safe delete hides swarms by default and preserves board files", async () => {
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

      expect(gone.time.deleted).toBeDefined()
      expect((await Swarm.list()).map((item) => item.id)).not.toContain(id)
      expect((await Swarm.list({ include_deleted: true })).map((item) => item.id)).toContain(id)
      expect(await Swarm.status(id, { include_deleted: true })).toMatchObject({ id })

      const base = path.join(Global.Path.data, "projects", Instance.project.id, "board", id)
      expect(await Bun.file(path.join(base, "tasks", `${task.id}.json`)).exists()).toBe(true)
      expect(await Bun.file(path.join(base, "signals.jsonl")).exists()).toBe(true)
      expect((await BoardTask.list(id)).length).toBe(1)
    })
  })

  test("cannot delete a running swarm", async () => {
    await withInstance(async () => {
      const id = "SW-running"
      await seed(id, { status: "active", stage: "executing" })
      await expect(Swarm.remove(id)).rejects.toThrow("Cannot delete running swarm")
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
      const detail = await SwarmAdmin.get(id)

      expect(overview).toHaveLength(1)
      expect(overview[0]).toMatchObject({
        swarm_id: id,
        status: "blocked",
        needs_attention: true,
      })
      expect(overview[0]?.attention).toContain("blocked_task")
      expect(overview[0]?.attention).toContain("no_consensus")
      expect(detail.plan_summary).toContain("read-only admin UI")
      expect(detail.risk_summary).toContain("Conductor note")
      expect(detail.actions[0]).toMatchObject({ kind: "decision" })
      expect(detail.task_filters.assignees).toContain("SE-worker-1")
      expect(detail.tasks.find((task) => task.id === stuck.id)?.blocked_reason).toContain("Waiting on API contract")
      expect(detail.agents.find((agent) => agent.label === "PM")?.discussion_channels).toContain("debate-delete")
      expect(detail.discussions[0]).toMatchObject({
        channel: "debate-delete",
        consensus_state: "no_consensus",
      })
      expect(detail.discussions[0]?.raw[0]?.entries.length).toBeGreaterThan(0)
    })
  })
})
