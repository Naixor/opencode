import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Delivery } from "../../src/delivery/schema"
import { DeliveryStore } from "../../src/delivery/store"
import { resetDatabase } from "../fixture/db"

describe("delivery store", () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  afterEach(async () => {
    await resetDatabase()
  })

  test("routes delivery CRUD through the shared store", () => {
    const role = DeliveryStore.createRole({
      role_id: "builder",
      name: "Builder",
      responsibility: "Ships changes",
      skills: ["code", "test"],
      limits: ["no_force_push"],
      approval_required: true,
    })

    const run = DeliveryStore.createRun({
      id: "SR-1",
      goal: "Ship US-004",
      owner_session_id: "SE-1",
    })

    const item = DeliveryStore.createItem({
      id: "WI-1",
      swarm_run_id: run.id,
      title: "Add delivery store",
      status: "ready",
      owner_role_id: role.role_id,
      blocked_by: [],
      scope: ["packages/opencode/src/delivery"],
      phase_gate: "implement",
      verification: {
        status: "pending",
        required: true,
        commands: ["bun run typecheck"],
        result: null,
        updated_at: null,
      },
      small_mr_required: true,
    })

    const question = DeliveryStore.createQuestion({
      id: "OQ-1",
      title: "Approve owner shift",
      context: "The work item needs a different owner",
      options: ["approve", "reject"],
      recommended_option: "approve",
      status: "waiting_user",
      deadline_policy: "manual",
      blocking: false,
      affects: [run.id, item.id],
      related_decision_id: "DE-1",
      raised_by: "conductor",
    })

    const decision = DeliveryStore.createDecision({
      id: "DE-1",
      kind: "role_change",
      summary: "Approve the reassignment",
      source: "alignment",
      status: "proposed",
      requires_user_confirmation: true,
      applies_to: [item.id, question.id],
      related_question_id: question.id,
    })

    expect(DeliveryStore.listRuns().map((item) => item.id)).toEqual([run.id])
    expect(DeliveryStore.listRoles().map((item) => item.role_id)).toEqual([role.role_id])
    expect(DeliveryStore.listItems().map((item) => item.id)).toEqual([item.id])
    expect(DeliveryStore.listDecisions().map((item) => item.id)).toEqual([decision.id])
    expect(DeliveryStore.listQuestions().map((item) => item.id)).toEqual([question.id])

    expect(
      DeliveryStore.updateRun(run.id, {
        status: "active",
      }),
    ).toMatchObject({
      id: run.id,
      status: "active",
      phase: "plan",
    })

    expect(
      DeliveryStore.updateRole(role.role_id, {
        responsibility: "Ships and verifies changes",
      }),
    ).toMatchObject({
      role_id: role.role_id,
      responsibility: "Ships and verifies changes",
    })

    expect(
      DeliveryStore.updateItem(item.id, {
        status: "in_progress",
        blocked_by: ["WI-0"],
      }),
    ).toMatchObject({
      id: item.id,
      status: "in_progress",
      blocked_by: ["WI-0"],
    })

    expect(
      DeliveryStore.updateDecision(decision.id, {
        status: "decided",
        decided_by: "conductor",
        decided_at: 42,
      }),
    ).toMatchObject({
      id: decision.id,
      status: "decided",
      decided_by: "conductor",
      decided_at: 42,
    })

    expect(
      DeliveryStore.updateQuestion(question.id, {
        status: "answered",
        blocking: false,
      }),
    ).toMatchObject({
      id: question.id,
      status: "answered",
      blocking: false,
    })

    expect(DeliveryStore.getRun(run.id).id).toBe(run.id)
    expect(DeliveryStore.getRole(role.role_id).role_id).toBe(role.role_id)
    expect(DeliveryStore.getItem(item.id).id).toBe(item.id)
    expect(DeliveryStore.getDecision(decision.id).id).toBe(decision.id)
    expect(DeliveryStore.getQuestion(question.id).id).toBe(question.id)

    DeliveryStore.deleteDecision(decision.id)
    DeliveryStore.deleteQuestion(question.id)
    DeliveryStore.deleteItem(item.id)
    DeliveryStore.deleteRun(run.id)
    DeliveryStore.deleteRole(role.role_id)

    expect(DeliveryStore.listDecisions()).toHaveLength(0)
    expect(DeliveryStore.listQuestions()).toHaveLength(0)
    expect(DeliveryStore.listItems()).toHaveLength(0)
    expect(DeliveryStore.listRuns()).toHaveLength(0)
    expect(DeliveryStore.listRoles()).toHaveLength(0)
  })

  test("rejects invalid delivery transitions in the shared store", () => {
    DeliveryStore.createRole({
      role_id: "builder",
      name: "Builder",
      responsibility: "Ships changes",
      skills: [],
      limits: [],
      approval_required: false,
    })

    DeliveryStore.createRun({
      id: "SR-1",
      goal: "Ship US-004",
      owner_session_id: "SE-1",
    })

    DeliveryStore.createItem({
      id: "WI-1",
      swarm_run_id: "SR-1",
      title: "Add delivery store",
      status: "ready",
      owner_role_id: "builder",
      blocked_by: [],
      scope: ["packages/opencode/src/delivery"],
      phase_gate: "implement",
      verification: {
        status: "pending",
        required: true,
        commands: ["bun run typecheck"],
        result: null,
        updated_at: null,
      },
      small_mr_required: true,
    })

    DeliveryStore.createDecision({
      id: "DE-1",
      kind: "role_change",
      summary: "Approve reassignment",
      source: "alignment",
      status: "proposed",
      requires_user_confirmation: true,
      applies_to: ["WI-1", "OQ-1"],
      related_question_id: "OQ-1",
    })

    DeliveryStore.createQuestion({
      id: "OQ-1",
      title: "Approve owner shift",
      context: "The work item needs a different owner",
      options: ["approve", "reject"],
      recommended_option: "approve",
      status: "open",
      deadline_policy: "manual",
      blocking: true,
      affects: ["SR-1", "WI-1"],
      related_decision_id: "DE-1",
      raised_by: "conductor",
    })

    expect(() => DeliveryStore.updateRun("SR-1", { status: "completed" })).toThrow("DeliveryTransitionError")
    expect(() => DeliveryStore.updateRun("SR-1", { phase: "commit" })).toThrow("DeliveryTransitionError")
    expect(() => DeliveryStore.updateItem("WI-1", { status: "completed" })).toThrow("DeliveryTransitionError")
    expect(() =>
      DeliveryStore.updateItem("WI-1", {
        verification: {
          status: "passed",
          required: true,
          commands: ["bun run typecheck"],
          result: "ok",
          updated_at: 42,
        },
      }),
    ).toThrow("DeliveryTransitionError")

    DeliveryStore.updateDecision("DE-1", { status: "decided" })
    expect(() => DeliveryStore.updateDecision("DE-1", { status: "cancelled" })).toThrow("DeliveryTransitionError")

    expect(() => DeliveryStore.updateQuestion("OQ-1", { status: "resolved" })).toThrow("DeliveryTransitionError")
    DeliveryStore.updateQuestion("OQ-1", { status: "waiting_user" })
    DeliveryStore.updateQuestion("OQ-1", { status: "answered" })
    DeliveryStore.updateQuestion("OQ-1", { status: "resolved" })
    expect(() => DeliveryStore.updateQuestion("OQ-1", { status: "open" })).toThrow("DeliveryTransitionError")
  })

  test("launches a staged delivery run from a high-level goal", () => {
    const result = DeliveryStore.launch({
      id: "SW-1",
      goal: "Ship staged swarm delivery",
      owner_session_id: "SE-1",
    })

    expect(result.run).toMatchObject({
      id: "SW-1",
      goal: "Ship staged swarm delivery",
      status: "active",
      phase: "plan",
      phases: [...Delivery.Phases],
      owner_session_id: "SE-1",
    })

    expect(DeliveryStore.listRoles().map((item) => item.role_id)).toEqual([
      "planner",
      "builder",
      "verifier",
      "shipper",
      "reviewer",
    ])

    expect(
      result.items
        .toSorted((a, b) => Delivery.Phases.indexOf(a.phase_gate) - Delivery.Phases.indexOf(b.phase_gate))
        .map((item) => ({
          id: item.id,
          phase_gate: item.phase_gate,
          owner_role_id: item.owner_role_id,
          blocked_by: item.blocked_by,
          scope: item.scope,
          commands: item.verification.commands,
          required: item.verification.required,
        })),
    ).toEqual([
      {
        id: "SW-1:plan",
        phase_gate: "plan",
        owner_role_id: "planner",
        blocked_by: [],
        scope: ["Ship staged swarm delivery"],
        commands: [],
        required: false,
      },
      {
        id: "SW-1:implement",
        phase_gate: "implement",
        owner_role_id: "builder",
        blocked_by: ["SW-1:plan"],
        scope: ["Ship staged swarm delivery"],
        commands: ["bun run typecheck", "bun run build"],
        required: true,
      },
      {
        id: "SW-1:verify",
        phase_gate: "verify",
        owner_role_id: "verifier",
        blocked_by: ["SW-1:implement"],
        scope: ["Ship staged swarm delivery"],
        commands: ["bun run typecheck", "bun run build", "bun test"],
        required: true,
      },
      {
        id: "SW-1:commit",
        phase_gate: "commit",
        owner_role_id: "shipper",
        blocked_by: ["SW-1:verify"],
        scope: ["Ship staged swarm delivery"],
        commands: ["bun run typecheck", "bun run build", "bun test"],
        required: true,
      },
      {
        id: "SW-1:retrospective",
        phase_gate: "retrospective",
        owner_role_id: "reviewer",
        blocked_by: ["SW-1:commit"],
        scope: ["Ship staged swarm delivery"],
        commands: [],
        required: false,
      },
    ])
  })

  test("persists phase gate evaluation and blocks phase advancement until blockers clear", () => {
    DeliveryStore.launch({
      id: "SW-1",
      goal: "Ship staged swarm delivery",
      owner_session_id: "SE-1",
    })

    const step = (id: string) => {
      DeliveryStore.updateItem(id, { status: "in_progress" })
      DeliveryStore.updateItem(id, { status: "verifying" })
      return DeliveryStore.updateItem(id, { status: "completed" })
    }

    expect(DeliveryStore.evaluateRun("SW-1").run.gate).toMatchObject({
      status: "pending",
      reason: "Waiting for plan exit rules",
      fallback: null,
    })

    step("SW-1:plan")

    const plan = DeliveryStore.evaluateRun("SW-1")
    expect(plan.run.gate).toMatchObject({
      status: "ready",
      reason: null,
      fallback: null,
    })
    expect(plan.items.find((item) => item.id === "SW-1:implement")?.gate).toMatchObject({
      status: "ready",
      reason: null,
      fallback: "plan",
    })

    expect(DeliveryStore.updateRun("SW-1", { phase: "implement" })).toMatchObject({
      id: "SW-1",
      phase: "implement",
      status: "active",
    })
    expect(DeliveryStore.getItem("SW-1:implement")).toMatchObject({
      status: "ready",
      gate: {
        status: "pending",
        fallback: "plan",
      },
    })

    DeliveryStore.createDecision({
      id: "DE-1",
      kind: "scope_change",
      summary: "Approve a major implementation change",
      source: "conductor",
      status: "proposed",
      requires_user_confirmation: true,
      applies_to: ["SW-1", "SW-1:implement"],
      related_question_id: "OQ-1",
    })
    DeliveryStore.createQuestion({
      id: "OQ-1",
      title: "Approve the implementation shift",
      context: "The current phase needs user input",
      options: ["approve", "reject"],
      recommended_option: "approve",
      status: "waiting_user",
      deadline_policy: "manual",
      blocking: true,
      affects: ["SW-1", "SW-1:implement"],
      related_decision_id: "DE-1",
      raised_by: "conductor",
    })

    const blocked = DeliveryStore.evaluateRun("SW-1")
    const reason = String(blocked.run.gate.reason ?? "")
    const item_reason = String(blocked.items.find((item) => item.id === "SW-1:implement")?.gate.reason ?? "")
    expect(blocked.run).toMatchObject({
      status: "blocked",
      gate: {
        status: "blocked",
        reason: expect.stringContaining("Decision DE-1"),
        fallback: "plan",
      },
    })
    expect(reason).toContain("Question OQ-1")
    expect(item_reason).toContain("Question OQ-1")
    expect(() => DeliveryStore.updateRun("SW-1", { phase: "verify" })).toThrow("DeliveryGateError")

    DeliveryStore.updateDecision("DE-1", { status: "decided", decided_by: "user", decided_at: 42 })
    DeliveryStore.updateQuestion("OQ-1", { status: "answered" })
    DeliveryStore.updateQuestion("OQ-1", { status: "resolved" })
    step("SW-1:implement")

    const open = DeliveryStore.evaluateRun("SW-1")
    expect(open.run).toMatchObject({
      status: "active",
      gate: {
        status: "ready",
        reason: null,
        fallback: "plan",
      },
    })
    expect(DeliveryStore.updateRun("SW-1", { phase: "verify" })).toMatchObject({
      id: "SW-1",
      phase: "verify",
      status: "active",
    })
  })

  test("allows same-role scheduling adjustments without confirmation", () => {
    DeliveryStore.launch({
      id: "SW-1",
      goal: "Ship staged swarm delivery",
      owner_session_id: "SE-1",
    })

    const review = DeliveryStore.reviewAssignments({
      run_id: "SW-1",
      items: [
        {
          id: "SW-1:implement",
          owner_role_id: "builder",
          blocked_by: ["SW-1:plan", "SPEC-1"],
          scope: ["packages/opencode/src/delivery", "packages/opencode/test/storage"],
        },
      ],
    })

    expect(review).toEqual({ major: false, changes: [] })

    const out = DeliveryStore.assign({
      run_id: "SW-1",
      items: [
        {
          id: "SW-1:implement",
          owner_role_id: "builder",
          blocked_by: ["SW-1:plan", "SPEC-1"],
          scope: ["packages/opencode/src/delivery", "packages/opencode/test/storage"],
        },
      ],
    })

    expect(out.review).toEqual({ major: false, changes: [] })
    expect(DeliveryStore.getItem("SW-1:implement")).toMatchObject({
      owner_role_id: "builder",
      blocked_by: ["SW-1:plan", "SPEC-1"],
      scope: ["packages/opencode/src/delivery", "packages/opencode/test/storage"],
    })
  })

  test("pauses affected work items and syncs the linked decision when a question closes", () => {
    DeliveryStore.launch({
      id: "SW-1",
      goal: "Ship staged swarm delivery",
      owner_session_id: "SE-1",
    })

    const step = (id: string) => {
      DeliveryStore.updateItem(id, { status: "in_progress" })
      DeliveryStore.updateItem(id, { status: "verifying" })
      return DeliveryStore.updateItem(id, { status: "completed" })
    }

    step("SW-1:plan")
    DeliveryStore.updateRun("SW-1", { phase: "implement" })
    DeliveryStore.createDecision({
      id: "DE-1",
      kind: "scope_change",
      summary: "Need an answer before implementation continues",
      source: "conductor",
      status: "proposed",
      requires_user_confirmation: false,
      applies_to: ["SW-1", "SW-1:implement"],
      related_question_id: "OQ-1",
    })
    DeliveryStore.createQuestion({
      id: "OQ-1",
      title: "Clarify the implementation boundary",
      context: "The builder needs one final scope answer",
      options: ["ship_it", "revise_scope"],
      recommended_option: "ship_it",
      status: "open",
      deadline_policy: "manual",
      blocking: true,
      affects: ["SW-1", "SW-1:implement"],
      related_decision_id: "DE-1",
      raised_by: "conductor",
    })

    const blocked = DeliveryStore.evaluateRun("SW-1")
    expect(blocked.run.status).toBe("blocked")
    expect(DeliveryStore.getItem("SW-1:implement")).toMatchObject({
      status: "blocked",
    })

    DeliveryStore.updateQuestion("OQ-1", { status: "waiting_user" })
    DeliveryStore.updateQuestion("OQ-1", { status: "answered" })
    const out = DeliveryStore.updateQuestion("OQ-1", { status: "resolved" })

    expect(out).toMatchObject({
      id: "OQ-1",
      status: "resolved",
      blocking: false,
    })
    expect(DeliveryStore.getDecision("DE-1")).toMatchObject({
      status: "decided",
      decided_by: "system",
    })
    expect(DeliveryStore.evaluateRun("SW-1").run).toMatchObject({
      status: "active",
      gate: {
        status: "pending",
        reason: "Waiting for implement exit rules",
      },
    })
    expect(DeliveryStore.getItem("SW-1:implement")).toMatchObject({
      status: "ready",
    })
  })

  test("re-checks deferred questions when the related gate becomes current", () => {
    DeliveryStore.launch({
      id: "SW-1",
      goal: "Ship staged swarm delivery",
      owner_session_id: "SE-1",
    })

    const step = (id: string) => {
      DeliveryStore.updateItem(id, { status: "in_progress" })
      DeliveryStore.updateItem(id, { status: "verifying" })
      return DeliveryStore.updateItem(id, { status: "completed" })
    }

    step("SW-1:plan")
    DeliveryStore.updateRun("SW-1", { phase: "implement" })
    DeliveryStore.createDecision({
      id: "DE-1",
      kind: "scope_change",
      summary: "Revisit the verify gate boundary",
      source: "conductor",
      status: "proposed",
      requires_user_confirmation: false,
      applies_to: ["SW-1:verify"],
      related_question_id: "OQ-1",
    })
    DeliveryStore.createQuestion({
      id: "OQ-1",
      title: "Can verification wait until the next gate?",
      context: "The verifier can answer later without blocking implementation.",
      options: ["ship_it", "revise_scope"],
      recommended_option: "ship_it",
      status: "open",
      deadline_policy: "manual",
      blocking: false,
      affects: ["SW-1:verify"],
      related_decision_id: "DE-1",
      raised_by: "conductor",
    })

    DeliveryStore.updateQuestion("OQ-1", { status: "deferred" })

    expect(DeliveryStore.getDecision("DE-1")).toMatchObject({
      status: "superseded",
      decided_by: "system",
    })
    expect(DeliveryStore.evaluateRun("SW-1").run).toMatchObject({
      status: "active",
      gate: {
        status: "pending",
        reason: "Waiting for implement exit rules",
      },
    })

    step("SW-1:implement")
    DeliveryStore.updateRun("SW-1", { phase: "verify" })

    const blocked = DeliveryStore.evaluateRun("SW-1")
    expect(blocked.run).toMatchObject({
      status: "blocked",
      gate: {
        status: "blocked",
        reason: expect.stringContaining("Question OQ-1 is still deferred"),
      },
    })
    expect(DeliveryStore.getItem("SW-1:verify")).toMatchObject({
      status: "pending",
      gate: {
        status: "blocked",
        reason: expect.stringContaining("Question OQ-1 is still deferred"),
      },
    })
  })

  test("detects major role and owner assignment changes before applying them", () => {
    DeliveryStore.launch({
      id: "SW-1",
      goal: "Ship staged swarm delivery",
      owner_session_id: "SE-1",
    })

    const roles = DeliveryStore.listRoles()
    const next = [
      ...roles
        .filter((item) => item.role_id !== "reviewer")
        .map((item) => (item.role_id === "builder" ? { ...item, responsibility: "Own architecture changes" } : item)),
      {
        role_id: "architect",
        name: "Architect",
        responsibility: "Own architecture decisions",
        skills: ["design", "planning"],
        limits: ["no_force_push"],
        approval_required: true,
      },
    ]

    const review = DeliveryStore.reviewAssignments({
      run_id: "SW-1",
      roles: next,
      items: [{ id: "SW-1:implement", owner_role_id: "architect" }],
    })

    expect(review.major).toBe(true)
    expect(review.changes.map((item) => item.kind).toSorted()).toEqual([
      "owner_reassigned",
      "role_added",
      "role_removed",
      "role_responsibility_changed",
    ])
    expect(() =>
      DeliveryStore.assign({
        run_id: "SW-1",
        roles: next,
        items: [{ id: "SW-1:implement", owner_role_id: "architect" }],
      }),
    ).toThrow("DeliveryAssignmentError")
    expect(DeliveryStore.getItem("SW-1:implement").owner_role_id).toBe("builder")
    expect(DeliveryStore.getRole("builder").responsibility).toBe("Implements the approved delivery scope")
    expect(() => DeliveryStore.getRole("architect")).toThrow("NotFoundError")
  })

  test("creates confirmation-backed assignment records for major role changes", () => {
    DeliveryStore.launch({
      id: "SW-1",
      goal: "Ship staged swarm delivery",
      owner_session_id: "SE-1",
    })

    const roles = DeliveryStore.listRoles()
    const next = [
      ...roles
        .filter((item) => item.role_id !== "reviewer")
        .map((item) => (item.role_id === "builder" ? { ...item, responsibility: "Own architecture changes" } : item)),
      {
        role_id: "architect",
        name: "Architect",
        responsibility: "Own architecture decisions",
        skills: ["design", "planning"],
        limits: ["no_force_push"],
        approval_required: true,
      },
    ]

    const out = DeliveryStore.requestAssignment({
      run_id: "SW-1",
      roles: next,
      items: [{ id: "SW-1:implement", owner_role_id: "architect" }],
      decision_id: "DE-1",
      question_id: "OQ-1",
      reason: "Architecture work needs a dedicated owner",
      raised_by: "conductor",
    })

    const info = DeliveryStore.AssignmentQuestion.parse(JSON.parse(out.question.context))

    expect(out.review.major).toBe(true)
    expect(out.decision).toMatchObject({
      id: "DE-1",
      status: "proposed",
      requires_user_confirmation: true,
      related_question_id: "OQ-1",
    })
    expect(out.question).toMatchObject({
      id: "OQ-1",
      status: "waiting_user",
      recommended_option: "confirm",
      related_decision_id: "DE-1",
      blocking: true,
    })
    expect(info.reason).toBe("Architecture work needs a dedicated owner")
    expect(info.impact).toEqual([
      "Role builder would change responsibility",
      "Role reviewer would be removed from the assignment plan",
      "Role architect would be added to the assignment plan",
      "Work item SW-1:implement would move from builder to architect",
    ])
    expect(info.before.roles.find((item) => item.role_id === "builder")).toMatchObject({
      responsibility: "Implements the approved delivery scope",
    })
    expect(info.after.roles.find((item) => item.role_id === "architect")).toMatchObject({
      responsibility: "Own architecture decisions",
    })
    expect(info.before.items).toEqual([
      {
        id: "SW-1:implement",
        title: "Implement approved delivery scope",
        owner_role_id: "builder",
        blocked_by: ["SW-1:plan"],
        scope: ["Ship staged swarm delivery"],
      },
    ])
    expect(info.after.items).toEqual([
      {
        id: "SW-1:implement",
        title: "Implement approved delivery scope",
        owner_role_id: "architect",
        blocked_by: ["SW-1:plan"],
        scope: ["Ship staged swarm delivery"],
      },
    ])
    expect(DeliveryStore.getItem("SW-1:implement").owner_role_id).toBe("builder")
    expect(DeliveryStore.getRole("builder").responsibility).toBe("Implements the approved delivery scope")
    expect(() => DeliveryStore.getRole("architect")).toThrow("NotFoundError")

    const blocked = DeliveryStore.evaluateRun("SW-1")
    expect(blocked.run.status).toBe("blocked")
    expect(String(blocked.run.gate.reason)).toContain("Decision DE-1")
    expect(String(blocked.run.gate.reason)).toContain("Question OQ-1")
  })

  test("records structured proposal and consensus actions on a single decision", () => {
    DeliveryStore.launch({
      id: "SW-1",
      goal: "Ship staged swarm delivery",
      owner_session_id: "SE-1",
    })

    DeliveryStore.createDecision({
      id: "DE-1",
      kind: "scope_change",
      summary: "Pick the implementation outcome",
      source: "conductor",
      status: "proposed",
      requires_user_confirmation: false,
      applies_to: ["SW-1", "SW-1:implement"],
    })

    const proposal = DeliveryStore.recordDecision({
      decision_id: "DE-1",
      kind: "proposal",
      role: "planner",
      outcome: "ship_it",
      context: "The current scope is ready for consensus review",
      participants: ["planner", "builder", "verifier"],
      candidate_outcomes: ["ship_it", "revise_scope"],
      input_context: "The builder finished implementation and the verifier has not objected yet",
      created_at: 10,
    })

    expect(proposal).toMatchObject({
      id: "DE-1",
      participants: ["planner", "builder", "verifier"],
      candidate_outcomes: ["ship_it", "revise_scope"],
      input_context: "The builder finished implementation and the verifier has not objected yet",
      actions: [
        {
          kind: "proposal",
          role: "planner",
          outcome: "ship_it",
          context: "The current scope is ready for consensus review",
          created_at: 10,
        },
      ],
    })

    const out = [
      {
        kind: "review" as const,
        role: "builder",
        outcome: "ship_it",
        context: "Implementation scope matches the original plan",
        created_at: 11,
      },
      {
        kind: "objection" as const,
        role: "verifier",
        outcome: "revise_scope",
        context: "Verification needs rollback notes before approval",
        created_at: 12,
      },
      {
        kind: "decision" as const,
        role: "conductor",
        outcome: "revise_scope",
        context: "The objection is valid, so the decision stays blocked pending revision",
        created_at: 13,
      },
    ].reduce((row, item) => DeliveryStore.recordDecision({ decision_id: row.id, ...item }), proposal)

    expect(out).toMatchObject({
      id: "DE-1",
      status: "decided",
      decided_by: "conductor",
      decided_at: 13,
    })
    expect(out.actions).toEqual([
      {
        kind: "proposal",
        role: "planner",
        outcome: "ship_it",
        context: "The current scope is ready for consensus review",
        created_at: 10,
      },
      {
        kind: "review",
        role: "builder",
        outcome: "ship_it",
        context: "Implementation scope matches the original plan",
        created_at: 11,
      },
      {
        kind: "objection",
        role: "verifier",
        outcome: "revise_scope",
        context: "Verification needs rollback notes before approval",
        created_at: 12,
      },
      {
        kind: "decision",
        role: "conductor",
        outcome: "revise_scope",
        context: JSON.stringify(
          {
            reason: "The objection is valid, so the decision stays blocked pending revision",
            updates: [
              {
                target: "SW-1",
                detail: "Refreshed SW-1 after decision resolved as revise_scope",
              },
              {
                target: "SW-1:implement",
                detail: "Refreshed SW-1:implement after decision resolved as revise_scope",
              },
            ],
          },
          null,
          2,
        ),
        created_at: 13,
      },
    ])

    expect(() =>
      DeliveryStore.recordDecision({
        decision_id: "DE-404",
        kind: "review",
        role: "builder",
        outcome: "ship_it",
        context: "No decision exists for this review",
      }),
    ).toThrow("NotFoundError")
  })

  test("auto-resolves a decision when required participants align", () => {
    DeliveryStore.launch({
      id: "SW-1",
      goal: "Ship staged swarm delivery",
      owner_session_id: "SE-1",
    })

    DeliveryStore.createDecision({
      id: "DE-1",
      kind: "scope_change",
      summary: "Pick the implementation outcome",
      source: "conductor",
      status: "proposed",
      requires_user_confirmation: false,
      applies_to: ["SW-1", "SW-1:implement"],
    })

    DeliveryStore.recordDecision({
      decision_id: "DE-1",
      kind: "proposal",
      role: "planner",
      outcome: "ship_it",
      context: "The current scope is ready for consensus review",
      participants: ["planner", "builder", "verifier"],
      candidate_outcomes: ["ship_it", "revise_scope"],
      input_context: "The builder finished implementation and the verifier has not objected yet",
      created_at: 10,
    })

    DeliveryStore.recordDecision({
      decision_id: "DE-1",
      kind: "review",
      role: "builder",
      outcome: "ship_it",
      context: "Implementation scope matches the original plan",
      created_at: 11,
    })

    const out = DeliveryStore.recordDecision({
      decision_id: "DE-1",
      kind: "review",
      role: "verifier",
      outcome: "ship_it",
      context: "Verification agrees with the current scope",
      created_at: 12,
    })

    expect(out).toMatchObject({
      id: "DE-1",
      status: "decided",
      decided_by: "system",
      decided_at: 12,
    })
    expect(out.actions).toEqual([
      {
        kind: "proposal",
        role: "planner",
        outcome: "ship_it",
        context: "The current scope is ready for consensus review",
        created_at: 10,
      },
      {
        kind: "review",
        role: "builder",
        outcome: "ship_it",
        context: "Implementation scope matches the original plan",
        created_at: 11,
      },
      {
        kind: "review",
        role: "verifier",
        outcome: "ship_it",
        context: "Verification agrees with the current scope",
        created_at: 12,
      },
      {
        kind: "decision",
        role: "system",
        outcome: "ship_it",
        context: JSON.stringify(
          {
            reason: "Consensus reached after 3 aligned inputs on ship_it",
            updates: [
              {
                target: "SW-1",
                detail: "Refreshed SW-1 after decision resolved as ship_it",
              },
              {
                target: "SW-1:implement",
                detail: "Refreshed SW-1:implement after decision resolved as ship_it",
              },
            ],
          },
          null,
          2,
        ),
        created_at: 12,
      },
    ])
  })

  test("applies confirmed role reassignments through the linked decision", () => {
    DeliveryStore.launch({
      id: "SW-1",
      goal: "Ship staged swarm delivery",
      owner_session_id: "SE-1",
    })

    DeliveryStore.requestAssignment({
      run_id: "SW-1",
      items: [{ id: "SW-1:implement", owner_role_id: "shipper" }],
      decision_id: "DE-1",
      question_id: "OQ-1",
      reason: "The shipper should own the implementation handoff",
      raised_by: "conductor",
    })

    const out = DeliveryStore.resolveAssignment({
      decision_id: "DE-1",
      answer: "confirm",
      decided_by: "user",
      decided_at: 42,
    })

    expect(out.decision).toMatchObject({
      id: "DE-1",
      status: "decided",
      decided_by: "user",
      decided_at: 42,
    })
    expect(out.question).toMatchObject({
      id: "OQ-1",
      status: "resolved",
      blocking: false,
    })
    expect(DeliveryStore.getItem("SW-1:implement")).toMatchObject({
      owner_role_id: "shipper",
    })
    expect(DeliveryStore.evaluateRun("SW-1").run).toMatchObject({
      status: "active",
      gate: {
        status: "pending",
        reason: "Waiting for plan exit rules",
      },
    })
  })

  test("keeps role assignments unchanged when the linked decision is rejected", () => {
    DeliveryStore.launch({
      id: "SW-1",
      goal: "Ship staged swarm delivery",
      owner_session_id: "SE-1",
    })

    DeliveryStore.requestAssignment({
      run_id: "SW-1",
      items: [{ id: "SW-1:implement", owner_role_id: "shipper" }],
      decision_id: "DE-1",
      question_id: "OQ-1",
      reason: "The shipper should own the implementation handoff",
      raised_by: "conductor",
      recommended_option: "reject",
    })

    const out = DeliveryStore.resolveAssignment({
      decision_id: "DE-1",
      answer: "reject",
      decided_by: "user",
      decided_at: 84,
    })

    expect(out.decision).toMatchObject({
      id: "DE-1",
      status: "cancelled",
      decided_by: "user",
      decided_at: 84,
    })
    expect(out.question).toMatchObject({
      id: "OQ-1",
      status: "resolved",
      blocking: false,
    })
    expect(DeliveryStore.getItem("SW-1:implement")).toMatchObject({
      owner_role_id: "builder",
    })
  })
})
