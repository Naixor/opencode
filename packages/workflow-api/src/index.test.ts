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
  WorkflowProgressV2,
  WorkflowRoundStatus,
  WorkflowStepKind,
  WorkflowStatus,
  WorkflowStepStatus,
  mergeWorkflowProgress,
  normalizeWorkflowMetadata,
  parseWorkflowProgress,
  readWorkflowProgress,
  validateWorkflowMetadata,
  workflowDisplayStatus,
  type WorkflowProgress as WorkflowProgressShape,
} from "./index"
import { workflowicon, workflowproject, workflowview, type WorkflowProjection } from "./presentation"

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
        { id: "child", kind: "task", parent_id: "other" },
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
    expect(out.error.issues.some((item) => item.path.join(".") === "step_definitions.1.parent_id")).toBe(true)
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

  test("readWorkflowProgress rejects minimal v2 metadata", () => {
    expect(
      readWorkflowProgress({
        [WorkflowProgressKey]: {
          version: "workflow-progress.v2",
          workflow: { status: "running", name: "demo" },
        },
      }),
    ).toBeUndefined()
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

  test("rejects partial v2 payloads that omit producer-owned ids and ordering", () => {
    const meta = {
      [WorkflowProgressKey]: {
        version: "workflow-progress.v2",
        workflow: { status: "waiting", label: "Implement" },
        machine: { active_step_id: "write" },
        step_definitions: [{ id: "write", label: "Write code" }],
        step_runs: [{ step_id: "write", status: "running" }],
        transitions: [{ level: "step", target_id: "write", reason: "Awaiting input" }],
      },
    }

    expect(parseWorkflowProgress(meta[WorkflowProgressKey])).toBeUndefined()
    expect(readWorkflowProgress(meta)).toBeUndefined()
    expect(normalizeWorkflowMetadata(meta)?.[WorkflowProgressKey]).toBeUndefined()
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
