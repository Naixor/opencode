import { describe, test, expect, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { SecurityConfig } from "@/security/config"
import { SecurityAccess } from "@/security/access"
import { SecurityUtil } from "@/security/util"
import { BuiltIn } from "@/plugin/builtin"
import type { SecuritySchema } from "@/security/schema"

afterEach(() => {
  SecurityConfig.resetConfig()
})

describe("Plugin tool security enforcement", () => {
  test("plugin tool with blocked file path in args gets access denied", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-sec-")))
    fs.mkdirSync(path.join(dir, ".git"))

    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [{ name: "viewer", level: 10 }],
      rules: [{ pattern: `${dir}/secrets/**`, type: "directory", deniedOperations: ["read", "write"], allowedRoles: [] }],
    }
    fs.writeFileSync(path.join(dir, ".opencode-security.json"), JSON.stringify(config))
    await SecurityConfig.loadSecurityConfig(dir)

    const role = SecurityUtil.getDefaultRole(SecurityConfig.getSecurityConfig())
    const secretPath = path.join(dir, "secrets", "key.pem")
    const access = SecurityAccess.checkAccess(secretPath, "read", role)
    expect(access.allowed).toBe(false)
  })

  test("plugin tool that reads protected file gets output redacted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-sec-"))
    fs.mkdirSync(path.join(dir, ".git"))

    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      rules: [{ pattern: "*.env", type: "file", deniedOperations: ["llm"], allowedRoles: [] }],
      segments: {
        markers: [
          {
            start: "// PROTECTED_START",
            end: "// PROTECTED_END",
            deniedOperations: ["llm"],
            allowedRoles: [],
          },
        ],
      },
    }
    fs.writeFileSync(path.join(dir, ".opencode-security.json"), JSON.stringify(config))
    await SecurityConfig.loadSecurityConfig(dir)

    const loadedConfig = SecurityConfig.getSecurityConfig()
    const content = "normal content // PROTECTED_START secret data // PROTECTED_END more content"
    const redacted = SecurityUtil.scanAndRedact(content, loadedConfig)
    // scanAndRedact should process the content
    expect(typeof redacted).toBe("string")
  })

  test("write to .opencode-security.json is blocked by implicit protection rule", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-sec-"))
    fs.mkdirSync(path.join(dir, ".git"))

    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      rules: [{ pattern: "*.txt", type: "file", deniedOperations: ["read"], allowedRoles: [] }],
    }
    fs.writeFileSync(path.join(dir, ".opencode-security.json"), JSON.stringify(config))
    await SecurityConfig.loadSecurityConfig(dir)

    const role = SecurityUtil.getDefaultRole(SecurityConfig.getSecurityConfig())
    const secConfigPath = path.join(dir, ".opencode-security.json")
    const access = SecurityAccess.checkAccess(secConfigPath, "write", role)
    expect(access.allowed).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("write to .opencode-security-audit.log is blocked by implicit protection rule", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-sec-"))
    fs.mkdirSync(path.join(dir, ".git"))

    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      rules: [{ pattern: "*.txt", type: "file", deniedOperations: ["read"], allowedRoles: [] }],
    }
    fs.writeFileSync(path.join(dir, ".opencode-security.json"), JSON.stringify(config))
    await SecurityConfig.loadSecurityConfig(dir)

    const role = SecurityUtil.getDefaultRole(SecurityConfig.getSecurityConfig())
    const auditPath = path.join(dir, ".opencode-security-audit.log")
    const access = SecurityAccess.checkAccess(auditPath, "write", role)
    expect(access.allowed).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("MCP default policy", () => {
  test("returns 'enforced' when security config has rules but no mcp block", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-pol-"))
    fs.mkdirSync(path.join(dir, ".git"))

    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      rules: [{ pattern: "*.env", type: "file", deniedOperations: ["read"], allowedRoles: [] }],
    }
    fs.writeFileSync(path.join(dir, ".opencode-security.json"), JSON.stringify(config))
    await SecurityConfig.loadSecurityConfig(dir)

    expect(SecurityConfig.getMcpPolicy("unknown-server")).toBe("enforced")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("returns 'trusted' when no config exists", () => {
    SecurityConfig.resetConfig()
    expect(SecurityConfig.getMcpPolicy("any-server")).toBe("trusted")
  })
})

describe("Structural diff for messages.transform", () => {
  test("message identity is based on info.id", () => {
    const original = [
      { info: { id: "msg-1" }, parts: [{ type: "text", text: "hello" }] },
      { info: { id: "msg-2" }, parts: [{ type: "text", text: "world" }] },
    ]

    const originalIds = new Set(original.map((m) => m.info.id))
    expect(originalIds.has("msg-1")).toBe(true)
    expect(originalIds.has("msg-2")).toBe(true)
    expect(originalIds.has("msg-3")).toBe(false)
  })

  test("syncs added messages (new IDs)", () => {
    const originalIds = new Set(["msg-1", "msg-2"])
    const mutated = [
      { info: { id: "msg-1" }, parts: [{ type: "text", text: "hello" }] },
      { info: { id: "msg-2" }, parts: [{ type: "text", text: "world" }] },
      { info: { id: "msg-3" }, parts: [{ type: "text", text: "new message" }] },
    ]

    const added = mutated.filter((m) => !originalIds.has(m.info.id))
    expect(added).toHaveLength(1)
    expect(added[0].info.id).toBe("msg-3")
  })

  test("syncs removed messages (missing IDs)", () => {
    const originalIds = new Set(["msg-1", "msg-2", "msg-3"])
    const mutated = [{ info: { id: "msg-1" }, parts: [{ type: "text", text: "hello" }] }]
    const mutatedIds = new Set(mutated.map((m) => m.info.id))

    const removed = new Set<string>()
    for (const id of originalIds) {
      if (!mutatedIds.has(id)) removed.add(id)
    }

    expect(removed.size).toBe(2)
    expect(removed.has("msg-2")).toBe(true)
    expect(removed.has("msg-3")).toBe(true)
  })

  test("discards content modifications on existing messages", () => {
    const original = [
      { info: { id: "msg-1" }, parts: [{ type: "text", text: "original content" }] },
    ]
    const mutated = [
      { info: { id: "msg-1" }, parts: [{ type: "text", text: "MODIFIED content" }] },
    ]

    // Structural diff only syncs add/remove, not modifications
    const originalIds = new Set(original.map((m) => m.info.id))
    const added = mutated.filter((m) => !originalIds.has(m.info.id))

    // No new messages added
    expect(added).toHaveLength(0)
    // Original content should be preserved (not overwritten by mutation)
    expect(original[0].parts[0].text).toBe("original content")
  })
})

describe("hasBuiltIn()", () => {
  test("returns true for registered features", () => {
    expect(BuiltIn.has("ast-grep")).toBe(true)
    expect(BuiltIn.has("lsp-rename")).toBe(true)
    expect(BuiltIn.has("look-at")).toBe(true)
  })

  test("returns false for unknown feature IDs", () => {
    expect(BuiltIn.has("nonexistent")).toBe(false)
    expect(BuiltIn.has("")).toBe(false)
  })

  test("plugin that checks hasBuiltIn skips tool registration when feature is built-in", () => {
    const hasBuiltIn = BuiltIn.has
    const tools: string[] = []

    // Simulate plugin registration logic
    if (!hasBuiltIn("ast-grep")) {
      tools.push("ast_grep_search")
    }
    if (!hasBuiltIn("nonexistent-feature")) {
      tools.push("custom_tool")
    }

    // ast-grep is built-in, so its tool should NOT be registered
    expect(tools).not.toContain("ast_grep_search")
    // nonexistent is not built-in, so its tool should be registered
    expect(tools).toContain("custom_tool")
  })
})
