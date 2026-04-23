import { expect, test } from "bun:test"
import path from "path"

const dir = path.join(import.meta.dir, "../..")

test("workflow route repaints runtime projection updates through session props", () => {
  const run = Bun.spawnSync(
    [
      "bun",
      "-e",
      `
import { mock } from "bun:test"
import "@opentui/solid/preload"
import { RGBA } from "@opentui/core"
import { createComponent, testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { WorkflowProgressKey } from "@lark-opencode/workflow-api"

mock.module("@tui/context/theme", () => {
  const theme = {
    backgroundPanel: RGBA.fromHex("#111111"),
    background: RGBA.fromHex("#000000"),
    text: RGBA.fromHex("#ffffff"),
    textMuted: RGBA.fromHex("#999999"),
    error: RGBA.fromHex("#ff0000"),
  }
  return {
    useTheme() {
      return {
        theme,
      }
    },
    selectedForeground(theme) {
      return theme.text
    },
    tint() {
      return RGBA.fromHex("#ffffff")
    },
    DEFAULT_THEMES: {},
    ThemeProvider(props) {
      return props.children
    },
  }
  },
  15000,
)

const { SessionToolRoute, sessiontoolprops } = await import("./src/cli/cmd/tui/routes/session/index")
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
}
const meta = { [WorkflowProgressKey]: progress }
const part = (metadata = {}) => ({
  id: "part-workflow",
  sessionID: "sess-1",
  messageID: "msg-1",
  callID: "call-1",
  type: "tool",
  tool: "workflow",
  state: {
    status: "running",
    title: "Workflow demo",
    input: { name: "demo" },
    output: "transcript fallback should stay hidden",
    metadata,
    time: { start: 0, end: 1 },
  },
})

let setpart
const view = await testRender(
  () => {
    const [tool, settool] = createSignal(part())
    setpart = settool
    return createComponent(
      SessionToolRoute,
      sessiontoolprops({
        part: tool,
      }),
    )
  },
  { width: 80, height: 20 },
)

await view.renderOnce()
const first = view.captureCharFrame()
setpart(part(meta))
await Bun.sleep(0)
await view.renderOnce()
const second = view.captureCharFrame()
view.renderer.destroy()
process.stdout.write(JSON.stringify({ first, second }))
process.exit(0)
      `,
    ],
    {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    },
  )

  expect(run.exitCode).toBe(0)
  const out = JSON.parse(run.stdout.toString()) as { first: string; second: string }

  expect(out.first).toContain("# Workflow demo")
  expect(out.first).toContain("No workflow state yet.")
  expect(out.first).not.toContain("Demo Flow")
  expect(out.second).toContain("# Workflow Demo Flow")
  expect(out.second).toContain("Demo Flow")
  expect(out.second).toContain("Working through the plan")
  expect(out.second).toContain("Step: Plan")
  expect(out.second).not.toContain("No workflow state yet.")
  expect(out.second).not.toContain("transcript fallback should stay hidden")
})
