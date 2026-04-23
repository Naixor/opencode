import { describe, expect, test } from "bun:test"
import {
  WorkflowAgentStatus,
  WorkflowPhaseStatus,
  WorkflowProgress,
  WorkflowProgressV1VersionValue,
  WorkflowProgressV2VersionValue,
  WorkflowProgressKey,
  WorkflowProgressStatus,
  WorkflowProgressWorkflowTargetId,
  WorkflowProgressTransitionLevel,
  WorkflowProgressTransitionRecord,
  WorkflowProgressV2,
  WorkflowRoundStatus,
  WorkflowStepKind,
  coerceWorkflowProgress,
  WorkflowProgressMachineMetadata,
  WorkflowProgressParticipantMetadata,
  WorkflowProgressWorkflowMetadata,
  WorkflowStatusUpdateInput,
  WorkflowStatus,
  WorkflowStepStatus,
  mergeWorkflowProgress,
  normalizeWorkflowMetadata,
  normalizeWorkflowProgressInput,
  parseWorkflowProgress,
  readWorkflowProgress,
  validateWorkflowMetadata,
  workflowDisplayStatus,
  type WorkflowProgress as WorkflowProgressShape,
} from "./index"
import {
  normalizeWorkflowProjectionInput,
  workflowfallback,
  workflowicon,
  workflowproject,
  workflowview,
  type WorkflowProjection,
} from "./presentation"
import { externalexample } from "./example"

function sourcekey(input?: {
  type?: string
  id?: string
  label?: string
  name?: string
  role?: string
  participant_id?: string
  step_id?: string
  run_id?: string
}) {
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

function historyid(input: {
  level: "workflow" | "step"
  target_id: string
  run_id?: string
  from_state?: string
  to_state: string
  timestamp?: string
  reason?: string
  source?: {
    type?: string
    id?: string
    label?: string
    name?: string
    role?: string
    participant_id?: string
    step_id?: string
    run_id?: string
  }
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

describe("workflow progress schema", () => {
  test("parses a minimal valid payload", () => {
    const val = WorkflowProgress.parse({
      version: "workflow-progress.v1",
      workflow: {
        status: "running",
      },
    })

    expect(val).toEqual({
      version: "workflow-progress.v1",
      workflow: {
        status: "running",
      },
    })
  })

  test("parses the full shared state machine schema", () => {
    const expected: WorkflowProgressShape = {
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
        name: "implement",
        label: "Implement workflow",
        summary: "Ship workflow visibility",
        input: "tasks/prds/prd-workflow-tui-workflow-agent.md",
        started_at: "2026-04-22T10:00:00.000Z",
      },
      phase: {
        status: "active",
        key: "planning",
        label: "Planning",
        summary: "Review the active story",
      },
      round: {
        status: "active",
        current: 1,
        max: 3,
        label: "Round 1 of 3",
        summary: "First implementation pass",
      },
      machine: {
        id: "implement-1",
        key: "implement",
        label: "Implement machine",
        summary: "Workflow state machine",
        root_step_id: "convert",
        active_step_id: "implement",
        active_run_id: "run-2",
        started_at: "2026-04-22T10:00:00.000Z",
        updated_at: "2026-04-22T10:05:00.000Z",
      },
      step_definitions: [
        {
          id: "convert",
          kind: "task",
          label: "Convert backlog",
          next: ["implement"],
        },
        {
          id: "implement",
          kind: "group",
          label: "Implement story",
          children: ["review", "verify"],
        },
        {
          id: "review",
          kind: "decision",
          parent_id: "implement",
          label: "Review gate",
        },
        {
          id: "verify",
          kind: "wait",
          parent_id: "implement",
          label: "Wait for verify",
        },
        {
          id: "done",
          kind: "terminal",
          label: "Done",
        },
      ],
      step_runs: [
        {
          id: "run-1",
          seq: 0,
          step_id: "convert",
          status: "completed",
          label: "Convert backlog",
          started_at: "2026-04-22T10:00:00.000Z",
          ended_at: "2026-04-22T10:01:00.000Z",
          actor: {
            name: "sisyphus",
            role: "implementer",
            status: "completed",
          },
          round: {
            current: 1,
            max: 3,
            label: "Round 1",
          },
        },
        {
          id: "run-2",
          seq: 1,
          step_id: "implement",
          status: "retrying",
          label: "Implement story",
          reason: "Address review feedback",
          started_at: "2026-04-22T10:02:00.000Z",
          parent_run_id: "run-1",
          round: {
            current: 1,
            max: 3,
          },
          retry: {
            current: 2,
            label: "Retry 2",
          },
          actor: {
            id: "agent-1",
            name: "sisyphus",
            role: "implementer",
            status: "running",
            summary: "Editing shared schema",
            updated_at: "2026-04-22T10:05:00.000Z",
          },
        },
      ],
      transitions: [
        {
          id: "workflow:workflow::0",
          seq: 0,
          timestamp: "2026-04-22T10:00:00.000Z",
          level: "workflow",
          target_id: WorkflowProgressWorkflowTargetId,
          to_state: "running",
          source: {
            type: "workflow",
            id: "implement",
          },
        },
        {
          id: "trans-2",
          seq: 1,
          timestamp: "2026-04-22T10:02:00.000Z",
          level: "step",
          target_id: "implement",
          run_id: "run-2",
          from_state: "active",
          to_state: "retrying",
          reason: "Address review feedback",
          source: {
            type: "agent",
            id: "agent-1",
            name: "sisyphus",
            participant_id: "agent-1",
            step_id: "implement",
            run_id: "run-2",
          },
        },
      ],
      steps: [
        {
          id: "inspect",
          status: "completed",
          label: "Inspect context",
          summary: "Read the PRD and backlog",
        },
        {
          id: "implement",
          status: "active",
          label: "Implement story",
          reason: "Editing shared schema",
        },
      ],
      agents: [
        {
          id: "agent-1",
          name: "sisyphus",
          role: "implementer",
          status: "running",
          summary: "Defining workflow schema",
          updated_at: "2026-04-22T10:05:00.000Z",
          round: 1,
        },
      ],
      participants: [
        {
          id: "agent-1",
          name: "sisyphus",
          role: "implementer",
          status: "running",
          summary: "Editing shared schema",
          updated_at: "2026-04-22T10:05:00.000Z",
          round: 1,
          step_id: "implement",
          run_id: "run-2",
        },
      ],
    }

    expect(WorkflowProgress.parse(expected)).toEqual(expected)
  })

  test("exports metadata aliases for external workflow emitters", () => {
    expect(WorkflowProgressWorkflowMetadata.parse({ status: "running", name: "demo" })).toEqual({
      status: "running",
      name: "demo",
    })

    expect(WorkflowProgressMachineMetadata.parse({ active_step_id: "plan", active_run_id: "run-1" })).toEqual({
      active_step_id: "plan",
      active_run_id: "run-1",
    })

    expect(WorkflowProgressParticipantMetadata.parse({ id: "agent-1", run_id: "run-1" })).toEqual({
      id: "agent-1",
      run_id: "run-1",
    })

    expect(
      WorkflowProgressTransitionRecord.parse({
        id: "trans-1",
        seq: 1,
        level: "step",
        target_id: "plan",
        run_id: "run-1",
        to_state: "active",
      }),
    ).toEqual({
      id: "trans-1",
      seq: 1,
      level: "step",
      target_id: "plan",
      run_id: "run-1",
      to_state: "active",
    })
  })

  test("runs the external adoption example through the shared reducer", () => {
    const demo = externalexample()

    expect(demo.updates).toHaveLength(3)
    expect(demo.progress).toMatchObject({
      version: "workflow-progress.v2",
      workflow: { status: "done", label: "External adoption" },
    })
    expect(demo.normalized.machine).toMatchObject({ title: "External machine" })
    expect(demo.projection.header).toEqual({
      title: "External adoption",
      status: "done",
      phase: "Done",
      round: "Round 1/1",
      summary: "External workflow using the shared contract",
      started_at: "2026-04-24T10:00:00.000Z",
    })
    expect(demo.projection.timeline).toEqual([
      expect.objectContaining({ label: "Done", kind: "terminal", active: true }),
    ])
    expect(demo.projection.history[0]).toMatchObject({ label: "External adoption", to_state: "done" })
    expect(demo.projection.agents[0]).toMatchObject({ name: "external-bot", status: "completed" })
    expect(demo.metadata[WorkflowProgressKey]).toEqual(demo.progress)
  })

  test("uses section-specific normalized status enums", () => {
    expect(Array.from(WorkflowProgressStatus.options).join(",")).toBe(
      ["pending", "active", "completed", "waiting", "blocked", "failed", "retrying", "running", "done"].join(","),
    )
    expect(Array.from(WorkflowStatus.options).join(",")).toBe(
      ["pending", "running", "waiting", "blocked", "failed", "retrying", "done"].join(","),
    )
    expect(Array.from(WorkflowPhaseStatus.options).join(",")).toBe(
      ["pending", "active", "completed", "waiting", "blocked", "failed", "retrying"].join(","),
    )
    expect(Array.from(WorkflowRoundStatus.options).join(",")).toBe(
      ["pending", "active", "completed", "waiting", "blocked", "failed", "retrying"].join(","),
    )
    expect(Array.from(WorkflowStepStatus.options).join(",")).toBe(
      ["pending", "active", "completed", "waiting", "blocked", "failed", "retrying"].join(","),
    )
    expect(Array.from(WorkflowAgentStatus.options).join(",")).toBe(
      ["pending", "running", "completed", "waiting", "blocked", "failed", "retrying"].join(","),
    )
    expect(Array.from(WorkflowStepKind.options).join(",")).toBe(
      ["task", "group", "wait", "decision", "terminal"].join(","),
    )
    expect(Array.from(WorkflowProgressTransitionLevel.options).join(",")).toBe(["workflow", "step"].join(","))
  })

  test("rejects payloads missing version", () => {
    const out = WorkflowProgress.safeParse({
      workflow: {
        status: "running",
      },
    })

    expect(out.success).toBe(false)
    if (out.success) throw new Error("expected parse failure")
    expect(out.error.issues.some((item) => item.path.join(".") === "version")).toBe(true)
  })

  test("rejects payloads missing workflow.status", () => {
    const out = WorkflowProgress.safeParse({
      version: "workflow-progress.v1",
      workflow: {},
    })

    expect(out.success).toBe(false)
    if (out.success) throw new Error("expected parse failure")
    expect(out.error.issues.some((item) => item.path.join(".") === "workflow.status")).toBe(true)
  })

  test("rejects invalid status values", () => {
    const out = WorkflowProgress.safeParse({
      version: "workflow-progress.v1",
      workflow: {
        status: "invalid",
      },
    })

    expect(out.success).toBe(false)
    if (out.success) throw new Error("expected parse failure")
    expect(out.error.issues.some((item) => item.path.join(".") === "workflow.status")).toBe(true)
  })

  test("ignores unknown keys for forward compatibility", () => {
    const out = WorkflowProgress.safeParse({
      version: "workflow-progress.v1",
      workflow: {
        status: "running",
        summry: "typo",
      },
    })

    expect(out.success).toBe(true)
    if (!out.success) throw new Error("expected parse success")
    expect(out.data).toEqual({
      version: "workflow-progress.v1",
      workflow: {
        status: "running",
      },
    })
  })

  test("rejects semantically invalid section states", () => {
    const out = WorkflowProgress.safeParse({
      version: "workflow-progress.v1",
      workflow: {
        status: "done",
      },
      phase: {
        status: "running",
      },
    })

    expect(out.success).toBe(false)
    if (out.success) throw new Error("expected parse failure")
    expect(out.error.issues.some((item) => item.path.join(".") === "phase.status")).toBe(true)
  })

  test("rejects transition states that do not match their level", () => {
    const workflow = WorkflowProgressV2.safeParse({
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
      },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [
        {
          id: "trans-1",
          seq: 0,
          timestamp: "2026-04-22T10:00:00.000Z",
          level: "workflow",
          target_id: WorkflowProgressWorkflowTargetId,
          to_state: "active",
        },
      ],
      participants: [],
    })

    expect(workflow.success).toBe(false)
    if (workflow.success) throw new Error("expected parse failure")
    expect(workflow.error.issues.some((item) => item.path.join(".") === "transitions.0.to_state")).toBe(true)

    const step = WorkflowProgressV2.safeParse({
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
      },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [
        {
          id: "trans-1",
          seq: 0,
          timestamp: "2026-04-22T10:00:00.000Z",
          level: "step",
          target_id: "implement",
          run_id: "run-1",
          to_state: "done",
        },
      ],
      participants: [],
    })

    expect(step.success).toBe(false)
    if (step.success) throw new Error("expected parse failure")
    expect(step.error.issues.some((item) => item.path.join(".") === "transitions.0.to_state")).toBe(true)
  })

  test("rejects unresolved v2 state-machine references", () => {
    const out = WorkflowProgressV2.safeParse({
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
        name: "implement",
      },
      machine: {
        root_step_id: "missing-root",
        active_step_id: "implement",
        active_run_id: "run-2",
      },
      step_definitions: [
        {
          id: "implement",
          kind: "task",
          next: ["missing-next"],
        },
      ],
      step_runs: [
        {
          id: "run-1",
          seq: 0,
          step_id: "missing-step",
          status: "active",
          parent_run_id: "missing-parent",
        },
        {
          id: "run-2",
          seq: 1,
          step_id: "implement",
          status: "active",
        },
      ],
      transitions: [
        {
          id: "trans-1",
          seq: 0,
          timestamp: "2026-04-22T10:00:00.000Z",
          level: "step",
          target_id: "missing-step",
          run_id: "run-2",
          to_state: "active",
        },
        {
          id: "trans-2",
          seq: 1,
          timestamp: "2026-04-22T10:00:01.000Z",
          level: "workflow",
          target_id: "missing-machine",
          to_state: "running",
        },
      ],
      participants: [
        {
          id: "agent-1",
          run_id: "missing-run",
          step_id: "missing-step",
        },
      ],
    })

    expect(out.success).toBe(false)
    if (out.success) throw new Error("expected parse failure")
    expect(out.error.issues.some((item) => item.path.join(".") === "machine.root_step_id")).toBe(true)
    expect(out.error.issues.some((item) => item.path.join(".") === "step_definitions.0.next.0")).toBe(true)
    expect(out.error.issues.some((item) => item.path.join(".") === "step_runs.0.step_id")).toBe(true)
    expect(out.error.issues.some((item) => item.path.join(".") === "step_runs.0.parent_run_id")).toBe(true)
    expect(out.error.issues.some((item) => item.path.join(".") === "transitions.0.target_id")).toBe(true)
    expect(out.error.issues.some((item) => item.path.join(".") === "transitions.0.run_id")).toBe(true)
    expect(out.error.issues.some((item) => item.path.join(".") === "transitions.1.target_id")).toBe(true)
    expect(out.error.issues.some((item) => item.path.join(".") === "participants.0.step_id")).toBe(true)
    expect(out.error.issues.some((item) => item.path.join(".") === "participants.0.run_id")).toBe(true)
  })

  test("accepts participant metadata in v2 payloads", () => {
    const out = WorkflowProgressV2.parse({
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
        name: "implement",
      },
      machine: {
        id: "implement",
        active_step_id: "plan",
        active_run_id: "run-1",
      },
      step_definitions: [{ id: "plan", kind: "task" }],
      step_runs: [{ id: "run-1", seq: 0, step_id: "plan", status: "active" }],
      transitions: [
        { id: "trans-1", seq: 0, level: "workflow", target_id: WorkflowProgressWorkflowTargetId, to_state: "running" },
      ],
      participants: [
        {
          id: "agent-1",
          name: "sisyphus",
          role: "implementer",
          status: "running",
          step_id: "plan",
          run_id: "run-1",
        },
      ],
    })

    expect(out.participants).toEqual([
      {
        id: "agent-1",
        name: "sisyphus",
        role: "implementer",
        status: "running",
        step_id: "plan",
        run_id: "run-1",
      },
    ])
  })

  test("rejects step transitions whose target_id disagrees with their run", () => {
    const out = WorkflowProgressV2.safeParse({
      version: "workflow-progress.v2",
      workflow: { status: "running", name: "implement" },
      machine: { active_step_id: "review", active_run_id: "run-1" },
      step_definitions: [
        { id: "review", kind: "task" },
        { id: "verify", kind: "task" },
      ],
      step_runs: [{ id: "run-1", seq: 0, step_id: "review", status: "active" }],
      transitions: [
        {
          id: "trans-1",
          seq: 0,
          level: "step",
          target_id: "verify",
          run_id: "run-1",
          to_state: "active",
        },
      ],
      participants: [],
    })

    expect(out.success).toBe(false)
    if (out.success) throw new Error("expected parse failure")
    expect(out.error.issues.some((item) => item.path.join(".") === "transitions.0.run_id")).toBe(true)
  })

  test("rejects participants whose step_id disagrees with their run", () => {
    const out = WorkflowProgressV2.safeParse({
      version: "workflow-progress.v2",
      workflow: { status: "running", name: "implement" },
      machine: { active_step_id: "review", active_run_id: "run-1" },
      step_definitions: [
        { id: "review", kind: "task" },
        { id: "verify", kind: "task" },
      ],
      step_runs: [{ id: "run-1", seq: 0, step_id: "review", status: "active" }],
      transitions: [],
      participants: [
        {
          id: "agent-1",
          step_id: "verify",
          run_id: "run-1",
        },
      ],
    })

    expect(out.success).toBe(false)
    if (out.success) throw new Error("expected parse failure")
    expect(out.error.issues.some((item) => item.path.join(".") === "participants.0.run_id")).toBe(true)
  })

  test("rejects invalid step definition trees", () => {
    const out = WorkflowProgressV2.safeParse({
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
        name: "implement",
      },
      machine: {},
      step_definitions: [
        { id: "root", kind: "group", children: ["child", "child", "root"] },
        { id: "child", kind: "task", parent_id: "missing" },
        { id: "other", kind: "group" },
      ],
      step_runs: [],
      transitions: [],
      participants: [],
    })

    expect(out.success).toBe(false)
    if (out.success) throw new Error("expected parse failure")
    expect(out.error.issues.some((item) => item.path.join(".") === "step_definitions.0.children.1")).toBe(true)
    expect(out.error.issues.some((item) => item.path.join(".") === "step_definitions.0.children.2")).toBe(true)
    expect(out.error.issues.some((item) => item.path.join(".") === "step_definitions.0.children.0")).toBe(false)
    expect(out.error.issues.some((item) => item.path.join(".") === "step_definitions.1.parent_id")).toBe(true)
  })

  test("rejects duplicate and self-referential children on v2 step trees", () => {
    const out = WorkflowProgressV2.safeParse({
      version: "workflow-progress.v2",
      workflow: { status: "running", name: "demo" },
      machine: {},
      step_definitions: [
        { id: "root", kind: "group", children: ["child", "child", "root"] },
        { id: "child", kind: "task", parent_id: "other" },
        { id: "other", kind: "group" },
      ],
      step_runs: [],
      transitions: [],
      participants: [],
    })

    expect(out.success).toBe(false)
    if (out.success) throw new Error("expected parse failure")
    expect(out.error.issues.some((item) => item.path.join(".") === "step_definitions.0.children.0")).toBe(false)
    expect(out.error.issues.some((item) => item.path.join(".") === "step_definitions.0.children.1")).toBe(true)
    expect(out.error.issues.some((item) => item.path.join(".") === "step_definitions.0.children.2")).toBe(true)
    expect(out.error.issues.some((item) => item.path.join(".") === "step_definitions.1.parent_id")).toBe(false)
  })

  test("accepts transition source references when they resolve", () => {
    const out = WorkflowProgressV2.parse({
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
        name: "implement",
      },
      machine: {
        active_step_id: "plan",
        active_run_id: "run-1",
      },
      step_definitions: [{ id: "plan", kind: "task" }],
      step_runs: [{ id: "run-1", seq: 0, step_id: "plan", status: "active" }],
      transitions: [
        {
          id: "trans-1",
          seq: 0,
          level: "step",
          target_id: "plan",
          run_id: "run-1",
          to_state: "active",
          source: {
            type: "agent",
            participant_id: "agent-1",
            step_id: "plan",
            run_id: "run-1",
          },
        },
      ],
      participants: [
        {
          id: "agent-1",
          name: "sisyphus",
          step_id: "plan",
          run_id: "run-1",
        },
      ],
    })

    expect(out.transitions[0]?.source).toEqual({
      type: "agent",
      participant_id: "agent-1",
      step_id: "plan",
      run_id: "run-1",
    })
  })

  test("rejects unresolved transition source references", () => {
    const out = WorkflowProgressV2.safeParse({
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
        name: "implement",
      },
      machine: {
        active_step_id: "plan",
        active_run_id: "run-1",
      },
      step_definitions: [{ id: "plan", kind: "task" }],
      step_runs: [{ id: "run-1", seq: 0, step_id: "plan", status: "active" }],
      transitions: [
        {
          id: "trans-1",
          seq: 0,
          level: "step",
          target_id: "plan",
          run_id: "run-1",
          to_state: "active",
          source: {
            participant_id: "missing-agent",
            step_id: "missing-step",
            run_id: "missing-run",
          },
        },
      ],
      participants: [],
    })

    expect(out.success).toBe(false)
    if (out.success) throw new Error("expected parse failure")
    expect(out.error.issues.some((item) => item.path.join(".") === "transitions.0.source.participant_id")).toBe(true)
    expect(out.error.issues.some((item) => item.path.join(".") === "transitions.0.source.step_id")).toBe(true)
    expect(out.error.issues.some((item) => item.path.join(".") === "transitions.0.source.run_id")).toBe(true)
  })

  test("rejects cyclic v2 step definition parent chains", () => {
    const out = WorkflowProgressV2.safeParse({
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
        name: "implement",
      },
      machine: {
        active_step_id: "review",
      },
      step_definitions: [
        {
          id: "plan",
          kind: "group",
          parent_id: "review",
        },
        {
          id: "work",
          kind: "group",
          parent_id: "plan",
        },
        {
          id: "review",
          kind: "task",
          parent_id: "work",
        },
      ],
      step_runs: [],
      transitions: [],
      participants: [],
    })

    expect(out.success).toBe(false)
    if (out.success) throw new Error("expected parse failure")
    expect(out.error.issues.some((item) => item.path.join(".") === "step_definitions.0.parent_id")).toBe(true)
  })

  test("requires monotonic seq values for step runs and transitions", () => {
    const out = WorkflowProgressV2.safeParse({
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
        name: "implement",
      },
      machine: {
        id: "implement",
      },
      step_definitions: [{ id: "plan", kind: "task" }],
      step_runs: [
        { id: "run-1", seq: 1, step_id: "plan", status: "active" },
        { id: "run-2", seq: 1, step_id: "plan", status: "completed" },
      ],
      transitions: [
        { id: "trans-1", seq: 2, level: "workflow", target_id: WorkflowProgressWorkflowTargetId, to_state: "running" },
        { id: "trans-2", seq: 2, level: "workflow", target_id: WorkflowProgressWorkflowTargetId, to_state: "waiting" },
      ],
      participants: [],
    })

    expect(out.success).toBe(false)
    if (out.success) throw new Error("expected parse failure")
    expect(out.error.issues.some((item) => item.path.join(".") === "step_runs.1.seq")).toBe(true)
    expect(out.error.issues.some((item) => item.path.join(".") === "transitions.1.seq")).toBe(true)
  })

  test("normalizes and reads workflow progress metadata", () => {
    const meta = normalizeWorkflowMetadata({
      keep: true,
      [WorkflowProgressKey]: {
        version: "workflow-progress.v1",
        workflow: {
          status: "running",
        },
      },
    })

    expect(meta).toMatchObject({ keep: true })
    expect(meta?.[WorkflowProgressKey]).toEqual({
      version: "workflow-progress.v1",
      workflow: {
        status: "running",
      },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [],
      steps: [],
      agents: [],
      participants: [],
    })
    expect(readWorkflowProgress(meta)?.workflow.status).toBe("running")
  })

  test("reads v2 workflow progress metadata", () => {
    const meta = normalizeWorkflowMetadata({
      keep: true,
      [WorkflowProgressKey]: {
        version: "workflow-progress.v2",
        workflow: {
          status: "running",
        },
        machine: {},
        step_definitions: [],
        step_runs: [],
        transitions: [],
        participants: [],
      },
    })

    expect(meta).toMatchObject({ keep: true })
    expect(readWorkflowProgress(meta)).toEqual({
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
      },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [],
      steps: [],
      agents: [],
      participants: [],
    })
  })

  test("readWorkflowProgress normalizes v1 into the advertised read shape", () => {
    expect(
      readWorkflowProgress({
        [WorkflowProgressKey]: {
          version: "workflow-progress.v1",
          workflow: { status: "running", name: "demo" },
        },
      }),
    ).toEqual({
      version: "workflow-progress.v1",
      workflow: { status: "running", name: "demo" },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [],
      steps: [],
      agents: [],
      participants: [],
    })
  })

  test("rejects minimal v2 payloads at parse boundaries", () => {
    const raw = {
      version: "workflow-progress.v2",
      workflow: { status: "running", name: "demo" },
    }

    expect(WorkflowProgressV2.safeParse(raw).success).toBe(false)
    expect(parseWorkflowProgress(raw)).toBeUndefined()
    expect(() => validateWorkflowMetadata({ [WorkflowProgressKey]: raw })).toThrow()
  })

  test("validateWorkflowMetadata preserves v1 payload shape", () => {
    expect(
      validateWorkflowMetadata({
        [WorkflowProgressKey]: {
          version: "workflow-progress.v1",
          workflow: { status: "running", name: "demo" },
          phase: { status: "active", label: "Plan" },
        },
      }),
    ).toEqual({
      [WorkflowProgressKey]: {
        version: "workflow-progress.v1",
        workflow: { status: "running", name: "demo" },
        phase: { status: "active", label: "Plan" },
      },
    })
  })

  test("readWorkflowProgress preserves minimal v2 metadata", () => {
    expect(
      readWorkflowProgress({
        [WorkflowProgressKey]: {
          version: "workflow-progress.v2",
          workflow: { status: "running", name: "demo" },
        },
      }),
    ).toEqual({
      version: "workflow-progress.v2",
      workflow: { status: "running", name: "demo" },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [],
      steps: [],
      agents: [],
      participants: [],
    })
  })

  test("merges v2 progress while preserving run history and transition order", () => {
    expect(
      mergeWorkflowProgress(
        {
          version: "workflow-progress.v2",
          workflow: {
            status: "running",
            name: "implement",
            started_at: "2026-04-22T10:00:00.000Z",
          },
          machine: {
            id: "implement",
            active_step_id: "convert",
            active_run_id: "run-1",
            updated_at: "2026-04-22T10:00:00.000Z",
          },
          step_definitions: [
            { id: "convert", kind: "task", next: ["review"] },
            { id: "review", kind: "task" },
          ],
          step_runs: [
            { id: "run-1", seq: 0, step_id: "convert", status: "active", started_at: "2026-04-22T10:00:00.000Z" },
          ],
          transitions: [
            {
              id: "trans-1",
              seq: 0,
              timestamp: "2026-04-22T10:00:00.000Z",
              level: "workflow",
              target_id: WorkflowProgressWorkflowTargetId,
              to_state: "running",
            },
          ],
          participants: [],
        },
        {
          version: "workflow-progress.v2",
          workflow: {
            status: "done",
            name: "implement",
            ended_at: "2026-04-22T10:02:00.000Z",
          },
          machine: {
            id: "implement",
            active_step_id: "review",
            active_run_id: "run-2",
            updated_at: "2026-04-22T10:02:00.000Z",
          },
          step_definitions: [
            { id: "convert", kind: "task", next: ["review"] },
            { id: "review", kind: "task" },
          ],
          step_runs: [
            {
              id: "run-1",
              seq: 0,
              step_id: "convert",
              status: "completed",
              started_at: "2026-04-22T10:00:00.000Z",
              ended_at: "2026-04-22T10:01:00.000Z",
            },
            {
              id: "run-2",
              seq: 1,
              step_id: "review",
              status: "completed",
              started_at: "2026-04-22T10:01:00.000Z",
              ended_at: "2026-04-22T10:02:00.000Z",
              round: { current: 2 },
              retry: { current: 1 },
              actor: { id: "agent-1", name: "sisyphus" },
            },
          ],
          transitions: [],
          participants: [],
        },
      ),
    ).toEqual({
      version: "workflow-progress.v2",
      workflow: {
        status: "done",
        name: "implement",
        started_at: "2026-04-22T10:00:00.000Z",
        ended_at: "2026-04-22T10:02:00.000Z",
      },
      machine: {
        id: "implement",
        active_step_id: "review",
        active_run_id: "run-2",
        updated_at: "2026-04-22T10:02:00.000Z",
      },
      step_definitions: [
        { id: "convert", kind: "task", next: ["review"] },
        { id: "review", kind: "task" },
      ],
      step_runs: [
        {
          id: "run-1",
          seq: 0,
          step_id: "convert",
          status: "completed",
          started_at: "2026-04-22T10:00:00.000Z",
          ended_at: "2026-04-22T10:01:00.000Z",
        },
        {
          id: "run-2",
          seq: 1,
          step_id: "review",
          status: "completed",
          started_at: "2026-04-22T10:01:00.000Z",
          ended_at: "2026-04-22T10:02:00.000Z",
          round: { current: 2 },
          retry: { current: 1 },
          actor: { id: "agent-1", name: "sisyphus" },
        },
      ],
      transitions: [
        {
          id: "trans-1",
          seq: 0,
          timestamp: "2026-04-22T10:00:00.000Z",
          level: "workflow",
          target_id: WorkflowProgressWorkflowTargetId,
          to_state: "running",
        },
        {
          id: historyid({
            level: "step",
            target_id: "convert",
            run_id: "run-1",
            to_state: "active",
            timestamp: "2026-04-22T10:00:00.000Z",
          }),
          seq: 1,
          timestamp: "2026-04-22T10:00:00.000Z",
          level: "step",
          target_id: "convert",
          run_id: "run-1",
          to_state: "active",
        },
        {
          id: historyid({
            level: "step",
            target_id: "convert",
            run_id: "run-1",
            from_state: "active",
            to_state: "completed",
            timestamp: "2026-04-22T10:01:00.000Z",
          }),
          seq: 2,
          timestamp: "2026-04-22T10:01:00.000Z",
          level: "step",
          target_id: "convert",
          run_id: "run-1",
          from_state: "active",
          to_state: "completed",
        },
        {
          id: historyid({
            level: "step",
            target_id: "review",
            run_id: "run-2",
            to_state: "completed",
            timestamp: "2026-04-22T10:02:00.000Z",
            source: { type: "agent", id: "agent-1", name: "sisyphus" },
          }),
          seq: 3,
          timestamp: "2026-04-22T10:02:00.000Z",
          level: "step",
          target_id: "review",
          run_id: "run-2",
          to_state: "completed",
          source: { type: "agent", id: "agent-1", name: "sisyphus" },
        },
        {
          id: historyid({
            level: "workflow",
            target_id: WorkflowProgressWorkflowTargetId,
            from_state: "running",
            to_state: "done",
            timestamp: "2026-04-22T10:02:00.000Z",
          }),
          seq: 4,
          timestamp: "2026-04-22T10:02:00.000Z",
          level: "workflow",
          target_id: WorkflowProgressWorkflowTargetId,
          from_state: "running",
          to_state: "done",
        },
      ],
      participants: [],
    })
  })

  test("orders terminal step closes before terminal workflow closes at the same timestamp", () => {
    const out = mergeWorkflowProgress(
      {
        version: "workflow-progress.v2",
        workflow: { status: "running", name: "implement" },
        machine: {
          id: "implement",
          active_step_id: "review",
          active_run_id: "run-2",
          updated_at: "2026-04-22T10:01:00.000Z",
        },
        step_definitions: [{ id: "review", kind: "task" }],
        step_runs: [
          { id: "run-2", seq: 0, step_id: "review", status: "active", started_at: "2026-04-22T10:01:00.000Z" },
        ],
        transitions: [],
        participants: [],
      },
      {
        version: "workflow-progress.v2",
        workflow: { status: "done", name: "implement", ended_at: "2026-04-22T10:02:00.000Z" },
        machine: { id: "implement", updated_at: "2026-04-22T10:02:00.000Z" },
        step_definitions: [{ id: "review", kind: "task" }],
        step_runs: [
          {
            id: "run-2",
            seq: 0,
            step_id: "review",
            status: "completed",
            started_at: "2026-04-22T10:01:00.000Z",
            ended_at: "2026-04-22T10:02:00.000Z",
          },
        ],
        transitions: [],
        participants: [],
      },
    )

    expect(out?.version).toBe("workflow-progress.v2")
    if (!out || out.version !== "workflow-progress.v2") throw new Error("expected v2 progress")
    const trans = out.transitions ?? []
    expect(trans.at(-2)).toEqual({
      id: historyid({
        level: "step",
        target_id: "review",
        run_id: "run-2",
        from_state: "active",
        to_state: "completed",
        timestamp: "2026-04-22T10:02:00.000Z",
      }),
      seq: 2,
      timestamp: "2026-04-22T10:02:00.000Z",
      level: "step",
      target_id: "review",
      run_id: "run-2",
      from_state: "active",
      to_state: "completed",
    })
    expect(trans.at(-1)).toEqual({
      id: historyid({
        level: "workflow",
        target_id: WorkflowProgressWorkflowTargetId,
        from_state: "running",
        to_state: "done",
        timestamp: "2026-04-22T10:02:00.000Z",
      }),
      seq: 3,
      timestamp: "2026-04-22T10:02:00.000Z",
      level: "workflow",
      target_id: WorkflowProgressWorkflowTargetId,
      from_state: "running",
      to_state: "done",
    })
  })

  test("preserves v2 progress when a later payload downgrades to v1", () => {
    expect(
      mergeWorkflowProgress(
        {
          version: "workflow-progress.v2",
          workflow: {
            status: "running",
            name: "implement",
            started_at: "2026-04-22T10:00:00.000Z",
          },
          machine: {
            id: "implement",
            active_step_id: "convert",
            active_run_id: "run-1",
            updated_at: "2026-04-22T10:00:00.000Z",
          },
          step_definitions: [{ id: "convert", kind: "task" }],
          step_runs: [
            { id: "run-1", seq: 0, step_id: "convert", status: "active", started_at: "2026-04-22T10:00:00.000Z" },
          ],
          transitions: [
            {
              id: "trans-1",
              seq: 0,
              timestamp: "2026-04-22T10:00:00.000Z",
              level: "workflow",
              target_id: WorkflowProgressWorkflowTargetId,
              to_state: "running",
            },
          ],
          participants: [],
        },
        {
          version: "workflow-progress.v1",
          workflow: {
            status: "running",
            name: "implement",
          },
          phase: {
            status: "active",
            label: "Plan",
          },
        },
      ),
    ).toEqual({
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
        name: "implement",
        started_at: "2026-04-22T10:00:00.000Z",
      },
      machine: {
        id: "implement",
        active_step_id: "convert",
        active_run_id: "run-1",
        updated_at: "2026-04-22T10:00:00.000Z",
      },
      step_definitions: [{ id: "convert", kind: "task" }],
      step_runs: [
        { id: "run-1", seq: 0, step_id: "convert", status: "active", started_at: "2026-04-22T10:00:00.000Z" },
      ],
      transitions: [
        {
          id: "trans-1",
          seq: 0,
          timestamp: "2026-04-22T10:00:00.000Z",
          level: "workflow",
          target_id: WorkflowProgressWorkflowTargetId,
          to_state: "running",
        },
        {
          id: historyid({
            level: "step",
            target_id: "convert",
            run_id: "run-1",
            to_state: "active",
            timestamp: "2026-04-22T10:00:00.000Z",
          }),
          seq: 1,
          timestamp: "2026-04-22T10:00:00.000Z",
          level: "step",
          target_id: "convert",
          run_id: "run-1",
          to_state: "active",
        },
      ],
      phase: {
        status: "active",
        label: "Plan",
      },
      participants: [],
    })
  })

  test("merges incremental v1 payloads without dropping prior optional sections", () => {
    expect(
      mergeWorkflowProgress(
        {
          version: "workflow-progress.v1",
          workflow: { status: "running", name: "demo" },
          phase: { status: "active", label: "Plan" },
          round: { status: "active", current: 1 },
          steps: [{ id: "step-1", status: "active", label: "Inspect" }],
          agents: [{ name: "builder", status: "running" }],
        },
        {
          version: "workflow-progress.v1",
          workflow: { status: "waiting", name: "demo" },
        },
      ),
    ).toEqual({
      version: "workflow-progress.v1",
      workflow: { status: "waiting", name: "demo" },
      phase: { status: "active", label: "Plan" },
      round: { status: "active", current: 1 },
      steps: [{ id: "step-1", status: "active", label: "Inspect" }],
      agents: [{ id: "builder", name: "builder", status: "running" }],
    })
  })

  test("keeps synthetic transition ids stable when seq changes", () => {
    const base = mergeWorkflowProgress(
      {
        version: "workflow-progress.v2",
        workflow: { status: "running", name: "demo", started_at: "2026-04-22T10:00:00.000Z" },
        machine: { id: "demo", active_step_id: "plan", active_run_id: "run-1", updated_at: "2026-04-22T10:00:00.000Z" },
        step_definitions: [{ id: "plan", kind: "task" }],
        step_runs: [{ id: "run-1", seq: 0, step_id: "plan", status: "active", started_at: "2026-04-22T10:00:00.000Z" }],
        transitions: [],
        participants: [],
      },
      {
        version: "workflow-progress.v2",
        workflow: { status: "done", name: "demo", ended_at: "2026-04-22T10:01:00.000Z" },
        machine: { id: "demo", updated_at: "2026-04-22T10:01:00.000Z" },
        step_definitions: [{ id: "plan", kind: "task" }],
        step_runs: [
          {
            id: "run-1",
            seq: 0,
            step_id: "plan",
            status: "completed",
            started_at: "2026-04-22T10:00:00.000Z",
            ended_at: "2026-04-22T10:01:00.000Z",
          },
        ],
        transitions: [],
        participants: [],
      },
    )
    const shifted = mergeWorkflowProgress(
      {
        version: "workflow-progress.v2",
        workflow: { status: "running", name: "demo", started_at: "2026-04-22T10:00:00.000Z" },
        machine: { id: "demo", active_step_id: "plan", active_run_id: "run-1", updated_at: "2026-04-22T10:00:00.000Z" },
        step_definitions: [
          { id: "prep", kind: "task" },
          { id: "plan", kind: "task" },
        ],
        step_runs: [
          {
            id: "prep-1",
            seq: 0,
            step_id: "prep",
            status: "completed",
            started_at: "2026-04-22T09:59:00.000Z",
            ended_at: "2026-04-22T09:59:30.000Z",
          },
          { id: "run-1", seq: 1, step_id: "plan", status: "active", started_at: "2026-04-22T10:00:00.000Z" },
        ],
        transitions: [
          {
            id: "seed",
            seq: 0,
            level: "step",
            target_id: "prep",
            run_id: "prep-1",
            to_state: "completed",
            timestamp: "2026-04-22T09:59:30.000Z",
          },
        ],
        participants: [],
      },
      {
        version: "workflow-progress.v2",
        workflow: { status: "done", name: "demo", ended_at: "2026-04-22T10:01:00.000Z" },
        machine: { id: "demo", updated_at: "2026-04-22T10:01:00.000Z" },
        step_definitions: [
          { id: "prep", kind: "task" },
          { id: "plan", kind: "task" },
        ],
        step_runs: [
          {
            id: "prep-1",
            seq: 0,
            step_id: "prep",
            status: "completed",
            started_at: "2026-04-22T09:59:00.000Z",
            ended_at: "2026-04-22T09:59:30.000Z",
          },
          {
            id: "run-1",
            seq: 1,
            step_id: "plan",
            status: "completed",
            started_at: "2026-04-22T10:00:00.000Z",
            ended_at: "2026-04-22T10:01:00.000Z",
          },
        ],
        transitions: [
          {
            id: "seed",
            seq: 0,
            level: "step",
            target_id: "prep",
            run_id: "prep-1",
            to_state: "completed",
            timestamp: "2026-04-22T09:59:30.000Z",
          },
        ],
        participants: [],
      },
    )

    expect(base?.version).toBe("workflow-progress.v2")
    expect(shifted?.version).toBe("workflow-progress.v2")
    if (!base || base.version !== "workflow-progress.v2") throw new Error("expected base v2")
    if (!shifted || shifted.version !== "workflow-progress.v2") throw new Error("expected shifted v2")
    expect(base.transitions.at(-2)?.id).toBe(shifted.transitions.at(-2)?.id)
    expect(base.transitions.at(-1)?.id).toBe(shifted.transitions.at(-1)?.id)
    expect(base.transitions.at(-2)?.seq).not.toBe(shifted.transitions.at(-2)?.seq)
  })

  test("preserves compatible v1 projection fields when a run upgrades to v2", () => {
    expect(
      mergeWorkflowProgress(
        {
          version: "workflow-progress.v1",
          workflow: {
            status: "running",
            name: "implement",
            started_at: "2026-04-22T10:00:00.000Z",
          },
          phase: {
            status: "active",
            label: "Plan",
          },
          round: {
            status: "active",
            current: 2,
          },
          steps: [{ id: "step-1", status: "active", label: "Inspect" }],
          agents: [{ name: "builder", role: "builder", status: "running" }],
        },
        {
          version: "workflow-progress.v2",
          workflow: {
            status: "running",
            name: "implement",
          },
          machine: {
            id: "implement",
            active_step_id: "step-1",
            active_run_id: "run-1",
            updated_at: "2026-04-22T10:00:00.000Z",
          },
          step_definitions: [{ id: "step-1", kind: "task", label: "Inspect" }],
          step_runs: [
            { id: "run-1", seq: 0, step_id: "step-1", status: "active", started_at: "2026-04-22T10:00:00.000Z" },
          ],
          transitions: [
            {
              id: "trans-1",
              seq: 0,
              timestamp: "2026-04-22T10:00:00.000Z",
              level: "step",
              target_id: "step-1",
              run_id: "run-1",
              to_state: "active",
            },
          ],
          participants: [],
        },
      ),
    ).toEqual({
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
        name: "implement",
        started_at: "2026-04-22T10:00:00.000Z",
      },
      machine: {
        id: "implement",
        active_step_id: "step-1",
        active_run_id: "run-1",
        updated_at: "2026-04-22T10:00:00.000Z",
      },
      step_definitions: [{ id: "step-1", kind: "task", label: "Inspect" }],
      step_runs: [{ id: "run-1", seq: 0, step_id: "step-1", status: "active", started_at: "2026-04-22T10:00:00.000Z" }],
      transitions: [
        {
          id: "trans-1",
          seq: 0,
          timestamp: "2026-04-22T10:00:00.000Z",
          level: "step",
          target_id: "step-1",
          run_id: "run-1",
          to_state: "active",
        },
      ],
      phase: {
        status: "active",
        label: "Plan",
      },
      round: {
        status: "active",
        current: 2,
      },
      steps: [{ id: "step-1", status: "active", label: "Inspect" }],
      agents: [{ id: "builder", name: "builder", role: "builder", status: "running" }],
      participants: [],
    })
  })

  test("normalizes v1 payloads into one read shape", () => {
    expect(
      readWorkflowProgress({
        [WorkflowProgressKey]: {
          version: "workflow-progress.v1",
          workflow: { status: "running", name: "demo" },
        },
      }),
    ).toEqual({
      version: "workflow-progress.v1",
      workflow: { status: "running", name: "demo" },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [],
      steps: [],
      agents: [],
      participants: [],
    })
  })

  test("coerces v1, v2, and partial payloads into one reducer input shape", () => {
    const val = [
      coerceWorkflowProgress({
        version: "workflow-progress.v1",
        workflow: { status: "running", name: "legacy" },
      }),
      coerceWorkflowProgress({
        version: "workflow-progress.v2",
        workflow: { status: "running", name: "modern" },
        machine: { active_step_id: "write", active_run_id: "run-1" },
        step_definitions: [{ id: "write", kind: "task" }],
        step_runs: [{ id: "run-1", seq: 0, step_id: "write", status: "active" }],
        transitions: [
          { id: "trans-1", seq: 0, level: "step", target_id: "write", run_id: "run-1", to_state: "active" },
        ],
        participants: [],
      }),
      coerceWorkflowProgress({
        version: "workflow-progress.v2",
        workflow: { status: "retrying" },
        machine: { active_step_id: "review" },
        step_definitions: [
          { id: "review", kind: "group", children: ["lint", "test"] },
          { id: "lint", kind: "task", parent_id: "review" },
          { id: "test", kind: "task", parent_id: "review" },
        ],
        step_runs: [
          { step_id: "review", status: "retrying", retry: { current: 1 } },
          { step_id: "review", status: "retrying", retry: { current: 2 } },
          { step_id: "lint", status: "completed", parent_run_id: "run-2" },
          { step_id: "test", status: "waiting", parent_run_id: "run-2" },
        ],
        transitions: [{ level: "step", target_id: "review", run_id: "run-2" }],
        participants: [{ step_id: "review", run_id: "run-2" }],
      }),
    ]

    expect(val.every((item) => item !== undefined)).toBe(true)
    expect(val.map((item) => item?.version)).toEqual([
      "workflow-progress.v1",
      "workflow-progress.v2",
      "workflow-progress.v2",
    ])
    expect(val[0]).toEqual({
      version: "workflow-progress.v1",
      workflow: { status: "running", name: "legacy" },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [],
      steps: [],
      agents: [],
      participants: [],
    })
    expect(val[1]).toEqual({
      version: "workflow-progress.v2",
      workflow: { status: "running", name: "modern" },
      machine: { active_step_id: "write", active_run_id: "run-1" },
      step_definitions: [{ id: "write", kind: "task" }],
      step_runs: [{ id: "run-1", seq: 0, step_id: "write", status: "active" }],
      transitions: [{ id: "trans-1", seq: 0, level: "step", target_id: "write", run_id: "run-1", to_state: "active" }],
      steps: [],
      agents: [],
      participants: [],
    })
    expect(val[2]).toEqual({
      version: "workflow-progress.v2",
      workflow: { status: "retrying" },
      machine: { active_step_id: "review" },
      step_definitions: [
        { id: "review", kind: "group", children: ["lint", "test"] },
        { id: "lint", kind: "task", parent_id: "review" },
        { id: "test", kind: "task", parent_id: "review" },
      ],
      step_runs: [
        { id: "run-1", seq: 0, step_id: "review", status: "retrying", retry: { current: 1 } },
        { id: "run-2", seq: 1, step_id: "review", status: "retrying", retry: { current: 2 } },
        { id: "run-3", seq: 2, step_id: "lint", status: "completed", parent_run_id: "run-2" },
        { id: "run-4", seq: 3, step_id: "test", status: "waiting", parent_run_id: "run-2" },
      ],
      transitions: [
        {
          id: "step:review:run-2:0",
          seq: 0,
          level: "step",
          target_id: "review",
          run_id: "run-2",
          to_state: "retrying",
        },
      ],
      steps: [],
      agents: [],
      participants: [{ id: "participant-1", name: "participant-1", run_id: "run-2", step_id: "review" }],
    })
  })

  test("shares fallback tokens across workflow projection regions", () => {
    const input = {
      version: "workflow-progress.v2",
      workflow: { status: "waiting" },
      machine: { active_step_id: "review" },
      step_definitions: [
        { id: "review", kind: "group", children: ["lint", "test"] },
        { id: "lint", kind: "task", parent_id: "review" },
        { id: "test", kind: "task", parent_id: "review" },
      ],
      step_runs: [
        { step_id: "review", status: "retrying", retry: { current: 2 } },
        { step_id: "lint", status: "completed", parent_run_id: "run-1" },
        { step_id: "test", status: "waiting", parent_run_id: "run-1" },
      ],
      transitions: [{ level: "step", target_id: "review", run_id: "run-1" }],
      participants: [{ step_id: "review", run_id: "run-1" }],
    }

    const norm = normalizeWorkflowProjectionInput(input)
    expect(norm).toBeDefined()
    if (!norm) throw new Error("expected normalized projection input")
    expect(norm.workflow.title).toBe(workflowfallback.workflow)
    expect(norm.step_runs[0]?.title).toBe("review")
    expect(norm.step_runs[0]?.reason_text).toBe(workflowfallback.reason)
    expect(norm.step_runs[0]?.round_text).toBe(workflowfallback.round)
    expect(norm.step_runs[0]?.retry_text).toBe("Retry 2")
    expect(norm.step_runs[0]?.actor_title).toBe("participant-1")
    expect(norm.participants[0]?.title).toBe("participant-1")
    expect(norm.transitions[0]).toEqual({
      id: "step:review:run-1:0",
      seq: 0,
      level: "step",
      target_id: "review",
      run_id: "run-1",
      to_state: "waiting",
      title: "review",
      timestamp_text: workflowfallback.timestamp,
      reason_text: workflowfallback.reason,
      source_text: "participant-1",
      round_text: workflowfallback.round,
    })

    const view = workflowproject({ progress: norm })
    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.header.title).toBe(workflowfallback.workflow)
    expect(view.timeline[0]).toMatchObject({ label: "review", reason: workflowfallback.reason, retry: "Retry 2" })
    expect(view.agents[0]).toMatchObject({
      name: "participant-1",
      status: "retrying",
      summary: "review waiting",
      action: "review waiting",
    })
    expect(view.history[0]).toMatchObject({
      kind: "change",
      label: "review",
      timestamp: workflowfallback.timestamp,
      reason: workflowfallback.reason,
      source: "participant-1",
      round: workflowfallback.round,
    })
    expect(view.alerts[0]).toMatchObject({ title: workflowfallback.workflow })
  })

  test("selects a deterministic active path for grouped parallel work with incomplete branch metadata", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "running", label: "Implement" },
        machine: { active_step_id: "review" },
        step_definitions: [
          { id: "review", kind: "group", label: "Review", children: ["lint", "test"] },
          { id: "lint", kind: "task", parent_id: "review", label: "Lint" },
          { id: "test", kind: "task", parent_id: "review", label: "Test" },
        ],
        step_runs: [
          { id: "run-review", seq: 0, step_id: "review", status: "active" },
          { id: "run-test", seq: 2, step_id: "test", status: "waiting" },
          { id: "run-lint", seq: 1, step_id: "lint", status: "active" },
        ],
        transitions: [
          { id: "trans-review", seq: 0, level: "step", target_id: "review", run_id: "run-review", to_state: "active" },
          { id: "trans-lint", seq: 1, level: "step", target_id: "lint", run_id: "run-lint", to_state: "active" },
          { id: "trans-test", seq: 2, level: "step", target_id: "test", run_id: "run-test", to_state: "waiting" },
        ],
      },
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.timeline.map((item) => ({ step_id: item.step_id, status: item.status, active: item.active }))).toEqual([
      { step_id: "review", status: "active", active: false },
      { step_id: "lint", status: "active", active: true },
      { step_id: "test", status: "waiting", active: false },
    ])
  })

  test("keeps the machine active group when descendant runs are only completed", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "running", label: "Implement" },
        machine: { active_step_id: "review" },
        step_definitions: [
          { id: "review", kind: "group", label: "Review", children: ["lint", "test"] },
          { id: "lint", kind: "task", parent_id: "review", label: "Lint" },
          { id: "test", kind: "task", parent_id: "review", label: "Test" },
        ],
        step_runs: [
          { id: "run-review", seq: 0, step_id: "review", status: "active" },
          { id: "run-test", seq: 2, step_id: "test", status: "completed" },
          { id: "run-lint", seq: 1, step_id: "lint", status: "completed" },
        ],
        transitions: [
          { id: "trans-review", seq: 0, level: "step", target_id: "review", run_id: "run-review", to_state: "active" },
          { id: "trans-lint", seq: 1, level: "step", target_id: "lint", run_id: "run-lint", to_state: "completed" },
          { id: "trans-test", seq: 2, level: "step", target_id: "test", run_id: "run-test", to_state: "completed" },
        ],
      },
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.timeline.map((item) => ({ step_id: item.step_id, status: item.status, active: item.active }))).toEqual([
      { step_id: "review", status: "active", active: true },
      { step_id: "lint", status: "completed", active: false },
      { step_id: "test", status: "completed", active: false },
    ])
  })

  test("keeps latest meaningful transitions deterministic and ignores duplicates or no-op records", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "blocked", label: "Implement" },
        machine: { active_step_id: "write", active_run_id: "run-1" },
        step_definitions: [{ id: "write", kind: "task", label: "Write code" }],
        step_runs: [{ id: "run-1", seq: 0, step_id: "write", status: "blocked" }],
        transitions: [
          {
            id: "dup-older",
            seq: 2,
            timestamp: "2026-04-23T10:00:00.000Z",
            level: "step",
            target_id: "write",
            run_id: "run-1",
            to_state: "waiting",
            reason: "Waiting on review",
          },
          {
            id: "dup-newer",
            seq: 3,
            timestamp: "2026-04-23T10:00:01.000Z",
            level: "step",
            target_id: "write",
            run_id: "run-1",
            to_state: "waiting",
            reason: "Still waiting",
          },
          {
            id: "noop",
            seq: 4,
            timestamp: "2026-04-23T10:00:02.000Z",
            level: "step",
            target_id: "write",
            run_id: "run-1",
            from_state: "blocked",
            to_state: "blocked",
          },
          {
            id: "flow",
            seq: 5,
            timestamp: "2026-04-23T10:00:03.000Z",
            level: "workflow",
            target_id: "workflow",
            to_state: "blocked",
            reason: "Review blocked",
          },
          {
            id: "step-latest",
            seq: 6,
            timestamp: "2026-04-23T10:00:03.000Z",
            level: "step",
            target_id: "write",
            run_id: "run-1",
            to_state: "blocked",
            reason: "Blocked on review",
          },
        ],
      },
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.history.map((item) => item.id)).toEqual(["step-latest", "flow", "dup-newer"])
    expect(view.latest).toMatchObject({ id: "step-latest", label: "Write code", to_state: "blocked" })
  })

  test("collapses duplicate no-run transitions while preserving distinct retry history", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "retrying", label: "Implement" },
        machine: { active_step_id: "write" },
        step_definitions: [{ id: "write", kind: "task", label: "Write code" }],
        step_runs: [{ id: "run-1", seq: 0, step_id: "write", status: "retrying" }],
        transitions: [
          {
            id: "retry-1-old",
            seq: 1,
            timestamp: "2026-04-23T10:00:00.000Z",
            level: "step",
            target_id: "write",
            to_state: "retrying",
            reason: "Round 1 failed",
          },
          {
            id: "retry-1-new",
            seq: 2,
            timestamp: "2026-04-23T10:00:00.000Z",
            level: "step",
            target_id: "write",
            to_state: "retrying",
            reason: "Round 1 failed",
          },
          {
            id: "retry-2",
            seq: 3,
            timestamp: "2026-04-23T10:05:00.000Z",
            level: "step",
            target_id: "write",
            to_state: "retrying",
            reason: "Round 2 failed",
          },
        ],
      },
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.history.map((item) => item.id)).toEqual(["retry-2", "retry-1-new"])
    expect(view.latest).toMatchObject({ id: "retry-2", reason: "Round 2 failed" })
  })

  test("keeps repeated run-backed states when another state intervenes", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "retrying", label: "Implement" },
        machine: { active_step_id: "write", active_run_id: "run-1" },
        step_definitions: [{ id: "write", kind: "task", label: "Write code" }],
        step_runs: [{ id: "run-1", seq: 0, step_id: "write", status: "retrying" }],
        transitions: [
          {
            id: "retry-1",
            seq: 1,
            timestamp: "2026-04-23T10:00:00.000Z",
            level: "step",
            target_id: "write",
            run_id: "run-1",
            to_state: "retrying",
            reason: "Round 1 failed",
          },
          {
            id: "blocked",
            seq: 2,
            timestamp: "2026-04-23T10:01:00.000Z",
            level: "step",
            target_id: "write",
            run_id: "run-1",
            from_state: "retrying",
            to_state: "blocked",
            reason: "Missing approval",
          },
          {
            id: "retry-2",
            seq: 3,
            timestamp: "2026-04-23T10:02:00.000Z",
            level: "step",
            target_id: "write",
            run_id: "run-1",
            from_state: "blocked",
            to_state: "retrying",
            reason: "Retry after approval",
          },
        ],
      },
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.history.map((item) => item.id)).toEqual(["retry-2", "blocked", "retry-1"])
  })

  test("derives agent state and latest action from participant, step run, and transition source metadata", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "running", label: "Implement" },
        machine: { active_step_id: "review", active_run_id: "run-1" },
        step_definitions: [{ id: "review", kind: "task", label: "Review" }],
        step_runs: [
          { id: "run-1", seq: 0, step_id: "review", status: "active", started_at: "2026-04-23T10:00:00.000Z" },
        ],
        transitions: [
          {
            id: "trans-1",
            seq: 0,
            timestamp: "2026-04-23T10:00:01.000Z",
            level: "step",
            target_id: "review",
            run_id: "run-1",
            to_state: "active",
            reason: "Started review",
            source: { participant_id: "agent-1", step_id: "review", run_id: "run-1" },
          },
        ],
        participants: [{ id: "agent-1", label: "Reviewer", role: "qa", step_id: "review", run_id: "run-1" }],
      },
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.agents[0]).toMatchObject({
      id: "agent-1",
      name: "Reviewer",
      role: "qa",
      status: "running",
      action: "Started review",
      active: true,
    })
  })

  test("prefers participant metadata and newer transition evidence when consolidating agents", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", label: "Implement" },
        machine: { active_step_id: "review", active_run_id: "run-1" },
        step_definitions: [{ id: "review", kind: "task", label: "Review" }],
        step_runs: [
          {
            id: "run-1",
            seq: 0,
            step_id: "review",
            status: "active",
            reason: "Started review",
            started_at: "2026-04-23T10:00:00.000Z",
          },
        ],
        transitions: [
          {
            id: "trans-1",
            seq: 1,
            timestamp: "2026-04-23T10:00:05.000Z",
            level: "step",
            target_id: "review",
            run_id: "run-1",
            to_state: "waiting",
            reason: "Waiting on reviewer",
            source: { participant_id: "agent-1", step_id: "review", run_id: "run-1" },
          },
        ],
        participants: [
          {
            id: "agent-1",
            label: "Reviewer",
            role: "qa",
            status: "waiting",
            updated_at: "2026-04-23T10:00:05.000Z",
            step_id: "review",
            run_id: "run-1",
          },
        ],
      },
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.agents[0]).toMatchObject({
      id: "agent-1",
      name: "Reviewer",
      role: "qa",
      status: "waiting",
      action: "Waiting on reviewer",
      updated_at: "2026-04-23T10:00:05.000Z",
      active: true,
    })
  })

  test("does not infer a participant label from ambiguous step-level fallbacks", () => {
    const norm = normalizeWorkflowProjectionInput({
      version: "workflow-progress.v2",
      workflow: { status: "running", label: "Implement" },
      machine: { active_step_id: "review", active_run_id: "run-1" },
      step_definitions: [{ id: "review", kind: "task", label: "Review" }],
      step_runs: [{ id: "run-1", seq: 0, step_id: "review", status: "active" }],
      transitions: [
        {
          id: "trans-1",
          seq: 0,
          timestamp: "2026-04-23T10:00:01.000Z",
          level: "step",
          target_id: "review",
          run_id: "run-1",
          to_state: "active",
          source: { step_id: "review", run_id: "run-1" },
        },
      ],
      participants: [
        { id: "agent-1", label: "Reviewer A", step_id: "review", run_id: "run-1" },
        { id: "agent-2", label: "Reviewer B", step_id: "review", run_id: "run-1" },
      ],
    })

    expect(norm).toBeDefined()
    if (!norm) throw new Error("expected normalized projection input")
    expect(norm.step_runs[0]?.actor_title).toBe("agent 1")
    expect(norm.transitions[0]?.source_text).toBe(workflowfallback.agent)

    const view = workflowproject({ progress: norm })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.agents.map((item) => item.name).sort()).toEqual(["Reviewer A", "Reviewer B"])
    expect(view.alerts).toEqual(
      expect.arrayContaining([expect.not.objectContaining({ level: "step", source: expect.anything() })]),
    )
  })

  test("prefers explicit transition source over synthesized run actor titles in alerts", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", label: "Implement" },
        machine: { active_step_id: "review", active_run_id: "run-1" },
        step_definitions: [{ id: "review", kind: "task", label: "Review" }],
        step_runs: [{ id: "run-1", seq: 0, step_id: "review", status: "waiting" }],
        transitions: [
          {
            id: "trans-1",
            seq: 0,
            timestamp: "2026-04-23T10:00:01.000Z",
            level: "step",
            target_id: "review",
            run_id: "run-1",
            to_state: "waiting",
            source: { label: "Lead reviewer", step_id: "review", run_id: "run-1" },
          },
        ],
        participants: [{ id: "agent-1", label: "Reviewer", step_id: "review", run_id: "run-1" }],
      },
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.alerts).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "step", source: "Lead reviewer" })]),
    )
  })

  test("keeps step alerts scoped to the current step run when another step changed later", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", label: "Implement" },
        machine: { active_step_id: "review", active_run_id: "run-review" },
        step_definitions: [
          { id: "review", kind: "task", label: "Review" },
          { id: "build", kind: "task", label: "Build" },
        ],
        step_runs: [
          { id: "run-review", seq: 0, step_id: "review", status: "waiting", reason: "Waiting on reviewer" },
          { id: "run-build", seq: 1, step_id: "build", status: "blocked", reason: "Build queue paused" },
        ],
        transitions: [
          {
            id: "trans-review",
            seq: 1,
            timestamp: "2026-04-23T10:00:01.000Z",
            level: "step",
            target_id: "review",
            run_id: "run-review",
            to_state: "waiting",
            reason: "Waiting on reviewer",
            source: { label: "Lead reviewer", step_id: "review", run_id: "run-review" },
          },
          {
            id: "trans-build",
            seq: 2,
            timestamp: "2026-04-23T10:00:02.000Z",
            level: "step",
            target_id: "build",
            run_id: "run-build",
            to_state: "blocked",
            reason: "Build queue paused",
            source: { label: "Builder", step_id: "build", run_id: "run-build" },
          },
        ],
      },
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "step",
          target: "review",
          source: "Lead reviewer",
          summary: "Waiting on reviewer",
        }),
      ]),
    )
    expect(view.alerts).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ level: "step", source: "Builder" })]),
    )
  })

  test("ignores stale machine active_run_id when a newer live descendant run exists", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", label: "Implement" },
        machine: { active_step_id: "review", active_run_id: "run-review" },
        step_definitions: [
          { id: "review", kind: "group", label: "Review", children: ["lint", "test"] },
          { id: "lint", kind: "task", parent_id: "review", label: "Lint" },
          { id: "test", kind: "task", parent_id: "review", label: "Test" },
        ],
        step_runs: [
          { id: "run-review", seq: 0, step_id: "review", status: "completed" },
          { id: "run-test", seq: 1, step_id: "test", status: "completed", parent_run_id: "run-review" },
          { id: "run-lint", seq: 2, step_id: "lint", status: "waiting", parent_run_id: "run-review" },
        ],
        transitions: [
          {
            id: "trans-review",
            seq: 0,
            level: "step",
            target_id: "review",
            run_id: "run-review",
            to_state: "completed",
          },
          { id: "trans-test", seq: 1, level: "step", target_id: "test", run_id: "run-test", to_state: "completed" },
          { id: "trans-lint", seq: 2, level: "step", target_id: "lint", run_id: "run-lint", to_state: "waiting" },
        ],
      },
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.timeline.map((item) => ({ step_id: item.step_id, status: item.status, active: item.active }))).toEqual([
      { step_id: "review", status: "completed", active: false },
      { step_id: "lint", status: "waiting", active: true },
      { step_id: "test", status: "completed", active: false },
    ])
    expect(view.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ level: "step", target: "lint" })]))
  })

  test("prefers a live child branch when active_run_id still points to a live group run", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", label: "Implement" },
        machine: { active_step_id: "review", active_run_id: "run-review" },
        step_definitions: [
          { id: "review", kind: "group", label: "Review", children: ["lint", "test"] },
          { id: "lint", kind: "task", parent_id: "review", label: "Lint" },
          { id: "test", kind: "task", parent_id: "review", label: "Test" },
        ],
        step_runs: [
          { id: "run-review", seq: 0, step_id: "review", status: "active" },
          { id: "run-test", seq: 1, step_id: "test", status: "completed", parent_run_id: "run-review" },
          { id: "run-lint", seq: 2, step_id: "lint", status: "waiting", parent_run_id: "run-review" },
        ],
        transitions: [
          { id: "trans-review", seq: 0, level: "step", target_id: "review", run_id: "run-review", to_state: "active" },
          { id: "trans-test", seq: 1, level: "step", target_id: "test", run_id: "run-test", to_state: "completed" },
          { id: "trans-lint", seq: 2, level: "step", target_id: "lint", run_id: "run-lint", to_state: "waiting" },
        ],
      },
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.timeline.map((item) => ({ step_id: item.step_id, status: item.status, active: item.active }))).toEqual([
      { step_id: "review", status: "active", active: false },
      { step_id: "lint", status: "waiting", active: true },
      { step_id: "test", status: "completed", active: false },
    ])
    expect(view.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ level: "step", target: "lint" })]))
  })

  test("does not reuse older step transition details for a newer run without a transition", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "retrying", label: "Implement" },
        machine: { active_step_id: "review", active_run_id: "run-2" },
        step_definitions: [{ id: "review", kind: "task", label: "Review" }],
        step_runs: [
          { id: "run-1", seq: 0, step_id: "review", status: "blocked" },
          { id: "run-2", seq: 1, step_id: "review", status: "retrying" },
        ],
        transitions: [
          {
            id: "trans-1",
            seq: 0,
            timestamp: "2026-04-23T10:00:01.000Z",
            level: "step",
            target_id: "review",
            run_id: "run-1",
            to_state: "blocked",
            reason: "Old blocked reason",
            source: { label: "Old reviewer", step_id: "review", run_id: "run-1" },
          },
        ],
      },
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "step",
          status: "retrying",
          target: "review",
          summary: workflowfallback.reason,
        }),
      ]),
    )
    expect(view.alerts).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ level: "step", source: "Old reviewer" }),
        expect.objectContaining({ level: "step", summary: "Old blocked reason" }),
      ]),
    )
  })

  test("emits distinct alert states for rich and fallback workflow payloads", () => {
    const states = ["running", "waiting", "blocked", "retrying", "failed", "done"] as const

    states.forEach((state) => {
      const step = state === "running" ? "active" : state === "done" ? "completed" : state
      const rich = workflowproject({
        progress: {
          version: "workflow-progress.v2",
          workflow: { status: state, label: "Implement" },
          machine: { active_step_id: "review", active_run_id: "run-1" },
          step_definitions: [{ id: "review", kind: "task", label: "Review" }],
          step_runs: [{ id: "run-1", seq: 0, step_id: "review", status: step }],
          transitions: [
            {
              id: `trans-${state}`,
              seq: 0,
              level: "step",
              target_id: "review",
              run_id: "run-1",
              to_state: step,
            },
          ],
        },
      })

      const fallback = workflowproject({
        progress: {
          version: "workflow-progress.v1",
          workflow: { status: state, label: "Legacy" },
          steps: [{ id: "review", status: step, label: "Review" }],
        },
      })

      expect(rich).toBeDefined()
      expect(fallback).toBeDefined()
      if (!rich || !fallback) throw new Error("expected workflow projection")
      expect(rich.alerts.some((item) => item.status === state)).toBe(true)
      expect(fallback.alerts.some((item) => item.status === state)).toBe(true)
    })
  })

  test("emits waiter kinds for workflow and step waiting alerts", () => {
    const flow = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", label: "Implement", summary: "Awaiting input" },
      },
    })

    const step = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", label: "Implement" },
        machine: { active_step_id: "review", active_run_id: "run-1" },
        step_definitions: [{ id: "review", kind: "wait", label: "Review" }],
        step_runs: [{ id: "run-1", seq: 0, step_id: "review", status: "waiting" }],
        transitions: [
          { id: "trans-1", seq: 0, level: "step", target_id: "review", run_id: "run-1", to_state: "waiting" },
        ],
      },
    })

    expect(flow).toBeDefined()
    expect(step).toBeDefined()
    if (!flow || !step) throw new Error("expected workflow projection")
    expect(flow.alerts[0]).toMatchObject({ level: "workflow", status: "waiting", waiter: "user" })
    expect(step.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "workflow", status: "waiting", waiter: "user" }),
        expect.objectContaining({
          level: "step",
          status: "waiting",
          waiter: "agent",
          summary: workflowfallback.reason,
        }),
      ]),
    )
  })

  test("preserves partial v2 payloads through metadata normalization and read paths", () => {
    const raw = {
      [WorkflowProgressKey]: {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", label: "Implement" },
        machine: { active_step_id: "write" },
        step_definitions: [{ id: "write", label: "Write code" }],
        step_runs: [{ step_id: "write", status: "running" }],
        transitions: [{ level: "step", target_id: "write", reason: "Awaiting input" }],
      },
    }

    const meta = normalizeWorkflowMetadata(raw)
    expect(parseWorkflowProgress(raw[WorkflowProgressKey])).toBeUndefined()
    expect(meta?.[WorkflowProgressKey]).toEqual({
      version: "workflow-progress.v2",
      workflow: { status: "waiting", label: "Implement" },
      machine: { active_step_id: "write" },
      step_definitions: [{ id: "write", kind: "task", label: "Write code" }],
      step_runs: [{ id: "run-1", seq: 0, step_id: "write", status: "waiting" }],
      transitions: [
        {
          id: "step:write::0",
          seq: 0,
          level: "step",
          target_id: "write",
          to_state: "waiting",
          reason: "Awaiting input",
        },
      ],
      steps: [],
      agents: [],
      participants: [],
    })
    expect(readWorkflowProgress(meta)).toEqual({
      version: "workflow-progress.v2",
      workflow: { status: "waiting", label: "Implement" },
      machine: { active_step_id: "write" },
      step_definitions: [{ id: "write", kind: "task", label: "Write code" }],
      step_runs: [{ id: "run-1", seq: 0, step_id: "write", status: "waiting" }],
      transitions: [
        {
          id: "step:write::0",
          seq: 0,
          level: "step",
          target_id: "write",
          to_state: "waiting",
          reason: "Awaiting input",
        },
      ],
      steps: [],
      agents: [],
      participants: [],
    })
  })

  test("rejects malformed transition-only partial v2 payloads at the shared normalizer boundary", () => {
    expect(
      normalizeWorkflowProgressInput({
        version: "workflow-progress.v2",
        workflow: { status: "waiting", name: "bad-transition" },
        transitions: [{ level: "step", target_id: "missing" }],
      }),
    ).toBeUndefined()
  })

  test("rejects partial v2 payloads that fail strict transition normalization", () => {
    expect(
      normalizeWorkflowProgressInput({
        version: "workflow-progress.v2",
        workflow: { status: "waiting", name: "bad-order" },
        step_definitions: [{ id: "write", label: "Write code" }],
        step_runs: [
          { id: "run-1", seq: 0, step_id: "write", status: "waiting" },
          { id: "run-2", seq: 1, step_id: "write", status: "waiting" },
        ],
        transitions: [
          { id: "trans-1", seq: 1, level: "step", target_id: "write", run_id: "run-1", to_state: "waiting" },
          { id: "trans-1", seq: 1, level: "step", target_id: "write", run_id: "run-2", to_state: "waiting" },
        ],
      }),
    ).toBeUndefined()
  })

  test("normalizes v1 payloads to the canonical read shape", () => {
    expect(
      normalizeWorkflowProgressInput({
        version: "workflow-progress.v1",
        workflow: { status: "running", label: "Plan" },
        round: { status: "active", current: 1 },
        steps: [{ id: "plan", status: "active", label: "Plan step" }],
        agents: [{ name: "ralph", status: "running" }],
      }),
    ).toEqual({
      version: "workflow-progress.v1",
      workflow: { status: "running", label: "Plan" },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [],
      round: { status: "active", current: 1 },
      steps: [{ id: "plan", status: "active", label: "Plan step" }],
      agents: [{ id: "ralph", name: "ralph", status: "running" }],
      participants: [],
    })
  })

  test("preserves helper-only v2 payloads through metadata normalization", () => {
    const raw = {
      [WorkflowProgressKey]: {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", name: "helper-only" },
        round: { status: "active", current: 2, max: 4 },
      },
    }

    expect(normalizeWorkflowMetadata(raw)?.[WorkflowProgressKey]).toEqual({
      version: "workflow-progress.v2",
      workflow: { status: "waiting", name: "helper-only" },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [],
      round: { status: "active", current: 2, max: 4 },
      steps: [],
      agents: [],
      participants: [],
    })
    expect(readWorkflowProgress(raw)).toEqual({
      version: "workflow-progress.v2",
      workflow: { status: "waiting", name: "helper-only" },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [],
      round: { status: "active", current: 2, max: 4 },
      steps: [],
      agents: [],
      participants: [],
    })
    expect(mergeWorkflowProgress(raw[WorkflowProgressKey])).toMatchObject({
      version: "workflow-progress.v2",
      workflow: { status: "waiting", name: "helper-only" },
      machine: {},
      step_definitions: [],
      step_runs: [],
      round: { status: "active", current: 2, max: 4 },
      participants: [],
    })
  })

  test("accepts partial v2 workflow status updates at the shared API boundary", () => {
    const val = WorkflowStatusUpdateInput.parse({
      title: "Planning",
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", name: "partial" },
        machine: { active_step_id: "step-1" },
        step_definitions: [{ id: "step-1", label: "Plan" }],
        step_runs: [{ step_id: "step-1", status: "waiting" }],
        transitions: [{ level: "step", target_id: "step-1", reason: "Awaiting review" }],
      },
    })

    expect(val.title).toBe("Planning")
    expect(val.progress).toMatchObject({
      version: "workflow-progress.v2",
      workflow: { status: "waiting", name: "partial" },
      machine: { active_step_id: "step-1" },
      step_definitions: [{ id: "step-1", label: "Plan" }],
      step_runs: [{ step_id: "step-1", status: "waiting" }],
      transitions: [{ level: "step", target_id: "step-1", reason: "Awaiting review" }],
    })
  })

  test("merges consecutive partial v2 payloads without dropping prior fields", () => {
    const val = mergeWorkflowProgress(
      {
        version: "workflow-progress.v2",
        workflow: { status: "running", name: "merge" },
        machine: { active_step_id: "step-1" },
        step_definitions: [{ id: "step-1", label: "Plan" }],
        step_runs: [{ id: "run-1", step_id: "step-1", status: "active", summary: "First pass" }],
        transitions: [{ level: "step", target_id: "step-1", run_id: "run-1", reason: "Started" }],
      },
      {
        version: "workflow-progress.v2",
        workflow: { status: "running", name: "merge" },
        machine: { active_run_id: "run-1" },
        step_definitions: [{ id: "step-1" }],
        step_runs: [{ id: "run-1", step_id: "step-1", status: "active" }],
        transitions: [{ level: "step", target_id: "step-1", run_id: "run-1", reason: "Still going" }],
        participants: [{ id: "agent-1", step_id: "step-1", run_id: "run-1" }],
      },
    )

    expect(val).toBeDefined()
    expect(val?.version).toBe("workflow-progress.v2")
    if (!val || val.version !== "workflow-progress.v2") throw new Error("expected merged v2 progress")
    expect(val.machine).toEqual({ active_step_id: "step-1", active_run_id: "run-1" })
    expect(val.step_definitions).toEqual([{ id: "step-1", kind: "task", label: "Plan" }])
    expect(val.step_runs).toEqual([{ id: "run-1", seq: 0, step_id: "step-1", status: "active", summary: "First pass" }])
    expect(val.participants).toEqual([{ id: "agent-1", name: "agent-1", run_id: "run-1", step_id: "step-1" }])
    expect(val.transitions).toEqual([
      {
        id: "step:step-1:run-1:0",
        seq: 0,
        level: "step",
        target_id: "step-1",
        run_id: "run-1",
        to_state: "active",
        reason: "Started",
      },
      {
        id: "workflow:workflow:::running:::|||||||",
        seq: 2,
        level: "workflow",
        target_id: "workflow",
        to_state: "running",
      },
    ])
  })

  test("merges delta-only partial v2 refs against prior state", () => {
    const val = mergeWorkflowProgress(
      {
        version: "workflow-progress.v2",
        workflow: { status: "running", name: "merge-refs" },
        machine: { active_step_id: "step-1" },
        step_definitions: [{ id: "step-1", label: "Plan" }],
        step_runs: [{ id: "run-1", step_id: "step-1", status: "active", summary: "First pass" }],
        participants: [{ id: "agent-1", step_id: "step-1", run_id: "run-1" }],
        transitions: [
          { id: "trans-1", seq: 0, level: "step", target_id: "step-1", run_id: "run-1", to_state: "active" },
        ],
      },
      {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", name: "merge-refs" },
        machine: { active_run_id: "run-1" },
        transitions: [
          {
            id: "trans-2",
            seq: 1,
            level: "step",
            target_id: "step-1",
            run_id: "run-1",
            to_state: "waiting",
            source: { participant_id: "agent-1", step_id: "step-1", run_id: "run-1" },
          },
        ],
      },
    )

    expect(val).toBeDefined()
    expect(val?.version).toBe("workflow-progress.v2")
    if (!val || val.version !== "workflow-progress.v2") throw new Error("expected merged v2 progress")
    expect(val.machine).toEqual({ active_step_id: "step-1", active_run_id: "run-1" })
    expect(val.participants).toEqual([{ id: "agent-1", name: "agent-1", run_id: "run-1", step_id: "step-1" }])
    expect(val.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "trans-1", run_id: "run-1", target_id: "step-1", to_state: "active" }),
        expect.objectContaining({
          id: "trans-2",
          run_id: "run-1",
          target_id: "step-1",
          to_state: "waiting",
          source: { participant_id: "agent-1", step_id: "step-1", run_id: "run-1" },
        }),
      ]),
    )
  })

  test("merges empty-array delta partial v2 refs against prior state", () => {
    const val = mergeWorkflowProgress(
      {
        version: "workflow-progress.v2",
        workflow: { status: "running", name: "merge-empty" },
        machine: { active_step_id: "step-1" },
        step_definitions: [{ id: "step-1", label: "Plan" }],
        step_runs: [{ id: "run-1", step_id: "step-1", status: "active" }],
        participants: [{ id: "agent-1", step_id: "step-1", run_id: "run-1" }],
        transitions: [
          { id: "trans-1", seq: 0, level: "step", target_id: "step-1", run_id: "run-1", to_state: "active" },
        ],
      },
      {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", name: "merge-empty" },
        machine: { active_run_id: "run-1" },
        step_definitions: [],
        step_runs: [],
        participants: [],
        transitions: [
          {
            id: "trans-2",
            seq: 1,
            level: "step",
            target_id: "step-1",
            run_id: "run-1",
            to_state: "waiting",
            source: { participant_id: "agent-1", step_id: "step-1", run_id: "run-1" },
          },
        ],
      },
    )

    expect(val).toBeDefined()
    expect(val?.version).toBe("workflow-progress.v2")
    if (!val || val.version !== "workflow-progress.v2") throw new Error("expected merged v2 progress")
    expect(val.machine).toEqual({ active_step_id: "step-1", active_run_id: "run-1" })
    expect(val.participants).toEqual([{ id: "agent-1", name: "agent-1", run_id: "run-1", step_id: "step-1" }])
    expect(val.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "trans-1", run_id: "run-1", target_id: "step-1", to_state: "active" }),
        expect.objectContaining({
          id: "trans-2",
          run_id: "run-1",
          target_id: "step-1",
          to_state: "waiting",
          source: { participant_id: "agent-1", step_id: "step-1", run_id: "run-1" },
        }),
      ]),
    )
  })

  test("drops malformed v2 payloads with unresolved graph references", () => {
    const meta = {
      [WorkflowProgressKey]: {
        version: "workflow-progress.v2",
        workflow: { status: "running", name: "implement" },
        machine: {
          root_step_id: "missing-root",
          active_step_id: "missing-step",
          active_run_id: "run-1",
        },
        step_definitions: [
          {
            id: "review",
            kind: "task",
            next: ["missing-next"],
          },
        ],
        step_runs: [
          {
            id: "run-1",
            step_id: "missing-step",
            status: "active",
            parent_run_id: "missing-parent",
          },
          {
            id: "run-2",
            step_id: "review",
            status: "completed",
          },
        ],
        transitions: [
          {
            timestamp: "2026-04-22T10:00:00.000Z",
            level: "step",
            target_id: "missing-step",
            run_id: "run-1",
            to_state: "active",
          },
          {
            timestamp: "2026-04-22T10:00:01.000Z",
            level: "workflow",
            target_id: "missing-machine",
            to_state: "running",
          },
        ],
      },
    }

    expect(parseWorkflowProgress(meta[WorkflowProgressKey])).toBeUndefined()
    expect(readWorkflowProgress(meta)).toBeUndefined()
    expect(normalizeWorkflowMetadata(meta)?.[WorkflowProgressKey]).toBeUndefined()
  })

  test("reuses normalized round titles for workflow history and keeps step summaries in alerts", () => {
    const norm = normalizeWorkflowProjectionInput({
      version: "workflow-progress.v2",
      workflow: { status: "waiting" },
      round: { status: "active", current: 2, max: 5 },
      machine: { active_step_id: "review" },
      step_definitions: [{ id: "review", kind: "task", label: "Review" }],
      step_runs: [{ step_id: "review", status: "waiting", summary: "Waiting on reviewer" }],
      transitions: [{ level: "workflow", to_state: "waiting" }],
    })

    expect(norm).toBeDefined()
    if (!norm) throw new Error("expected normalized projection input")

    const view = workflowproject({ progress: norm })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.header.round).toBe("Round 2/5")
    expect(view.history[0]).toMatchObject({ kind: "round", level: "workflow", round: "Round 2/5" })
    expect(view.alerts).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "step", summary: "Waiting on reviewer" })]),
    )
  })

  test("prefers workflow round text when a run has no round metadata", () => {
    const norm = normalizeWorkflowProjectionInput({
      version: "workflow-progress.v2",
      workflow: { status: "waiting" },
      round: { status: "active", current: 2, max: 5 },
      machine: { active_step_id: "review", active_run_id: "run-1" },
      step_definitions: [{ id: "review", kind: "task", label: "Review" }],
      step_runs: [{ id: "run-1", seq: 0, step_id: "review", status: "waiting" }],
      transitions: [
        { id: "trans-1", seq: 0, level: "step", target_id: "review", run_id: "run-1", to_state: "waiting" },
      ],
      participants: [],
    })

    expect(norm).toBeDefined()
    if (!norm) throw new Error("expected normalized projection input")
    expect(norm.step_runs[0]?.round_text).toBe(workflowfallback.round)
    expect(norm.transitions[0]?.round_text).toBe("Round 2/5")

    const view = workflowproject({ progress: norm })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.header.round).toBe("Round 2/5")
    expect(view.history[0]).toMatchObject({ kind: "change", level: "step", round: "Round 2/5" })
  })

  test("keeps timestamped workflow transitions as change rows even inside an active round", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "blocked", label: "Implement" },
        round: { status: "active", current: 2, max: 5 },
        machine: { active_step_id: "review" },
        step_definitions: [{ id: "review", kind: "decision", label: "Review" }],
        step_runs: [{ id: "run-1", seq: 0, step_id: "review", status: "blocked", reason: "Await approval" }],
        transitions: [
          {
            id: "flow-1",
            seq: 1,
            timestamp: "2026-04-23T10:00:00.000Z",
            level: "workflow",
            target_id: "workflow",
            to_state: "blocked",
            reason: "Await approval",
          },
        ],
      },
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.history[0]).toMatchObject({
      kind: "change",
      level: "workflow",
      timestamp: "2026-04-23T10:00:00.000Z",
      round: "Round 2/5",
    })
  })

  test("uses participant id before generic fallback titles", () => {
    const norm = normalizeWorkflowProjectionInput({
      version: "workflow-progress.v2",
      workflow: { status: "waiting" },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [],
      participants: [{ id: "agent-ralph" }],
    })

    expect(norm).toBeDefined()
    if (!norm) throw new Error("expected normalized projection input")
    expect(norm.participants[0]?.title).toBe("agent-ralph")
  })

  test("uses timestamp fallback when transitions omit event time", () => {
    const norm = normalizeWorkflowProjectionInput({
      version: "workflow-progress.v2",
      workflow: { status: "waiting", started_at: "2026-04-22T10:00:00.000Z" },
      machine: { updated_at: "2026-04-22T10:00:01.000Z" },
      step_definitions: [{ id: "review", kind: "task", label: "Review" }],
      step_runs: [
        { id: "run-1", seq: 0, step_id: "review", status: "waiting", started_at: "2026-04-22T10:00:02.000Z" },
      ],
      transitions: [
        { id: "trans-1", seq: 0, level: "step", target_id: "review", run_id: "run-1", to_state: "waiting" },
      ],
      participants: [],
    })

    expect(norm).toBeDefined()
    if (!norm) throw new Error("expected normalized projection input")
    expect(norm.transitions[0]?.timestamp_text).toBe(workflowfallback.timestamp)
  })

  test("workflowproject accepts raw v1 payloads", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v1",
        workflow: { status: "running", label: "Planning" },
        steps: [{ id: "plan", status: "active", label: "Plan step", reason: "Drafting" }],
      },
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.header.title).toBe("Planning")
    expect(view.timeline[0]).toMatchObject({ label: "Plan step", reason: "Drafting" })
  })

  test("workflowproject accepts raw partial v2 payloads", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", label: "Implement" },
        machine: { active_step_id: "write" },
        step_definitions: [{ id: "write", label: "Write code" }],
        step_runs: [{ step_id: "write", status: "waiting" }],
        transitions: [{ level: "step", target_id: "write", reason: "Awaiting input" }],
      },
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.header.title).toBe("Implement")
    expect(view.history[0]).toMatchObject({ label: "Write code", reason: "Awaiting input" })
  })

  test("workflowview preserves caller-supplied workflow names", () => {
    const view = workflowview({
      metadata: {
        [WorkflowProgressKey]: {
          version: "workflow-progress.v2",
          workflow: { status: "waiting" },
          machine: { active_step_id: "write" },
          step_definitions: [{ id: "write", label: "Write code" }],
          step_runs: [{ step_id: "write", status: "waiting" }],
          transitions: [{ level: "step", target_id: "write", reason: "Awaiting input" }],
        },
      },
      name: "Implement story",
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow view")
    expect(view.title).toBe("Workflow Implement story")
  })

  test("workflowproject normalizes header fallback fields for all consumers", () => {
    const view = workflowproject({
      progress: {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", input: "Need approval" },
        machine: { active_step_id: "write" },
        step_definitions: [{ id: "write", label: "Write code" }],
        step_runs: [{ step_id: "write", status: "waiting" }],
        transitions: [{ level: "step", target_id: "write", reason: "Awaiting input" }],
      },
      name: "Implement story",
    })

    expect(view).toBeDefined()
    if (!view) throw new Error("expected workflow projection")
    expect(view.header).toEqual({
      title: "Implement story",
      status: "waiting",
      phase: workflowfallback.phase,
      summary: "Need approval",
      started_at: workflowfallback.timestamp,
    })
  })

  test("preserves structurally empty v2 state-machine sections", () => {
    const val = WorkflowProgressV2.parse({
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
      },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [],
      participants: [],
    })

    expect(val).toEqual({
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
      },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [],
      participants: [],
    })
  })

  test("drops unsupported workflow progress versions at the metadata boundary", () => {
    const meta = normalizeWorkflowMetadata({
      keep: true,
      [WorkflowProgressKey]: {
        version: "workflow-progress.v3",
        workflow: {
          status: "running",
        },
      },
    })

    expect((meta as Record<string, unknown> | undefined)?.keep).toBe(true)
    expect(meta?.[WorkflowProgressKey]).toBeUndefined()
    expect(readWorkflowProgress(meta)).toBeUndefined()
    expect(
      readWorkflowProgress({
        [WorkflowProgressKey]: {
          version: "workflow-progress.v3",
          workflow: {
            status: "running",
          },
        },
      }),
    ).toBeUndefined()
  })

  test("throws when validating unsupported workflow progress metadata for persistence", () => {
    expect(() =>
      validateWorkflowMetadata({
        [WorkflowProgressKey]: {
          version: "workflow-progress.v3",
          workflow: {
            status: "running",
          },
        },
      }),
    ).toThrow("Unsupported workflow progress version")
  })

  test("rejects malformed v2 workflow metadata at the persistence boundary", () => {
    expect(() =>
      validateWorkflowMetadata({
        [WorkflowProgressKey]: {
          version: "workflow-progress.v2",
          workflow: {
            status: "running",
          },
          machine: {
            active_step_id: "step-1",
            active_run_id: "run-1",
          },
          step_definitions: [{ label: "Inspect" }],
          step_runs: [{ step_id: "step-1", status: "active" }],
          transitions: [{ level: "step", target_id: "step-1", to_state: "active" }],
        },
      }),
    ).toThrow()
  })

  test("returns undefined for malformed workflow progress metadata", () => {
    expect(
      readWorkflowProgress({
        [WorkflowProgressKey]: {
          version: "workflow-progress.v1",
          workflow: {
            status: "invalid",
          },
        },
      }),
    ).toBeUndefined()
  })

  test("drops malformed supported workflow progress during normalization", () => {
    const meta = normalizeWorkflowMetadata({
      keep: true,
      [WorkflowProgressKey]: {
        version: "workflow-progress.v1",
        workflow: {
          status: "invalid",
        },
      },
    })

    expect(meta).toMatchObject({ keep: true })
    expect(meta?.[WorkflowProgressKey]).toBeUndefined()
  })

  test("parses only supported workflow progress versions", () => {
    expect(
      parseWorkflowProgress({
        version: "workflow-progress.v1",
        workflow: {
          status: "running",
        },
      }),
    ).toEqual({
      version: "workflow-progress.v1",
      workflow: {
        status: "running",
      },
    })
    expect(
      parseWorkflowProgress({
        version: "workflow-progress.v2",
        workflow: {
          status: "running",
        },
        machine: {},
        step_definitions: [],
        step_runs: [],
        transitions: [],
        participants: [],
      }),
    ).toEqual({
      version: "workflow-progress.v2",
      workflow: {
        status: "running",
      },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [],
      participants: [],
    })
    expect(
      parseWorkflowProgress({
        version: "workflow-progress.v3",
        workflow: {
          status: "running",
        },
      }),
    ).toBeUndefined()
  })

  test("exports version constants and v2 schema", () => {
    expect(WorkflowProgressV1VersionValue).toBe("workflow-progress.v1")
    expect(WorkflowProgressV2VersionValue).toBe("workflow-progress.v2")
    expect(
      WorkflowProgressV2.parse({
        version: "workflow-progress.v2",
        workflow: { status: "running" },
        machine: {},
        step_definitions: [],
        step_runs: [],
        transitions: [],
        participants: [],
      }),
    ).toEqual({
      version: "workflow-progress.v2",
      workflow: { status: "running" },
      machine: {},
      step_definitions: [],
      step_runs: [],
      transitions: [],
      participants: [],
    })
  })
})
