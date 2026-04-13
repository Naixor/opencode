import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import { DecisionTable, OpenQuestionTable, RoleSpecTable, SwarmRunTable, WorkItemTable } from "./delivery.sql"
import { Delivery } from "./schema"
import { Database, NotFoundError, eq } from "../storage/db"

export namespace DeliveryStore {
  const Kind = z.enum(["run", "item", "decision", "question"])
  const Field = z.enum(["status", "phase", "verification", "gate"])
  const Change = z.enum(["role_added", "role_removed", "role_responsibility_changed", "owner_reassigned"])

  export const AssignmentChange = z.object({
    kind: Change,
    role_id: z.string().nullable().default(null),
    item_id: z.string().nullable().default(null),
    from: z.string().nullable().default(null),
    to: z.string().nullable().default(null),
    message: z.string(),
  })
  export type AssignmentChange = z.infer<typeof AssignmentChange>

  export const AssignmentReview = z.object({
    major: z.boolean(),
    changes: z.array(AssignmentChange),
  })
  export type AssignmentReview = z.infer<typeof AssignmentReview>

  const Answer = z.enum(["confirm", "reject"])

  export const AssignmentRole = z.object({
    role_id: z.string(),
    name: z.string(),
    responsibility: z.string(),
    skills: z.array(z.string()),
    limits: z.array(z.string()),
    approval_required: z.boolean(),
  })
  export type AssignmentRole = z.infer<typeof AssignmentRole>

  export const AssignmentItemState = z.object({
    id: z.string(),
    title: z.string(),
    owner_role_id: z.string(),
    blocked_by: z.array(z.string()),
    scope: z.array(z.string()),
  })
  export type AssignmentItemState = z.infer<typeof AssignmentItemState>

  const AssignmentState = z.object({
    roles: z.array(AssignmentRole),
    items: z.array(AssignmentItemState),
  })

  export const AssignmentQuestion = z.object({
    reason: z.string().trim().min(1),
    impact: z.array(z.string()).default([]),
    before: AssignmentState,
    after: AssignmentState,
  })
  export type AssignmentQuestion = z.infer<typeof AssignmentQuestion>

  export const TransitionError = NamedError.create(
    "DeliveryTransitionError",
    z.object({
      kind: Kind,
      field: Field,
      id: z.string(),
      from: z.string(),
      to: z.string(),
      message: z.string(),
    }),
  )

  export const GateError = NamedError.create(
    "DeliveryGateError",
    z.object({
      id: z.string(),
      phase: Delivery.RunPhase,
      to: Delivery.RunPhase,
      reason: z.string(),
      message: z.string(),
    }),
  )

  export const AssignmentError = NamedError.create(
    "DeliveryAssignmentError",
    z.object({
      run_id: z.string(),
      changes: z.array(AssignmentChange),
      message: z.string(),
    }),
  )

  export type Run = typeof SwarmRunTable.$inferSelect
  export type RunCreate = typeof SwarmRunTable.$inferInsert
  export type RunPatch = Partial<Pick<RunCreate, "goal" | "status" | "phase" | "phases" | "gate" | "owner_session_id">>

  export type Role = typeof RoleSpecTable.$inferSelect
  export type RoleCreate = typeof RoleSpecTable.$inferInsert
  export type RolePatch = Partial<
    Pick<RoleCreate, "name" | "responsibility" | "skills" | "limits" | "approval_required">
  >

  export type Item = typeof WorkItemTable.$inferSelect
  export type ItemCreate = typeof WorkItemTable.$inferInsert
  export type ItemPatch = Partial<
    Pick<
      ItemCreate,
      | "title"
      | "status"
      | "owner_role_id"
      | "blocked_by"
      | "scope"
      | "phase_gate"
      | "gate"
      | "verification"
      | "small_mr_required"
    >
  >
  export type AssignmentItem = { id: string } & ItemPatch
  export type AssignmentInput = {
    run_id: string
    roles?: RoleCreate[]
    items?: AssignmentItem[]
  }
  export type AssignmentRequest = AssignmentInput & {
    decision_id: string
    question_id: string
    reason: string
    raised_by: string
    title?: string
    source?: string
    recommended_option?: z.infer<typeof Answer>
  }
  export type AssignmentResolution = {
    decision_id: string
    answer: z.infer<typeof Answer>
    decided_by: string
    decided_at?: number
  }

  export type Decision = typeof DecisionTable.$inferSelect
  export type DecisionCreate = typeof DecisionTable.$inferInsert
  export type DecisionPatch = Partial<
    Pick<
      DecisionCreate,
      | "kind"
      | "summary"
      | "source"
      | "status"
      | "requires_user_confirmation"
      | "applies_to"
      | "participants"
      | "candidate_outcomes"
      | "input_context"
      | "actions"
      | "related_question_id"
      | "decided_by"
      | "decided_at"
    >
  >

  const DecisionAction = z.object({
    decision_id: z.string(),
    kind: Delivery.DecisionActionKind,
    role: z.string(),
    outcome: z.string().nullable().default(null),
    context: z.string().nullable().default(null),
    created_at: z.number().default(() => Date.now()),
  })

  const DecisionProposal = DecisionAction.extend({
    kind: z.literal("proposal"),
    participants: z.array(z.string()).min(1),
    candidate_outcomes: z.array(z.string()).min(1),
    input_context: z.string().trim().min(1),
  })

  export const DecisionInput = z.discriminatedUnion("kind", [
    DecisionProposal,
    DecisionAction.extend({
      kind: z.enum(["review", "objection", "decision"]),
    }),
  ])
  export type DecisionInput = z.input<typeof DecisionInput>

  const DecisionUpdate = z.object({
    target: z.string(),
    detail: z.string().trim().min(1),
  })

  const DecisionResolution = z.object({
    reason: z.string().trim().min(1),
    updates: z.array(DecisionUpdate).default([]),
  })

  export type Question = typeof OpenQuestionTable.$inferSelect
  export type QuestionCreate = typeof OpenQuestionTable.$inferInsert
  export type QuestionPatch = Partial<
    Pick<
      QuestionCreate,
      | "title"
      | "context"
      | "options"
      | "recommended_option"
      | "status"
      | "deadline_policy"
      | "blocking"
      | "affects"
      | "related_decision_id"
      | "raised_by"
    >
  >

  const roles = [
    {
      role_id: "planner",
      name: "Planner",
      responsibility: "Turns a delivery goal into a staged run plan",
      skills: ["planning", "scope"],
      limits: ["no_direct_commit"],
      approval_required: false,
    },
    {
      role_id: "builder",
      name: "Builder",
      responsibility: "Implements the approved delivery scope",
      skills: ["code", "build"],
      limits: ["no_force_push"],
      approval_required: false,
    },
    {
      role_id: "verifier",
      name: "Verifier",
      responsibility: "Runs verification before commit",
      skills: ["typecheck", "test"],
      limits: ["read_only"],
      approval_required: false,
    },
    {
      role_id: "shipper",
      name: "Shipper",
      responsibility: "Commits verified scope as a small MR",
      skills: ["git", "release"],
      limits: ["local_commit_only"],
      approval_required: false,
    },
    {
      role_id: "reviewer",
      name: "Reviewer",
      responsibility: "Captures retrospective notes and follow-ups",
      skills: ["retrospective", "memory"],
      limits: ["no_scope_expansion"],
      approval_required: false,
    },
  ] satisfies RoleCreate[]

  const seed = [
    {
      phase: "plan",
      title: "Plan staged delivery run",
      owner_role_id: "planner",
      required: false,
      commands: [] as string[],
    },
    {
      phase: "implement",
      title: "Implement approved delivery scope",
      owner_role_id: "builder",
      required: true,
      commands: ["bun run typecheck", "bun run build"],
    },
    {
      phase: "verify",
      title: "Verify implementation scope",
      owner_role_id: "verifier",
      required: true,
      commands: ["bun run typecheck", "bun run build", "bun test"],
    },
    {
      phase: "commit",
      title: "Create local small-MR commit",
      owner_role_id: "shipper",
      required: true,
      commands: ["bun run typecheck", "bun run build", "bun test"],
    },
    {
      phase: "retrospective",
      title: "Capture delivery retrospective",
      owner_role_id: "reviewer",
      required: false,
      commands: [] as string[],
    },
  ] as const satisfies readonly {
    phase: Delivery.RunPhase
    title: string
    owner_role_id: string
    required: boolean
    commands: string[]
  }[]

  function hit<T>(value: T | undefined, kind: string, id: string) {
    if (value) return value
    throw new NotFoundError({ message: `${kind} not found: ${id}` })
  }

  function fail(
    next_kind: z.infer<typeof Kind>,
    next_field: z.infer<typeof Field>,
    id: string,
    from: string,
    to: string,
  ) {
    throw new TransitionError({
      kind: next_kind,
      field: next_field,
      id,
      from,
      to,
      message: `Invalid ${next_kind} ${next_field} transition: ${from} -> ${to}`,
    })
  }

  function verify(value: ItemCreate["verification"] | undefined) {
    if (value === undefined) return undefined
    return Delivery.Verification.parse(value)
  }

  function clean(value: string | null | undefined) {
    return (value ?? "").trim().replace(/\s+/g, " ")
  }

  function gate(phase: Delivery.RunPhase, value?: Delivery.Gate | Partial<Delivery.Gate>) {
    return Delivery.gate(phase, value)
  }

  function done(item: Item) {
    if (item.status !== "completed") return false
    if (!item.verification.required) return true
    if (!item.phase_gate || !["verify", "commit"].includes(item.phase_gate)) return true
    return item.verification.status === "passed"
  }

  function broke(item: Item) {
    if (item.status === "failed") return true
    if (!item.verification.required) return false
    return ["failed", "repair_required", "cancelled"].includes(item.verification.status)
  }

  function sort(items: Item[]) {
    return items.toSorted((a, b) => Delivery.Phases.indexOf(a.phase_gate) - Delivery.Phases.indexOf(b.phase_gate))
  }

  function match(value: string[], ids: Set<string>) {
    return value.some((item) => ids.has(item))
  }

  function armed(row: Question, run: Run, item: Item) {
    if (["resolved", "cancelled"].includes(row.status)) return false
    if (!match(row.affects, new Set([run.id, item.id]))) return false
    if (["open", "waiting_user", "answered"].includes(row.status)) return row.blocking
    return row.status === "deferred" && row.affects.includes(item.id)
  }

  function pause(row: Question, id: string) {
    if (!row.affects.includes(id)) return false
    if (!row.blocking) return false
    return ["open", "waiting_user", "answered"].includes(row.status)
  }

  function blocks(run: Run, item: Item, decisions: Decision[], questions: Question[]) {
    const ids = new Set([run.id, item.id])
    return [
      ...decisions
        .filter((row) => row.status === "proposed" && row.requires_user_confirmation && match(row.applies_to, ids))
        .map((row) => `Decision ${row.id} is awaiting confirmation`),
      ...questions
        .filter((row) => armed(row, run, item) && match(row.affects, ids))
        .map((row) => `Question ${row.id} is still ${row.status}`),
    ]
  }

  function follow(db: Database.TxOrDb, ask: Question) {
    const id = ask.related_decision_id
    if (!id) return
    const row = decision(db, id)
    if (row.status !== "proposed") return
    const status =
      ask.status === "resolved"
        ? "decided"
        : ask.status === "deferred"
          ? "superseded"
          : ask.status === "cancelled"
            ? "cancelled"
            : null
    if (!status) return
    if (!Delivery.canTransitionDecision(row.status, status)) fail("decision", "status", row.id, row.status, status)
    const when = Date.now()
    const outcome = ask.status === "resolved" ? ask.recommended_option || "resolved" : ask.status
    const reason =
      ask.status === "resolved"
        ? `Question ${ask.id} resolved and promoted the linked decision`
        : ask.status === "deferred"
          ? `Question ${ask.id} deferred until the next related gate`
          : `Question ${ask.id} cancelled without applying the linked decision`
    db.update(DecisionTable)
      .set({
        status,
        decided_by: "system",
        decided_at: when,
        actions: [
          ...row.actions,
          Delivery.DecisionAction.parse({
            kind: "decision",
            role: "system",
            outcome,
            context: stamp(reason, [
              ...row.applies_to.map((item) => touchview(item, outcome)),
              {
                target: ask.id,
                detail:
                  ask.status === "resolved"
                    ? `Closed ${ask.id} after the answer was accepted`
                    : ask.status === "deferred"
                      ? `Deferred ${ask.id} for re-check at the next related gate`
                      : `Cancelled ${ask.id} without applying a final decision`,
              },
            ]),
            created_at: when,
          }),
        ],
      })
      .where(eq(DecisionTable.id, row.id))
      .run()
  }

  function sync(db: Database.TxOrDb, id: string) {
    const row = run(db, id)
    const items = sort(db.select().from(WorkItemTable).where(eq(WorkItemTable.swarm_run_id, id)).all())
    const cur = items.find((item) => item.phase_gate === row.phase)
    const ids = new Set([id, ...items.map((item) => item.id)])
    const decisions = db
      .select()
      .from(DecisionTable)
      .all()
      .filter((item) => match(item.applies_to, ids))
    const questions = db
      .select()
      .from(OpenQuestionTable)
      .all()
      .filter((item) => match(item.affects, ids))
    const wait = cur ? blocks(row, cur, decisions, questions) : []
    const fail = cur ? broke(cur) : false
    const rule = Delivery.rule(row.phase)
    const now = Date.now()
    const run_gate = gate(row.phase, {
      status: wait.length > 0 || fail ? "blocked" : cur && done(cur) ? "ready" : "pending",
      reason:
        wait.length > 0
          ? wait.join("; ")
          : fail
            ? `Phase ${row.phase} failed${rule.fallback ? `; fallback ${rule.fallback}` : ""}`
            : cur && done(cur)
              ? null
              : cur
                ? `Waiting for ${row.phase} exit rules`
                : `Waiting for ${row.phase} work item`,
      updated_at: now,
    })
    const status = run_gate.status === "blocked" ? "blocked" : row.status === "blocked" ? "active" : row.status
    db.update(SwarmRunTable)
      .set({
        gate: run_gate,
        ...(status === row.status ? {} : { status }),
      })
      .where(eq(SwarmRunTable.id, id))
      .run()
    const next = Delivery.next(row.phase)
    items.forEach((item) => {
      const stopped = questions.some((row) => pause(row, item.id))
      const item_gate =
        item.phase_gate === row.phase
          ? run_gate
          : Delivery.Phases.indexOf(item.phase_gate) < Delivery.Phases.indexOf(row.phase)
            ? gate(item.phase_gate, {
                status: item.status === "completed" ? "ready" : "blocked",
                reason: item.status === "completed" ? null : `Phase ${item.phase_gate} is incomplete`,
                updated_at: now,
              })
            : item.phase_gate === next && run_gate.status === "ready"
              ? gate(item.phase_gate, {
                  status: "ready",
                  reason: null,
                  updated_at: now,
                })
              : gate(item.phase_gate, {
                  status: "pending",
                  reason: `Waiting for ${row.phase} gate`,
                  updated_at: now,
                })
      const status: Item["status"] | undefined = stopped
        ? "blocked"
        : item.status === "blocked"
          ? item.phase_gate === row.phase && run_gate.status !== "blocked"
            ? "ready"
            : item.phase_gate === next && run_gate.status === "ready"
              ? "ready"
              : "pending"
          : item.phase_gate === row.phase && item.status === "pending" && run_gate.status !== "blocked"
            ? "ready"
            : undefined
      const patch = {
        gate: item_gate,
        ...(status ? { status } : {}),
      }
      db.update(WorkItemTable).set(patch).where(eq(WorkItemTable.id, item.id)).run()
    })
    return {
      run: run(db, id),
      items: sort(db.select().from(WorkItemTable).where(eq(WorkItemTable.swarm_run_id, id)).all()),
    }
  }

  function touch(db: Database.TxOrDb, ids: string[]) {
    const set = new Set(ids)
    const items = db
      .select()
      .from(WorkItemTable)
      .all()
      .filter((item) => set.has(item.id))
    const runs = db
      .select()
      .from(SwarmRunTable)
      .all()
      .filter((item) => set.has(item.id))
    const seen = new Set([...runs.map((item) => item.id), ...items.map((item) => item.swarm_run_id)])
    return [...seen].map((id) => sync(db, id))
  }

  function draft(id: string, scope: string[]) {
    return seed.map((item, i) => ({
      id: `${id}:${item.phase}`,
      swarm_run_id: id,
      title: item.title,
      status: item.phase === "plan" ? "ready" : "pending",
      owner_role_id: item.owner_role_id,
      blocked_by: i === 0 ? [] : [`${id}:${seed[i - 1]!.phase}`],
      scope,
      phase_gate: item.phase,
      gate: gate(item.phase),
      verification: {
        status: "pending",
        required: item.required,
        commands: item.commands,
        result: null,
        updated_at: null,
      },
      small_mr_required: true,
    })) satisfies ItemCreate[]
  }

  function run(db: Database.TxOrDb, id: string) {
    return hit(db.select().from(SwarmRunTable).where(eq(SwarmRunTable.id, id)).get(), "SwarmRun", id)
  }

  function role(db: Database.TxOrDb, id: string) {
    return hit(db.select().from(RoleSpecTable).where(eq(RoleSpecTable.role_id, id)).get(), "RoleSpec", id)
  }

  function item(db: Database.TxOrDb, id: string) {
    return hit(db.select().from(WorkItemTable).where(eq(WorkItemTable.id, id)).get(), "WorkItem", id)
  }

  function decision(db: Database.TxOrDb, id: string) {
    return hit(db.select().from(DecisionTable).where(eq(DecisionTable.id, id)).get(), "Decision", id)
  }

  function question(db: Database.TxOrDb, id: string) {
    return hit(db.select().from(OpenQuestionTable).where(eq(OpenQuestionTable.id, id)).get(), "OpenQuestion", id)
  }

  function action(input: DecisionInput) {
    return Delivery.DecisionAction.parse({
      kind: input.kind,
      role: input.role,
      outcome: input.outcome,
      context: input.context,
      created_at: input.created_at,
    })
  }

  function stamp(reason: string, updates: z.input<typeof DecisionUpdate>[]) {
    return JSON.stringify(
      DecisionResolution.parse({
        reason,
        updates,
      }),
      null,
      2,
    )
  }

  function align(input: {
    participants: string[]
    candidate_outcomes: string[]
    input_context: string
    actions: Delivery.DecisionAction[]
  }) {
    if (input.participants.length === 0) return { kind: "insufficient" as const }
    if (input.candidate_outcomes.length === 0) return { kind: "insufficient" as const }
    if (clean(input.input_context).length === 0) return { kind: "insufficient" as const }
    if (!input.actions.some((item) => item.kind === "proposal")) return { kind: "insufficient" as const }
    const seen = new Map(
      input.actions
        .filter((item) => item.outcome && input.participants.includes(item.role))
        .map((item) => [item.role, item.outcome]),
    )
    if (input.participants.some((item) => !seen.get(item))) return { kind: "insufficient" as const }
    const outcomes = input.participants.map((item) => seen.get(item)!)
    if (outcomes.some((item) => !input.candidate_outcomes.includes(item))) return { kind: "insufficient" as const }
    const picks = [...new Set(outcomes)]
    if (picks.length === 1) return { kind: "agreement" as const, outcome: picks[0]! }
    return { kind: "conflict" as const, outcomes: picks }
  }

  function touchview(id: string, outcome: string) {
    return {
      target: id,
      detail: `Refreshed ${id} after decision resolved as ${outcome}`,
    }
  }

  function settle(
    db: Database.TxOrDb,
    row: Decision,
    input: {
      actions: Delivery.DecisionAction[]
      outcome: string
      reason: string
      decided_by: string
      decided_at: number
    },
  ) {
    if (!Delivery.canTransitionDecision(row.status, "decided"))
      fail("decision", "status", row.id, row.status, "decided")
    const updates = row.applies_to.map((item) => touchview(item, input.outcome))
    db.update(DecisionTable)
      .set({
        status: "decided",
        decided_by: input.decided_by,
        decided_at: input.decided_at,
        actions: [
          ...input.actions,
          Delivery.DecisionAction.parse({
            kind: "decision",
            role: input.decided_by,
            outcome: input.outcome,
            context: stamp(input.reason, updates),
            created_at: input.decided_at,
          }),
        ],
      })
      .where(eq(DecisionTable.id, row.id))
      .run()
    touch(db, row.applies_to)
    return decision(db, row.id)
  }

  function patchRole(db: Database.TxOrDb, id: string, input: RolePatch) {
    const prev = role(db, id)
    const next = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.responsibility === undefined ? {} : { responsibility: input.responsibility }),
      ...(input.skills === undefined ? {} : { skills: input.skills }),
      ...(input.limits === undefined ? {} : { limits: input.limits }),
      ...(input.approval_required === undefined ? {} : { approval_required: input.approval_required }),
    } satisfies RolePatch
    if (Object.keys(next).length === 0) return prev
    db.update(RoleSpecTable).set(next).where(eq(RoleSpecTable.role_id, id)).run()
    return role(db, id)
  }

  function patchItem(db: Database.TxOrDb, id: string, input: ItemPatch, sync_run = true) {
    const prev = item(db, id)
    if (input.owner_role_id !== undefined) role(db, input.owner_role_id)
    const proof = verify(input.verification)
    const next = {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.status === undefined ? {} : { status: Delivery.WorkStatus.parse(input.status) }),
      ...(input.owner_role_id === undefined ? {} : { owner_role_id: input.owner_role_id }),
      ...(input.blocked_by === undefined ? {} : { blocked_by: input.blocked_by }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.phase_gate === undefined ? {} : { phase_gate: Delivery.WorkPhaseGate.parse(input.phase_gate) }),
      ...(input.gate === undefined ? {} : { gate: gate(input.phase_gate ?? prev.phase_gate, input.gate) }),
      ...(proof === undefined ? {} : { verification: proof }),
      ...(input.small_mr_required === undefined ? {} : { small_mr_required: input.small_mr_required }),
    } satisfies ItemPatch
    if (Object.keys(next).length === 0) return prev
    if (next.status !== undefined && !Delivery.canTransitionWorkStatus(prev.status, next.status)) {
      fail("item", "status", id, prev.status, next.status)
    }
    if (proof !== undefined && !Delivery.canTransitionVerification(prev.verification.status, proof.status)) {
      fail("item", "verification", id, prev.verification.status, proof.status)
    }
    db.update(WorkItemTable).set(next).where(eq(WorkItemTable.id, id)).run()
    if (sync_run) sync(db, prev.swarm_run_id)
    return item(db, id)
  }

  function review(db: Database.TxOrDb, input: AssignmentInput) {
    run(db, input.run_id)
    const changes: AssignmentChange[] = []
    if (input.roles) {
      const prev = new Map(
        db
          .select()
          .from(RoleSpecTable)
          .all()
          .map((item) => [item.role_id, item]),
      )
      const next = new Map(input.roles.map((item) => [item.role_id, item]))
      prev.forEach((item, id) => {
        const row = next.get(id)
        if (!row) {
          changes.push({
            kind: "role_removed",
            role_id: id,
            item_id: null,
            from: item.responsibility,
            to: null,
            message: `Role ${id} would be removed from the assignment plan`,
          })
          return
        }
        if (clean(item.responsibility) === clean(row.responsibility)) return
        changes.push({
          kind: "role_responsibility_changed",
          role_id: id,
          item_id: null,
          from: item.responsibility,
          to: row.responsibility,
          message: `Role ${id} would change responsibility`,
        })
      })
      next.forEach((item, id) => {
        if (prev.has(id)) return
        changes.push({
          kind: "role_added",
          role_id: id,
          item_id: null,
          from: null,
          to: item.responsibility,
          message: `Role ${id} would be added to the assignment plan`,
        })
      })
    }
    input.items?.forEach((row) => {
      const prev = item(db, row.id)
      if (prev.swarm_run_id !== input.run_id) {
        throw new Error(`WorkItem ${row.id} does not belong to run ${input.run_id}`)
      }
      if (row.owner_role_id === undefined || row.owner_role_id === prev.owner_role_id) return
      changes.push({
        kind: "owner_reassigned",
        role_id: row.owner_role_id,
        item_id: row.id,
        from: prev.owner_role_id,
        to: row.owner_role_id,
        message: `Work item ${row.id} would move from ${prev.owner_role_id} to ${row.owner_role_id}`,
      })
    })
    return AssignmentReview.parse({
      major: changes.length > 0,
      changes,
    })
  }

  function roleview(item: Role | RoleCreate) {
    return AssignmentRole.parse({
      role_id: item.role_id,
      name: item.name,
      responsibility: item.responsibility,
      skills: [...item.skills],
      limits: [...item.limits],
      approval_required: item.approval_required,
    })
  }

  function itemview(item: Pick<Item, "id" | "title" | "owner_role_id" | "blocked_by" | "scope">) {
    return AssignmentItemState.parse({
      id: item.id,
      title: item.title,
      owner_role_id: item.owner_role_id,
      blocked_by: [...item.blocked_by],
      scope: [...item.scope],
    })
  }

  function assignment(db: Database.TxOrDb, input: AssignmentRequest, review: AssignmentReview) {
    return AssignmentQuestion.parse({
      reason: input.reason,
      impact: review.changes.map((item) => item.message),
      before: {
        roles: input.roles ? db.select().from(RoleSpecTable).all().map(roleview) : [],
        items: input.items?.map((row) => itemview(item(db, row.id))) ?? [],
      },
      after: {
        roles: input.roles?.map(roleview) ?? [],
        items:
          input.items?.map((row) => {
            const prev = item(db, row.id)
            return itemview({
              id: prev.id,
              title: row.title ?? prev.title,
              owner_role_id: row.owner_role_id ?? prev.owner_role_id,
              blocked_by: row.blocked_by ?? prev.blocked_by,
              scope: row.scope ?? prev.scope,
            })
          }) ?? [],
      },
    })
  }

  function apply(db: Database.TxOrDb, input: AssignmentQuestion) {
    const prev = new Map(input.before.roles.map((item) => [item.role_id, item]))
    const next = new Map(input.after.roles.map((item) => [item.role_id, item]))
    next.forEach((item, id) => {
      if (!prev.has(id)) {
        db.insert(RoleSpecTable).values(item).run()
        return
      }
      patchRole(db, id, {
        name: item.name,
        responsibility: item.responsibility,
        skills: item.skills,
        limits: item.limits,
        approval_required: item.approval_required,
      })
    })
    input.after.items.forEach((row) => {
      patchItem(
        db,
        row.id,
        {
          title: row.title,
          owner_role_id: row.owner_role_id,
          blocked_by: row.blocked_by,
          scope: row.scope,
        },
        false,
      )
    })
    prev.forEach((item, id) => {
      if (next.has(id)) return
      const used = db.select().from(WorkItemTable).where(eq(WorkItemTable.owner_role_id, id)).get()
      if (used) {
        throw new Error(`Role ${id} still owns work item ${used.id}`)
      }
      db.delete(RoleSpecTable).where(eq(RoleSpecTable.role_id, item.role_id)).run()
    })
  }

  export function listRuns() {
    return Database.use((db) => db.select().from(SwarmRunTable).all())
  }

  export function getRun(id: string) {
    return Database.use((db) => run(db, id))
  }

  export function evaluateRun(id: string) {
    return Database.transaction((db) => sync(db, id))
  }

  export function createRun(input: RunCreate) {
    return Database.use((db) => {
      const phase = input.phase === undefined ? "plan" : Delivery.RunPhase.parse(input.phase)
      db.insert(SwarmRunTable)
        .values({
          ...input,
          ...(input.status === undefined ? {} : { status: Delivery.RunStatus.parse(input.status) }),
          phase,
          ...(input.phases === undefined ? {} : { phases: input.phases.map((item) => Delivery.RunPhase.parse(item)) }),
          gate: gate(phase, input.gate),
        })
        .run()
      return run(db, input.id)
    })
  }

  export function updateRun(id: string, input: RunPatch) {
    return Database.transaction((db) => {
      const prev = run(db, id)
      const next = {
        ...(input.goal === undefined ? {} : { goal: input.goal }),
        ...(input.status === undefined ? {} : { status: Delivery.RunStatus.parse(input.status) }),
        ...(input.phase === undefined ? {} : { phase: Delivery.RunPhase.parse(input.phase) }),
        ...(input.phases === undefined ? {} : { phases: input.phases.map((item) => Delivery.RunPhase.parse(item)) }),
        ...(input.gate === undefined ? {} : { gate: gate(input.phase ?? prev.phase, input.gate) }),
        ...(input.owner_session_id === undefined ? {} : { owner_session_id: input.owner_session_id }),
      } satisfies RunPatch
      if (Object.keys(next).length === 0) return prev
      if (next.status !== undefined && !Delivery.canTransitionRunStatus(prev.status, next.status))
        fail("run", "status", id, prev.status, next.status)
      if (next.phase !== undefined && !Delivery.canTransitionRunPhase(prev.phase, next.phase))
        fail("run", "phase", id, prev.phase, next.phase)
      if (next.phase !== undefined && next.phase !== prev.phase) {
        const view = sync(db, id)
        if (next.phase !== Delivery.next(prev.phase) || view.run.gate.status !== "ready") {
          throw new GateError({
            id,
            phase: prev.phase,
            to: next.phase,
            reason: view.run.gate.reason ?? `Phase ${prev.phase} is not ready to advance`,
            message: `Cannot advance ${id} from ${prev.phase} to ${next.phase}`,
          })
        }
        next.gate = gate(next.phase)
      }
      db.update(SwarmRunTable).set(next).where(eq(SwarmRunTable.id, id)).run()
      sync(db, id)
      return run(db, id)
    })
  }

  export function deleteRun(id: string) {
    return Database.transaction((db) => {
      const prev = run(db, id)
      db.delete(SwarmRunTable).where(eq(SwarmRunTable.id, id)).run()
      return prev
    })
  }

  export function listRoles() {
    return Database.use((db) => db.select().from(RoleSpecTable).all())
  }

  export function getRole(id: string) {
    return Database.use((db) => role(db, id))
  }

  export function createRole(input: RoleCreate) {
    return Database.use((db) => {
      db.insert(RoleSpecTable).values(input).run()
      return role(db, input.role_id)
    })
  }

  export function updateRole(id: string, input: RolePatch) {
    return Database.transaction((db) => {
      return patchRole(db, id, input)
    })
  }

  export function deleteRole(id: string) {
    return Database.transaction((db) => {
      const prev = role(db, id)
      db.delete(RoleSpecTable).where(eq(RoleSpecTable.role_id, id)).run()
      return prev
    })
  }

  export function listItems() {
    return Database.use((db) => db.select().from(WorkItemTable).all())
  }

  export function listRunItems(id: string) {
    return Database.use((db) => db.select().from(WorkItemTable).where(eq(WorkItemTable.swarm_run_id, id)).all())
  }

  export function getItem(id: string) {
    return Database.use((db) => item(db, id))
  }

  export function createItem(input: ItemCreate) {
    return Database.use((db) => {
      const phase = input.phase_gate === undefined ? "plan" : Delivery.WorkPhaseGate.parse(input.phase_gate)
      db.insert(WorkItemTable)
        .values({
          ...input,
          ...(input.status === undefined ? {} : { status: Delivery.WorkStatus.parse(input.status) }),
          phase_gate: phase,
          gate: gate(phase, input.gate),
          verification: Delivery.Verification.parse(input.verification),
        })
        .run()
      sync(db, input.swarm_run_id)
      return item(db, input.id)
    })
  }

  export function updateItem(id: string, input: ItemPatch) {
    return Database.transaction((db) => {
      return patchItem(db, id, input)
    })
  }

  export function reviewAssignments(input: AssignmentInput) {
    return Database.use((db) => review(db, input))
  }

  export function assign(input: AssignmentInput) {
    return Database.transaction((db) => {
      const state = review(db, input)
      if (state.major) {
        throw new AssignmentError({
          run_id: input.run_id,
          changes: state.changes,
          message: `Major assignment changes require confirmation for run ${input.run_id}`,
        })
      }
      input.roles?.forEach((item) => {
        patchRole(db, item.role_id, {
          name: item.name,
          responsibility: item.responsibility,
          skills: item.skills,
          limits: item.limits,
          approval_required: item.approval_required,
        })
      })
      input.items?.forEach((item) => {
        const { id, ...rest } = item
        patchItem(db, id, rest, false)
      })
      if ((input.items?.length ?? 0) > 0) sync(db, input.run_id)
      return {
        run: run(db, input.run_id),
        review: state,
        roles: input.roles?.map((item) => role(db, item.role_id)) ?? [],
        items: input.items?.map((item) => item.id).map((id) => item(db, id)) ?? [],
      }
    })
  }

  export function requestAssignment(input: AssignmentRequest) {
    return Database.transaction((db) => {
      const state = review(db, input)
      if (!state.major) {
        throw new AssignmentError({
          run_id: input.run_id,
          changes: state.changes,
          message: `Assignment changes do not require confirmation for run ${input.run_id}`,
        })
      }
      const info = assignment(db, input, state)
      const ids = [...new Set([input.run_id, ...(input.items?.map((item) => item.id) ?? [])])]
      db.insert(DecisionTable)
        .values({
          id: input.decision_id,
          kind: "role_change",
          summary:
            state.changes.length === 1
              ? state.changes[0]!.message
              : `${state.changes.length} assignment changes require confirmation`,
          source: input.source ?? "assignment_review",
          status: "proposed",
          requires_user_confirmation: true,
          applies_to: ids,
          related_question_id: input.question_id,
        })
        .run()
      db.insert(OpenQuestionTable)
        .values({
          id: input.question_id,
          title: input.title ?? `Confirm assignment changes for ${input.run_id}`,
          context: JSON.stringify(info, null, 2),
          options: [...Answer.options],
          recommended_option: input.recommended_option ?? "confirm",
          status: "waiting_user",
          deadline_policy: "manual",
          blocking: true,
          affects: ids,
          related_decision_id: input.decision_id,
          raised_by: input.raised_by,
        })
        .run()
      touch(db, ids)
      return {
        review: state,
        decision: decision(db, input.decision_id),
        question: question(db, input.question_id),
      }
    })
  }

  export function resolveAssignment(input: AssignmentResolution) {
    return Database.transaction((db) => {
      const row = decision(db, input.decision_id)
      const qid = row.related_question_id
      if (!qid) throw new Error(`Decision ${row.id} has no related question`)
      let ask = question(db, qid)
      const info = AssignmentQuestion.parse(JSON.parse(ask.context))
      const status = input.answer === "confirm" ? "decided" : "cancelled"
      const when = input.decided_at ?? Date.now()
      if (!Delivery.canTransitionDecision(row.status, status)) fail("decision", "status", row.id, row.status, status)
      if (ask.status === "waiting_user") {
        if (!Delivery.canTransitionQuestion(ask.status, "answered"))
          fail("question", "status", ask.id, ask.status, "answered")
        db.update(OpenQuestionTable).set({ status: "answered" }).where(eq(OpenQuestionTable.id, ask.id)).run()
        ask = question(db, ask.id)
      }
      if (!Delivery.canTransitionQuestion(ask.status, "resolved"))
        fail("question", "status", ask.id, ask.status, "resolved")
      if (input.answer === "confirm") apply(db, info)
      db.update(OpenQuestionTable)
        .set({
          status: "resolved",
          blocking: false,
        })
        .where(eq(OpenQuestionTable.id, ask.id))
        .run()
      db.update(DecisionTable)
        .set({
          status,
          decided_by: input.decided_by,
          decided_at: when,
          actions: [
            ...row.actions,
            Delivery.DecisionAction.parse({
              kind: "decision",
              role: input.decided_by,
              outcome: input.answer,
              context: stamp(input.answer === "confirm" ? info.reason : `Rejected assignment change: ${info.reason}`, [
                ...row.applies_to.map((item) => touchview(item, input.answer === "confirm" ? "confirm" : "reject")),
                {
                  target: ask.id,
                  detail:
                    input.answer === "confirm"
                      ? `Resolved ${ask.id} and applied the approved assignment change`
                      : `Resolved ${ask.id} without changing the assignment plan`,
                },
              ]),
              created_at: when,
            }),
          ],
        })
        .where(eq(DecisionTable.id, row.id))
        .run()
      touch(db, [...row.applies_to, ...ask.affects])
      return {
        decision: decision(db, row.id),
        question: question(db, ask.id),
      }
    })
  }

  export function deleteItem(id: string) {
    return Database.transaction((db) => {
      const prev = item(db, id)
      db.delete(WorkItemTable).where(eq(WorkItemTable.id, id)).run()
      return prev
    })
  }

  export function listDecisions() {
    return Database.use((db) => db.select().from(DecisionTable).all())
  }

  export function getDecision(id: string) {
    return Database.use((db) => decision(db, id))
  }

  export function createDecision(input: DecisionCreate) {
    return Database.use((db) => {
      db.insert(DecisionTable)
        .values({
          ...input,
          ...(input.status === undefined ? {} : { status: Delivery.DecisionStatus.parse(input.status) }),
          ...(input.participants === undefined ? {} : { participants: [...input.participants] }),
          ...(input.candidate_outcomes === undefined ? {} : { candidate_outcomes: [...input.candidate_outcomes] }),
          ...(input.input_context === undefined ? {} : { input_context: input.input_context }),
          ...(input.actions === undefined
            ? {}
            : { actions: input.actions.map((item) => Delivery.DecisionAction.parse(item)) }),
        })
        .run()
      touch(db, input.applies_to)
      return decision(db, input.id)
    })
  }

  export function updateDecision(id: string, input: DecisionPatch) {
    return Database.transaction((db) => {
      const prev = decision(db, id)
      const next = {
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.status === undefined ? {} : { status: Delivery.DecisionStatus.parse(input.status) }),
        ...(input.requires_user_confirmation === undefined
          ? {}
          : { requires_user_confirmation: input.requires_user_confirmation }),
        ...(input.applies_to === undefined ? {} : { applies_to: input.applies_to }),
        ...(input.participants === undefined ? {} : { participants: [...input.participants] }),
        ...(input.candidate_outcomes === undefined ? {} : { candidate_outcomes: [...input.candidate_outcomes] }),
        ...(input.input_context === undefined ? {} : { input_context: input.input_context }),
        ...(input.actions === undefined
          ? {}
          : { actions: input.actions.map((item) => Delivery.DecisionAction.parse(item)) }),
        ...(input.related_question_id === undefined ? {} : { related_question_id: input.related_question_id }),
        ...(input.decided_by === undefined ? {} : { decided_by: input.decided_by }),
        ...(input.decided_at === undefined ? {} : { decided_at: input.decided_at }),
      } satisfies DecisionPatch
      if (Object.keys(next).length === 0) return prev
      if (next.status !== undefined && !Delivery.canTransitionDecision(prev.status, next.status))
        fail("decision", "status", id, prev.status, next.status)
      db.update(DecisionTable).set(next).where(eq(DecisionTable.id, id)).run()
      touch(db, [...prev.applies_to, ...(next.applies_to ?? [])])
      return decision(db, id)
    })
  }

  export function recordDecision(input: DecisionInput) {
    return Database.transaction((db) => {
      const item = DecisionInput.parse(input)
      const row = decision(db, item.decision_id)
      const actions =
        item.kind === "decision" && item.role === "conductor" ? [...row.actions] : [...row.actions, action(item)]
      const participants = item.kind === "proposal" ? [...item.participants] : row.participants
      const outcomes = item.kind === "proposal" ? [...item.candidate_outcomes] : row.candidate_outcomes
      const context = item.kind === "proposal" ? item.input_context : row.input_context
      const view = align({
        participants,
        candidate_outcomes: outcomes,
        input_context: context,
        actions,
      })
      if (!row.requires_user_confirmation && item.kind === "decision" && item.role === "conductor" && item.outcome) {
        if (view.kind === "conflict" || view.kind === "agreement") {
          return settle(db, row, {
            actions,
            outcome: item.outcome,
            reason: clean(item.context) || `Conductor arbitration resolved ${row.id} as ${item.outcome}`,
            decided_by: item.role,
            decided_at: item.created_at ?? Date.now(),
          })
        }
      }
      if (!row.requires_user_confirmation && view.kind === "agreement") {
        return settle(db, row, {
          actions,
          outcome: view.outcome,
          reason: `Consensus reached after ${participants.length} aligned inputs on ${view.outcome}`,
          decided_by: "system",
          decided_at: item.created_at ?? Date.now(),
        })
      }
      db.update(DecisionTable)
        .set({
          actions,
          ...(item.kind !== "proposal"
            ? {}
            : {
                participants,
                candidate_outcomes: outcomes,
                input_context: context,
              }),
        })
        .where(eq(DecisionTable.id, row.id))
        .run()
      return decision(db, row.id)
    })
  }

  export function deleteDecision(id: string) {
    return Database.transaction((db) => {
      const prev = decision(db, id)
      db.delete(DecisionTable).where(eq(DecisionTable.id, id)).run()
      return prev
    })
  }

  export function listQuestions() {
    return Database.use((db) => db.select().from(OpenQuestionTable).all())
  }

  export function getQuestion(id: string) {
    return Database.use((db) => question(db, id))
  }

  export function createQuestion(input: QuestionCreate) {
    return Database.use((db) => {
      db.insert(OpenQuestionTable)
        .values({
          ...input,
          ...(input.status === undefined ? {} : { status: Delivery.OpenQuestionStatus.parse(input.status) }),
        })
        .run()
      touch(db, input.affects)
      return question(db, input.id)
    })
  }

  export function launch(input: { id: string; goal: string; owner_session_id: string; scope?: string[] }) {
    return Database.transaction((db) => {
      db.insert(RoleSpecTable).values(roles).onConflictDoNothing().run()
      db.insert(SwarmRunTable)
        .values({
          id: input.id,
          goal: input.goal,
          status: "active",
          phase: "plan",
          phases: [...Delivery.Phases],
          gate: gate("plan"),
          owner_session_id: input.owner_session_id,
        })
        .run()
      const scope = input.scope && input.scope.length > 0 ? input.scope : [input.goal]
      db.insert(WorkItemTable).values(draft(input.id, scope)).run()
      return sync(db, input.id)
    })
  }

  export function updateQuestion(id: string, input: QuestionPatch) {
    return Database.transaction((db) => {
      const prev = question(db, id)
      const status = input.status === undefined ? prev.status : Delivery.OpenQuestionStatus.parse(input.status)
      const next = {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.options === undefined ? {} : { options: input.options }),
        ...(input.recommended_option === undefined ? {} : { recommended_option: input.recommended_option }),
        ...(input.status === undefined ? {} : { status }),
        ...(input.deadline_policy === undefined ? {} : { deadline_policy: input.deadline_policy }),
        ...(input.blocking === undefined
          ? ["resolved", "deferred", "cancelled"].includes(status)
            ? { blocking: false }
            : {}
          : { blocking: input.blocking }),
        ...(input.affects === undefined ? {} : { affects: input.affects }),
        ...(input.related_decision_id === undefined ? {} : { related_decision_id: input.related_decision_id }),
        ...(input.raised_by === undefined ? {} : { raised_by: input.raised_by }),
      } satisfies QuestionPatch
      if (Object.keys(next).length === 0) return prev
      if (next.status !== undefined && !Delivery.canTransitionQuestion(prev.status, next.status))
        fail("question", "status", id, prev.status, next.status)
      db.update(OpenQuestionTable).set(next).where(eq(OpenQuestionTable.id, id)).run()
      const row = question(db, id)
      if (["resolved", "deferred", "cancelled"].includes(row.status)) follow(db, row)
      touch(db, [...prev.affects, ...(next.affects ?? [])])
      return question(db, id)
    })
  }

  export function deleteQuestion(id: string) {
    return Database.transaction((db) => {
      const prev = question(db, id)
      db.delete(OpenQuestionTable).where(eq(OpenQuestionTable.id, id)).run()
      return prev
    })
  }
}
