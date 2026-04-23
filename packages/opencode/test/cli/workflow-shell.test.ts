import { describe, expect, test } from "bun:test"
import { workflowfallback } from "@lark-opencode/workflow-api/presentation"
import { workflowshell } from "../../src/cli/cmd/tui/routes/session/workflow-shell"
import { renderpage } from "./workflow-screen-browser"
import { renderfixture, workflowfixtures } from "./workflow-screen-harness"

function order(text: string, keys: string[]) {
  return keys.map((item) => text.indexOf(item))
}

function section(text: string, key: string, next: string) {
  const start = text.indexOf(key)
  const end = text.indexOf(next)
  return text.slice(start, end >= 0 ? end : undefined)
}

function timelinearea(input: {
  shell: ReturnType<typeof renderfixture> | ReturnType<typeof workflowshell>
  width: 80 | 120
}) {
  if (input.shell.layout === "stacked") return section(input.shell.lines.join("\n"), "[timeline]", "[agents]")
  const cell = Math.max(1, Math.floor((input.width - 3) / 2))
  const start = input.shell.lines.findIndex((line) => line.includes("[timeline]"))
  const end = input.shell.lines.findIndex((line) => line.includes("[history]"))
  return input.shell.lines
    .slice(start, end)
    .map((line) => line.slice(0, cell))
    .join("\n")
}

function agentsarea(input: {
  shell: ReturnType<typeof renderfixture> | ReturnType<typeof workflowshell>
  width: 80 | 120
}) {
  if (input.shell.layout === "stacked") return section(input.shell.lines.join("\n"), "[agents]", "[history]")
  const cell = Math.max(1, Math.floor((input.width - 3) / 2))
  const start = input.shell.lines.findIndex((line) => line.includes("[timeline]"))
  const end = input.shell.lines.findIndex((line) => line.includes("[history]"))
  return input.shell.lines
    .slice(start, end)
    .map((line) => line.slice(cell + 3))
    .join("\n")
}

function frame(name: keyof typeof workflowfixtures, width: 80 | 120) {
  return [renderfixture(name, width).title, ...renderfixture(name, width).lines]
    .map((line) => line.trimEnd())
    .join("\n")
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
    expect(empty).toContain(`- ○ ${workflowfallback.step} · pending`)
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

  test("renders the timeline from the timeline projection region only", () => {
    ;([80, 120] as const).forEach((width) => {
      const shell = workflowshell({
        width,
        view: {
          mode: "projection",
          empty: false,
          state: "running",
          notice: "outside timeline",
          timeline_note: "inside timeline",
          header: {
            title: "Demo Flow",
            status: "done",
            phase: "Ship",
            summary: "header only",
            started_at: workflowfallback.timestamp,
          },
          timeline: [
            {
              id: "wait",
              step_id: "wait",
              label: "Await QA",
              kind: "wait",
              status: "waiting",
              active: true,
              depth: 1,
              reason: "Waiting for input",
            },
          ],
          agents: [
            {
              id: "agent-1",
              name: "Agent From Agents",
              status: "running",
              action: "agents only",
              active: true,
            },
          ],
          history: [
            {
              id: "hist-1",
              timestamp: workflowfallback.timestamp,
              level: "step",
              target_id: "wait",
              label: "History Label",
              to_state: "waiting",
            },
          ],
          alerts: [
            {
              id: "alert-1",
              level: "step",
              status: "waiting",
              title: "Alert Title",
            },
          ],
        },
      })

      const area = timelinearea({ shell, width })

      expect(area).toContain("inside timeline")
      expect(area).toContain("> … [wait] Await QA · waiting · Waiting for input")
      expect(area).not.toContain("outside timeline")
      expect(area).not.toContain("Agent From Agents")
      expect(area).not.toContain("History Label")
      expect(area).not.toContain("Alert Title")
      expect(area).not.toContain("header only")
    })
  })

  test("renders the agents panel from the agents projection region only", () => {
    ;([80, 120] as const).forEach((width) => {
      const shell = workflowshell({
        width,
        view: {
          mode: "projection",
          empty: false,
          state: "running",
          notice: "outside agents",
          timeline_note: "timeline only",
          header: {
            title: "Demo Flow",
            status: "done",
            phase: "Ship",
            summary: "header only",
            started_at: workflowfallback.timestamp,
          },
          timeline: [
            {
              id: "wait",
              step_id: "wait",
              label: "Await QA",
              kind: "wait",
              status: "waiting",
              active: true,
              depth: 1,
              reason: "Waiting for input",
            },
          ],
          agents: [
            {
              id: "agent-1",
              name: workflowfallback.agent,
              role: "Reviewer",
              status: "waiting",
              summary: workflowfallback.reason,
              active: true,
            },
            {
              id: "agent-2",
              name: "blocked-agent",
              status: "blocked",
              action: "Need approval",
              active: false,
            },
            {
              id: "agent-3",
              name: "retrying-agent",
              status: "retrying",
              action: "Retrying step",
              active: true,
            },
            {
              id: "agent-4",
              name: "done-agent",
              status: "completed",
              summary: "Merged",
              active: false,
            },
          ],
          history: [
            {
              id: "hist-1",
              timestamp: workflowfallback.timestamp,
              level: "step",
              target_id: "wait",
              label: "History Label",
              to_state: "waiting",
            },
          ],
          alerts: [
            {
              id: "alert-1",
              level: "step",
              status: "waiting",
              title: "Alert Title",
            },
          ],
        },
      })

      const area = agentsarea({ shell, width })

      expect(area).toContain(`Agent: Reviewer · … WAITING · ${workflowfallback.reason}`)
      expect(area).toContain("Agent: blocked-agent · ! BLOCKED · Need approval")
      expect(area).toContain("Agent: retrying-agent · ↻ RETRYING · Retrying step")
      expect(area).toContain("Agent: done-agent · ✓ DONE · Merged")
      expect(area).not.toContain("timeline only")
      expect(area).not.toContain("header only")
      expect(area).not.toContain("History Label")
      expect(area).not.toContain("Alert Title")
    })
  })

  test("shows only the active branch plus active group children in the running fixture", () => {
    ;([80, 120] as const).forEach((width) => {
      const text = renderfixture("running", width).lines.join("\n")

      expect(text).toContain("- ✓ Plan · done · Plan approved")
      expect(text).toContain("  - • [group] Review · active · Parallel checks")
      expect(text).toContain("    > • Lint · active · Linting changes")
      expect(text).toContain("    - … [wait] Await QA · waiting · Waiting for QA slot")
      expect(text).not.toContain("Docs")
    })
  })

  test("matches golden frames for active-path fixtures at 80 columns", () => {
    expect(frame("running", 80)).toBe(`# Workflow Running Flow
[header]
Workflow: Running Flow
Summary: Flow is running
Status: • RUNNING
Phase: Execute
Started: time unknown
Round: Round 2/4
[timeline]
- ✓ Plan · done · Plan approved
  - • [group] Review · active · Parallel checks
    > • Lint · active · Linting changes
    - … [wait] Await QA · waiting · Waiting for QA slot
[agents]
Agent: running-agent · • ACTIVE · Linting changes
[history]
Latest: time unknown · Await QA -> waiting · Waiting for QA slot
Latest: time unknown · Lint -> active · Linting changes
Latest: time unknown · Review -> active · Parallel checks
Latest: time unknown · Plan -> completed · Plan approved
[alerts]
Alert: running · Running Flow · Flow is running`)
    expect(frame("waiting", 80)).toBe(`# Workflow Waiting Flow
[header]
Workflow: Waiting Flow
Summary: Flow is waiting
Status: … WAITING
Phase: Execute
Started: time unknown
Round: Round 2/4
[timeline]
> … [wait] Review · waiting · waiting reason
[agents]
Agent: waiting-agent · … WAITING · waiting reason
[history]
Latest: time unknown · Review -> waiting · waiting reason
[alerts]
Alert: waiting · Waiting Flow · Flow is waiting
Alert: waiting · Review · waiting reason`)
    expect(frame("blocked", 80)).toBe(`# Workflow Blocked Flow
[header]
Workflow: Blocked Flow
Summary: Flow is blocked
Status: ! BLOCKED
Phase: Execute
Started: time unknown
Round: Round 2/4
[timeline]
> ! [decision] Review · blocked · blocked reason
[agents]
Agent: blocked-agent · ! BLOCKED · blocked reason
[history]
Latest: time unknown · Review -> blocked · blocked reason
[alerts]
Alert: blocked · Blocked Flow · Flow is blocked
Alert: blocked · Review · blocked reason`)
    expect(frame("retrying", 80)).toBe(`# Workflow Retrying Flow
[header]
Workflow: Retrying Flow
Summary: Flow is retrying
Status: ↻ RETRYING
Phase: Execute
Started: time unknown
Round: Round 2/4
[timeline]
> ↻ Review · retrying · Retry 2 · retrying reason
[agents]
Agent: retrying-agent · ↻ RETRYING · retrying reason
[history]
Latest: time unknown · Review -> retrying · retrying reason
[alerts]
Alert: retrying · Retrying Flow · Flow is retrying
Alert: retrying · Review · retrying reason`)
    expect(frame("failed", 80)).toBe(`# Workflow Failed Flow
[header]
Workflow: Failed Flow
Summary: Flow is failed
Status: ✗ FAILED
Phase: Execute
Started: time unknown
Round: Round 2/4
[timeline]
> ✗ Review · failed · failed reason
[agents]
Agent: failed-agent · ✗ FAILED · failed reason
[history]
Latest: time unknown · Review -> failed · failed reason
[alerts]
Alert: failed · Failed Flow · Flow is failed
Alert: failed · Review · failed reason`)
    expect(frame("done", 80)).toBe(`# Workflow Done Flow
[header]
Workflow: Done Flow
Summary: Flow is done
Status: ✓ DONE
Phase: Execute
Started: time unknown
Round: Round 2/4
[timeline]
> ✓ [terminal] Ship · done · done reason
[agents]
Agent: done-agent · ✓ DONE · done reason
[history]
Latest: time unknown · Ship -> completed · done reason
[alerts]
Alert: done · Done Flow · Flow is done`)
  })

  test("matches golden frames for active-path fixtures at 120 columns", () => {
    expect(frame("running", 120)).toBe(`# Workflow Running Flow
[header]
Workflow: Running Flow
Summary: Flow is running
Status: • RUNNING
Phase: Execute
Started: time unknown
Round: Round 2/4
[timeline]                                                   [agents]
- ✓ Plan · done · Plan approved                              Agent: running-agent · • ACTIVE · Linting changes
  - • [group] Review · active · Parallel checks
    > • Lint · active · Linting changes
    - … [wait] Await QA · waiting · Waiting for QA slot
[history]                                                    [alerts]
Latest: time unknown · Await QA -> waiting · Waiting for …   Alert: running · Running Flow · Flow is running
Latest: time unknown · Lint -> active · Linting changes
Latest: time unknown · Review -> active · Parallel checks
Latest: time unknown · Plan -> completed · Plan approved`)
    expect(frame("waiting", 120)).toBe(`# Workflow Waiting Flow
[header]
Workflow: Waiting Flow
Summary: Flow is waiting
Status: … WAITING
Phase: Execute
Started: time unknown
Round: Round 2/4
[timeline]                                                   [agents]
> … [wait] Review · waiting · waiting reason                 Agent: waiting-agent · … WAITING · waiting reason
[history]                                                    [alerts]
Latest: time unknown · Review -> waiting · waiting reason    Alert: waiting · Waiting Flow · Flow is waiting
                                                             Alert: waiting · Review · waiting reason`)
    expect(frame("blocked", 120)).toBe(`# Workflow Blocked Flow
[header]
Workflow: Blocked Flow
Summary: Flow is blocked
Status: ! BLOCKED
Phase: Execute
Started: time unknown
Round: Round 2/4
[timeline]                                                   [agents]
> ! [decision] Review · blocked · blocked reason             Agent: blocked-agent · ! BLOCKED · blocked reason
[history]                                                    [alerts]
Latest: time unknown · Review -> blocked · blocked reason    Alert: blocked · Blocked Flow · Flow is blocked
                                                             Alert: blocked · Review · blocked reason`)
    expect(frame("retrying", 120)).toBe(`# Workflow Retrying Flow
[header]
Workflow: Retrying Flow
Summary: Flow is retrying
Status: ↻ RETRYING
Phase: Execute
Started: time unknown
Round: Round 2/4
[timeline]                                                   [agents]
> ↻ Review · retrying · Retry 2 · retrying reason            Agent: retrying-agent · ↻ RETRYING · retrying reason
[history]                                                    [alerts]
Latest: time unknown · Review -> retrying · retrying reas…   Alert: retrying · Retrying Flow · Flow is retrying
                                                             Alert: retrying · Review · retrying reason`)
    expect(frame("failed", 120)).toBe(`# Workflow Failed Flow
[header]
Workflow: Failed Flow
Summary: Flow is failed
Status: ✗ FAILED
Phase: Execute
Started: time unknown
Round: Round 2/4
[timeline]                                                   [agents]
> ✗ Review · failed · failed reason                          Agent: failed-agent · ✗ FAILED · failed reason
[history]                                                    [alerts]
Latest: time unknown · Review -> failed · failed reason      Alert: failed · Failed Flow · Flow is failed
                                                             Alert: failed · Review · failed reason`)
    expect(frame("done", 120)).toBe(`# Workflow Done Flow
[header]
Workflow: Done Flow
Summary: Flow is done
Status: ✓ DONE
Phase: Execute
Started: time unknown
Round: Round 2/4
[timeline]                                                   [agents]
> ✓ [terminal] Ship · done · done reason                     Agent: done-agent · ✓ DONE · done reason
[history]                                                    [alerts]
Latest: time unknown · Ship -> completed · done reason       Alert: done · Done Flow · Flow is done`)
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
    expect(partial).toContain("> … Write code · waiting")
  })
})
