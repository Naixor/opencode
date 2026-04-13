import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Swarm } from "../../src/session/swarm"
import { SwarmCleanup } from "../../src/session/swarm-cleanup"
import { SwarmDiscussTool, SwarmListTool, SwarmStatusTool } from "../../src/tool/swarm"

const ctx = {
  sessionID: "test-session",
  messageID: "test-msg",
  callID: "test-call",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("swarm tools", () => {
  async function withInstance(fn: () => Promise<void>) {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn,
    })
  }

  async function save(input: {
    id: string
    goal: string
    workers?: number
    status?: Swarm.Status
    stage?: Swarm.Stage
    reason?: string | null
  }) {
    const ses = await Session.create({ title: `Swarm ${input.id}` })
    const now = Date.now()
    await Swarm.save({
      id: input.id,
      goal: input.goal,
      conductor: ses.id,
      workers: Array.from({ length: input.workers ?? 0 }, (_, i) => ({
        session_id: `ses_worker_${i}`,
        agent: "sisyphus",
        role: i === 0 ? "QA" : undefined,
        task_id: `T-${i + 1}`,
        status: i === 0 ? "blocked" : "running",
        updated_at: now,
        reason: i === 0 ? "awaiting approval" : null,
        evidence: [],
      })),
      config: {
        max_workers: 4,
        auto_escalate: true,
        verify_on_complete: true,
        wait_timeout_seconds: 600,
      },
      status: input.status ?? "active",
      stage: input.stage ?? "executing",
      reason: input.reason ?? null,
      resume: { stage: null },
      visibility: { archived_at: null },
      time: { created: now, updated: now },
    })
  }

  test("swarm_list renders a readable table", async () => {
    await withInstance(async () => {
      const tool = await SwarmListTool.init()
      await save({
        id: "SW-a",
        goal: "Build a swarm dashboard with alerting and role summaries for active worker sessions.",
        workers: 2,
        status: "blocked",
        stage: "executing",
        reason: "worker blocked",
      })
      await save({
        id: "SW-b",
        goal: "Investigate stale worker cleanup.",
        workers: 0,
        status: "completed",
        stage: "idle",
      })

      const result = await tool.execute({}, ctx)
      expect(result.output).toContain("ID")
      expect(result.output).toContain("Status")
      expect(result.output).toContain("Workers")
      expect(result.output).toContain("SW-a")
      expect(result.output).toContain("blocked/executing")
      expect(result.output).toContain("Notes:")
      expect(result.output).toContain("worker blocked")
    })
  })

  test("swarm_status renders a detail view", async () => {
    await withInstance(async () => {
      const tool = await SwarmStatusTool.init()
      await save({
        id: "SW-detail",
        goal: "Triage a blocked worker.",
        workers: 1,
        status: "blocked",
        stage: "executing",
        reason: "worker blocked",
      })

      const result = await tool.execute({ id: "SW-detail" }, ctx)
      expect(result.output).toContain("ID: SW-detail")
      expect(result.output).toContain("State: blocked/executing")
      expect(result.output).toContain("Worker Detail:")
      expect(result.output).toContain("QA [blocked] task T-1 - awaiting approval")
    })
  })

  test("swarm_discuss falls back to default roles", async () => {
    await withInstance(async () => {
      await SwarmCleanup.run({ dry_run: false, confirm: "purge-legacy-swarms" })
      const tool = await SwarmDiscussTool.init()

      const result = await tool.execute({ topic: "How should swarm status feel in the CLI?" }, ctx)
      expect(result.output).toContain("Roles: PM, RD, QA")
      expect(result.metadata.roles).toEqual(["PM", "RD", "QA"])

      const info = await Swarm.load(String(result.metadata.swarmId))
      expect(info?.goal).toContain('Role: "PM"')
      expect(info?.goal).toContain('Role: "RD"')
      expect(info?.goal).toContain('Role: "QA"')
    })
  })
})
