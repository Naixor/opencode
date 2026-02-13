import { describe, test, expect } from "bun:test"
import { BuiltIn } from "@/plugin/builtin"

describe("BuiltIn", () => {
  test("has() returns true for shipped features", () => {
    expect(BuiltIn.has("ast-grep")).toBe(true)
    expect(BuiltIn.has("lsp-rename")).toBe(true)
    expect(BuiltIn.has("look-at")).toBe(true)
    expect(BuiltIn.has("context-injection")).toBe(true)
    expect(BuiltIn.has("todo-continuation")).toBe(true)
    expect(BuiltIn.has("comment-checker")).toBe(true)
    expect(BuiltIn.has("session-recovery")).toBe(true)
  })

  test("has() returns false for non-existent features", () => {
    expect(BuiltIn.has("nonexistent-feature")).toBe(false)
    expect(BuiltIn.has("")).toBe(false)
    expect(BuiltIn.has("AST-GREP")).toBe(false)
  })
})
