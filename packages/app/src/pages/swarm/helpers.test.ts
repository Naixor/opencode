import { describe, expect, test } from "bun:test"
import { ago, consensusTone, filterTasks, stateTone, taskTone } from "./helpers"

describe("swarm helpers", () => {
  test("formats relative time", () => {
    expect(ago(9_500, 10_000)).toBe("just now")
    expect(ago(0)).toBe("-")
    expect(ago(60_000, 180_000)).toBe("2m ago")
    expect(ago(0, 7_200_000)).toBe("-")
    expect(ago(0, 0)).toBe("-")
  })

  test("filters tasks by local controls", () => {
    const list = [
      { assignee: "PM", status: "pending", type: "implement" },
      { assignee: "RD", status: "in_progress", type: "review" },
    ]
    expect(filterTasks(list, { assignee: "RD", status: "", type: "" })).toHaveLength(1)
    expect(filterTasks(list, { assignee: "", status: "pending", type: "implement" })).toHaveLength(1)
    expect(filterTasks(list, { assignee: "", status: "failed", type: "" })).toHaveLength(0)
  })

  test("returns stable tone classes", () => {
    expect(stateTone("blocked")).toContain("amber")
    expect(consensusTone("no_consensus")).toContain("red")
    expect(taskTone("in_progress", false)).toContain("sky")
    expect(taskTone("pending", true)).toContain("amber")
  })
})
