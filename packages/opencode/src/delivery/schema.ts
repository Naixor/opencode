import z from "zod"

export namespace Delivery {
  const status = ["pending", "active", "blocked", "completed", "failed", "cancelled"] as const
  const phase = ["plan", "implement", "verify", "commit", "retrospective"] as const
  const work = ["pending", "ready", "in_progress", "verifying", "completed", "blocked", "failed", "cancelled"] as const
  const verify = ["pending", "running", "passed", "failed", "repair_required", "cancelled", "skipped"] as const
  const commit_status = ["committed"] as const
  const audit = ["phase", "assignment", "decision", "question", "verification", "commit", "retrospective"] as const
  const gate_status = ["pending", "ready", "blocked"] as const
  const decision = ["proposed", "decided", "superseded", "cancelled"] as const
  const action = ["proposal", "review", "objection", "decision"] as const
  const question = ["open", "waiting_user", "answered", "resolved", "deferred", "cancelled"] as const
  const retrospective = ["completed", "failed"] as const
  const memory_category = ["style", "pattern", "tool", "domain", "workflow", "correction", "context"] as const
  const memory_status = ["written", "pending_confirmation", "filtered", "duplicate"] as const

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

  export const CommitStatus = z.enum(commit_status)
  export type CommitStatus = z.infer<typeof CommitStatus>

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

  export const Commit = z
    .object({
      status: CommitStatus.default("committed"),
      staged_scope: z.array(z.string()).min(1),
      proof: Verification,
      hash: z.string().trim().min(1).nullable().default(null),
      message: z.string().trim().min(1).nullable().default(null),
      recorded_at: z.number(),
    })
    .refine((value) => value.hash || value.message, {
      message: "Commit record requires a hash or message",
      path: ["hash"],
    })
  export type Commit = z.infer<typeof Commit>

  export const RetrospectiveOutcome = z.enum(retrospective)
  export type RetrospectiveOutcome = z.infer<typeof RetrospectiveOutcome>

  export const RetrospectiveItem = z.object({
    id: z.string(),
    title: z.string().trim().min(1),
    phase: RunPhase,
    status: WorkStatus,
    owner_role_id: z.string(),
  })
  export type RetrospectiveItem = z.infer<typeof RetrospectiveItem>

  export const RetrospectiveDecision = z.object({
    id: z.string(),
    kind: z.string().trim().min(1),
    status: z.enum(decision),
    summary: z.string().trim().min(1),
    question_id: z.string().nullable().default(null),
    requires_user_confirmation: z.boolean().default(false),
  })
  export type RetrospectiveDecision = z.infer<typeof RetrospectiveDecision>

  export const RetrospectiveVerification = z.object({
    item_id: z.string(),
    phase: RunPhase,
    status: VerificationStatus,
    result: z.string().nullable().default(null),
    required: z.boolean().default(true),
    updated_at: z.number().nullable().default(null),
  })
  export type RetrospectiveVerification = z.infer<typeof RetrospectiveVerification>

  export const RetrospectiveFailure = z.object({
    item_id: z.string(),
    phase: RunPhase,
    result: z.string().trim().min(1),
  })
  export type RetrospectiveFailure = z.infer<typeof RetrospectiveFailure>

  export const RetrospectiveIssue = z.object({
    summary: z.string().trim().min(1),
    related_ids: z.array(z.string()).default([]),
  })
  export type RetrospectiveIssue = z.infer<typeof RetrospectiveIssue>

  export const RetrospectiveMemoryStatus = z.enum(memory_status)
  export type RetrospectiveMemoryStatus = z.infer<typeof RetrospectiveMemoryStatus>

  export const RetrospectiveMemoryInput = z.object({
    content: z.string().trim().min(1),
    categories: z.array(z.enum(memory_category)).min(1),
    tags: z.array(z.string()).default([]),
    citations: z.array(z.string()).default([]),
    impact: z.enum(["low", "high"]).default("low"),
  })
  export type RetrospectiveMemoryInput = z.infer<typeof RetrospectiveMemoryInput>

  export const RetrospectiveMemory = RetrospectiveMemoryInput.extend({
    status: RetrospectiveMemoryStatus,
    memory_id: z.string().nullable().default(null),
    reason: z.string().nullable().default(null),
  })
  export type RetrospectiveMemory = z.infer<typeof RetrospectiveMemory>

  export const Retrospective = z.object({
    summary: z.string().trim().min(1),
    outcome: RetrospectiveOutcome,
    work_items: z.array(RetrospectiveItem).default([]),
    decisions: z.array(RetrospectiveDecision).default([]),
    verification: z.array(RetrospectiveVerification).default([]),
    failures: z.array(RetrospectiveFailure).default([]),
    escalations: z.array(RetrospectiveIssue).default([]),
    collaboration_issues: z.array(RetrospectiveIssue).default([]),
    memories: z.array(RetrospectiveMemory).default([]),
    created_at: z.number(),
  })
  export type Retrospective = z.infer<typeof Retrospective>

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

  export const AuditKind = z.enum(audit)
  export type AuditKind = z.infer<typeof AuditKind>

  export const PhaseAudit = z.object({
    kind: z.literal("phase"),
    phase: RunPhase,
    status: RunStatus,
    gate: Gate,
    created_at: z.number(),
  })
  export type PhaseAudit = z.infer<typeof PhaseAudit>

  export const AssignmentAudit = z.object({
    kind: z.literal("assignment"),
    run_id: z.string(),
    item_ids: z.array(z.string()).default([]),
    role_ids: z.array(z.string()).default([]),
    summary: z.string().trim().min(1),
    created_at: z.number(),
  })
  export type AssignmentAudit = z.infer<typeof AssignmentAudit>

  export const DecisionAudit = z.object({
    kind: z.literal("decision"),
    decision_id: z.string(),
    status: z.enum(decision),
    summary: z.string().trim().min(1),
    outcome: z.string().nullable().default(null),
    applies_to: z.array(z.string()).default([]),
    created_at: z.number(),
  })
  export type DecisionAudit = z.infer<typeof DecisionAudit>

  export const QuestionAudit = z.object({
    kind: z.literal("question"),
    question_id: z.string(),
    status: z.enum(question),
    blocking: z.boolean(),
    summary: z.string().trim().min(1),
    affects: z.array(z.string()).default([]),
    created_at: z.number(),
  })
  export type QuestionAudit = z.infer<typeof QuestionAudit>

  export const VerificationAudit = z.object({
    kind: z.literal("verification"),
    item_id: z.string(),
    phase: RunPhase,
    verification: Verification,
    created_at: z.number(),
  })
  export type VerificationAudit = z.infer<typeof VerificationAudit>

  export const CommitAudit = z.object({
    kind: z.literal("commit"),
    item_id: z.string(),
    commit: Commit,
    created_at: z.number(),
  })
  export type CommitAudit = z.infer<typeof CommitAudit>

  export const RetrospectiveAudit = z.object({
    kind: z.literal("retrospective"),
    outcome: RetrospectiveOutcome,
    summary: z.string().trim().min(1),
    memory_ids: z.array(z.string()).default([]),
    created_at: z.number(),
  })
  export type RetrospectiveAudit = z.infer<typeof RetrospectiveAudit>

  export const AuditEvent = z.discriminatedUnion("kind", [
    PhaseAudit,
    AssignmentAudit,
    DecisionAudit,
    QuestionAudit,
    VerificationAudit,
    CommitAudit,
    RetrospectiveAudit,
  ])
  export type AuditEvent = z.infer<typeof AuditEvent>

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

  export const RunRow = z.object({
    id: z.string(),
    goal: z.string(),
    status: RunStatus,
    phase: RunPhase,
    phases: z.array(RunPhase),
    gate: Gate,
    audit: z.array(AuditEvent),
    retrospective: Retrospective.nullable(),
    created_at: z.number(),
    updated_at: z.number(),
    owner_session_id: z.string(),
  })
  export type RunRow = z.infer<typeof RunRow>

  export const ItemRow = z.object({
    id: z.string(),
    swarm_run_id: z.string(),
    title: z.string(),
    status: WorkStatus,
    owner_role_id: z.string(),
    blocked_by: z.array(z.string()),
    scope: z.array(z.string()),
    phase_gate: WorkPhaseGate,
    verification: Verification,
    small_mr_required: z.boolean(),
    gate: Gate,
    checkpoint: Checkpoint,
    commit: Commit.nullable(),
    failure: Failure.nullable(),
  })
  export type ItemRow = z.infer<typeof ItemRow>

  export const DecisionRow = z.object({
    id: z.string(),
    kind: z.string(),
    summary: z.string(),
    source: z.string(),
    status: DecisionStatus,
    requires_user_confirmation: z.boolean(),
    applies_to: z.array(z.string()),
    participants: z.array(z.string()),
    candidate_outcomes: z.array(z.string()),
    input_context: z.string(),
    actions: z.array(DecisionAction),
    related_question_id: z.string().nullable(),
    decided_by: z.string().nullable(),
    decided_at: z.number().nullable(),
  })
  export type DecisionRow = z.infer<typeof DecisionRow>

  export const QuestionRow = z.object({
    id: z.string(),
    title: z.string(),
    context: z.string(),
    options: z.array(z.string()),
    recommended_option: z.string().nullable(),
    status: OpenQuestionStatus,
    deadline_policy: z.string().nullable(),
    blocking: z.boolean(),
    affects: z.array(z.string()),
    related_decision_id: z.string().nullable(),
    raised_by: z.string(),
  })
  export type QuestionRow = z.infer<typeof QuestionRow>

  export const State = z.object({
    item: ItemRow,
    proof: Verification.nullable(),
    commit: Commit.nullable(),
    verified: z.boolean(),
    committed: z.boolean(),
    completed: z.boolean(),
  })
  export type State = z.infer<typeof State>

  export const Blocker = z.object({
    id: z.string(),
    kind: z.enum(["decision", "question", "work_item", "small_mr"]),
    status: z.string().nullable(),
    summary: z.string().trim().min(1),
    affects: z.array(z.string()).default([]),
  })
  export type Blocker = z.infer<typeof Blocker>

  export const Small = z.object({
    required: z.boolean(),
    status: GateStatus,
    reason: z.string().nullable(),
    active: z.array(z.string()).default([]),
  })
  export type Small = z.infer<typeof Small>

  export const Detail = z.object({
    run: RunRow,
    items: z.array(ItemRow),
    decisions: z.array(DecisionRow),
    questions: z.array(QuestionRow),
    gate: Gate,
    current_item_id: z.string().nullable(),
    blockers: z.array(Blocker),
    small_mr: Small,
    audit: z.array(AuditEvent),
    state: z.array(State),
    completed: z.array(z.string()),
    pending: z.array(z.string()),
  })
  export type Detail = z.infer<typeof Detail>

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
      running: ["running", "pending", "passed", "failed", "repair_required", "cancelled"],
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
