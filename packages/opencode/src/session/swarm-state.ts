import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Lock } from "../util/lock"
import { Log } from "../util/log"

export namespace SwarmState {
  const log = Log.create({ service: "swarm.state" })

  export const StatusNext: Record<Status, readonly Status[]> = {
    active: ["active", "paused", "blocked", "completed", "failed", "stopped"],
    paused: ["paused", "active", "blocked", "failed", "stopped"],
    blocked: ["blocked", "active", "paused", "failed", "stopped"],
    completed: ["completed"],
    failed: ["failed"],
    stopped: ["stopped"],
  }

  export const StageNext: Record<Stage, readonly Stage[]> = {
    planning: ["planning", "dispatching", "executing", "discussing", "verifying", "repairing", "idle"],
    dispatching: ["dispatching", "executing", "discussing", "verifying", "repairing", "idle"],
    executing: ["executing", "dispatching", "discussing", "verifying", "repairing", "idle"],
    discussing: ["discussing", "dispatching", "executing", "verifying", "idle"],
    verifying: ["verifying", "repairing", "idle"],
    repairing: ["repairing", "dispatching", "executing", "verifying", "idle"],
    idle: ["idle", "planning", "dispatching", "executing", "discussing", "verifying", "repairing"],
  }

  export const WorkerNext: Record<WorkerStatus, readonly WorkerStatus[]> = {
    queued: ["queued", "starting", "cancelled", "stopped"],
    starting: ["starting", "running", "blocked", "failed", "cancelled", "stopped"],
    running: ["running", "waiting", "blocked", "completed", "failed", "cancelled", "stopped"],
    waiting: ["waiting", "blocked", "completed", "failed", "cancelled", "stopped"],
    blocked: ["blocked", "running", "failed", "cancelled", "stopped"],
    completed: ["completed"],
    failed: ["failed"],
    cancelled: ["cancelled"],
    stopped: ["stopped"],
  }

  export const DiscussionNext: Record<DiscussionStatus, readonly DiscussionStatus[]> = {
    idle: ["idle", "collecting", "cancelled"],
    collecting: ["collecting", "round_complete", "consensus_ready", "exhausted", "failed", "cancelled"],
    round_complete: ["round_complete", "collecting", "consensus_ready", "decided", "exhausted", "failed", "cancelled"],
    consensus_ready: ["consensus_ready", "collecting", "decided", "exhausted", "failed", "cancelled"],
    decided: ["decided"],
    exhausted: ["exhausted"],
    failed: ["failed"],
    cancelled: ["cancelled"],
  }

  export const VerifyNext: Record<VerifyStatus, readonly VerifyStatus[]> = {
    idle: ["idle", "pending", "running", "skipped", "cancelled"],
    pending: ["pending", "running", "passed", "failed", "repair_required", "cancelled"],
    running: ["running", "passed", "failed", "repair_required", "cancelled"],
    passed: ["passed"],
    failed: ["failed", "repair_required"],
    repair_required: ["repair_required", "pending", "running", "failed", "cancelled"],
    skipped: ["skipped"],
    cancelled: ["cancelled"],
  }

  export function align(snapshot: Snapshot) {
    for (const task of Object.values(snapshot.tasks)) {
      if (["pending", "ready"].includes(task.status)) {
        const deps = task.blocked_by.map((id) => snapshot.tasks[id]?.status)
        task.status = deps.length === 0 || deps.every((item) => item === "completed") ? "ready" : "pending"
      }
      task.reason = task.status === "blocked" || task.status === "failed" ? task.reason : null
    }
    for (const worker of Object.values(snapshot.workers)) {
      if (!worker.task_id) continue
      const task = snapshot.tasks[worker.task_id]
      if (!task) continue
      if (["queued", "starting", "running", "waiting"].includes(worker.status)) {
        task.status = "in_progress"
        task.reason = null
        continue
      }
      if (worker.status === "blocked") {
        task.status = "blocked"
        task.reason = worker.reason
        continue
      }
      if (worker.status === "failed") {
        task.status = "failed"
        task.reason = worker.reason
        continue
      }
      if (worker.status === "completed") {
        task.status =
          snapshot.verify.status === "pending" || snapshot.verify.status === "running" ? "verifying" : "completed"
        task.reason = null
      }
    }
    if (snapshot.verify.status === "pending" || snapshot.verify.status === "running") {
      snapshot.swarm.status = "active"
      snapshot.swarm.stage = "verifying"
    }
    if (snapshot.verify.status === "failed" || snapshot.verify.status === "repair_required") {
      snapshot.swarm.status = "active"
      snapshot.swarm.stage = "repairing"
    }
  }

  export const Status = z.enum(["active", "paused", "blocked", "completed", "failed", "stopped"])
  export type Status = z.infer<typeof Status>

  export const Stage = z.enum(["planning", "dispatching", "executing", "discussing", "verifying", "repairing", "idle"])
  export type Stage = z.infer<typeof Stage>

  export const WorkerStatus = z.enum([
    "queued",
    "starting",
    "running",
    "waiting",
    "blocked",
    "completed",
    "failed",
    "cancelled",
    "stopped",
  ])
  export type WorkerStatus = z.infer<typeof WorkerStatus>

  export const TaskStatus = z.enum([
    "pending",
    "ready",
    "in_progress",
    "verifying",
    "completed",
    "blocked",
    "failed",
    "cancelled",
  ])
  export type TaskStatus = z.infer<typeof TaskStatus>

  export const TaskType = z.enum(["implement", "review", "test", "investigate", "fix", "refactor", "discuss"])
  export type TaskType = z.infer<typeof TaskType>

  export const DiscussionStatus = z.enum([
    "idle",
    "collecting",
    "round_complete",
    "consensus_ready",
    "decided",
    "exhausted",
    "failed",
    "cancelled",
  ])
  export type DiscussionStatus = z.infer<typeof DiscussionStatus>

  export const VerifyStatus = z.enum([
    "idle",
    "pending",
    "running",
    "passed",
    "failed",
    "repair_required",
    "skipped",
    "cancelled",
  ])
  export type VerifyStatus = z.infer<typeof VerifyStatus>

  export const Authoritative = [
    "schema_version",
    "rev",
    "seq",
    "swarm.status",
    "swarm.stage",
    "swarm.resume.stage",
    "swarm.visibility.archived_at",
    "workers[*].status",
    "workers[*].task_id",
    "tasks[*].status",
    "tasks[*].blocked_by",
    "tasks[*].verify_required",
    "discussions[*].status",
    "discussions[*].current_round",
    "verify.status",
    "verify.result",
    "audit.last_txn",
  ] as const

  export const Metadata = [
    "swarm.goal",
    "swarm.conductor",
    "swarm.config",
    "swarm.time",
    "workers[*].session_id",
    "workers[*].agent",
    "workers[*].role",
    "workers[*].updated_at",
    "tasks[*].subject",
    "tasks[*].description",
    "tasks[*].type",
    "tasks[*].scope",
    "tasks[*].artifacts",
    "tasks[*].assignee",
    "tasks[*].blocks",
    "tasks[*].metadata",
    "tasks[*].created_at",
    "tasks[*].updated_at",
    "tasks[*].reason",
    "discussions[*].channel",
    "discussions[*].topic",
    "discussions[*].participants",
    "discussions[*].received",
    "discussions[*].max_rounds",
    "verify.required",
    "verify.updated_at",
    "verify.waiver",
    "audit.entries",
    "audit.illegal",
  ] as const

  export const Config = z.object({
    max_workers: z.number().int().positive().default(4),
    auto_escalate: z.boolean().default(true),
    verify_on_complete: z.boolean().default(true),
    wait_timeout_seconds: z.number().int().positive().default(600),
  })
  export type Config = z.infer<typeof Config>

  export const Swarm = z
    .object({
      id: z.string(),
      goal: z.string(),
      conductor: z.string(),
      status: Status,
      stage: Stage,
      reason: z.string().nullable().default(null),
      visibility: z.object({ archived_at: z.number().nullable().default(null) }).default({ archived_at: null }),
      resume: z.object({ stage: Stage.nullable().default(null) }).default({ stage: null }),
      config: Config,
      time: z.object({
        created: z.number(),
        updated: z.number(),
        completed: z.number().nullable().default(null),
        stopped: z.number().nullable().default(null),
        archived: z.number().nullable().default(null),
        deleted: z.number().nullable().default(null),
      }),
    })
    .superRefine((value, ctx) => {
      if (["completed", "failed", "stopped"].includes(value.status) && value.stage !== "idle") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stage"],
          message: `terminal swarm status requires stage=idle, got ${value.status}/${value.stage}`,
        })
      }
      if (value.status === "paused" && value.resume.stage === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resume", "stage"],
          message: "paused swarm status requires resume.stage",
        })
      }
    })
  export type Swarm = z.infer<typeof Swarm>

  export const Worker = z.object({
    id: z.string(),
    session_id: z.string(),
    agent: z.string(),
    role: z.string().nullable().default(null),
    task_id: z.string().nullable().default(null),
    status: WorkerStatus,
    updated_at: z.number(),
    reason: z.string().nullable().default(null),
    evidence: z.array(z.string()).default([]),
  })
  export type Worker = z.infer<typeof Worker>

  export const Task = z.object({
    id: z.string(),
    subject: z.string(),
    description: z.string().nullable().default(null),
    status: TaskStatus,
    blocked_by: z.array(z.string()).default([]),
    blocks: z.array(z.string()).default([]),
    assignee: z.string().nullable().default(null),
    type: TaskType,
    scope: z.array(z.string()).default([]),
    artifacts: z.array(z.string()).default([]),
    verify_required: z.boolean().default(true),
    metadata: z.record(z.string(), z.unknown()).default({}),
    created_at: z.number(),
    updated_at: z.number(),
    reason: z.string().nullable().default(null),
  })
  export type Task = z.infer<typeof Task>

  export const Discussion = z.object({
    id: z.string(),
    channel: z.string(),
    topic: z.string(),
    status: DiscussionStatus,
    current_round: z.number().int().positive(),
    max_rounds: z.number().int().positive().default(3),
    participants: z.array(z.string()).default([]),
    received: z.array(z.string()).default([]),
    updated_at: z.number(),
  })
  export type Discussion = z.infer<typeof Discussion>

  export const Verify = z.object({
    status: VerifyStatus,
    result: z.string().nullable().default(null),
    required: z.boolean().default(true),
    waiver: z
      .object({
        actor: z.string(),
        reason: z.string(),
        at: z.number(),
      })
      .nullable()
      .default(null),
    updated_at: z.number(),
  })
  export type Verify = z.infer<typeof Verify>

  export const AuditEntry = z.object({
    txn: z.string(),
    actor: z.string(),
    reason: z.string(),
    at: z.number(),
    rev: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
  })
  export type AuditEntry = z.infer<typeof AuditEntry>

  export const Illegal = z.object({
    actor: z.string(),
    reason: z.string(),
    at: z.number(),
  })
  export type Illegal = z.infer<typeof Illegal>

  export const Audit = z.object({
    last_txn: z.string().nullable().default(null),
    entries: z.array(AuditEntry).default([]),
    illegal: z.array(Illegal).default([]),
  })
  export type Audit = z.infer<typeof Audit>

  export const Snapshot = z.object({
    schema_version: z.literal(2),
    rev: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
    swarm: Swarm,
    workers: z.record(z.string(), Worker).default({}),
    tasks: z.record(z.string(), Task).default({}),
    discussions: z.record(z.string(), Discussion).default({}),
    verify: Verify,
    audit: Audit,
  })
  export type Snapshot = z.infer<typeof Snapshot>

  export const Example = Snapshot.parse({
    schema_version: 2,
    rev: 3,
    seq: 42,
    swarm: {
      id: "sw_1",
      goal: "Verify the canonical snapshot schema",
      conductor: "SE-conductor",
      status: "active",
      stage: "verifying",
      reason: "all_required_tasks_finished",
      visibility: { archived_at: null },
      resume: { stage: "executing" },
      config: { max_workers: 4, auto_escalate: true, verify_on_complete: true, wait_timeout_seconds: 600 },
      time: { created: 1, updated: 2, completed: null, stopped: null, archived: null, deleted: null },
    },
    workers: {
      w_1: {
        id: "w_1",
        session_id: "SE-worker-1",
        agent: "sisyphus",
        role: null,
        task_id: "t_1",
        status: "completed",
        updated_at: 2,
        reason: null,
        evidence: [],
      },
    },
    tasks: {
      t_1: {
        id: "t_1",
        subject: "Run verification",
        description: null,
        status: "verifying",
        blocked_by: [],
        blocks: [],
        assignee: "SE-worker-1",
        type: "test",
        scope: [],
        artifacts: [],
        verify_required: true,
        metadata: {},
        created_at: 1,
        updated_at: 2,
        reason: null,
      },
    },
    discussions: {},
    verify: {
      status: "running",
      result: null,
      required: true,
      waiver: null,
      updated_at: 2,
    },
    audit: {
      last_txn: "txn_42",
      entries: [],
      illegal: [],
    },
  })

  export function filepath(id: string) {
    return path.join(Global.Path.data, "projects", Instance.project.id, "board", id, "state.json")
  }

  function key(id: string) {
    return `swarm-state:${id}`
  }

  export async function ensure(id: string) {
    await fs.mkdir(path.dirname(filepath(id)), { recursive: true })
  }

  export async function read(id: string): Promise<Snapshot | undefined> {
    const file = Bun.file(filepath(id))
    if (!(await file.exists())) return undefined
    return Snapshot.parse(await file.json())
  }

  export async function write(snapshot: Snapshot) {
    await ensure(snapshot.swarm.id)
    await Bun.write(filepath(snapshot.swarm.id), JSON.stringify(snapshot, null, 2))
  }

  export async function illegal(id: string, input: { actor: string; reason: string }) {
    using _ = await Lock.write(key(id))
    const state = await read(id)
    if (!state) return
    state.audit.illegal.push({ actor: input.actor, reason: input.reason, at: Date.now() })
    await write(state)
    log.warn("illegal swarm mutation", { swarm: id, actor: input.actor, reason: input.reason })
  }

  export function check(prev: Snapshot, next: Snapshot) {
    if (!StatusNext[prev.swarm.status].includes(next.swarm.status)) {
      throw new Error(`Invalid swarm status transition: ${prev.swarm.status} -> ${next.swarm.status}`)
    }
    if (!StageNext[prev.swarm.stage].includes(next.swarm.stage)) {
      throw new Error(`Invalid swarm stage transition: ${prev.swarm.stage} -> ${next.swarm.stage}`)
    }
    if (prev.swarm.status === "blocked" && next.swarm.status === "active" && !next.swarm.reason) {
      throw new Error("Blocked swarm recovery requires explicit unblock evidence")
    }
    const tasks = new Map<string, string>()
    for (const [id, worker] of Object.entries(next.workers)) {
      const prevWorker = prev.workers[id]
      if (prevWorker && !WorkerNext[prevWorker.status].includes(worker.status)) {
        throw new Error(`Invalid worker status transition: ${prevWorker.status} -> ${worker.status}`)
      }
      if (prevWorker?.status === "blocked" && worker.status === "running" && worker.evidence.length === 0) {
        throw new Error(`Blocked worker ${id} requires explicit unblock evidence`)
      }
      if (!worker.task_id || ["completed", "failed", "cancelled", "stopped"].includes(worker.status)) continue
      const hit = tasks.get(worker.task_id)
      if (hit) throw new Error(`Only one non-terminal worker may own task ${worker.task_id}: ${hit}, ${id}`)
      tasks.set(worker.task_id, id)
    }
    for (const [id, item] of Object.entries(next.discussions)) {
      const prevItem = prev.discussions[id]
      if (prevItem && !DiscussionNext[prevItem.status].includes(item.status)) {
        throw new Error(`Invalid discussion status transition: ${prevItem.status} -> ${item.status}`)
      }
      if (item.current_round < 1) throw new Error(`Discussion ${id} must start at round 1`)
      if (item.current_round > item.max_rounds) throw new Error(`Discussion ${id} exceeded max rounds`)
    }
    if (!VerifyNext[prev.verify.status].includes(next.verify.status)) {
      throw new Error(`Invalid verify status transition: ${prev.verify.status} -> ${next.verify.status}`)
    }
    if (next.verify.status === "skipped" && !next.verify.waiver) {
      throw new Error("Verify.skipped requires explicit waiver evidence")
    }
    if ((next.verify.status === "pending" || next.verify.status === "running") && next.swarm.status !== "active") {
      throw new Error("Verify pending/running requires swarm.status=active")
    }
    if ((next.verify.status === "pending" || next.verify.status === "running") && next.swarm.stage !== "verifying") {
      throw new Error("Verify pending/running requires swarm.stage=verifying")
    }
    if (next.swarm.status === "completed") {
      const needed = Object.values(next.tasks).filter((task) => task.verify_required)
      if (needed.some((task) => task.status !== "completed")) {
        throw new Error("Swarm completion requires all required tasks to be completed")
      }
      const okay = next.verify.status === "passed" || (next.verify.status === "skipped" && Boolean(next.verify.waiver))
      if (!okay) throw new Error("Swarm completion requires verify passed or skipped with waiver")
    }
  }

  export async function mutate(
    id: string,
    input: {
      actor: string
      reason: string
      fn: (snapshot: Snapshot) => void
    },
  ) {
    using _ = await Lock.write(key(id))
    const state = await read(id)
    if (!state) throw new Error(`Swarm state not found: ${id}`)
    if (input.actor !== "coordinator" && input.actor !== state.swarm.conductor) {
      state.audit.illegal.push({ actor: input.actor, reason: input.reason, at: Date.now() })
      await write(state)
      log.warn("blocked non-coordinator mutation", { swarm: id, actor: input.actor, reason: input.reason })
      throw new Error(`Only the coordinator can mutate swarm state: ${input.actor}`)
    }
    const next = structuredClone(state)
    input.fn(next)
    align(next)
    check(state, next)
    const checked = Snapshot.parse(next)
    await write(checked)
    return checked
  }

  export function create(input: {
    id: string
    goal: string
    conductor: string
    config?: Partial<Config>
    time?: { created?: number; updated?: number }
  }): Snapshot {
    const now = input.time?.updated ?? input.time?.created ?? Date.now()
    return Snapshot.parse({
      schema_version: 2,
      rev: 0,
      seq: 0,
      swarm: {
        id: input.id,
        goal: input.goal,
        conductor: input.conductor,
        status: "active",
        stage: "planning",
        reason: null,
        visibility: { archived_at: null },
        resume: { stage: null },
        config: {
          max_workers: input.config?.max_workers ?? 4,
          auto_escalate: input.config?.auto_escalate ?? true,
          verify_on_complete: input.config?.verify_on_complete ?? true,
          wait_timeout_seconds: input.config?.wait_timeout_seconds ?? 600,
        },
        time: {
          created: input.time?.created ?? now,
          updated: now,
          completed: null,
          stopped: null,
          archived: null,
          deleted: null,
        },
      },
      workers: {},
      tasks: {},
      discussions: {},
      verify: {
        status: "idle",
        result: null,
        required: input.config?.verify_on_complete ?? true,
        waiver: null,
        updated_at: now,
      },
      audit: {
        last_txn: null,
        entries: [],
        illegal: [],
      },
    })
  }
}
