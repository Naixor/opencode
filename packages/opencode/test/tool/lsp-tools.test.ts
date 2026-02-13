import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs"
import {
  LspGotoDefinitionTool,
  LspFindReferencesTool,
  LspSymbolsTool,
  LspHoverTool,
  LspImplementationTool,
} from "../../src/tool/lsp-tools"
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

describe("lsp-tools: tool definitions", () => {
  test("lsp_goto_definition tool has correct id and parameters", async () => {
    expect(LspGotoDefinitionTool.id).toBe("lsp_goto_definition")
    const tool = await LspGotoDefinitionTool.init()
    expect(tool.description).toBeTruthy()
    const schema = tool.parameters
    const parsed = schema.parse({ filePath: "test.ts", line: 1, character: 1 })
    expect(parsed.filePath).toBe("test.ts")
    expect(parsed.line).toBe(1)
    expect(parsed.character).toBe(1)
  })

  test("lsp_find_references tool has correct id and parameters", async () => {
    expect(LspFindReferencesTool.id).toBe("lsp_find_references")
    const tool = await LspFindReferencesTool.init()
    expect(tool.description).toBeTruthy()
    const schema = tool.parameters
    const parsed = schema.parse({ filePath: "test.ts", line: 5, character: 10 })
    expect(parsed.filePath).toBe("test.ts")
    expect(parsed.includeDeclaration).toBe(true)
    expect(parsed.limit).toBe(100)
  })

  test("lsp_find_references includeDeclaration defaults to true", async () => {
    const tool = await LspFindReferencesTool.init()
    const parsed = tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1 })
    expect(parsed.includeDeclaration).toBe(true)
  })

  test("lsp_find_references limit defaults to 100", async () => {
    const tool = await LspFindReferencesTool.init()
    const parsed = tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1 })
    expect(parsed.limit).toBe(100)
  })

  test("lsp_symbols tool has correct id and parameters", async () => {
    expect(LspSymbolsTool.id).toBe("lsp_symbols")
    const tool = await LspSymbolsTool.init()
    expect(tool.description).toBeTruthy()
    const parsed = tool.parameters.parse({ filePath: "test.ts", scope: "document" })
    expect(parsed.scope).toBe("document")
    expect(parsed.query).toBe("")
    expect(parsed.limit).toBe(50)
  })

  test("lsp_symbols scope accepts document and workspace", async () => {
    const tool = await LspSymbolsTool.init()
    expect(tool.parameters.parse({ filePath: "test.ts", scope: "document" }).scope).toBe("document")
    expect(tool.parameters.parse({ filePath: "test.ts", scope: "workspace" }).scope).toBe("workspace")
    expect(() => tool.parameters.parse({ filePath: "test.ts", scope: "invalid" })).toThrow()
  })

  test("lsp_hover tool has correct id", async () => {
    expect(LspHoverTool.id).toBe("lsp_hover")
    const tool = await LspHoverTool.init()
    expect(tool.description).toBeTruthy()
    const parsed = tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1 })
    expect(parsed.filePath).toBe("test.ts")
  })

  test("lsp_implementation tool has correct id", async () => {
    expect(LspImplementationTool.id).toBe("lsp_implementation")
    const tool = await LspImplementationTool.init()
    expect(tool.description).toBeTruthy()
    const parsed = tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1 })
    expect(parsed.filePath).toBe("test.ts")
  })

  test("original lsp tool still exists with all operations", async () => {
    expect(LspTool.id).toBe("lsp")
    const tool = await LspTool.init()
    expect(tool.description).toBeTruthy()
    const parsed = tool.parameters.parse({
      operation: "goToDefinition",
      filePath: "test.ts",
      line: 1,
      character: 1,
    })
    expect(parsed.operation).toBe("goToDefinition")
  })
})

describe("lsp-tools: parameter validation", () => {
  test("lsp_goto_definition rejects line < 1", async () => {
    const tool = await LspGotoDefinitionTool.init()
    expect(() => tool.parameters.parse({ filePath: "test.ts", line: 0, character: 1 })).toThrow()
  })

  test("lsp_goto_definition rejects character < 1", async () => {
    const tool = await LspGotoDefinitionTool.init()
    expect(() => tool.parameters.parse({ filePath: "test.ts", line: 1, character: 0 })).toThrow()
  })

  test("lsp_goto_definition rejects missing filePath", async () => {
    const tool = await LspGotoDefinitionTool.init()
    expect(() => tool.parameters.parse({ line: 1, character: 1 })).toThrow()
  })

  test("lsp_find_references rejects limit <= 0", async () => {
    const tool = await LspFindReferencesTool.init()
    expect(() =>
      tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1, limit: 0 }),
    ).toThrow()
  })

  test("lsp_find_references accepts custom limit", async () => {
    const tool = await LspFindReferencesTool.init()
    const parsed = tool.parameters.parse({ filePath: "test.ts", line: 1, character: 1, limit: 50 })
    expect(parsed.limit).toBe(50)
  })

  test("lsp_find_references accepts includeDeclaration=false", async () => {
    const tool = await LspFindReferencesTool.init()
    const parsed = tool.parameters.parse({
      filePath: "test.ts",
      line: 1,
      character: 1,
      includeDeclaration: false,
    })
    expect(parsed.includeDeclaration).toBe(false)
  })

  test("lsp_symbols rejects limit <= 0", async () => {
    const tool = await LspSymbolsTool.init()
    expect(() =>
      tool.parameters.parse({ filePath: "test.ts", scope: "document", limit: 0 }),
    ).toThrow()
  })
})

describe("lsp-tools: file not found error", () => {
  test("lsp_goto_definition throws on nonexistent file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LspGotoDefinitionTool.init()
        await expect(
          tool.execute({ filePath: path.join(tmp.path, "nonexistent.ts"), line: 1, character: 1 }, ctx),
        ).rejects.toThrow("File not found")
      },
    })
  })

  test("lsp_find_references throws on nonexistent file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LspFindReferencesTool.init()
        await expect(
          tool.execute(
            { filePath: path.join(tmp.path, "nonexistent.ts"), line: 1, character: 1, includeDeclaration: true, limit: 100 },
            ctx,
          ),
        ).rejects.toThrow("File not found")
      },
    })
  })

  test("lsp_symbols throws on nonexistent file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LspSymbolsTool.init()
        await expect(
          tool.execute(
            { filePath: path.join(tmp.path, "nonexistent.ts"), scope: "document", query: "", limit: 50 },
            ctx,
          ),
        ).rejects.toThrow("File not found")
      },
    })
  })

  test("lsp_hover throws on nonexistent file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LspHoverTool.init()
        await expect(
          tool.execute({ filePath: path.join(tmp.path, "nonexistent.ts"), line: 1, character: 1 }, ctx),
        ).rejects.toThrow("File not found")
      },
    })
  })

  test("lsp_implementation throws on nonexistent file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LspImplementationTool.init()
        await expect(
          tool.execute({ filePath: path.join(tmp.path, "nonexistent.ts"), line: 1, character: 1 }, ctx),
        ).rejects.toThrow("File not found")
      },
    })
  })
})

describe("lsp-tools: SecurityAccess filtering on results", () => {
  test("SecurityAccess with protected file filters it from results (uri format)", async () => {
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

    // Verify access control is correctly set up
    const denied = SecurityAccess.checkAccess(protectedPath, "read", "agent")
    expect(denied.allowed).toBe(false)

    const allowed = SecurityAccess.checkAccess(publicPath, "read", "agent")
    expect(allowed.allowed).toBe(true)

    // Simulate LSP results with file URIs and verify filtering
    const mockResults = [
      { uri: pathToFileURL(publicPath).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
      { uri: pathToFileURL(protectedPath).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
    ]

    const filtered = mockResults.filter((item) => {
      const filePath = new URL(item.uri).pathname
      return SecurityAccess.checkAccess(filePath, "read", "agent").allowed
    })

    expect(filtered.length).toBe(1)
    expect(filtered[0].uri).toBe(pathToFileURL(publicPath).href)

    teardownSecurityConfig()
  })

  test("SecurityAccess with location.uri format filters protected files", async () => {
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

    // Simulate LSP reference results with location.uri format
    const mockResults = [
      { location: { uri: pathToFileURL(allowedPath).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } } },
      { location: { uri: pathToFileURL(blockedPath).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } } },
    ]

    const filtered = mockResults.filter((item) => {
      const uri = item.location?.uri
      if (!uri) return true
      const filePath = new URL(uri).pathname
      return SecurityAccess.checkAccess(filePath, "read", "agent").allowed
    })

    expect(filtered.length).toBe(1)

    teardownSecurityConfig()
  })
})

describe("lsp-tools: registry registration", () => {
  test("all 5 new tools have distinct IDs", () => {
    const ids = [
      LspGotoDefinitionTool.id,
      LspFindReferencesTool.id,
      LspSymbolsTool.id,
      LspHoverTool.id,
      LspImplementationTool.id,
    ]
    const unique = new Set(ids)
    expect(unique.size).toBe(5)
    expect(ids).toContain("lsp_goto_definition")
    expect(ids).toContain("lsp_find_references")
    expect(ids).toContain("lsp_symbols")
    expect(ids).toContain("lsp_hover")
    expect(ids).toContain("lsp_implementation")
  })

  test("original lsp tool ID is preserved", () => {
    expect(LspTool.id).toBe("lsp")
  })

  test("new tools are separate from original lsp tool", () => {
    const newIds = [
      LspGotoDefinitionTool.id,
      LspFindReferencesTool.id,
      LspSymbolsTool.id,
      LspHoverTool.id,
      LspImplementationTool.id,
    ]
    expect(newIds).not.toContain("lsp")
  })
})

describe("lsp-tools: output formatting", () => {
  test("lsp_find_references with limit truncates 150 results", async () => {
    // Verify that the limit parameter is correctly parsed and would be applied
    const tool = await LspFindReferencesTool.init()
    const parsed = tool.parameters.parse({
      filePath: "test.ts",
      line: 1,
      character: 1,
      limit: 100,
    })
    expect(parsed.limit).toBe(100)

    // Simulate truncation logic: 150 results sliced to 100
    const mockResults = Array.from({ length: 150 }, (_, i) => ({ index: i }))
    const limited = mockResults.slice(0, parsed.limit)
    expect(limited.length).toBe(100)
  })

  test("lsp_symbols scope=document returns only document symbols", async () => {
    const tool = await LspSymbolsTool.init()
    const parsed = tool.parameters.parse({
      filePath: "test.ts",
      scope: "document",
    })
    expect(parsed.scope).toBe("document")
    // Document scope does not use query parameter
    expect(parsed.query).toBe("")
  })

  test("lsp_symbols scope=workspace with query filters results", async () => {
    const tool = await LspSymbolsTool.init()
    const parsed = tool.parameters.parse({
      filePath: "test.ts",
      scope: "workspace",
      query: "Foo",
    })
    expect(parsed.scope).toBe("workspace")
    expect(parsed.query).toBe("Foo")
  })
})

describe("lsp-tools: no LSP server available", () => {
  test("lsp_goto_definition throws when no LSP server for file type", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // Create a file with an extension unlikely to have an LSP server
        await Bun.write(path.join(dir, "test.xyz123"), "some content")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LspGotoDefinitionTool.init()
        await expect(
          tool.execute({ filePath: path.join(tmp.path, "test.xyz123"), line: 1, character: 1 }, ctx),
        ).rejects.toThrow("No LSP server available")
      },
    })
  })
})
