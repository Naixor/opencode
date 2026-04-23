import { describe, expect, test } from "bun:test"
import { workflowfallback } from "@lark-opencode/workflow-api/presentation"
import { workflowshell } from "../../src/cli/cmd/tui/routes/session/workflow-shell"
import { renderpage } from "./workflow-screen-browser"
import { renderfixture, workflowfixtures } from "./workflow-screen-harness"

function order(text: string, keys: string[]) {
  return keys.map((item) => text.indexOf(item))
}

describe("workflowshell", () => {
  test("keeps stable region order at 120 and 80 columns", () => {
    ;([120, 80] as const).forEach((width) => {
      const shell = renderfixture("running", width)
      const text = shell.lines.join("\n")
      const hit = order(text, ["[header]", "[timeline]", "[agents]", "[history]", "[alerts]"])

      expect(shell.layout).toBe(width === 120 ? "wide" : "stacked")
      expect(hit.every((item) => item >= 0)).toBe(true)
      expect([...hit].sort((a, b) => a - b)).toEqual(hit)
      expect(shell.lines.every((line) => line.length <= width)).toBe(true)
    })
  })

  test("renders every harness fixture at 80 and 120 columns", () => {
    Object.keys(workflowfixtures).forEach((name) => {
      ;([80, 120] as const).forEach((width) => {
        const shell = renderfixture(name as keyof typeof workflowfixtures, width)
        expect(shell.title).toContain("# Workflow")
        expect(shell.lines.length).toBeGreaterThan(4)
      })
    })
  })

  test("exports one browser page from the same fixture loader", () => {
    const page = renderpage()

    expect(page).toContain("workflow-screen-harness")
    expect(page).toContain("white-space:pre")
    expect(page).not.toContain("pre-wrap")
    Object.keys(workflowfixtures).forEach((name) => {
      expect(page).toContain(`data-fixture="${name}"`)
    })
    ;([80, 120] as const).forEach((width) => {
      expect(page).toContain(`data-width="${width}"`)
      expect(page).toContain(`style="width:${width}ch"`)
    })
  })

  test("shows explicit empty and inactive workflow states with shared fallback tokens", () => {
    const empty = renderfixture("empty", 80).lines.join("\n")
    const inactive = renderfixture("inactive", 80).lines.join("\n")

    expect(empty).toContain(`No ${workflowfallback.workflow} state yet.`)
    expect(empty).toContain(`Summary: ${workflowfallback.reason}`)
    expect(empty).toContain(`Phase: ${workflowfallback.phase}`)
    expect(empty).toContain(`Step: ${workflowfallback.step} · pending`)
    expect(inactive).toContain(`No active ${workflowfallback.workflow}.`)
    expect(inactive).toContain(`Workflow: ${workflowfallback.workflow}`)
  })

  test("reads header lines from the header projection region", () => {
    const shell = workflowshell({
      width: 80,
      view: {
        mode: "projection",
        empty: false,
        state: "failed",
        header: {
          title: "Demo Flow",
          status: "done",
          phase: workflowfallback.phase,
          summary: workflowfallback.reason,
          started_at: workflowfallback.timestamp,
        },
        timeline: [],
        agents: [],
        history: [],
        alerts: [],
      },
    })

    expect(shell.lines.join("\n")).toContain("Status: ✓ DONE")
  })

  test("visibly distinguishes workflow states in the header", () => {
    expect(renderfixture("running", 80).lines.join("\n")).toContain("Status: • RUNNING")
    expect(renderfixture("waiting", 80).lines.join("\n")).toContain("Status: … WAITING")
    expect(renderfixture("blocked", 80).lines.join("\n")).toContain("Status: ! BLOCKED")
    expect(renderfixture("failed", 80).lines.join("\n")).toContain("Status: ✗ FAILED")
    expect(renderfixture("done", 80).lines.join("\n")).toContain("Status: ✓ DONE")
  })

  test("preserves fallback and partial metadata states in the harness", () => {
    const legacy = renderfixture("v1", 120).lines.join("\n")
    const partial = renderfixture("partial", 120).lines.join("\n")

    expect(legacy).toContain("Legacy Flow")
    expect(legacy).toContain("Review")
    expect(partial).toContain("Partial Flow")
    expect(partial).toContain("Write code -> waiting")
  })
})
