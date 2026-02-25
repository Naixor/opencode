import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { SecurityConfig } from "../../src/security/config"
import { BuiltinMcp } from "../../src/mcp/builtin"

let mockMcpPolicy = "trusted"
const spies: Array<ReturnType<typeof spyOn>> = []

describe("BuiltinMcp", () => {
  beforeEach(() => {
    mockMcpPolicy = "trusted"
    spies.push(
      spyOn(SecurityConfig, "getMcpPolicy").mockImplementation(() => mockMcpPolicy as "trusted" | "enforced" | "blocked"),
      spyOn(SecurityConfig, "getSecurityConfig").mockImplementation(() => ({ version: "1.0", roles: [], rules: [] })),
      spyOn(SecurityConfig, "loadSecurityConfig").mockImplementation(async () => ({ version: "1.0", roles: [], rules: [] })),
      spyOn(SecurityConfig, "resetConfig").mockImplementation(() => {}),
    )
  })

  afterEach(() => {
    spies.forEach((s) => s.mockRestore())
    spies.length = 0
  })

  test("all 3 servers have valid configs", () => {
    const defs = BuiltinMcp.definitions()
    expect(defs.length).toBe(3)
    const names = defs.map((d) => d.name)
    expect(names).toContain("websearch")
    expect(names).toContain("context7")
    expect(names).toContain("grep_app")
    for (const def of defs) {
      expect(def.description).toBeTruthy()
      expect(def.envVar).toBeTruthy()
      const config = def.config("test-key")
      expect(config.type).toBe("remote")
      expect((config as { url: string }).url).toBeTruthy()
    }
  })

  test("default state all disabled (no API keys)", () => {
    const result = BuiltinMcp.resolve(undefined, [])
    expect(Object.keys(result).length).toBe(0)
  })

  test("set EXA_API_KEY -> websearch enabled", () => {
    const result = BuiltinMcp.resolve(undefined, [], { EXA_API_KEY: "test-exa-key" })
    expect(result.websearch).toBeDefined()
    expect(result.websearch.type).toBe("remote")
    const remote = result.websearch as { url: string; headers?: Record<string, string> }
    expect(remote.headers?.["x-api-key"]).toBe("test-exa-key")
  })

  test("set CONTEXT7_API_KEY -> context7 enabled", () => {
    const result = BuiltinMcp.resolve(undefined, [], { CONTEXT7_API_KEY: "test-c7-key" })
    expect(result.context7).toBeDefined()
    expect(result.context7.type).toBe("remote")
    const remote = result.context7 as { url: string; headers?: Record<string, string> }
    expect(remote.headers?.Authorization).toBe("Bearer test-c7-key")
  })

  test("set GREP_APP_API_KEY -> grep_app enabled", () => {
    const result = BuiltinMcp.resolve(undefined, [], { GREP_APP_API_KEY: "test-grep-key" })
    expect(result.grep_app).toBeDefined()
    expect(result.grep_app.type).toBe("remote")
    const remote = result.grep_app as { url: string; headers?: Record<string, string> }
    expect(remote.headers?.Authorization).toBe("Bearer test-grep-key")
  })

  test("key in opencode.jsonc (via apiKeys param) -> server enabled", () => {
    const result = BuiltinMcp.resolve(undefined, [], {
      EXA_API_KEY: "from-config",
      CONTEXT7_API_KEY: "c7-from-config",
    })
    expect(result.websearch).toBeDefined()
    expect(result.context7).toBeDefined()
    expect(Object.keys(result).length).toBe(2)
  })

  test("no key + agent tries MCP -> clear error with env var name", () => {
    const msg = BuiltinMcp.getDisabledMessage("websearch")
    expect(msg).toBeTruthy()
    expect(msg).toContain("EXA_API_KEY")
    expect(msg).toContain("websearch")

    const c7Msg = BuiltinMcp.getDisabledMessage("context7")
    expect(c7Msg).toContain("CONTEXT7_API_KEY")

    const grepMsg = BuiltinMcp.getDisabledMessage("grep_app")
    expect(grepMsg).toContain("GREP_APP_API_KEY")
  })

  test("API key set but disabled_mcps=['websearch'] -> not loaded", () => {
    const result = BuiltinMcp.resolve(undefined, ["websearch"], { EXA_API_KEY: "test-key" })
    expect(result.websearch).toBeUndefined()
  })

  test("disabled_mcps blocks multiple servers", () => {
    const result = BuiltinMcp.resolve(undefined, ["websearch", "context7"], {
      EXA_API_KEY: "test",
      CONTEXT7_API_KEY: "test",
      GREP_APP_API_KEY: "test",
    })
    expect(result.websearch).toBeUndefined()
    expect(result.context7).toBeUndefined()
    expect(result.grep_app).toBeDefined()
  })

  test("blocked server -> tools not exposed", () => {
    mockMcpPolicy = "blocked"
    const result = BuiltinMcp.resolve(undefined, [], { EXA_API_KEY: "test-key" })
    expect(result.websearch).toBeUndefined()
  })

  test("enforced server -> config still returned (input scanning applied)", () => {
    mockMcpPolicy = "enforced"
    const result = BuiltinMcp.resolve(undefined, [], { EXA_API_KEY: "test-key" })
    expect(result.websearch).toBeDefined()
  })

  test("user-configured server takes priority over built-in", () => {
    const userMcp = {
      websearch: {
        type: "remote" as const,
        url: "https://custom.example.com/mcp",
      },
    }
    const result = BuiltinMcp.resolve(userMcp, [], { EXA_API_KEY: "test-key" })
    // Built-in websearch should be skipped since user configured it
    expect(result.websearch).toBeUndefined()
  })

  test("OAuth params: built-in configs disable OAuth", () => {
    const result = BuiltinMcp.resolve(undefined, [], { EXA_API_KEY: "key" })
    const config = result.websearch as { oauth?: unknown }
    expect(config.oauth).toBe(false)
  })

  test("isBuiltin identifies built-in servers", () => {
    expect(BuiltinMcp.isBuiltin("websearch")).toBe(true)
    expect(BuiltinMcp.isBuiltin("context7")).toBe(true)
    expect(BuiltinMcp.isBuiltin("grep_app")).toBe(true)
    expect(BuiltinMcp.isBuiltin("custom-server")).toBe(false)
  })

  test("getRequiredEnvVar returns correct env var", () => {
    expect(BuiltinMcp.getRequiredEnvVar("websearch")).toBe("EXA_API_KEY")
    expect(BuiltinMcp.getRequiredEnvVar("context7")).toBe("CONTEXT7_API_KEY")
    expect(BuiltinMcp.getRequiredEnvVar("grep_app")).toBe("GREP_APP_API_KEY")
    expect(BuiltinMcp.getRequiredEnvVar("unknown")).toBeUndefined()
  })

  test("getDisabledMessage returns undefined for non-builtin", () => {
    const msg = BuiltinMcp.getDisabledMessage("custom-server")
    expect(msg).toBeUndefined()
  })

  test("multiple API keys -> multiple servers enabled", () => {
    const result = BuiltinMcp.resolve(undefined, [], {
      EXA_API_KEY: "k1",
      CONTEXT7_API_KEY: "k2",
      GREP_APP_API_KEY: "k3",
    })
    expect(Object.keys(result).length).toBe(3)
    expect(result.websearch).toBeDefined()
    expect(result.context7).toBeDefined()
    expect(result.grep_app).toBeDefined()
  })

  test("env var fallback: process.env used when apiKeys not provided", () => {
    const originalEnv = process.env.EXA_API_KEY
    process.env.EXA_API_KEY = "env-key"
    try {
      const result = BuiltinMcp.resolve(undefined, [])
      expect(result.websearch).toBeDefined()
      const remote = result.websearch as { headers?: Record<string, string> }
      expect(remote.headers?.["x-api-key"]).toBe("env-key")
    } finally {
      if (originalEnv === undefined) {
        delete process.env.EXA_API_KEY
      } else {
        process.env.EXA_API_KEY = originalEnv
      }
    }
  })
})
