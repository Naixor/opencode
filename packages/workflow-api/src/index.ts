import z from "zod"

/**
 * Public workflow file attachment schema.
 *
 * This mirrors the file objects exposed to workflow `run(ctx, input)` handlers.
 * Use it when validating custom workflow input or documenting workflow contracts.
 */
export const WorkflowFile = z.object({
  type: z.literal("file"),
  mime: z.string(),
  url: z.string(),
  filename: z.string().optional(),
  source: z
    .object({
      type: z.enum(["file", "symbol", "resource"]),
      text: z.object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      }),
      path: z.string().optional(),
      name: z.string().optional(),
      kind: z.number().int().optional(),
      range: z.unknown().optional(),
      clientName: z.string().optional(),
      uri: z.string().optional(),
    })
    .optional(),
})

/**
 * Default input passed to a workflow when no custom schema is supplied.
 *
 * - `raw`: raw argument string after the workflow name
 * - `argv`: shell-like split args
 * - `files`: attached file parts from the invoking message
 */
export const WorkflowArgs = z.object({
  raw: z.string(),
  argv: z.array(z.string()),
  files: z.array(WorkflowFile),
})

/**
 * Standard workflow return payload.
 *
 * Workflows may also return a plain string. Use this object form when you want
 * a stable title or structured metadata in addition to output text.
 */
export const WorkflowResult = z.object({
  title: z.string().optional(),
  output: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const WorkflowProgressKey = "workflow_progress" as const

export const WorkflowProgressV1VersionValue = "workflow-progress.v1" as const

export const WorkflowProgressV2VersionValue = "workflow-progress.v2" as const

export const WorkflowProgressWorkflowTargetId = "workflow" as const

export const WorkflowProgressVersionValue = WorkflowProgressV2VersionValue

export const WorkflowProgressVersionValues = [WorkflowProgressV1VersionValue, WorkflowProgressV2VersionValue] as const

export const WorkflowProgressVersion = z.enum(WorkflowProgressVersionValues)

export const WorkflowProgressStatus = z.enum([
  "pending",
  "active",
  "completed",
  "waiting",
  "blocked",
  "failed",
  "retrying",
  "running",
  "done",
])

export const WorkflowStatus = z.enum(["pending", "running", "waiting", "blocked", "failed", "retrying", "done"])

export const WorkflowPhaseStatus = z.enum([
  "pending",
  "active",
  "completed",
  "waiting",
  "blocked",
  "failed",
  "retrying",
])

export const WorkflowRoundStatus = z.enum([
  "pending",
  "active",
  "completed",
  "waiting",
  "blocked",
  "failed",
  "retrying",
])

export const WorkflowStepStatus = z.enum(["pending", "active", "completed", "waiting", "blocked", "failed", "retrying"])

export const WorkflowAgentStatus = z.enum([
  "pending",
  "running",
  "completed",
  "waiting",
  "blocked",
  "failed",
  "retrying",
])

/**
 * Required: `status`
 * Optional: `name`, `label`, `summary`, `input`, `started_at`, `ended_at`
 * Fallback: omit missing text or time fields; render `label`, then `name`, then a
 * stable workflow identifier from the caller when available.
 */
export const WorkflowProgressWorkflow = z.object({
  status: WorkflowStatus,
  name: z.string().optional(),
  label: z.string().optional(),
  summary: z.string().optional(),
  input: z.string().optional(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
})

/**
 * Required: `status`
 * Optional: `key`, `label`, `summary`
 * Fallback: render `label`, then `key`, then `status`. If `phase` is missing,
 * consumers should fall back to workflow-level status.
 */
export const WorkflowProgressPhase = z.object({
  status: WorkflowPhaseStatus,
  key: z.string().optional(),
  label: z.string().optional(),
  summary: z.string().optional(),
})

/**
 * Required: `status`
 * Optional: `current`, `max`, `label`, `summary`
 * Fallback: when `current` is missing, render `Round unknown`; when `max` is
 * missing, show only the current round label or number.
 */
export const WorkflowProgressRound = z.object({
  status: WorkflowRoundStatus,
  current: z.number().int().nonnegative().optional(),
  max: z.number().int().positive().optional(),
  label: z.string().optional(),
  summary: z.string().optional(),
})

/**
 * Required: `id`, `status`
 * Optional: `label`, `summary`, `reason`
 * Fallback: render `label`, then `id`; omit `reason` when unavailable. If
 * `steps` is missing, consumers should skip the timeline instead of failing.
 */
export const WorkflowProgressStep = z.object({
  id: z.string(),
  status: WorkflowStepStatus,
  label: z.string().optional(),
  summary: z.string().optional(),
  reason: z.string().optional(),
})

/**
 * Required: `name`, `status`
 * Optional: `role`, `summary`, `updated_at`, `round`
 * Fallback: render `role`, then `name`; use a stable empty state like `not
 * started` when `summary` is missing; omit time or round details when absent.
 */
export const WorkflowProgressAgent = z.object({
  id: z.string().optional(),
  name: z.string(),
  label: z.string().optional(),
  status: WorkflowAgentStatus,
  role: z.string().optional(),
  summary: z.string().optional(),
  updated_at: z.string().optional(),
  round: z.number().int().nonnegative().optional(),
})

export const WorkflowStepKind = z.enum(["task", "group", "wait", "decision", "terminal"])

export const WorkflowProgressParticipant = z.object({
  id: z.string(),
  label: z.string().optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  status: WorkflowAgentStatus.optional(),
  summary: z.string().optional(),
  updated_at: z.string().optional(),
  round: z.number().int().nonnegative().optional(),
  step_id: z.string().optional(),
  run_id: z.string().optional(),
})

export const WorkflowProgressMachine = z.object({
  id: z.string().optional(),
  key: z.string().optional(),
  label: z.string().optional(),
  summary: z.string().optional(),
  root_step_id: z.string().optional(),
  active_step_id: z.string().optional(),
  active_run_id: z.string().optional(),
  started_at: z.string().optional(),
  updated_at: z.string().optional(),
})

export const WorkflowProgressStepDefinition = z.object({
  id: z.string(),
  kind: WorkflowStepKind,
  parent_id: z.string().optional(),
  label: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  children: z.array(z.string()).optional(),
  next: z.array(z.string()).optional(),
})

export const WorkflowProgressRunRound = z.object({
  current: z.number().int().nonnegative(),
  max: z.number().int().positive().optional(),
  label: z.string().optional(),
  summary: z.string().optional(),
})

export const WorkflowProgressRunRetry = z.object({
  current: z.number().int().nonnegative(),
  max: z.number().int().positive().optional(),
  label: z.string().optional(),
  summary: z.string().optional(),
})

export const WorkflowProgressRunActor = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  status: WorkflowAgentStatus.optional(),
  summary: z.string().optional(),
  updated_at: z.string().optional(),
})

export const WorkflowProgressStepRun = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  step_id: z.string(),
  status: WorkflowStepStatus,
  label: z.string().optional(),
  summary: z.string().optional(),
  reason: z.string().optional(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  parent_run_id: z.string().optional(),
  round: WorkflowProgressRunRound.optional(),
  retry: WorkflowProgressRunRetry.optional(),
  actor: WorkflowProgressRunActor.optional(),
})

export const WorkflowProgressTransitionLevel = z.enum(["workflow", "step"])

export const WorkflowProgressTransitionSource = z.object({
  type: z.string().optional(),
  id: z.string().optional(),
  label: z.string().optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  participant_id: z.string().optional(),
  step_id: z.string().optional(),
  run_id: z.string().optional(),
})

const WorkflowProgressTransitionBase = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  timestamp: z.string().optional(),
  target_id: z.string(),
  run_id: z.string().optional(),
  reason: z.string().optional(),
  source: WorkflowProgressTransitionSource.optional(),
})

const WorkflowProgressWorkflowTransition = WorkflowProgressTransitionBase.extend({
  level: z.literal("workflow"),
  from_state: WorkflowStatus.optional(),
  to_state: WorkflowStatus,
})

const WorkflowProgressStepTransition = WorkflowProgressTransitionBase.extend({
  level: z.literal("step"),
  from_state: WorkflowStepStatus.optional(),
  to_state: WorkflowStepStatus,
})

export const WorkflowProgressTransition = z.discriminatedUnion("level", [
  WorkflowProgressWorkflowTransition,
  WorkflowProgressStepTransition,
])

export const WorkflowProgressWorkflowMetadata = WorkflowProgressWorkflow

export const WorkflowProgressMachineMetadata = WorkflowProgressMachine

export const WorkflowProgressParticipantMetadata = WorkflowProgressParticipant

export const WorkflowProgressTransitionRecord = WorkflowProgressTransition

function issue(ctx: z.RefinementCtx, path: Array<string | number>, message: string) {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message,
  })
}

/**
 * Required: `version`, `workflow`
 * Optional: `phase`, `round`, `steps`, `agents`
 * Fallback: this remains the migration compatibility shape. Consumers should
 * preserve workflow-level status plus any simple phase, round, step, and agent
 * metadata when state-machine sections are unavailable.
 */
export const WorkflowProgressV1 = z.object({
  version: z.literal(WorkflowProgressV1VersionValue),
  workflow: WorkflowProgressWorkflow,
  phase: WorkflowProgressPhase.optional(),
  round: WorkflowProgressRound.optional(),
  steps: z.array(WorkflowProgressStep).optional(),
  agents: z.array(WorkflowProgressAgent).optional(),
})

const WorkflowProgressV2Tolerant = z.object({
  version: z.literal(WorkflowProgressV2VersionValue),
  workflow: WorkflowProgressWorkflow,
  machine: WorkflowProgressMachine.optional(),
  step_definitions: z.array(WorkflowProgressStepDefinition).optional(),
  step_runs: z.array(WorkflowProgressStepRun).optional(),
  transitions: z.array(WorkflowProgressTransition).optional(),
  phase: WorkflowProgressPhase.optional(),
  round: WorkflowProgressRound.optional(),
  steps: z.array(WorkflowProgressStep).optional(),
  agents: z.array(WorkflowProgressAgent).optional(),
  participants: z.array(WorkflowProgressParticipant).optional(),
})

const WorkflowProgressV2Base = WorkflowProgressV2Tolerant.transform((input) => ({
  version: input.version,
  workflow: input.workflow,
  machine: input.machine ?? {},
  step_definitions: input.step_definitions ?? [],
  step_runs: input.step_runs ?? [],
  transitions: input.transitions ?? [],
  ...(input.phase ? { phase: input.phase } : {}),
  ...(input.round ? { round: input.round } : {}),
  ...(input.steps ? { steps: input.steps } : {}),
  ...(input.agents ? { agents: input.agents } : {}),
  participants: input.participants ?? [],
}))

const WorkflowProgressV2Shape = z.object({
  version: z.literal(WorkflowProgressV2VersionValue),
  workflow: WorkflowProgressWorkflow,
  machine: WorkflowProgressMachine,
  step_definitions: z.array(WorkflowProgressStepDefinition),
  step_runs: z.array(WorkflowProgressStepRun),
  transitions: z.array(WorkflowProgressTransition),
  phase: WorkflowProgressPhase.optional(),
  round: WorkflowProgressRound.optional(),
  steps: z.array(WorkflowProgressStep).optional(),
  agents: z.array(WorkflowProgressAgent).optional(),
  participants: z.array(WorkflowProgressParticipant),
})

/**
 * Required: `version`, `workflow`, `machine`, `step_definitions`, `step_runs`,
 * `transitions`, `participants`
 * Optional: `phase`, `round`, `steps`, `agents`
 * Fallback: external emitters may omit the optional projection helpers, but the
 * state-machine sections stay deterministic so reducers can sort by `seq` and
 * break ties with stable record ids.
 */
export const WorkflowProgressV2 = WorkflowProgressV2Shape.superRefine((input, ctx) => {
  const defs = new Set<string>()
  const graph = new Map<string, z.infer<typeof WorkflowProgressStepDefinition>>()
  const runs = new Map<string, z.infer<typeof WorkflowProgressStepRun>>()
  const trans = new Set<string>()
  const parts = new Set<string>()

  input.step_definitions?.forEach((item, ix) => {
    if (defs.has(item.id)) {
      issue(ctx, ["step_definitions", ix, "id"], `Duplicate step definition id: ${item.id}`)
      return
    }
    defs.add(item.id)
    graph.set(item.id, item)
  })

  input.step_definitions?.forEach((item, ix) => {
    if (item.parent_id && !defs.has(item.parent_id)) {
      issue(ctx, ["step_definitions", ix, "parent_id"], `Unknown step definition id: ${item.parent_id}`)
    }
    const kids = new Set<string>()
    item.children?.forEach((id, jx) => {
      if (id === item.id) {
        issue(ctx, ["step_definitions", ix, "children", jx], `Step definition cannot reference itself: ${id}`)
        return
      }
      if (kids.has(id)) {
        issue(ctx, ["step_definitions", ix, "children", jx], `Duplicate child step definition id: ${id}`)
        return
      }
      kids.add(id)
      if (!defs.has(id)) {
        issue(ctx, ["step_definitions", ix, "children", jx], `Unknown step definition id: ${id}`)
        return
      }
    })
    item.next?.forEach((id, jx) => {
      if (!defs.has(id)) {
        issue(ctx, ["step_definitions", ix, "next", jx], `Unknown step definition id: ${id}`)
      }
    })

    if (!item.parent_id) return
    const seen = new Set([item.id])
    let cur: string | undefined = item.parent_id
    while (cur) {
      if (seen.has(cur)) {
        issue(ctx, ["step_definitions", ix, "parent_id"], `Cyclic step definition parent chain: ${item.id}`)
        return
      }
      seen.add(cur)
      cur = graph.get(cur)?.parent_id
    }
  })

  input.step_runs?.forEach((item, ix) => {
    if (runs.has(item.id)) {
      issue(ctx, ["step_runs", ix, "id"], `Duplicate step run id: ${item.id}`)
      return
    }
    runs.set(item.id, item)
  })

  input.step_runs?.forEach((item, ix) => {
    if (!defs.has(item.step_id)) {
      issue(ctx, ["step_runs", ix, "step_id"], `Unknown step definition id: ${item.step_id}`)
    }
    if (item.parent_run_id && !runs.has(item.parent_run_id)) {
      issue(ctx, ["step_runs", ix, "parent_run_id"], `Unknown step run id: ${item.parent_run_id}`)
    }
    if (ix > 0 && input.step_runs && input.step_runs[ix - 1] && input.step_runs[ix - 1].seq >= item.seq) {
      issue(ctx, ["step_runs", ix, "seq"], `Step run seq must be strictly increasing: ${item.seq}`)
    }
  })

  input.participants?.forEach((item, ix) => {
    if (parts.has(item.id)) {
      issue(ctx, ["participants", ix, "id"], `Duplicate participant id: ${item.id}`)
      return
    }
    parts.add(item.id)
    if (item.step_id && !defs.has(item.step_id)) {
      issue(ctx, ["participants", ix, "step_id"], `Unknown step definition id: ${item.step_id}`)
    }
    if (!item.run_id) return
    const run = runs.get(item.run_id)
    if (!run) {
      issue(ctx, ["participants", ix, "run_id"], `Unknown step run id: ${item.run_id}`)
      return
    }
    if (item.step_id && run.step_id !== item.step_id) {
      issue(
        ctx,
        ["participants", ix, "run_id"],
        `Step run ${run.id} points to ${run.step_id}, expected ${item.step_id}`,
      )
    }
  })

  if (input.machine?.root_step_id && !defs.has(input.machine.root_step_id)) {
    issue(ctx, ["machine", "root_step_id"], `Unknown step definition id: ${input.machine.root_step_id}`)
  }
  if (input.machine?.active_step_id && !defs.has(input.machine.active_step_id)) {
    issue(ctx, ["machine", "active_step_id"], `Unknown step definition id: ${input.machine.active_step_id}`)
  }
  if (input.machine?.active_run_id) {
    const run = runs.get(input.machine.active_run_id)
    if (!run) {
      issue(ctx, ["machine", "active_run_id"], `Unknown step run id: ${input.machine.active_run_id}`)
    }
    if (run && input.machine.active_step_id && run.step_id !== input.machine.active_step_id) {
      issue(
        ctx,
        ["machine", "active_run_id"],
        `Step run ${run.id} points to ${run.step_id}, expected ${input.machine.active_step_id}`,
      )
    }
  }

  input.transitions?.forEach((item, ix) => {
    if (trans.has(item.id)) {
      issue(ctx, ["transitions", ix, "id"], `Duplicate transition id: ${item.id}`)
    }
    trans.add(item.id)
    if (ix > 0 && input.transitions && input.transitions[ix - 1] && input.transitions[ix - 1].seq >= item.seq) {
      issue(ctx, ["transitions", ix, "seq"], `Transition seq must be strictly increasing: ${item.seq}`)
    }
    if (item.level === "workflow") {
      if (item.target_id !== WorkflowProgressWorkflowTargetId) {
        issue(ctx, ["transitions", ix, "target_id"], `Unknown workflow target id: ${item.target_id}`)
      }
      return
    }

    if (!defs.has(item.target_id)) {
      issue(ctx, ["transitions", ix, "target_id"], `Unknown step definition id: ${item.target_id}`)
    }
    if (!item.run_id) return
    const run = runs.get(item.run_id)
    if (!run) {
      issue(ctx, ["transitions", ix, "run_id"], `Unknown step run id: ${item.run_id}`)
      return
    }
    if (run.step_id !== item.target_id) {
      issue(
        ctx,
        ["transitions", ix, "run_id"],
        `Step run ${run.id} points to ${run.step_id}, expected ${item.target_id}`,
      )
    }

    const ref = item.source
    if (!ref) return
    if (ref.participant_id) {
      const part = input.participants?.find((row) => row.id === ref.participant_id)
      if (!part) {
        issue(ctx, ["transitions", ix, "source", "participant_id"], `Unknown participant id: ${ref.participant_id}`)
      }
      if (part && ref.run_id && part.run_id && part.run_id !== ref.run_id) {
        issue(
          ctx,
          ["transitions", ix, "source", "run_id"],
          `Participant ${part.id} points to ${part.run_id}, expected ${ref.run_id}`,
        )
      }
      if (part && ref.step_id && part.step_id && part.step_id !== ref.step_id) {
        issue(
          ctx,
          ["transitions", ix, "source", "step_id"],
          `Participant ${part.id} points to ${part.step_id}, expected ${ref.step_id}`,
        )
      }
    }
    if (ref.step_id && !defs.has(ref.step_id)) {
      issue(ctx, ["transitions", ix, "source", "step_id"], `Unknown step definition id: ${ref.step_id}`)
    }
    if (!ref.run_id) return
    const src = runs.get(ref.run_id)
    if (!src) {
      issue(ctx, ["transitions", ix, "source", "run_id"], `Unknown step run id: ${ref.run_id}`)
      return
    }
    if (ref.step_id && src.step_id !== ref.step_id) {
      issue(
        ctx,
        ["transitions", ix, "source", "run_id"],
        `Step run ${src.id} points to ${src.step_id}, expected ${ref.step_id}`,
      )
    }
  })
})

export const WorkflowProgress = z.discriminatedUnion("version", [WorkflowProgressV1, WorkflowProgressV2])

export const WorkflowStatusUpdate = z
  .object({
    title: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    progress: WorkflowProgress.optional(),
  })
  .strict()

export type WorkflowFile = z.infer<typeof WorkflowFile>
export type WorkflowArgs = z.infer<typeof WorkflowArgs>
export type WorkflowResult = z.infer<typeof WorkflowResult>
export type WorkflowProgressVersion = z.infer<typeof WorkflowProgressVersion>
export type WorkflowProgressStatus = z.infer<typeof WorkflowProgressStatus>
export type WorkflowStatus = z.infer<typeof WorkflowStatus>
export type WorkflowPhaseStatus = z.infer<typeof WorkflowPhaseStatus>
export type WorkflowRoundStatus = z.infer<typeof WorkflowRoundStatus>
export type WorkflowStepStatus = z.infer<typeof WorkflowStepStatus>
export type WorkflowAgentStatus = z.infer<typeof WorkflowAgentStatus>
export type WorkflowStepKind = z.infer<typeof WorkflowStepKind>
export type WorkflowProgressWorkflow = z.infer<typeof WorkflowProgressWorkflow>
export type WorkflowProgressPhase = z.infer<typeof WorkflowProgressPhase>
export type WorkflowProgressRound = z.infer<typeof WorkflowProgressRound>
export type WorkflowProgressStep = z.infer<typeof WorkflowProgressStep>
export type WorkflowProgressAgent = z.infer<typeof WorkflowProgressAgent>
export type WorkflowProgressWorkflowMetadata = z.infer<typeof WorkflowProgressWorkflowMetadata>
export type WorkflowProgressParticipant = z.infer<typeof WorkflowProgressParticipant>
export type WorkflowProgressParticipantMetadata = z.infer<typeof WorkflowProgressParticipantMetadata>
export type WorkflowProgressMachine = z.infer<typeof WorkflowProgressMachine>
export type WorkflowProgressMachineMetadata = z.infer<typeof WorkflowProgressMachineMetadata>
export type WorkflowProgressStepDefinition = z.infer<typeof WorkflowProgressStepDefinition>
export type WorkflowProgressRunRound = z.infer<typeof WorkflowProgressRunRound>
export type WorkflowProgressRunRetry = z.infer<typeof WorkflowProgressRunRetry>
export type WorkflowProgressRunActor = z.infer<typeof WorkflowProgressRunActor>
export type WorkflowProgressStepRun = z.infer<typeof WorkflowProgressStepRun>
export type WorkflowProgressTransitionLevel = z.infer<typeof WorkflowProgressTransitionLevel>
export type WorkflowProgressTransitionSource = z.infer<typeof WorkflowProgressTransitionSource>
export type WorkflowProgressTransition = z.infer<typeof WorkflowProgressTransition>
export type WorkflowProgressTransitionRecord = z.infer<typeof WorkflowProgressTransitionRecord>
export type WorkflowProgressV1 = z.infer<typeof WorkflowProgressV1>
export type WorkflowProgressV2 = z.infer<typeof WorkflowProgressV2>
export type WorkflowProgress = z.infer<typeof WorkflowProgress>
export type WorkflowProgressRead = {
  version: WorkflowProgressVersion
  workflow: WorkflowProgressWorkflow
  machine: WorkflowProgressMachine
  step_definitions: WorkflowProgressStepDefinition[]
  step_runs: WorkflowProgressStepRun[]
  transitions: WorkflowProgressTransition[]
  phase?: WorkflowProgressPhase
  round?: WorkflowProgressRound
  steps: WorkflowProgressStep[]
  agents: WorkflowProgressAgent[]
  participants: WorkflowProgressParticipant[]
}
export type WorkflowStatusUpdate = z.infer<typeof WorkflowStatusUpdate>

export type WorkflowTaskInput = {
  description: string
  prompt: string
  subagent: string
  category?: string
  model?: `${string}/${string}` | { providerID: string; modelID: string }
  session_id?: string
  load_skills?: string[]
}

export type WorkflowTaskResult = {
  session_id: string
  text: string
}

export type WorkflowInvokeInput = {
  name: string
  raw?: string
  argv?: string[]
  files?: WorkflowFile[]
}

export type WorkflowInvokeResult = {
  name: string
  title?: string
  output?: string
  metadata?: Record<string, unknown>
}

export type WorkflowContext<Input = WorkflowArgs> = {
  name: string
  directory: string
  worktree: string
  sessionID: string
  userMessageID: string
  assistantMessageID: string
  raw: string
  argv: string[]
  files: WorkflowFile[]
  status(input: WorkflowStatusUpdate): Promise<void>
  write(input: { file: string; content: string }): Promise<void>
  ask(input: {
    questions: Array<{
      question: string
      header: string
      options: Array<{
        label: string
        description: string
      }>
      multiple?: boolean
      custom?: boolean
    }>
  }): Promise<{
    answers: string[][]
    images?: Array<{
      mime: string
      url: string
      filename?: string
    }>
  }>
  task(input: WorkflowTaskInput): Promise<WorkflowTaskResult>
  workflow(input: WorkflowInvokeInput): Promise<WorkflowInvokeResult>
}

export type WorkflowDefinition<Input = WorkflowArgs> = {
  description?: string
  input?: z.ZodType<Input>
  run(ctx: WorkflowContext<Input>, input: Input): Promise<string | WorkflowResult> | string | WorkflowResult
}

export type Context<Input = WorkflowArgs> = WorkflowContext<Input>
export type Definition<Input = WorkflowArgs> = WorkflowDefinition<Input>

const WorkflowProgressEnvelope = z.object({
  version: z.string(),
})

export function define<Input = WorkflowArgs>(input: WorkflowDefinition<Input>) {
  return input
}

export function result(input: WorkflowResult) {
  return input
}

function stripprogress(input: Record<string, unknown>) {
  const { [WorkflowProgressKey]: _, ...rest } = input
  return rest
}

function item(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  return input as Record<string, unknown>
}

function text(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function strings(input: unknown) {
  if (!Array.isArray(input)) return
  return input.filter((item): item is string => typeof item === "string")
}

function int(input: unknown, min = 0) {
  if (typeof input !== "number") return
  if (!Number.isInteger(input)) return
  if (input < min) return
  return input
}

function status<T extends string>(schema: z.ZodType<T>, input: unknown) {
  const out = schema.safeParse(input)
  if (!out.success) return
  return out.data
}

function phasestatus(input: WorkflowStatus): WorkflowPhaseStatus {
  if (input === "running") return "active"
  if (input === "done") return "completed"
  return input
}

function roundstatus(input: WorkflowStatus): WorkflowRoundStatus {
  if (input === "running") return "active"
  if (input === "done") return "completed"
  return input
}

function stepstatus(input: WorkflowStatus): WorkflowStepStatus {
  if (input === "running") return "active"
  if (input === "done") return "completed"
  return input
}

function agentstatus(input: WorkflowStatus): WorkflowAgentStatus {
  if (input === "done") return "completed"
  return input
}

function workflow(input: unknown) {
  const val = item(input)
  if (!val) return
  const state = status(WorkflowStatus, val.status)
  if (!state) return
  return WorkflowProgressWorkflow.parse({
    status: state,
    ...(text(val.name) ? { name: text(val.name) } : {}),
    ...(text(val.label) ? { label: text(val.label) } : {}),
    ...(text(val.summary) ? { summary: text(val.summary) } : {}),
    ...(text(val.input) ? { input: text(val.input) } : {}),
    ...(text(val.started_at) ? { started_at: text(val.started_at) } : {}),
    ...(text(val.ended_at) ? { ended_at: text(val.ended_at) } : {}),
  })
}

function phase(input: unknown, fallback: WorkflowStatus): WorkflowProgressPhase | undefined {
  const val = item(input)
  if (!val) return
  return WorkflowProgressPhase.parse({
    status: status(WorkflowPhaseStatus, val.status) ?? phasestatus(fallback),
    ...(text(val.key) ? { key: text(val.key) } : {}),
    ...(text(val.label) ? { label: text(val.label) } : {}),
    ...(text(val.summary) ? { summary: text(val.summary) } : {}),
  })
}

function round(input: unknown, fallback: WorkflowStatus): WorkflowProgressRound | undefined {
  const val = item(input)
  if (!val) return
  return WorkflowProgressRound.parse({
    status: status(WorkflowRoundStatus, val.status) ?? roundstatus(fallback),
    ...(int(val.current) !== undefined ? { current: int(val.current) } : {}),
    ...(int(val.max, 1) !== undefined ? { max: int(val.max, 1) } : {}),
    ...(text(val.label) ? { label: text(val.label) } : {}),
    ...(text(val.summary) ? { summary: text(val.summary) } : {}),
  })
}

function step(input: unknown, fallback: WorkflowStatus, ix: number) {
  const val = item(input)
  if (!val) return
  const id = text(val.id) ?? text(val.label) ?? `step-${ix + 1}`
  return WorkflowProgressStep.parse({
    id,
    status: status(WorkflowStepStatus, val.status) ?? stepstatus(fallback),
    ...(text(val.label) ? { label: text(val.label) } : {}),
    ...(text(val.summary) ? { summary: text(val.summary) } : {}),
    ...(text(val.reason) ? { reason: text(val.reason) } : {}),
  })
}

function steps(input: unknown, fallback: WorkflowStatus): WorkflowProgressStep[] | undefined {
  if (!Array.isArray(input)) return
  return input.flatMap((val, ix) => {
    const out = step(val, fallback, ix)
    return out ? [out] : []
  })
}

function agent(input: unknown, fallback: WorkflowStatus, ix: number) {
  const val = item(input)
  if (!val) return
  const id = text(val.id) ?? text(val.name) ?? text(val.label) ?? text(val.role) ?? `agent-${ix + 1}`
  const name = text(val.name) ?? text(val.label) ?? text(val.role) ?? id ?? `agent-${ix + 1}`
  return WorkflowProgressAgent.parse({
    id,
    name,
    ...(text(val.label) ? { label: text(val.label) } : {}),
    status: status(WorkflowAgentStatus, val.status) ?? agentstatus(fallback),
    ...(text(val.role) ? { role: text(val.role) } : {}),
    ...(text(val.summary) ? { summary: text(val.summary) } : {}),
    ...(text(val.updated_at) ? { updated_at: text(val.updated_at) } : {}),
    ...(int(val.round) !== undefined ? { round: int(val.round) } : {}),
  })
}

function agents(input: unknown, fallback: WorkflowStatus): WorkflowProgressAgent[] | undefined {
  if (!Array.isArray(input)) return
  return input.flatMap((val, ix) => {
    const out = agent(val, fallback, ix)
    return out ? [out] : []
  })
}

function participant(input: unknown, fallback: WorkflowStatus, ix: number) {
  const val = item(input)
  if (!val) return
  const id = text(val.id) ?? text(val.name) ?? text(val.label) ?? text(val.role) ?? `participant-${ix + 1}`
  const name = text(val.name) ?? text(val.label) ?? text(val.role) ?? id
  return WorkflowProgressParticipant.parse({
    id,
    ...(text(val.label) ? { label: text(val.label) } : {}),
    ...(name ? { name } : {}),
    ...(text(val.role) ? { role: text(val.role) } : {}),
    ...(status(WorkflowAgentStatus, val.status) ? { status: status(WorkflowAgentStatus, val.status) } : {}),
    ...(text(val.summary) ? { summary: text(val.summary) } : {}),
    ...(text(val.updated_at) ? { updated_at: text(val.updated_at) } : {}),
    ...(int(val.round) !== undefined ? { round: int(val.round) } : {}),
    ...(text(val.step_id) ? { step_id: text(val.step_id) } : {}),
    ...(text(val.run_id) ? { run_id: text(val.run_id) } : {}),
  })
}

function participants(input: unknown, fallback: WorkflowStatus): WorkflowProgressParticipant[] | undefined {
  if (!Array.isArray(input)) return
  return input.flatMap((val, ix) => {
    const out = participant(val, fallback, ix)
    return out ? [out] : []
  })
}

function canonical<T>(schema: z.ZodType<T>, input: unknown, fallback: T) {
  if (input === undefined) return fallback
  const out = schema.safeParse(input)
  if (!out.success) return
  return out.data
}

function machine(input: unknown): WorkflowProgressMachine {
  const val = item(input)
  if (!val) return WorkflowProgressMachine.parse({})
  return WorkflowProgressMachine.parse({
    ...(text(val.id) ? { id: text(val.id) } : {}),
    ...(text(val.key) ? { key: text(val.key) } : {}),
    ...(text(val.label) ? { label: text(val.label) } : {}),
    ...(text(val.summary) ? { summary: text(val.summary) } : {}),
    ...(text(val.root_step_id) ? { root_step_id: text(val.root_step_id) } : {}),
    ...(text(val.active_step_id) ? { active_step_id: text(val.active_step_id) } : {}),
    ...(text(val.active_run_id) ? { active_run_id: text(val.active_run_id) } : {}),
    ...(text(val.started_at) ? { started_at: text(val.started_at) } : {}),
    ...(text(val.updated_at) ? { updated_at: text(val.updated_at) } : {}),
  })
}

function stepdef(input: unknown, ix: number) {
  const val = item(input)
  if (!val) return
  const id = text(val.id) ?? text(val.label) ?? `step-${ix + 1}`
  return WorkflowProgressStepDefinition.parse({
    id,
    kind: status(WorkflowStepKind, val.kind) ?? "task",
    ...(text(val.parent_id) ? { parent_id: text(val.parent_id) } : {}),
    ...(text(val.label) ? { label: text(val.label) } : {}),
    ...(text(val.summary) ? { summary: text(val.summary) } : {}),
    ...(text(val.description) ? { description: text(val.description) } : {}),
    ...(strings(val.children) ? { children: strings(val.children) } : {}),
    ...(strings(val.next) ? { next: strings(val.next) } : {}),
  })
}

function stepdefs(input: unknown): WorkflowProgressStepDefinition[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((val, ix) => {
    const out = stepdef(val, ix)
    return out ? [out] : []
  })
}

function runround(input: unknown) {
  const val = item(input)
  if (!val) return
  return WorkflowProgressRunRound.parse({
    current: int(val.current) ?? 0,
    ...(int(val.max, 1) !== undefined ? { max: int(val.max, 1) } : {}),
    ...(text(val.label) ? { label: text(val.label) } : {}),
    ...(text(val.summary) ? { summary: text(val.summary) } : {}),
  })
}

function retry(input: unknown) {
  const val = item(input)
  if (!val) return
  return WorkflowProgressRunRetry.parse({
    current: int(val.current) ?? 0,
    ...(int(val.max, 1) !== undefined ? { max: int(val.max, 1) } : {}),
    ...(text(val.label) ? { label: text(val.label) } : {}),
    ...(text(val.summary) ? { summary: text(val.summary) } : {}),
  })
}

function actor(input: unknown, fallback: WorkflowStatus) {
  const val = item(input)
  if (!val) return
  const id = text(val.id) ?? text(val.name) ?? text(val.label) ?? text(val.role)
  const out = WorkflowProgressRunActor.parse({
    ...(id ? { id } : {}),
    ...(text(val.label) ? { label: text(val.label) } : {}),
    ...(text(val.name) ? { name: text(val.name) } : {}),
    ...(text(val.role) ? { role: text(val.role) } : {}),
    ...((status(WorkflowAgentStatus, val.status) ?? agentstatus(fallback))
      ? { status: status(WorkflowAgentStatus, val.status) ?? agentstatus(fallback) }
      : {}),
    ...(text(val.summary) ? { summary: text(val.summary) } : {}),
    ...(text(val.updated_at) ? { updated_at: text(val.updated_at) } : {}),
  })
  if (Object.keys(out).length === 0) return
  return out
}

function steprun(input: unknown, fallback: WorkflowStatus, ix: number) {
  const val = item(input)
  if (!val) return
  const id = text(val.id) ?? `run-${ix + 1}`
  const step_id = text(val.step_id) ?? text(val.label) ?? id
  return WorkflowProgressStepRun.parse({
    id,
    seq: int(val.seq) ?? ix,
    step_id,
    status: status(WorkflowStepStatus, val.status) ?? stepstatus(fallback),
    ...(text(val.label) ? { label: text(val.label) } : {}),
    ...(text(val.summary) ? { summary: text(val.summary) } : {}),
    ...(text(val.reason) ? { reason: text(val.reason) } : {}),
    ...(text(val.started_at) ? { started_at: text(val.started_at) } : {}),
    ...(text(val.ended_at) ? { ended_at: text(val.ended_at) } : {}),
    ...(text(val.parent_run_id) ? { parent_run_id: text(val.parent_run_id) } : {}),
    ...(runround(val.round) ? { round: runround(val.round) } : {}),
    ...(retry(val.retry) ? { retry: retry(val.retry) } : {}),
    ...(actor(val.actor, fallback) ? { actor: actor(val.actor, fallback) } : {}),
  })
}

function stepruns(input: unknown, fallback: WorkflowStatus): WorkflowProgressStepRun[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((val, ix) => {
    const out = steprun(val, fallback, ix)
    return out ? [out] : []
  })
}

function source(input: unknown) {
  const val = item(input)
  if (!val) return
  const id = text(val.id) ?? text(val.name) ?? text(val.label) ?? text(val.role)
  const out = WorkflowProgressTransitionSource.parse({
    ...(text(val.type) ? { type: text(val.type) } : {}),
    ...(id ? { id } : {}),
    ...(text(val.label) ? { label: text(val.label) } : {}),
    ...(text(val.name) ? { name: text(val.name) } : {}),
    ...(text(val.role) ? { role: text(val.role) } : {}),
    ...(text(val.participant_id) ? { participant_id: text(val.participant_id) } : {}),
    ...(text(val.step_id) ? { step_id: text(val.step_id) } : {}),
    ...(text(val.run_id) ? { run_id: text(val.run_id) } : {}),
  })
  if (Object.keys(out).length === 0) return
  return out
}

function transition(input: unknown, fallback: WorkflowStatus, ix: number) {
  const val = item(input)
  if (!val) return
  const level = status(WorkflowProgressTransitionLevel, val.level) ?? "workflow"
  const run_id = text(val.run_id)
  const seq = int(val.seq) ?? ix
  const target_id =
    text(val.target_id) ?? (level === "workflow" ? WorkflowProgressWorkflowTargetId : (run_id ?? `step-${ix + 1}`))
  const base = {
    id: text(val.id) ?? `${level}:${target_id}:${run_id ?? ""}:${seq}`,
    seq,
    ...(text(val.timestamp) ? { timestamp: text(val.timestamp) } : {}),
    level,
    target_id,
    ...(run_id ? { run_id } : {}),
    ...(text(val.reason) ? { reason: text(val.reason) } : {}),
    ...(source(val.source) ? { source: source(val.source) } : {}),
  }
  if (level === "step") {
    return WorkflowProgressTransition.parse({
      ...base,
      level,
      ...(status(WorkflowStepStatus, val.from_state) ? { from_state: status(WorkflowStepStatus, val.from_state) } : {}),
      to_state: status(WorkflowStepStatus, val.to_state) ?? stepstatus(fallback),
    })
  }
  return WorkflowProgressTransition.parse({
    ...base,
    level,
    ...(status(WorkflowStatus, val.from_state) ? { from_state: status(WorkflowStatus, val.from_state) } : {}),
    to_state: status(WorkflowStatus, val.to_state) ?? fallback,
  })
}

function transitions(input: unknown, fallback: WorkflowStatus): WorkflowProgressTransition[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((val, ix) => {
    const out = transition(val, fallback, ix)
    return out ? [out] : []
  })
}

function uniq<T extends { id: string }>(input: T[]) {
  const seen = new Set<string>()
  return input.flatMap((item) => {
    if (seen.has(item.id)) return []
    seen.add(item.id)
    return [item]
  })
}

function scrub(input: z.input<typeof WorkflowProgressV2Base>) {
  const step_definitions = uniq(input.step_definitions ?? [])
  const defs = new Set(step_definitions.map((item) => item.id))
  const next_defs = step_definitions.map((item) => ({
    id: item.id,
    kind: item.kind,
    ...(item.parent_id && defs.has(item.parent_id) ? { parent_id: item.parent_id } : {}),
    ...(item.label ? { label: item.label } : {}),
    ...(item.summary ? { summary: item.summary } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(item.children?.filter((id) => defs.has(id)).length
      ? { children: item.children.filter((id) => defs.has(id)) }
      : {}),
    ...(item.next?.filter((id) => defs.has(id)).length ? { next: item.next.filter((id) => defs.has(id)) } : {}),
  }))
  const step_runs = orderruns(uniq(input.step_runs ?? []).filter((item) => defs.has(item.step_id)))
  const runs = new Map(step_runs.map((item) => [item.id, item]))
  const next_runs = step_runs.map((item) => ({
    id: item.id,
    seq: item.seq,
    step_id: item.step_id,
    status: item.status,
    ...(item.label ? { label: item.label } : {}),
    ...(item.summary ? { summary: item.summary } : {}),
    ...(item.reason ? { reason: item.reason } : {}),
    ...(item.started_at ? { started_at: item.started_at } : {}),
    ...(item.ended_at ? { ended_at: item.ended_at } : {}),
    ...(item.parent_run_id && runs.has(item.parent_run_id) ? { parent_run_id: item.parent_run_id } : {}),
    ...(item.round ? { round: item.round } : {}),
    ...(item.retry ? { retry: item.retry } : {}),
    ...(item.actor ? { actor: item.actor } : {}),
  }))
  const active = input.machine?.active_run_id ? runs.get(input.machine.active_run_id) : undefined
  const transitions = (input.transitions ?? []).reduce<WorkflowProgressTransition[]>((result, item) => {
    if (item.level === "workflow") {
      result.push({ ...item, target_id: WorkflowProgressWorkflowTargetId })
      return result
    }
    if (!defs.has(item.target_id)) return result
    result.push(item)
    return result
  }, [])
  const participants = uniq(input.participants ?? []).map((item) => {
    return {
      id: item.id,
      ...(item.label ? { label: item.label } : {}),
      ...(item.name ? { name: item.name } : {}),
      ...(item.role ? { role: item.role } : {}),
      ...(item.status ? { status: item.status } : {}),
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.updated_at ? { updated_at: item.updated_at } : {}),
      ...(item.round !== undefined ? { round: item.round } : {}),
      ...(item.step_id && defs.has(item.step_id) ? { step_id: item.step_id } : {}),
      ...(item.run_id && runs.has(item.run_id) ? { run_id: item.run_id } : {}),
    }
  })
  return {
    ...input,
    machine: {
      ...(input.machine?.id ? { id: input.machine.id } : {}),
      ...(input.machine?.key ? { key: input.machine.key } : {}),
      ...(input.machine?.label ? { label: input.machine.label } : {}),
      ...(input.machine?.summary ? { summary: input.machine.summary } : {}),
      ...(input.machine?.root_step_id && defs.has(input.machine.root_step_id)
        ? { root_step_id: input.machine.root_step_id }
        : {}),
      ...(input.machine?.active_step_id && defs.has(input.machine.active_step_id)
        ? { active_step_id: input.machine.active_step_id }
        : {}),
      ...(active ? { active_run_id: active.id } : {}),
      ...(input.machine?.started_at ? { started_at: input.machine.started_at } : {}),
      ...(input.machine?.updated_at ? { updated_at: input.machine.updated_at } : {}),
    },
    step_definitions: next_defs,
    step_runs: next_runs,
    transitions,
    participants,
  }
}

function mergeobj<T extends Record<string, unknown>>(a?: T, b?: T) {
  if (!a) return b
  if (!b) return a
  return { ...a, ...b }
}

function mergedef(
  a: WorkflowProgressStepDefinition,
  b: WorkflowProgressStepDefinition,
): WorkflowProgressStepDefinition {
  return {
    id: b.id,
    kind: b.kind,
    ...((b.parent_id ?? a.parent_id) ? { parent_id: b.parent_id ?? a.parent_id } : {}),
    ...((b.label ?? a.label) ? { label: b.label ?? a.label } : {}),
    ...((b.summary ?? a.summary) ? { summary: b.summary ?? a.summary } : {}),
    ...((b.description ?? a.description) ? { description: b.description ?? a.description } : {}),
    ...((b.children ?? a.children) ? { children: b.children ?? a.children } : {}),
    ...((b.next ?? a.next) ? { next: b.next ?? a.next } : {}),
  }
}

function mergerun(a: WorkflowProgressStepRun, b: WorkflowProgressStepRun): WorkflowProgressStepRun {
  return {
    id: b.id,
    seq: b.seq,
    step_id: b.step_id,
    status: b.status,
    ...((b.label ?? a.label) ? { label: b.label ?? a.label } : {}),
    ...((b.summary ?? a.summary) ? { summary: b.summary ?? a.summary } : {}),
    ...((b.reason ?? a.reason) ? { reason: b.reason ?? a.reason } : {}),
    ...((b.started_at ?? a.started_at) ? { started_at: b.started_at ?? a.started_at } : {}),
    ...((b.ended_at ?? a.ended_at) ? { ended_at: b.ended_at ?? a.ended_at } : {}),
    ...((b.parent_run_id ?? a.parent_run_id) ? { parent_run_id: b.parent_run_id ?? a.parent_run_id } : {}),
    ...(mergeobj(a.round, b.round) ? { round: mergeobj(a.round, b.round) } : {}),
    ...(mergeobj(a.retry, b.retry) ? { retry: mergeobj(a.retry, b.retry) } : {}),
    ...(mergeobj(a.actor, b.actor) ? { actor: mergeobj(a.actor, b.actor) } : {}),
  }
}

function mergeparticipant(a: WorkflowProgressParticipant, b: WorkflowProgressParticipant): WorkflowProgressParticipant {
  return {
    id: b.id,
    ...((b.label ?? a.label) ? { label: b.label ?? a.label } : {}),
    ...((b.name ?? a.name) ? { name: b.name ?? a.name } : {}),
    ...((b.role ?? a.role) ? { role: b.role ?? a.role } : {}),
    ...((b.status ?? a.status) ? { status: b.status ?? a.status } : {}),
    ...((b.summary ?? a.summary) ? { summary: b.summary ?? a.summary } : {}),
    ...((b.updated_at ?? a.updated_at) ? { updated_at: b.updated_at ?? a.updated_at } : {}),
    ...((b.round ?? a.round) !== undefined ? { round: b.round ?? a.round } : {}),
    ...((b.step_id ?? a.step_id) ? { step_id: b.step_id ?? a.step_id } : {}),
    ...((b.run_id ?? a.run_id) ? { run_id: b.run_id ?? a.run_id } : {}),
  }
}

function mergev1(a: WorkflowProgressV1, b: WorkflowProgressV1): WorkflowProgressV1 {
  return {
    version: WorkflowProgressV1VersionValue,
    workflow: mergeobj(a.workflow, b.workflow) ?? b.workflow,
    ...(b.phase ? { phase: mergeobj(a.phase, b.phase) ?? b.phase } : a.phase ? { phase: a.phase } : {}),
    ...(b.round ? { round: mergeobj(a.round, b.round) ?? b.round } : a.round ? { round: a.round } : {}),
    ...(b.steps ? { steps: b.steps } : a.steps ? { steps: a.steps } : {}),
    ...(b.agents ? { agents: b.agents } : a.agents ? { agents: a.agents } : {}),
  }
}

function mergeby<T>(a: T[], b: T[], key: (input: T) => string, merge: (a: T, b: T) => T) {
  const seen = new Map(a.map((item) => [key(item), item]))
  const out = [...a]
  b.forEach((item) => {
    const id = key(item)
    const cur = seen.get(id)
    if (!cur) {
      seen.set(id, item)
      out.push(item)
      return
    }
    const next = merge(cur, item)
    seen.set(id, next)
    const ix = out.findIndex((row) => key(row) === id)
    out[ix] = next
  })
  return out
}

function sourcekey(input?: WorkflowProgressTransitionSource) {
  return [
    input?.type ?? "",
    input?.id ?? "",
    input?.label ?? "",
    input?.name ?? "",
    input?.role ?? "",
    input?.participant_id ?? "",
    input?.step_id ?? "",
    input?.run_id ?? "",
  ].join("|")
}

function transid(input: WorkflowProgressTransition) {
  return input.id
}

function sign(input: WorkflowProgressTransition) {
  return [input.level, input.target_id, input.run_id ?? "", input.from_state ?? "", input.to_state].join("|")
}

function stamp(input: {
  run?: WorkflowProgressStepRun
  workflow: WorkflowProgressWorkflow
  machine: WorkflowProgressMachine
}) {
  return (
    input.run?.ended_at ??
    input.run?.started_at ??
    input.machine.updated_at ??
    input.workflow.ended_at ??
    input.workflow.started_at
  )
}

function actor_source(input?: WorkflowProgressRunActor): WorkflowProgressTransitionSource | undefined {
  if (!input?.id && !input?.label && !input?.name && !input?.role) return
  return {
    type: "agent",
    ...(input.id ? { id: input.id } : {}),
    ...(input.label ? { label: input.label } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.role ? { role: input.role } : {}),
  }
}

function historyid(input: {
  level: WorkflowProgressTransitionLevel
  target_id: string
  run_id?: string
  from_state?: WorkflowStatus | WorkflowStepStatus
  to_state: WorkflowStatus | WorkflowStepStatus
  timestamp?: string
  reason?: string
  source?: WorkflowProgressTransitionSource
}) {
  return [
    input.level,
    input.target_id,
    input.run_id ?? "",
    input.from_state ?? "",
    input.to_state,
    input.timestamp ?? "",
    input.reason ?? "",
    sourcekey(input.source),
  ].join(":")
}

function runseq(input: WorkflowProgressStepRun) {
  return input.seq
}

function transseq(input: WorkflowProgressTransition) {
  return input.seq
}

function orderruns(input: WorkflowProgressStepRun[]) {
  return input.toSorted((a, b) => {
    const out = runseq(a) - runseq(b)
    if (out !== 0) return out
    const at = a.started_at ?? a.ended_at ?? ""
    const bt = b.started_at ?? b.ended_at ?? ""
    const time = at.localeCompare(bt)
    if (time !== 0) return time
    return a.id.localeCompare(b.id)
  })
}

function endstep(input: WorkflowProgressTransition) {
  return input.level === "step" && (input.to_state === "completed" || input.to_state === "failed")
}

function endflow(input: WorkflowProgressTransition) {
  return input.level === "workflow" && (input.to_state === "done" || input.to_state === "failed")
}

function history(a: WorkflowProgressV2 | undefined, b: WorkflowProgressV2) {
  const seen = new Set((b.transitions ?? []).map(sign))
  const prev = new Map((a?.step_runs ?? []).map((item) => [item.id, item]))
  const out: WorkflowProgressTransition[] = []
  let seq = Math.max(-1, ...(a?.transitions ?? []).map(transseq), ...(b.transitions ?? []).map(transseq))
  b.step_runs?.forEach((item) => {
    const old = prev.get(item.id)
    if (old?.status === item.status) return
    seq += 1
    const next = {
      id: historyid({
        level: "step",
        target_id: item.step_id,
        run_id: item.id,
        from_state: old?.status,
        to_state: item.status,
        timestamp: stamp({ run: item, workflow: b.workflow, machine: b.machine ?? {} }),
        reason: item.reason,
        source: actor_source(item.actor),
      }),
      seq,
      ...(stamp({ run: item, workflow: b.workflow, machine: b.machine ?? {} })
        ? { timestamp: stamp({ run: item, workflow: b.workflow, machine: b.machine ?? {} }) }
        : {}),
      level: "step" as const,
      target_id: item.step_id,
      run_id: item.id,
      ...(old?.status ? { from_state: old.status } : {}),
      to_state: item.status,
      ...(item.reason ? { reason: item.reason } : {}),
      ...(actor_source(item.actor) ? { source: actor_source(item.actor) } : {}),
    }
    if (!seen.has(sign(next))) out.push(next)
  })
  if (!a || a.workflow.status !== b.workflow.status) {
    seq += 1
    const item = {
      id: historyid({
        level: "workflow",
        target_id: WorkflowProgressWorkflowTargetId,
        from_state: a?.workflow.status,
        to_state: b.workflow.status,
        timestamp: stamp({ workflow: b.workflow, machine: b.machine ?? {} }),
      }),
      seq,
      ...(stamp({ workflow: b.workflow, machine: b.machine ?? {} })
        ? { timestamp: stamp({ workflow: b.workflow, machine: b.machine ?? {} }) }
        : {}),
      level: "workflow" as const,
      target_id: WorkflowProgressWorkflowTargetId,
      ...(a?.workflow.status ? { from_state: a.workflow.status } : {}),
      to_state: b.workflow.status,
    }
    if (!seen.has(sign(item))) {
      if (endflow(item) && out.some(endstep)) return [...out, item]
      return [item, ...out]
    }
  }
  return out
}

function uniqtrans(input: WorkflowProgressTransition[]) {
  const seen = new Set<string>()
  return input.flatMap((item) => {
    const id = transid(item)
    if (seen.has(id)) return []
    seen.add(id)
    return [item]
  })
}

function ordertrans(input: WorkflowProgressTransition[]) {
  return input.toSorted((a, b) => {
    const seq = a.seq - b.seq
    if (seq !== 0) return seq
    const time = (a.timestamp ?? "").localeCompare(b.timestamp ?? "")
    if (time !== 0) return time
    return a.id.localeCompare(b.id)
  })
}

function mergev2(a: WorkflowProgressV2 | undefined, b: WorkflowProgressV2): WorkflowProgressV2 {
  const step_definitions = mergeby(a?.step_definitions ?? [], b.step_definitions ?? [], (item) => item.id, mergedef)
  const step_runs = orderruns(mergeby(a?.step_runs ?? [], b.step_runs ?? [], (item) => item.id, mergerun))
  const participants = mergeby(a?.participants ?? [], b.participants ?? [], (item) => item.id, mergeparticipant)
  const item = {
    version: WorkflowProgressV2VersionValue,
    workflow: mergeobj(a?.workflow, b.workflow) ?? b.workflow,
    machine: mergeobj(a?.machine, b.machine) ?? b.machine ?? {},
    step_definitions,
    step_runs,
    transitions: ordertrans(
      uniqtrans([
        ...(a?.transitions ?? []),
        ...(b.transitions ?? []),
        ...history(a, { ...b, step_definitions, step_runs }),
      ]),
    ),
    ...(b.phase ? { phase: mergeobj(a?.phase, b.phase) ?? b.phase } : a?.phase ? { phase: a.phase } : {}),
    ...(b.round ? { round: mergeobj(a?.round, b.round) ?? b.round } : a?.round ? { round: a.round } : {}),
    ...(b.steps ? { steps: b.steps } : a?.steps ? { steps: a.steps } : {}),
    ...(b.agents ? { agents: b.agents } : a?.agents ? { agents: a.agents } : {}),
    participants,
  } satisfies z.input<typeof WorkflowProgressV2Base>
  return WorkflowProgressV2Base.parse(scrub(item))
}

function lift(input: WorkflowProgressV1): WorkflowProgressV2 {
  return WorkflowProgressV2Base.parse({
    version: WorkflowProgressV2VersionValue,
    workflow: input.workflow,
    machine: {},
    step_definitions: [],
    step_runs: [],
    transitions: [],
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.round ? { round: input.round } : {}),
    ...(input.steps ? { steps: input.steps } : {}),
    ...(input.agents ? { agents: input.agents } : {}),
    participants: [],
  })
}

function strict(input: unknown): WorkflowProgress | undefined {
  const head = WorkflowProgressEnvelope.safeParse(input)
  if (!head.success) return
  if (!WorkflowProgressVersionValues.includes(head.data.version as WorkflowProgressVersion)) return
  if (head.data.version === WorkflowProgressV1VersionValue) {
    const out = WorkflowProgressV1.safeParse(input)
    if (!out.success) return
    return out.data
  }
  const out = WorkflowProgressV2.safeParse(input)
  if (!out.success) return
  return out.data
}

function build(input: unknown): WorkflowProgressV1 | WorkflowProgressV2 | undefined {
  const head = WorkflowProgressEnvelope.safeParse(input)
  if (!head.success) return
  if (!WorkflowProgressVersionValues.includes(head.data.version as WorkflowProgressVersion)) return
  if (head.data.version === WorkflowProgressV1VersionValue) {
    const val = item(input)
    if (!val) return
    const info = workflow(val.workflow)
    if (!info) return
    return {
      version: WorkflowProgressV1VersionValue,
      workflow: info,
      ...(phase(val.phase, info.status) ? { phase: phase(val.phase, info.status) } : {}),
      ...(round(val.round, info.status) ? { round: round(val.round, info.status) } : {}),
      ...(steps(val.steps, info.status) ? { steps: steps(val.steps, info.status) } : {}),
      ...(agents(val.agents, info.status) ? { agents: agents(val.agents, info.status) } : {}),
    }
  }
  const out = WorkflowProgressV2.safeParse(input)
  if (!out.success) return
  return out.data
}

function strictv2(input: z.input<typeof WorkflowProgressV2Base>) {
  const out = WorkflowProgressV2.safeParse(input)
  if (!out.success) return
  return out.data
}

export function parseWorkflowProgress(input: unknown): WorkflowProgress | undefined {
  const progress = build(input)
  if (!progress) return
  if (progress.version === WorkflowProgressV1VersionValue) {
    const out = WorkflowProgressV1.safeParse(progress)
    if (!out.success) return
    return out.data
  }
  const out = strictv2(progress)
  if (!out) return
  return out
}

export function mergeWorkflowProgress(...items: unknown[]): WorkflowProgress | undefined {
  return items.reduce<WorkflowProgress | undefined>((acc, raw) => {
    const item = raw ? parseWorkflowProgress(raw) : undefined
    if (!item) return acc
    if (!acc) return item.version === WorkflowProgressV2VersionValue ? mergev2(undefined, item) : item
    if (acc.version === WorkflowProgressV2VersionValue) {
      return mergev2(acc, item.version === WorkflowProgressV2VersionValue ? item : lift(item))
    }
    if (item.version !== WorkflowProgressV2VersionValue) return mergev1(acc, item)
    return mergev2(lift(acc), item)
  }, undefined)
}

export function normalizeWorkflowProgress(input: unknown): WorkflowProgressRead | undefined {
  const progress = parseWorkflowProgress(input)
  if (!progress) return
  if (
    !("machine" in progress && "step_definitions" in progress && "step_runs" in progress && "transitions" in progress)
  ) {
    return {
      version: progress.version,
      workflow: progress.workflow,
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [],
      ...(progress.phase ? { phase: progress.phase } : {}),
      ...(progress.round ? { round: progress.round } : {}),
      steps: progress.steps ?? [],
      agents: progress.agents ?? [],
      participants: [],
    }
  }
  return {
    version: progress.version,
    workflow: progress.workflow,
    machine: progress.machine,
    step_definitions: progress.step_definitions,
    step_runs: progress.step_runs,
    transitions: progress.transitions,
    ...(progress.phase ? { phase: progress.phase } : {}),
    ...(progress.round ? { round: progress.round } : {}),
    steps: progress.steps ?? [],
    agents: progress.agents ?? [],
    participants: progress.participants,
  }
}

export function normalizeWorkflowMetadata(input?: Record<string, unknown>) {
  if (!input) return input
  if (!(WorkflowProgressKey in input)) return { ...input }
  const head = WorkflowProgressEnvelope.safeParse(input[WorkflowProgressKey])
  if (head.success && !WorkflowProgressVersionValues.includes(head.data.version as WorkflowProgressVersion)) {
    return stripprogress(input)
  }
  const progress = parseWorkflowProgress(input[WorkflowProgressKey])
  return {
    ...stripprogress(input),
    ...(progress ? { [WorkflowProgressKey]: progress } : {}),
  } satisfies Record<string, unknown>
}

export function readWorkflowProgress(input?: Record<string, unknown>): WorkflowProgressRead | undefined {
  if (!input || !(WorkflowProgressKey in input)) return
  return normalizeWorkflowProgress(input[WorkflowProgressKey])
}

export function validateWorkflowMetadata(input?: Record<string, unknown>) {
  if (!input) return input
  if (!(WorkflowProgressKey in input)) return { ...input }
  const head = WorkflowProgressEnvelope.parse(input[WorkflowProgressKey])
  if (!WorkflowProgressVersionValues.includes(head.version as WorkflowProgressVersion)) {
    throw new Error(`Unsupported workflow progress version: ${head.version}`)
  }
  const progress = strict(input[WorkflowProgressKey])
  if (!progress) {
    const raw = WorkflowProgress.safeParse(input[WorkflowProgressKey])
    if (!raw.success) throw raw.error
    throw new Error("Invalid workflow progress metadata")
  }
  return {
    ...input,
    [WorkflowProgressKey]: progress,
  } satisfies Record<string, unknown>
}

export function workflowStatusKind(
  input?:
    | WorkflowProgressStatus
    | WorkflowStatus
    | WorkflowPhaseStatus
    | WorkflowRoundStatus
    | WorkflowStepStatus
    | WorkflowAgentStatus,
) {
  if (!input) return
  if (input === "active" || input === "running") return "running" as const
  if (input === "completed" || input === "done") return "done" as const
  return input
}

export function workflowDisplayStatus(input: {
  tool_status?: "pending" | "running" | "completed" | "error"
  progress?: WorkflowProgressRead
}) {
  const state = workflowStatusKind(input.progress?.workflow.status)
  if (input.tool_status === "error") return "failed" as const
  if (state && state !== "running" && state !== "pending") return state
  if (input.tool_status === "completed") return "done" as const
  if (input.tool_status === "pending") return "pending" as const
  return state ?? "running"
}

export function workflowPhaseLabel(progress?: WorkflowProgressRead) {
  if (!progress?.phase) return
  return progress.phase.label ?? progress.phase.key ?? progress.phase.status
}

export function workflowRoundLabel(progress?: WorkflowProgressRead) {
  if (!progress?.round) return
  if (progress.round.label) return progress.round.label
  if (progress.round.current !== undefined && progress.round.max !== undefined) {
    return `Round ${progress.round.current}/${progress.round.max}`
  }
  if (progress.round.current !== undefined) return `Round ${progress.round.current}`
  return "Round unknown"
}

export const File = WorkflowFile
export const Args = WorkflowArgs
export const Result = WorkflowResult

export type File = WorkflowFile
export type Args = WorkflowArgs
export type Result = WorkflowResult
export type TaskInput = WorkflowTaskInput
export type TaskResult = WorkflowTaskResult
export type WorkflowInput = WorkflowInvokeInput

export const runtime = {
  workflow: define,
  args: Args,
  file: File,
  result,
}
