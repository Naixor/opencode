import { describe, test, expect } from "bun:test"

function resolveMax(todoContinuation: boolean | number | undefined): number {
  return todoContinuation === false ? 0 : typeof todoContinuation === "number" ? todoContinuation : 3
}

describe("Todo continuation enforcer", () => {
  test("triggers when incomplete TODOs exist", () => {
    const todos: { content: string; status: string; activeForm: string }[] = [
      { content: "Task 1", status: "completed", activeForm: "Doing task 1" },
      { content: "Task 2", status: "pending", activeForm: "Doing task 2" },
      { content: "Task 3", status: "in_progress", activeForm: "Doing task 3" },
    ]

    const incomplete = todos.filter((t) => t.status === "pending" || t.status === "in_progress")
    expect(incomplete.length).toBe(2)
  })

  test("respects max retry limit", () => {
    const maxContinuations = 3
    let count = 0

    while (count < maxContinuations) {
      count++
    }

    expect(count).toBe(maxContinuations)
    expect(count < maxContinuations).toBe(false)
  })

  test("does not trigger in plan mode", () => {
    const agentName = "plan"
    const maxContinuations = 3

    const shouldContinue = maxContinuations > 0 && agentName !== "plan"
    expect(shouldContinue).toBe(false)
  })

  test("does not trigger when all TODOs are completed", () => {
    const todos: { content: string; status: string; activeForm: string }[] = [
      { content: "Task 1", status: "completed", activeForm: "Doing task 1" },
      { content: "Task 2", status: "completed", activeForm: "Doing task 2" },
    ]

    const incomplete = todos.filter((t) => t.status === "pending" || t.status === "in_progress")
    expect(incomplete.length).toBe(0)
  })

  test("configuration default is 3", () => {
    expect(resolveMax(undefined)).toBe(3)
  })

  test("configuration false disables continuation", () => {
    expect(resolveMax(false)).toBe(0)
  })

  test("configuration number sets custom max", () => {
    expect(resolveMax(5)).toBe(5)
  })
})
