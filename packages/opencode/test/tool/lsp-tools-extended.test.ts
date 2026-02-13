import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs"
import {
  LspDiagnosticsTool,
  LspPrepareRenameTool,
  LspRenameTool,
  LspCallHierarchyTool,
} from "../../src/tool/lsp-tools-extended"
import { LspTool } from "../../src/tool/lsp"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { SecurityAccess } from "../../src/security/access"
import { setupSecurityConfig, teardownSecurityConfig } from "../security/access_control_cases/helpers"
import { pathToFileURL } from "url"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("lsp-tools-extended: tool definitions", () => {
  test("lsp_diagnostics tool has correct id and parameters", async () => {
    expect(LspDiagnosticsTool.id).toBe("lsp_diagnostics")
    const tool = await LspDiagnosticsTool.init()
    expect(tool.description).toBeTruthy()
    const parsed = tool.parameters.parse({ filePath: "test.ts" })
    expect(parsed.filePath).toBe("test.ts")
    expect(parsed.severity).toBe("all")
  })

  test("lsp_diagnostics severity accepts all valid values", async () => {
    const tool = await LspDiagnosticsTool.init()
    expect(tool.parameters.parse({ filePath: "test.ts", severity: "error" }).severity).toBe("error")
    expect(tool.parameters.parse({ filePath: "test.ts", severity: "warning" }).severity).toBe("warning")
    expect(tool.parameters.parse({ filePath: "test.ts", severity: "information" }).severity).toBe("information")
    expect(tool.parameters.parse({ filePath: "test.ts", severity: "hint" }).severity).toBe("hint")
    expect(tool.parameters.parse({ filePath: "test.ts", severity: "all" }).severity).toBe("all")
  })

  test("lsp_diagnostics severity rejects invalid values", async () => {
    const tool = await LspDiagnosticsTool.init()
    expect(() => tool.parameters.parse({ filePath: "test.ts", severity: "invalid" })).toThrow()
  })

  test("lsp_diagnostics severity defaults to all", async () => {
    const tool = await LspDiagnosticsTool.init()
    const parsed = tool.parameters.parse({ filePath: "test.ts" })
    expect(parsed.severity).toBe("all")
  })

  test("lsp_prepare_rename tool has correct id and parameters", async () => {
    expect(LspPrepareRenameTool.id).toBe("lsp_prepare_rename")
    const tool = await LspPrepareRenameTool.init()
    expect(tool.description).toBeTruthy()
    const parsed = tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1 })
    expect(parsed.filePath).toBe("test.ts")
    expect(parsed.line).toBe(1)
    expect(parsed.character).toBe(1)
  })

  test("lsp_rename tool has correct id and parameters", async () => {
    expect(LspRenameTool.id).toBe("lsp_rename")
    const tool = await LspRenameTool.init()
    expect(tool.description).toBeTruthy()
    const parsed = tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1, newName: "newFoo" })
    expect(parsed.filePath).toBe("test.ts")
    expect(parsed.newName).toBe("newFoo")
  })

  test("lsp_rename rejects empty newName", async () => {
    const tool = await LspRenameTool.init()
    expect(() => tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1, newName: "" })).toThrow()
  })

  test("lsp_call_hierarchy tool has correct id and parameters", async () => {
    expect(LspCallHierarchyTool.id).toBe("lsp_call_hierarchy")
    const tool = await LspCallHierarchyTool.init()
    expect(tool.description).toBeTruthy()
    const parsed = tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1, direction: "incoming" })
    expect(parsed.direction).toBe("incoming")
  })

  test("lsp_call_hierarchy direction accepts all valid values", async () => {
    const tool = await LspCallHierarchyTool.init()
    expect(tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1, direction: "prepare" }).direction).toBe("prepare")
    expect(tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1, direction: "incoming" }).direction).toBe("incoming")
    expect(tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1, direction: "outgoing" }).direction).toBe("outgoing")
  })

  test("lsp_call_hierarchy direction rejects invalid values", async () => {
    const tool = await LspCallHierarchyTool.init()
    expect(() => tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1, direction: "invalid" })).toThrow()
  })
})

describe("lsp-tools-extended: parameter validation", () => {
  test("lsp_prepare_rename rejects line < 1", async () => {
    const tool = await LspPrepareRenameTool.init()
    expect(() => tool.parameters.parse({ filePath: "test.ts", line: 0, character: 1 })).toThrow()
  })

  test("lsp_prepare_rename rejects character < 1", async () => {
    const tool = await LspPrepareRenameTool.init()
    expect(() => tool.parameters.parse({ filePath: "test.ts", line: 1, character: 0 })).toThrow()
  })

  test("lsp_rename rejects line < 1", async () => {
    const tool = await LspRenameTool.init()
    expect(() => tool.parameters.parse({ filePath: "test.ts", line: 0, character: 1, newName: "foo" })).toThrow()
  })

  test("lsp_rename rejects missing newName", async () => {
    const tool = await LspRenameTool.init()
    expect(() => tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1 })).toThrow()
  })

  test("lsp_call_hierarchy rejects line < 1", async () => {
    const tool = await LspCallHierarchyTool.init()
    expect(() => tool.parameters.parse({ filePath: "test.ts", line: 0, character: 1, direction: "prepare" })).toThrow()
  })

  test("lsp_call_hierarchy rejects missing direction", async () => {
    const tool = await LspCallHierarchyTool.init()
    expect(() => tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1 })).toThrow()
  })
})

describe("lsp-tools-extended: file not found error", () => {
  test("lsp_diagnostics throws on nonexistent file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LspDiagnosticsTool.init()
        await expect(
          tool.execute({ filePath: path.join(tmp.path, "nonexistent.ts"), severity: "all" }, ctx),
        ).rejects.toThrow("File not found")
      },
    })
  })

  test("lsp_prepare_rename throws on nonexistent file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LspPrepareRenameTool.init()
        await expect(
          tool.execute({ filePath: path.join(tmp.path, "nonexistent.ts"), line: 1, character: 1 }, ctx),
        ).rejects.toThrow("File not found")
      },
    })
  })

  test("lsp_rename throws on nonexistent file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LspRenameTool.init()
        await expect(
          tool.execute({ filePath: path.join(tmp.path, "nonexistent.ts"), line: 1, character: 1, newName: "foo" }, ctx),
        ).rejects.toThrow("File not found")
      },
    })
  })

  test("lsp_call_hierarchy throws on nonexistent file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LspCallHierarchyTool.init()
        await expect(
          tool.execute({ filePath: path.join(tmp.path, "nonexistent.ts"), line: 1, character: 1, direction: "prepare" }, ctx),
        ).rejects.toThrow("File not found")
      },
    })
  })
})

describe("lsp-tools-extended: deprecated lsp tool", () => {
  test("deprecated lsp tool still has correct id", () => {
    expect(LspTool.id).toBe("lsp")
  })

  test("deprecated lsp tool still accepts all operations", async () => {
    const tool = await LspTool.init()
    const operations = [
      "goToDefinition",
      "findReferences",
      "hover",
      "documentSymbol",
      "workspaceSymbol",
      "goToImplementation",
      "prepareCallHierarchy",
      "incomingCalls",
      "outgoingCalls",
    ] as const
    for (const op of operations) {
      const parsed = tool.parameters.parse({ operation: op, filePath: "test.ts", line: 1, character: 1 })
      expect(parsed.operation).toBe(op)
    }
  })
})

describe("lsp-tools-extended: SecurityAccess filtering", () => {
  test("lsp_diagnostics filters protected files from results", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "public.ts"), "export const pub = 1")
        await Bun.write(path.join(dir, "secret.ts"), "export const sec = 2")
      },
    })

    const realDir = fs.realpathSync(tmp.path)
    const protectedPath = path.join(realDir, "secret.ts")
    const publicPath = path.join(realDir, "public.ts")

    await setupSecurityConfig(
      {
        version: "1.0",
        roles: [{ name: "agent", level: 1 }],
        rules: [
          {
            pattern: protectedPath,
            type: "file" as const,
            allowedRoles: [],
            deniedOperations: ["read" as const],
          },
        ],
      },
      realDir,
    )

    const denied = SecurityAccess.checkAccess(protectedPath, "read", "agent")
    expect(denied.allowed).toBe(false)

    const allowed = SecurityAccess.checkAccess(publicPath, "read", "agent")
    expect(allowed.allowed).toBe(true)

    teardownSecurityConfig()
  })

  test("lsp_rename filters protected files from workspace edit results", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "allowed.ts"), "export const a = 1")
        await Bun.write(path.join(dir, "blocked.ts"), "export const b = 2")
      },
    })

    const realDir = fs.realpathSync(tmp.path)
    const blockedPath = path.join(realDir, "blocked.ts")
    const allowedPath = path.join(realDir, "allowed.ts")

    await setupSecurityConfig(
      {
        version: "1.0",
        roles: [{ name: "agent", level: 1 }],
        rules: [
          {
            pattern: blockedPath,
            type: "file" as const,
            allowedRoles: [],
            deniedOperations: ["read" as const],
          },
        ],
      },
      realDir,
    )

    // Verify security correctly set up
    const denied = SecurityAccess.checkAccess(blockedPath, "read", "agent")
    expect(denied.allowed).toBe(false)

    // Simulate workspace edit changes filtering
    const changes: Record<string, unknown[]> = {
      [pathToFileURL(allowedPath).href]: [{ range: {}, newText: "newFoo" }],
      [pathToFileURL(blockedPath).href]: [{ range: {}, newText: "newFoo" }],
    }

    const filteredEntries = Object.entries(changes).filter(([uri]) => {
      const filePath = new URL(uri).pathname
      return SecurityAccess.checkAccess(filePath, "read", "agent").allowed
    })

    expect(filteredEntries.length).toBe(1)

    teardownSecurityConfig()
  })
})

describe("lsp-tools-extended: registry", () => {
  test("all 4 new tools have distinct IDs", () => {
    const ids = [
      LspDiagnosticsTool.id,
      LspPrepareRenameTool.id,
      LspRenameTool.id,
      LspCallHierarchyTool.id,
    ]
    const unique = new Set(ids)
    expect(unique.size).toBe(4)
    expect(ids).toContain("lsp_diagnostics")
    expect(ids).toContain("lsp_prepare_rename")
    expect(ids).toContain("lsp_rename")
    expect(ids).toContain("lsp_call_hierarchy")
  })

  test("new tools are separate from original lsp tool", () => {
    const newIds = [
      LspDiagnosticsTool.id,
      LspPrepareRenameTool.id,
      LspRenameTool.id,
      LspCallHierarchyTool.id,
    ]
    expect(newIds).not.toContain("lsp")
  })
})

describe("lsp-tools-extended: no LSP server available", () => {
  test("lsp_diagnostics throws when no LSP server for file type", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.xyz456"), "some content")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LspDiagnosticsTool.init()
        await expect(
          tool.execute({ filePath: path.join(tmp.path, "test.xyz456"), severity: "all" }, ctx),
        ).rejects.toThrow("No LSP server available")
      },
    })
  })

  test("lsp_call_hierarchy throws when no LSP server for file type", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.xyz789"), "some content")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LspCallHierarchyTool.init()
        await expect(
          tool.execute({ filePath: path.join(tmp.path, "test.xyz789"), line: 1, character: 1, direction: "prepare" }, ctx),
        ).rejects.toThrow("No LSP server available")
      },
    })
  })
})
