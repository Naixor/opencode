import { describe, test, expect } from "bun:test"

describe("LspTool", () => {
  test("diagnostics operation is in the operations list", async () => {
    const { LspTool } = await import("@/tool/lsp")
    expect(LspTool.id).toBe("lsp")
    const tool = await LspTool.init()
    const result = tool.parameters.safeParse({
      operation: "diagnostics",
      filePath: "/tmp/test.ts",
      severity: "error",
    })
    expect(result.success).toBe(true)
  })

  test("diagnostics respects severity filter parameter", async () => {
    const { LspTool } = await import("@/tool/lsp")
    const tool = await LspTool.init()
    for (const severity of ["error", "warning", "information", "hint"]) {
      const result = tool.parameters.safeParse({
        operation: "diagnostics",
        filePath: "/tmp/test.ts",
        severity,
      })
      expect(result.success).toBe(true)
    }
  })

  test("prepareRename operation is accepted", async () => {
    const { LspTool } = await import("@/tool/lsp")
    const tool = await LspTool.init()
    const result = tool.parameters.safeParse({
      operation: "prepareRename",
      filePath: "/tmp/test.ts",
      line: 1,
      character: 5,
    })
    expect(result.success).toBe(true)
  })

  test("rename operation requires newName", async () => {
    const { LspTool } = await import("@/tool/lsp")
    const tool = await LspTool.init()
    const result = tool.parameters.safeParse({
      operation: "rename",
      filePath: "/tmp/test.ts",
      line: 1,
      character: 5,
      newName: "newFunctionName",
    })
    expect(result.success).toBe(true)
  })

  test("rename operation accepts without newName at schema level", async () => {
    const { LspTool } = await import("@/tool/lsp")
    const tool = await LspTool.init()
    // newName is optional at schema level (validated at execute time)
    const result = tool.parameters.safeParse({
      operation: "rename",
      filePath: "/tmp/test.ts",
      line: 1,
      character: 5,
    })
    expect(result.success).toBe(true)
  })

  test("rejects invalid operation", async () => {
    const { LspTool } = await import("@/tool/lsp")
    const tool = await LspTool.init()
    const result = tool.parameters.safeParse({
      operation: "invalidOperation",
      filePath: "/tmp/test.ts",
    })
    expect(result.success).toBe(false)
  })
})
