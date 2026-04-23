import { afterEach, expect, mock, test } from "bun:test"
import { RGBA } from "@opentui/core"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import "@opentui/solid/preload"
import { createComponent, testRender } from "@opentui/solid"

afterEach(() => {
  mock.restore()
})

function mocktheme() {
  mock.module("@tui/context/theme", () => ({
    useTheme() {
      return {
        theme: {
          backgroundPanel: RGBA.fromHex("#111111"),
          background: RGBA.fromHex("#000000"),
          text: RGBA.fromHex("#ffffff"),
          textMuted: RGBA.fromHex("#999999"),
          error: RGBA.fromHex("#ff0000"),
        },
      }
    },
  }))
}

function workflowpart(input?: { status?: string; metadata?: Record<string, unknown>; error?: string }): ToolPart {
  return {
    id: "part-workflow",
    sessionID: "sess-1",
    messageID: "msg-1",
    callID: "call-1",
    type: "tool",
    tool: "workflow",
    state: {
      status: input?.status ?? "error",
      title: "Workflow demo",
      input: { name: "demo" },
      output: "transcript fallback should stay hidden",
      metadata: input?.metadata ?? {},
      ...(input?.error !== undefined ? { error: input.error } : {}),
      time: { start: 0, end: 1 },
    },
  } as ToolPart
}

test("workflow tool ignores blank error text in error state", async () => {
  mocktheme()
  const { WorkflowTool } = await import("../../src/cli/cmd/tui/routes/session/workflow-tool")
  const view = await testRender(
    () =>
      createComponent(WorkflowTool, {
        input: { name: "demo" },
        metadata: {},
        part: workflowpart({ error: "   " }),
      }),
    { width: 80, height: 20 },
  )

  try {
    await view.renderOnce()
    const frame = view.captureCharFrame()

    expect(frame).toContain("# Workflow demo")
    expect(frame).toContain("No workflow state yet.")
    expect(frame).not.toContain("transcript fallback should stay hidden")
  } finally {
    view.renderer.destroy()
  }
})
