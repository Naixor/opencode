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
        audit: [
          {
            kind: "phase",
            phase: "plan",
            status: "active",
            gate: Delivery.gate("plan"),
            created_at: 20,
          },
          {
            kind: "assignment",
            run_id: "SR-1",
            item_ids: ["WI-1"],
            role_ids: ["builder"],
            summary: "Updated assignment plan for SR-1",
            created_at: 21,
          },
          {
            kind: "decision",
            decision_id: "DE-1",
            status: "proposed",
            summary: "Approve role reassignment",
            outcome: "approve",
            applies_to: ["SR-1", "WI-1"],
            created_at: 22,
          },
          {
            kind: "question",
            question_id: "OQ-1",
            status: "waiting_user",
            blocking: true,
            summary: "Need role approval",
            affects: ["WI-1", "SR-1"],
            created_at: 23,
          },
          {
            kind: "verification",
            item_id: "WI-1",
            phase: "implement",
            verification: {
              status: "passed",
              required: true,
              commands: ["bun run typecheck", "bun run build"],
              result: "build passed",
              updated_at: 24,
            },
            created_at: 24,
          },
          {
            kind: "commit",
            item_id: "WI-1",
            commit: {
              status: "committed",
              staged_scope: ["packages/opencode/src/delivery/store.ts"],
              proof: {
                status: "passed",
                required: true,
                commands: ["bun run typecheck", "bun run build"],
                result: "build passed",
                updated_at: 21,
              },
              hash: "abc1234",
              message: "feat: ship delivery schema",
              recorded_at: 25,
            },
            created_at: 25,
          },
          {
            kind: "retrospective",
            outcome: "completed",
            summary: "Delivery finished cleanly and produced one reusable workflow memory.",
            memory_ids: ["memory_1"],
            created_at: 26,
          },
        ],
        retrospective: {
          summary: "Delivery finished cleanly and produced one reusable workflow memory.",
          outcome: "completed",
          work_items: [
            {
              id: "WI-1",
              title: "Ship the delivery schema",
              phase: "implement",
              status: "ready",
              owner_role_id: "builder",
            },
          ],
          decisions: [
            {
              id: "DE-1",
              kind: "role_change",
              status: "proposed",
              summary: "Approve role reassignment",
              question_id: "OQ-1",
              requires_user_confirmation: true,
            },
          ],
          verification: [
            {
              item_id: "WI-1",
              phase: "implement",
              status: "passed",
              result: "typecheck passed",
              required: true,
              updated_at: 42,
            },
          ],
          failures: [],
          escalations: [
            {
              summary: "No escalation was required.",
              related_ids: [],
            },
          ],
          collaboration_issues: [
            {
              summary: "Confirmation remained pending until the final review.",
              related_ids: ["DE-1", "OQ-1"],
            },
          ],
          memories: [
            {
              content: "Delivery retrospective should record durable workflow lessons after final verification.",
              categories: ["workflow"],
              tags: ["delivery", "retrospective"],
              citations: ["swarm_run:SR-1"],
              impact: "low",
              status: "written",
              memory_id: "memory_1",
              reason: null,
            },
          ],
          created_at: 26,
        },
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
        checkpoint: {
          last_successful_phase: "implement",
          verification_result: "typecheck passed",
          produced_files: ["packages/opencode/src/delivery/store.ts"],
          pending_actions: ["Run bun test"],
          rollback_suggestions: ["Revert the delivery store change if regressions appear"],
          destructive_cleanup_allowed: false,
          cleanup_decision_id: null,
          updated_at: 42,
        },
        commit: {
          status: "committed",
          staged_scope: ["packages/opencode/src/delivery/store.ts"],
          proof: {
            status: "passed",
            required: true,
            commands: ["bun run typecheck", "bun run build"],
            result: "build passed",
            updated_at: 21,
          },
          hash: "abc1234",
          message: "feat: ship delivery schema",
          recorded_at: 22,
        },
        failure: {
          phase: "commit",
          result: "Pre-commit checks failed before the local commit step",
          verification: {
            status: "failed",
            required: true,
            commands: ["bun run typecheck", "bun run build"],
            result: "build failed",
            updated_at: 84,
          },
          produced_files: ["packages/opencode/src/delivery/store.ts"],
          pending_actions: ["Repair build failure"],
          rollback_suggestions: ["Keep the current worktree and inspect the failing build output"],
          destructive_cleanup_allowed: false,
          cleanup_decision_id: null,
          recorded_at: 85,
        },
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
      audit: [
        {
          kind: "phase",
          phase: "plan",
          status: "active",
          gate: Delivery.gate("plan"),
          created_at: 20,
        },
        {
          kind: "assignment",
          run_id: "SR-1",
          item_ids: ["WI-1"],
          role_ids: ["builder"],
          summary: "Updated assignment plan for SR-1",
          created_at: 21,
        },
        {
          kind: "decision",
          decision_id: "DE-1",
          status: "proposed",
          summary: "Approve role reassignment",
          outcome: "approve",
          applies_to: ["SR-1", "WI-1"],
          created_at: 22,
        },
        {
          kind: "question",
          question_id: "OQ-1",
          status: "waiting_user",
          blocking: true,
          summary: "Need role approval",
          affects: ["WI-1", "SR-1"],
          created_at: 23,
        },
        {
          kind: "verification",
          item_id: "WI-1",
          phase: "implement",
          verification: {
            status: "passed",
            required: true,
            commands: ["bun run typecheck", "bun run build"],
            result: "build passed",
            updated_at: 24,
          },
          created_at: 24,
        },
        {
          kind: "commit",
          item_id: "WI-1",
          commit: {
            status: "committed",
            staged_scope: ["packages/opencode/src/delivery/store.ts"],
            proof: {
              status: "passed",
              required: true,
              commands: ["bun run typecheck", "bun run build"],
              result: "build passed",
              updated_at: 21,
            },
            hash: "abc1234",
            message: "feat: ship delivery schema",
            recorded_at: 25,
          },
          created_at: 25,
        },
        {
          kind: "retrospective",
          outcome: "completed",
          summary: "Delivery finished cleanly and produced one reusable workflow memory.",
          memory_ids: ["memory_1"],
          created_at: 26,
        },
      ],
      retrospective: {
        summary: "Delivery finished cleanly and produced one reusable workflow memory.",
        outcome: "completed",
        work_items: [
          {
            id: "WI-1",
            title: "Ship the delivery schema",
            phase: "implement",
            status: "ready",
            owner_role_id: "builder",
          },
        ],
        decisions: [
          {
            id: "DE-1",
            kind: "role_change",
            status: "proposed",
            summary: "Approve role reassignment",
            question_id: "OQ-1",
            requires_user_confirmation: true,
          },
        ],
        verification: [
          {
            item_id: "WI-1",
            phase: "implement",
            status: "passed",
            result: "typecheck passed",
            required: true,
            updated_at: 42,
          },
        ],
        failures: [],
        escalations: [
          {
            summary: "No escalation was required.",
            related_ids: [],
          },
        ],
        collaboration_issues: [
          {
            summary: "Confirmation remained pending until the final review.",
            related_ids: ["DE-1", "OQ-1"],
          },
        ],
        memories: [
          {
            content: "Delivery retrospective should record durable workflow lessons after final verification.",
            categories: ["workflow"],
            tags: ["delivery", "retrospective"],
            citations: ["swarm_run:SR-1"],
            impact: "low",
            status: "written",
            memory_id: "memory_1",
            reason: null,
          },
        ],
        created_at: 26,
      },
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
      checkpoint: {
        last_successful_phase: "implement",
        verification_result: "typecheck passed",
        produced_files: ["packages/opencode/src/delivery/store.ts"],
        pending_actions: ["Run bun test"],
        rollback_suggestions: ["Revert the delivery store change if regressions appear"],
        destructive_cleanup_allowed: false,
        cleanup_decision_id: null,
        updated_at: 42,
      },
      commit: {
        status: "committed",
        staged_scope: ["packages/opencode/src/delivery/store.ts"],
        proof: {
          status: "passed",
          required: true,
          commands: ["bun run typecheck", "bun run build"],
          result: "build passed",
          updated_at: 21,
        },
        hash: "abc1234",
        message: "feat: ship delivery schema",
        recorded_at: 22,
      },
      failure: {
        phase: "commit",
        result: "Pre-commit checks failed before the local commit step",
        verification: {
          status: "failed",
          required: true,
          commands: ["bun run typecheck", "bun run build"],
          result: "build failed",
          updated_at: 84,
        },
        produced_files: ["packages/opencode/src/delivery/store.ts"],
        pending_actions: ["Repair build failure"],
        rollback_suggestions: ["Keep the current worktree and inspect the failing build output"],
        destructive_cleanup_allowed: false,
        cleanup_decision_id: null,
        recorded_at: 85,
      },
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
      "audit",
      "retrospective",
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
      "checkpoint",
      "failure",
      "commit",
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
    expect(
      Delivery.Checkpoint.safeParse({
        last_successful_phase: "verify",
        verification_result: "bun test passed",
        produced_files: ["packages/opencode/src/delivery/store.ts"],
        pending_actions: ["Create local commit"],
        rollback_suggestions: ["Leave the current worktree intact until cleanup is approved"],
        destructive_cleanup_allowed: false,
        cleanup_decision_id: null,
        updated_at: Date.now(),
      }).success,
    ).toBe(true)
    expect(
      Delivery.Failure.safeParse({
        phase: "commit",
        result: "Pre-commit checks failed",
        verification: {
          status: "failed",
          required: true,
          commands: ["bun run build"],
          result: "build failed",
          updated_at: Date.now(),
        },
        produced_files: ["packages/opencode/src/delivery/store.ts"],
        pending_actions: ["Fix the build"],
        rollback_suggestions: ["Do not clean the worktree without approval"],
        destructive_cleanup_allowed: false,
        cleanup_decision_id: null,
        recorded_at: Date.now(),
      }).success,
    ).toBe(true)
    expect(
      Delivery.Commit.safeParse({
        status: "committed",
        staged_scope: ["packages/opencode/src/delivery/store.ts"],
        proof: {
          status: "passed",
          required: true,
          commands: ["bun run typecheck", "bun run build", "bun test"],
          result: "bun test passed",
          updated_at: Date.now(),
        },
        hash: "abc1234",
        message: "feat: US-015 - Execute local commit phase with audit writeback",
        recorded_at: Date.now(),
      }).success,
    ).toBe(true)
    expect(
      Delivery.AuditEvent.safeParse({
        kind: "retrospective",
        outcome: "completed",
        summary: "Delivery finished cleanly and produced one reusable workflow memory.",
        memory_ids: ["memory_1"],
        created_at: Date.now(),
      }).success,
    ).toBe(true)
    expect(
      Delivery.Retrospective.safeParse({
        summary: "Delivery finished cleanly and produced one reusable workflow memory.",
        outcome: "completed",
        work_items: [
          {
            id: "WI-1",
            title: "Ship the delivery schema",
            phase: "implement",
            status: "completed",
            owner_role_id: "builder",
          },
        ],
        decisions: [
          {
            id: "DE-1",
            kind: "role_change",
            status: "decided",
            summary: "Approve role reassignment",
            question_id: "OQ-1",
            requires_user_confirmation: true,
          },
        ],
        verification: [
          {
            item_id: "WI-1",
            phase: "implement",
            status: "passed",
            result: "build passed",
            required: true,
            updated_at: Date.now(),
          },
        ],
        failures: [
          {
            item_id: "WI-1",
            phase: "commit",
            result: "Pre-commit checks failed",
          },
        ],
        escalations: [
          {
            summary: "Escalated one blocking review item.",
            related_ids: ["DE-1"],
          },
        ],
        collaboration_issues: [
          {
            summary: "The handoff needed one extra clarification cycle.",
            related_ids: ["OQ-1"],
          },
        ],
        memories: [
          {
            content: "Record delivery retrospectives before marking a run complete.",
            categories: ["workflow"],
            tags: ["delivery", "retrospective"],
            citations: ["swarm_run:SW-1"],
            impact: "low",
            status: "written",
            memory_id: "memory_1",
            reason: null,
          },
        ],
        created_at: Date.now(),
      }).success,
    ).toBe(true)
    expect(
      Delivery.AuditEvent.safeParse({
        kind: "commit",
        item_id: "SW-1:commit",
        commit: {
          status: "committed",
          staged_scope: ["packages/opencode/src/delivery/store.ts"],
          proof: {
            status: "passed",
            required: true,
            commands: ["bun run typecheck", "bun run build", "bun test"],
            result: "bun test passed",
            updated_at: Date.now(),
          },
          hash: "abc1234",
          message: "feat: US-015 - Execute local commit phase with audit writeback",
          recorded_at: Date.now(),
        },
        created_at: Date.now(),
      }).success,
    ).toBe(true)
    expect(Delivery.canTransitionVerification("pending", "running")).toBe(true)
    expect(Delivery.canTransitionVerification("running", "pending")).toBe(true)
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
