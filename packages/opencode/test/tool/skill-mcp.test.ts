import { describe, expect, test, afterEach, mock, beforeEach } from "bun:test"
import { SkillMcpTool } from "../../src/tool/skill-mcp"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

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

// Mock MCP tools, resources, and prompts
const mockTools: Record<string, { execute: ReturnType<typeof mock> }> = {}
const mockStatuses: Record<string, { status: string; error?: string }> = {}
let mockResources: Record<string, { name: string; uri: string; client: string }> = {}
let mockPrompts: Record<string, { name: string; client: string }> = {}
let mockGetPromptResult: unknown = null
let mockReadResourceResult: unknown = null

mock.module("../../src/mcp/index", () => ({
  MCP: {
    tools: mock(() => Promise.resolve({ ...mockTools })),
    status: mock(() => Promise.resolve({ ...mockStatuses })),
    resources: mock(() => Promise.resolve({ ...mockResources })),
    prompts: mock(() => Promise.resolve({ ...mockPrompts })),
    getPrompt: mock((clientName: string, name: string, args?: Record<string, string>) =>
      Promise.resolve(mockGetPromptResult),
    ),
    readResource: mock((clientName: string, uri: string) =>
      Promise.resolve(mockReadResourceResult),
    ),
  },
}))

// Mock security config
let mockMcpPolicy = "trusted"
mock.module("../../src/security/config", () => ({
  SecurityConfig: {
    getMcpPolicy: mock((serverName: string) => mockMcpPolicy),
    getSecurityConfig: mock(() => ({})),
    loadSecurityConfig: mock(() => ({})),
  },
}))

const mockLogSecurityEvent = mock(() => {})
mock.module("../../src/security/audit", () => ({
  SecurityAudit: {
    logSecurityEvent: mockLogSecurityEvent,
  },
}))

describe("skill_mcp tool", () => {
  beforeEach(() => {
    // Reset all mock state
    Object.keys(mockTools).forEach((k) => delete mockTools[k])
    Object.keys(mockStatuses).forEach((k) => delete mockStatuses[k])
    mockResources = {}
    mockPrompts = {}
    mockGetPromptResult = null
    mockReadResourceResult = null
    mockMcpPolicy = "trusted"
    mockLogSecurityEvent.mockClear()
  })

  afterEach(() => {})

  test("tool invocation with tool_name -> MCP tool called", async () => {
    // Set up mock MCP server with a tool
    mockStatuses["test-server"] = { status: "connected" }
    const mockExecute = mock(() =>
      Promise.resolve({
        content: [{ type: "text", text: "Search results for query" }],
        isError: false,
      }),
    )
    mockTools["test-server_search"] = { execute: mockExecute }

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillMcpTool.init()
        const result = await tool.execute(
          {
            mcp_name: "test-server",
            tool_name: "search",
            arguments: { query: "hello" },
          },
          ctx,
        )
        expect(result.output).toContain("Search results for query")
        expect(result.metadata.operation).toBe("tool")
        expect(result.metadata.server).toBe("test-server")
        expect(mockExecute).toHaveBeenCalled()
      },
    })
  })

  test("resource access with resource_name -> resource fetched", async () => {
    mockStatuses["docs-server"] = { status: "connected" }
    mockResources["docs-server:docs"] = { name: "docs", uri: "docs://api", client: "docs-server" }
    mockReadResourceResult = {
      contents: [{ text: "API documentation content", uri: "docs://api", mimeType: "text/plain" }],
    }

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillMcpTool.init()
        const result = await tool.execute(
          {
            mcp_name: "docs-server",
            resource_name: "docs://api",
          },
          ctx,
        )
        expect(result.output).toContain("API documentation content")
        expect(result.metadata.operation).toBe("resource")
        expect(result.metadata.server).toBe("docs-server")
      },
    })
  })

  test("prompt execution with prompt_name -> prompt run", async () => {
    mockStatuses["prompt-server"] = { status: "connected" }
    mockPrompts["prompt-server:summarize"] = { name: "summarize", client: "prompt-server" }
    mockGetPromptResult = {
      messages: [
        { role: "user", content: { type: "text", text: "Summarize this document" } },
        { role: "assistant", content: { type: "text", text: "Here is the summary." } },
      ],
    }

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillMcpTool.init()
        const result = await tool.execute(
          {
            mcp_name: "prompt-server",
            prompt_name: "summarize",
            arguments: { topic: "AI" },
          },
          ctx,
        )
        expect(result.output).toContain("Summarize this document")
        expect(result.output).toContain("Here is the summary.")
        expect(result.metadata.operation).toBe("prompt")
        expect(result.metadata.server).toBe("prompt-server")
      },
    })
  })

  test("multiple operations specified -> validation error", async () => {
    mockStatuses["test-server"] = { status: "connected" }

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillMcpTool.init()
        const result = await tool.execute(
          {
            mcp_name: "test-server",
            tool_name: "search",
            resource_name: "docs://api",
          },
          ctx,
        )
        expect(result.output).toContain("exactly one of")
        expect(result.output).toContain("Multiple operations")
        expect(result.metadata.error).toBe(true)
      },
    })
  })

  test("no operation specified -> validation error", async () => {
    mockStatuses["test-server"] = { status: "connected" }

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillMcpTool.init()
        const result = await tool.execute(
          { mcp_name: "test-server" },
          ctx,
        )
        expect(result.output).toContain("exactly one of")
        expect(result.metadata.error).toBe(true)
      },
    })
  })

  test("blocked MCP server -> access denied", async () => {
    mockStatuses["blocked-server"] = { status: "connected" }
    mockMcpPolicy = "blocked"

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillMcpTool.init()
        const result = await tool.execute(
          {
            mcp_name: "blocked-server",
            tool_name: "search",
          },
          ctx,
        )
        expect(result.output).toContain("blocked by security policy")
        expect(result.metadata.denied).toBe(true)
        expect(mockLogSecurityEvent).toHaveBeenCalled()
      },
    })
  })

  test("unknown MCP server -> clear error", async () => {
    mockStatuses["known-server"] = { status: "connected" }
    mockMcpPolicy = "trusted"

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillMcpTool.init()
        const result = await tool.execute(
          {
            mcp_name: "nonexistent-server",
            tool_name: "search",
          },
          ctx,
        )
        expect(result.output).toContain("Unknown MCP server")
        expect(result.output).toContain("nonexistent-server")
        expect(result.metadata.error).toBe(true)
      },
    })
  })

  test("arguments as JSON string -> parsed correctly", async () => {
    mockStatuses["test-server"] = { status: "connected" }
    const mockExecute = mock((args: unknown) =>
      Promise.resolve({
        content: [{ type: "text", text: `Result for: ${JSON.stringify(args)}` }],
        isError: false,
      }),
    )
    mockTools["test-server_query"] = { execute: mockExecute }

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillMcpTool.init()
        const result = await tool.execute(
          {
            mcp_name: "test-server",
            tool_name: "query",
            arguments: '{"q": "test", "limit": 10}',
          },
          ctx,
        )
        expect(result.metadata.error).toBeUndefined()
        expect(mockExecute).toHaveBeenCalled()
        const callArgs = mockExecute.mock.calls[0]?.[0] as Record<string, unknown>
        expect(callArgs.q).toBe("test")
        expect(callArgs.limit).toBe(10)
      },
    })
  })

  test("arguments as object -> passed through", async () => {
    mockStatuses["test-server"] = { status: "connected" }
    const mockExecute = mock((args: unknown) =>
      Promise.resolve({
        content: [{ type: "text", text: "OK" }],
        isError: false,
      }),
    )
    mockTools["test-server_action"] = { execute: mockExecute }

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillMcpTool.init()
        const result = await tool.execute(
          {
            mcp_name: "test-server",
            tool_name: "action",
            arguments: { key: "value", nested: { a: 1 } },
          },
          ctx,
        )
        expect(result.metadata.error).toBeUndefined()
        expect(mockExecute).toHaveBeenCalled()
        const callArgs = mockExecute.mock.calls[0]?.[0] as Record<string, unknown>
        expect(callArgs.key).toBe("value")
        expect((callArgs.nested as Record<string, number>).a).toBe(1)
      },
    })
  })

  test("MCP server not connected -> error with status", async () => {
    mockStatuses["offline-server"] = { status: "failed", error: "Connection refused" }
    mockMcpPolicy = "trusted"

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillMcpTool.init()
        const result = await tool.execute(
          {
            mcp_name: "offline-server",
            tool_name: "search",
          },
          ctx,
        )
        expect(result.output).toContain("not connected")
        expect(result.output).toContain("Connection refused")
        expect(result.metadata.error).toBe(true)
      },
    })
  })

  test("tool not found on server -> lists available tools", async () => {
    mockStatuses["test-server"] = { status: "connected" }
    mockTools["test-server_alpha"] = {
      execute: mock(() => Promise.resolve({ content: [{ type: "text", text: "OK" }] })),
    }
    mockTools["test-server_beta"] = {
      execute: mock(() => Promise.resolve({ content: [{ type: "text", text: "OK" }] })),
    }

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillMcpTool.init()
        const result = await tool.execute(
          {
            mcp_name: "test-server",
            tool_name: "nonexistent",
          },
          ctx,
        )
        expect(result.output).toContain("not found")
        expect(result.output).toContain("alpha")
        expect(result.output).toContain("beta")
        expect(result.metadata.error).toBe(true)
      },
    })
  })

  test("MCP tool returns error -> error formatted", async () => {
    mockStatuses["test-server"] = { status: "connected" }
    mockTools["test-server_fail"] = {
      execute: mock(() =>
        Promise.resolve({
          content: [{ type: "text", text: "Something went wrong" }],
          isError: true,
        }),
      ),
    }

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillMcpTool.init()
        const result = await tool.execute(
          {
            mcp_name: "test-server",
            tool_name: "fail",
          },
          ctx,
        )
        expect(result.output).toContain("Error from MCP tool")
        expect(result.output).toContain("Something went wrong")
      },
    })
  })

  test("resource read failure -> error message", async () => {
    mockStatuses["res-server"] = { status: "connected" }
    mockReadResourceResult = null

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillMcpTool.init()
        const result = await tool.execute(
          {
            mcp_name: "res-server",
            resource_name: "nonexistent://resource",
          },
          ctx,
        )
        expect(result.output).toContain("Failed to read resource")
        expect(result.metadata.error).toBe(true)
      },
    })
  })

  test("prompt not found -> lists available prompts", async () => {
    mockStatuses["prompt-server"] = { status: "connected" }
    mockPrompts["prompt-server:available"] = { name: "available", client: "prompt-server" }
    mockGetPromptResult = null

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillMcpTool.init()
        const result = await tool.execute(
          {
            mcp_name: "prompt-server",
            prompt_name: "nonexistent",
          },
          ctx,
        )
        expect(result.output).toContain("Failed to execute prompt")
        expect(result.output).toContain("available")
      },
    })
  })
})
