import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { Delivery } from "../../src/delivery/schema"
import {
  DecisionTable,
  OpenQuestionTable,
  RoleSpecTable,
  SwarmRunTable,
  WorkItemTable,
} from "../../src/delivery/delivery.sql"
import { Database } from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"

describe("delivery schema", () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  afterEach(async () => {
    await resetDatabase()
  })

  test("persists delivery schema records", () => {
    const db = Database.Client()

    db.insert(SwarmRunTable)
      .values({
        id: "SR-1",
        goal: "Ship a delivery schema",
        status: "pending",
        phase: "plan",
        phases: [...Delivery.Phases],
        gate: Delivery.gate("plan"),
        owner_session_id: "SE-1",
      })
      .run()

    db.insert(RoleSpecTable)
      .values({
        role_id: "builder",
        name: "Builder",
        responsibility: "Implements changes",
        skills: ["code", "tests"],
        limits: ["no_force_push"],
        approval_required: true,
      })
      .run()

    db.insert(WorkItemTable)
      .values({
        id: "WI-1",
        swarm_run_id: "SR-1",
        title: "Ship the delivery schema",
        status: "ready",
        owner_role_id: "builder",
        blocked_by: ["WI-0"],
        scope: ["packages/opencode/src/delivery"],
        phase_gate: "implement",
        gate: Delivery.gate("implement"),
        verification: {
          status: "pending",
          required: true,
          commands: ["bun run typecheck"],
          result: null,
          updated_at: null,
        },
        small_mr_required: true,
      })
      .run()

    db.insert(OpenQuestionTable)
      .values({
        id: "OQ-1",
        title: "Need role approval",
        context: "A reassignment changes ownership",
        options: ["approve", "reject"],
        recommended_option: "approve",
        status: "waiting_user",
        deadline_policy: "manual",
        blocking: true,
        affects: ["WI-1", "SR-1"],
        related_decision_id: "DE-1",
        raised_by: "conductor",
      })
      .run()

    db.insert(DecisionTable)
      .values({
        id: "DE-1",
        kind: "role_change",
        summary: "Approve role reassignment",
        source: "alignment",
        status: "proposed",
        requires_user_confirmation: true,
        applies_to: ["WI-1", "OQ-1"],
        participants: ["planner", "builder", "verifier"],
        candidate_outcomes: ["approve", "reject"],
        input_context: "Builder asked for a role change after review feedback",
        actions: [
          {
            kind: "proposal",
            role: "planner",
            outcome: "approve",
            context: "Seed the decision with the current assignment plan",
            created_at: 42,
          },
        ],
        related_question_id: "OQ-1",
        decided_by: null,
        decided_at: null,
      })
      .run()

    const run = db.select().from(SwarmRunTable).get()
    const role = db.select().from(RoleSpecTable).get()
    const item = db.select().from(WorkItemTable).get()
    const question = db.select().from(OpenQuestionTable).get()
    const decision = db.select().from(DecisionTable).get()

    expect(run).toMatchObject({
      id: "SR-1",
      goal: "Ship a delivery schema",
      status: "pending",
      phase: "plan",
      phases: [...Delivery.Phases],
      gate: Delivery.gate("plan"),
      owner_session_id: "SE-1",
    })
    expect(typeof run?.created_at).toBe("number")
    expect(typeof run?.updated_at).toBe("number")
    expect(role).toEqual({
      role_id: "builder",
      name: "Builder",
      responsibility: "Implements changes",
      skills: ["code", "tests"],
      limits: ["no_force_push"],
      approval_required: true,
    })
    expect(item).toEqual({
      id: "WI-1",
      swarm_run_id: "SR-1",
      title: "Ship the delivery schema",
      status: "ready",
      owner_role_id: "builder",
      blocked_by: ["WI-0"],
      scope: ["packages/opencode/src/delivery"],
      phase_gate: "implement",
      gate: Delivery.gate("implement"),
      verification: {
        status: "pending",
        required: true,
        commands: ["bun run typecheck"],
        result: null,
        updated_at: null,
      },
      small_mr_required: true,
    })
    expect(question).toEqual({
      id: "OQ-1",
      title: "Need role approval",
      context: "A reassignment changes ownership",
      options: ["approve", "reject"],
      recommended_option: "approve",
      status: "waiting_user",
      deadline_policy: "manual",
      blocking: true,
      affects: ["WI-1", "SR-1"],
      related_decision_id: "DE-1",
      raised_by: "conductor",
    })
    expect(decision).toEqual({
      id: "DE-1",
      kind: "role_change",
      summary: "Approve role reassignment",
      source: "alignment",
      status: "proposed",
      requires_user_confirmation: true,
      applies_to: ["WI-1", "OQ-1"],
      participants: ["planner", "builder", "verifier"],
      candidate_outcomes: ["approve", "reject"],
      input_context: "Builder asked for a role change after review feedback",
      actions: [
        {
          kind: "proposal",
          role: "planner",
          outcome: "approve",
          context: "Seed the decision with the current assignment plan",
          created_at: 42,
        },
      ],
      related_question_id: "OQ-1",
      decided_by: null,
      decided_at: null,
    })
  })

  test("applies the migration columns", () => {
    Database.Client()
    Database.close()

    const sqlite = new BunDatabase(Database.Path, { readonly: true })
    const run = sqlite.query("pragma table_info('swarm_run')").all() as { name: string }[]
    const role = sqlite.query("pragma table_info('role_spec')").all() as { name: string }[]
    const item = sqlite.query("pragma table_info('work_item')").all() as { name: string }[]
    const decision = sqlite.query("pragma table_info('decision')").all() as { name: string }[]
    const question = sqlite.query("pragma table_info('open_question')").all() as { name: string }[]
    sqlite.close()

    expect(run.map((item) => item.name)).toEqual([
      "id",
      "goal",
      "status",
      "phase",
      "phases",
      "created_at",
      "updated_at",
      "owner_session_id",
      "gate",
    ])
    expect(role.map((item) => item.name)).toEqual([
      "role_id",
      "name",
      "responsibility",
      "skills",
      "limits",
      "approval_required",
    ])
    expect(item.map((item) => item.name)).toEqual([
      "id",
      "swarm_run_id",
      "title",
      "status",
      "owner_role_id",
      "blocked_by",
      "scope",
      "phase_gate",
      "verification",
      "small_mr_required",
      "gate",
    ])
    expect(decision.map((item) => item.name)).toEqual([
      "id",
      "kind",
      "summary",
      "source",
      "status",
      "requires_user_confirmation",
      "applies_to",
      "related_question_id",
      "decided_by",
      "decided_at",
      "participants",
      "candidate_outcomes",
      "input_context",
      "actions",
    ])
    expect(question.map((item) => item.name)).toEqual([
      "id",
      "title",
      "context",
      "options",
      "recommended_option",
      "status",
      "deadline_policy",
      "blocking",
      "affects",
      "related_decision_id",
      "raised_by",
    ])
  })

  test("shares delivery validators and transitions", () => {
    expect(Delivery.RunStatus.safeParse("active").success).toBe(true)
    expect(Delivery.RunStatus.safeParse("plan").success).toBe(false)
    expect(Delivery.canTransitionRunStatus("pending", "active")).toBe(true)
    expect(Delivery.canTransitionRunStatus("pending", "completed")).toBe(false)
    expect(Delivery.RunPhase.safeParse("commit").success).toBe(true)
    expect(Delivery.RunPhase.safeParse("blocked").success).toBe(false)
    expect(Delivery.canTransitionRunPhase("plan", "implement")).toBe(true)
    expect(Delivery.canTransitionRunPhase("plan", "commit")).toBe(false)
    expect(Delivery.rule("verify")).toEqual({
      enter: ["implementation work item is completed"],
      exit: ["verification work item is completed", "required verification passed"],
      fallback: "implement",
    })
    expect(Delivery.gate("commit")).toEqual({
      status: "pending",
      reason: null,
      enter: ["verification work item is completed", "required verification passed"],
      exit: ["commit work item is completed"],
      fallback: "verify",
      updated_at: null,
    })
    expect(Delivery.next("commit")).toBe("retrospective")
    expect(Delivery.next("retrospective")).toBeNull()
    expect(Delivery.WorkStatus.safeParse("ready").success).toBe(true)
    expect(Delivery.WorkStatus.safeParse("verify").success).toBe(false)
    expect(Delivery.canTransitionWorkStatus("ready", "in_progress")).toBe(true)
    expect(Delivery.canTransitionWorkStatus("ready", "completed")).toBe(false)
    expect(Delivery.WorkPhaseGate.safeParse("retrospective").success).toBe(true)
    expect(Delivery.WorkPhaseGate.safeParse("completed").success).toBe(false)
    expect(Delivery.DecisionStatus.safeParse("decided").success).toBe(true)
    expect(Delivery.DecisionStatus.safeParse("open").success).toBe(false)
    expect(Delivery.DecisionActionKind.safeParse("review").success).toBe(true)
    expect(Delivery.DecisionActionKind.safeParse("consensus").success).toBe(false)
    expect(Delivery.OpenQuestionStatus.safeParse("answered").success).toBe(true)
    expect(Delivery.OpenQuestionStatus.safeParse("superseded").success).toBe(false)
    expect(
      Delivery.Verification.safeParse({
        status: "passed",
        required: true,
        commands: ["bun run typecheck"],
        result: "ok",
        updated_at: Date.now(),
      }).success,
    ).toBe(true)
    expect(Delivery.canTransitionVerification("pending", "running")).toBe(true)
    expect(Delivery.canTransitionVerification("pending", "passed")).toBe(false)
    expect(
      Delivery.DecisionAction.safeParse({
        kind: "objection",
        role: "qa",
        outcome: "reject",
        context: "Missing rollback plan",
        created_at: 42,
      }).success,
    ).toBe(true)
    expect(Delivery.canTransitionDecision("proposed", "decided")).toBe(true)
    expect(Delivery.canTransitionDecision("decided", "cancelled")).toBe(false)
    expect(Delivery.canTransitionQuestion("open", "waiting_user")).toBe(true)
    expect(Delivery.canTransitionQuestion("open", "answered")).toBe(false)
    expect(Delivery.canTransitionQuestion("waiting_user", "resolved")).toBe(false)
    expect(Delivery.canTransitionQuestion("answered", "resolved")).toBe(true)
    expect(Delivery.canTransitionQuestion("deferred", "waiting_user")).toBe(true)
    expect(Delivery.canTransitionQuestion("resolved", "open")).toBe(false)
  })
})
