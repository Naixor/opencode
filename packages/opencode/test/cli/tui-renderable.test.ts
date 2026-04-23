import { expect, test } from "bun:test"
import { WorkflowProgressKey } from "@lark-opencode/workflow-api"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import path from "path"
import { workflowtoolview } from "../../src/cli/cmd/tui/routes/session/workflow-tool-view"

const root = path.join(__dirname, "../..")
const tui = path.join(root, "src", "cli", "cmd", "tui")

const progress = {
  version: "workflow-progress.v2",
  workflow: {
    status: "running",
    name: "demo",
    label: "Demo Flow",
    summary: "Working through the plan",
  },
  machine: {
    id: "demo",
    active_step_id: "step-1",
    active_run_id: "run-1",
  },
  step_definitions: [{ id: "step-1", kind: "task", label: "Plan" }],
  step_runs: [{ id: "run-1", seq: 0, step_id: "step-1", status: "active", summary: "Planning" }],
  transitions: [{ id: "trans-1", seq: 0, level: "step", target_id: "step-1", run_id: "run-1", to_state: "active" }],
  participants: [],
} as const

test("TUI custom components do not pass explicit children props", async () => {
  const files = await Array.fromAsync(
    new Bun.Glob("**/*.tsx").scan({
      cwd: tui,
      absolute: true,
      onlyFiles: true,
    }),
  )

  const hits = (
    await Promise.all(
      files.map(async (file) => {
        const text = await Bun.file(file).text()
        return Array.from(text.matchAll(/<([A-Z][A-Za-z0-9]*)\b[^>]*\bchildren=\{/g)).map(
          (item) => `${path.relative(root, file)}:${item[1]}`,
        )
      }),
    )
  ).flat()

  expect(hits).toEqual([])
})

test("session inline spinner renders children through JSX slot", async () => {
  const file = path.join(tui, "routes", "session", "index.tsx")
  const text = await Bun.file(file).text()

  expect(text).toContain("<Spinner color={fg()}>{label()}</Spinner>")
  expect(text).not.toContain("<Spinner color={fg()} children={props.label} />")
})

test("session route stringifies risky text payloads before rendering", async () => {
  const file = path.join(tui, "routes", "session", "index.tsx")
  const text = await Bun.file(file).text()

  expect(text).toContain("<text fg={theme.textMuted}>{str(props.message.error?.data.message)}</text>")
  expect(text).toContain("<text fg={theme.error}>{str(error())}</text>")
  expect(text).toContain("<text fg={theme.textMuted}>{str(q.question)}</text>")
  expect(text).toContain("function str<T>(input: T)")
  expect(text).toContain("return JSON.stringify(input)")
})

test("workflow tool keeps projection view reactive in source", async () => {
  const file = path.join(tui, "routes", "session", "workflow-tool.tsx")
  const text = await Bun.file(file).text()

  expect(text).toContain("const dim = useTerminalDimensions()")
  expect(text).toContain("const width = createMemo(() => Math.max(40, dim().width - 3))")
  expect(text).toContain("const view = createMemo(() => workflowtoolview({ ...props, width: width() }))")
  expect(text).toContain("{view().title}")
  expect(text).toContain("<For each={view().lines}>")
})

test("session workflow tool renders projection state and zero-data fallback", async () => {
  const active = workflowtoolview({
    input: { name: "demo" },
    metadata: {
      [WorkflowProgressKey]: progress,
    },
    part: {
      id: "part-workflow",
      sessionID: "sess-1",
      messageID: "msg-1",
      callID: "call-1",
      type: "tool",
      tool: "workflow",
      state: {
        status: "completed",
        title: "Workflow demo",
        input: { name: "demo" },
        output: "transcript fallback should stay hidden",
        metadata: {
          [WorkflowProgressKey]: progress,
        },
        time: { start: 0, end: 1 },
      },
    } as ToolPart,
  })

  expect(active.lines.join("\n")).toContain("[header]")
  expect(active.lines.join("\n")).toContain("Workflow: Demo Flow")
  expect(active.lines.join("\n")).toContain("Summary: Working through the plan")
  expect(active.lines.join("\n")).toContain("[timeline]")
  expect(active.lines.join("\n")).toContain("Step: Plan · active")
  expect(active.lines.join("\n")).not.toContain("transcript fallback should stay hidden")

  const empty = workflowtoolview({
    input: { name: "demo" },
    metadata: {},
    part: {
      id: "part-empty",
      sessionID: "sess-1",
      messageID: "msg-1",
      callID: "call-2",
      type: "tool",
      tool: "workflow",
      state: {
        status: "completed",
        title: "Workflow demo",
        input: { name: "demo" },
        output: "transcript fallback should stay hidden",
        metadata: {},
        time: { start: 0, end: 1 },
      },
    } as ToolPart,
  })

  expect(empty.title).toBe("# Workflow demo")
  expect(empty.lines.join("\n")).toContain("No workflow state yet.")
  expect(empty.lines.join("\n")).toContain("Workflow: demo")
  expect(empty.lines.join("\n")).not.toContain("transcript fallback should stay hidden")
})
