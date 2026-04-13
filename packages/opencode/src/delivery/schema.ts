import z from "zod"

export namespace Delivery {
  const status = ["pending", "active", "blocked", "completed", "failed", "cancelled"] as const
  const phase = ["plan", "implement", "verify", "commit", "retrospective"] as const
  const work = ["pending", "ready", "in_progress", "verifying", "completed", "blocked", "failed", "cancelled"] as const
  const verify = ["pending", "running", "passed", "failed", "repair_required", "cancelled", "skipped"] as const
  const gate_status = ["pending", "ready", "blocked"] as const
  const decision = ["proposed", "decided", "superseded", "cancelled"] as const
  const action = ["proposal", "review", "objection", "decision"] as const
  const question = ["open", "waiting_user", "answered", "resolved", "deferred", "cancelled"] as const

  export const RunStatus = z.enum(status)
  export type RunStatus = z.infer<typeof RunStatus>

  export const RunPhase = z.enum(phase)
  export type RunPhase = z.infer<typeof RunPhase>
  export const Phases = [...phase] as const

  export const WorkStatus = z.enum(work)
  export type WorkStatus = z.infer<typeof WorkStatus>

  export const WorkPhaseGate = z.enum(phase)
  export type WorkPhaseGate = z.infer<typeof WorkPhaseGate>

  export const VerificationStatus = z.enum(verify)
  export type VerificationStatus = z.infer<typeof VerificationStatus>

  export const GateStatus = z.enum(gate_status)
  export type GateStatus = z.infer<typeof GateStatus>

  export const Verification = z.object({
    status: VerificationStatus,
    required: z.boolean().default(true),
    commands: z.array(z.string()).default([]),
    result: z.string().nullable().default(null),
    updated_at: z.number().nullable().default(null),
  })
  export type Verification = z.infer<typeof Verification>

  export const Checkpoint = z.object({
    last_successful_phase: RunPhase.nullable().default(null),
    verification_result: z.string().nullable().default(null),
    produced_files: z.array(z.string()).default([]),
    pending_actions: z.array(z.string()).default([]),
    rollback_suggestions: z.array(z.string()).default([]),
    destructive_cleanup_allowed: z.boolean().default(false),
    cleanup_decision_id: z.string().nullable().default(null),
    updated_at: z.number().nullable().default(null),
  })
  export type Checkpoint = z.infer<typeof Checkpoint>

  export const Failure = z.object({
    phase: RunPhase,
    result: z.string().trim().min(1),
    verification: Verification,
    produced_files: z.array(z.string()).default([]),
    pending_actions: z.array(z.string()).default([]),
    rollback_suggestions: z.array(z.string()).default([]),
    destructive_cleanup_allowed: z.boolean().default(false),
    cleanup_decision_id: z.string().nullable().default(null),
    recorded_at: z.number(),
  })
  export type Failure = z.infer<typeof Failure>

  const rules = {
    plan: {
      enter: ["run is active"],
      exit: ["plan work item is completed"],
      fallback: null,
    },
    implement: {
      enter: ["plan work item is completed"],
      exit: ["implementation work item is completed"],
      fallback: "plan",
    },
    verify: {
      enter: ["implementation work item is completed"],
      exit: ["verification work item is completed", "required verification passed"],
      fallback: "implement",
    },
    commit: {
      enter: ["verification work item is completed", "required verification passed"],
      exit: ["commit work item is completed"],
      fallback: "verify",
    },
    retrospective: {
      enter: ["commit work item is completed"],
      exit: ["retrospective work item is completed"],
      fallback: "commit",
    },
  } as const satisfies Record<RunPhase, { enter: string[]; exit: string[]; fallback: RunPhase | null }>

  export const Gate = z.object({
    status: GateStatus,
    reason: z.string().nullable().default(null),
    enter: z.array(z.string()).default([]),
    exit: z.array(z.string()).default([]),
    fallback: RunPhase.nullable().default(null),
    updated_at: z.number().nullable().default(null),
  })
  export type Gate = z.infer<typeof Gate>

  export const DecisionStatus = z.enum(decision)
  export type DecisionStatus = z.infer<typeof DecisionStatus>

  export const DecisionActionKind = z.enum(action)
  export type DecisionActionKind = z.infer<typeof DecisionActionKind>

  export const DecisionAction = z.object({
    kind: DecisionActionKind,
    role: z.string(),
    outcome: z.string().nullable().default(null),
    context: z.string().nullable().default(null),
    created_at: z.number(),
  })
  export type DecisionAction = z.infer<typeof DecisionAction>

  export const OpenQuestionStatus = z.enum(question)
  export type OpenQuestionStatus = z.infer<typeof OpenQuestionStatus>

  const steps = {
    run_status: {
      pending: ["pending", "active", "cancelled"],
      active: ["active", "blocked", "completed", "failed", "cancelled"],
      blocked: ["blocked", "active", "failed", "cancelled"],
      completed: ["completed"],
      failed: ["failed"],
      cancelled: ["cancelled"],
    },
    run_phase: {
      plan: ["plan", "implement"],
      implement: ["implement", "verify"],
      verify: ["verify", "commit"],
      commit: ["commit", "retrospective"],
      retrospective: ["retrospective"],
    },
    work_status: {
      pending: ["pending", "ready", "cancelled"],
      ready: ["ready", "in_progress", "blocked", "cancelled"],
      in_progress: ["in_progress", "verifying", "blocked", "failed", "cancelled"],
      verifying: ["verifying", "completed", "failed", "blocked", "cancelled"],
      completed: ["completed"],
      blocked: ["blocked", "ready", "in_progress", "failed", "cancelled"],
      failed: ["failed"],
      cancelled: ["cancelled"],
    },
    verify_status: {
      pending: ["pending", "running", "skipped", "cancelled"],
      running: ["running", "passed", "failed", "repair_required", "cancelled"],
      passed: ["passed"],
      failed: ["failed", "repair_required"],
      repair_required: ["repair_required", "running", "cancelled"],
      cancelled: ["cancelled"],
      skipped: ["skipped"],
    },
    decision: {
      proposed: ["proposed", "decided", "superseded", "cancelled"],
      decided: ["decided", "superseded"],
      superseded: ["superseded"],
      cancelled: ["cancelled"],
    },
    question: {
      open: ["open", "waiting_user", "deferred", "cancelled"],
      waiting_user: ["waiting_user", "answered", "cancelled"],
      answered: ["answered", "resolved"],
      resolved: ["resolved"],
      deferred: ["deferred", "open", "waiting_user", "cancelled"],
      cancelled: ["cancelled"],
    },
  } as const satisfies {
    run_status: Record<RunStatus, readonly RunStatus[]>
    run_phase: Record<RunPhase, readonly RunPhase[]>
    work_status: Record<WorkStatus, readonly WorkStatus[]>
    verify_status: Record<VerificationStatus, readonly VerificationStatus[]>
    decision: Record<DecisionStatus, readonly DecisionStatus[]>
    question: Record<OpenQuestionStatus, readonly OpenQuestionStatus[]>
  }

  function step<T extends string>(list: readonly T[], to: T) {
    return list.includes(to)
  }

  export function canTransitionRunStatus(from: RunStatus, to: RunStatus) {
    return step(steps.run_status[from], to)
  }

  export function canTransitionRunPhase(from: RunPhase, to: RunPhase) {
    return step(steps.run_phase[from], to)
  }

  export function canTransitionWorkStatus(from: WorkStatus, to: WorkStatus) {
    return step(steps.work_status[from], to)
  }

  export function canTransitionVerification(from: VerificationStatus, to: VerificationStatus) {
    return step(steps.verify_status[from], to)
  }

  export function rule(from: RunPhase) {
    return {
      enter: [...rules[from].enter],
      exit: [...rules[from].exit],
      fallback: rules[from].fallback,
    }
  }

  export function gate(from: RunPhase, input?: Partial<Gate>) {
    return Gate.parse({
      status: "pending",
      reason: null,
      enter: [...rules[from].enter],
      exit: [...rules[from].exit],
      fallback: rules[from].fallback,
      updated_at: null,
      ...input,
    })
  }

  export function next(from: RunPhase) {
    const i = phase.indexOf(from)
    return i === -1 || i === phase.length - 1 ? null : phase[i + 1]
  }

  export function canTransitionDecision(from: DecisionStatus, to: DecisionStatus) {
    return step(steps.decision[from], to)
  }

  export function canTransitionQuestion(from: OpenQuestionStatus, to: OpenQuestionStatus) {
    return step(steps.question[from], to)
  }
}
