import { describe, test, expect, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { SecurityConfig } from "@/security/config"
import type { SecuritySchema } from "@/security/schema"

afterEach(() => {
  SecurityConfig.resetConfig()
})

describe("SecurityConfig self-protection", () => {
  test("loading config with rules adds implicit protection for .opencode-security.json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-prot-"))
    fs.mkdirSync(path.join(dir, ".git"))
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [{ name: "viewer", level: 10 }],
      rules: [{ pattern: "*.env", type: "file", deniedOperations: ["read"], allowedRoles: [] }],
    }
    fs.writeFileSync(path.join(dir, ".opencode-security.json"), JSON.stringify(config))
    const loaded = await SecurityConfig.loadSecurityConfig(dir)
    const protRule = loaded.rules?.find((r) => r.pattern === ".opencode-security.json")
    expect(protRule).toBeDefined()
    expect(protRule!.deniedOperations).toContain("write")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("loading config adds implicit protection for .opencode-security-audit.log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-prot-"))
    fs.mkdirSync(path.join(dir, ".git"))
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      rules: [{ pattern: "*.env", type: "file", deniedOperations: ["read"], allowedRoles: [] }],
    }
    fs.writeFileSync(path.join(dir, ".opencode-security.json"), JSON.stringify(config))
    const loaded = await SecurityConfig.loadSecurityConfig(dir)
    const auditRule = loaded.rules?.find((r) => r.pattern === ".opencode-security-audit.log")
    expect(auditRule).toBeDefined()
    expect(auditRule!.deniedOperations).toContain("write")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("does not duplicate implicit rules if user already defined them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-prot-"))
    fs.mkdirSync(path.join(dir, ".git"))
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      rules: [
        { pattern: ".opencode-security.json", type: "file", deniedOperations: ["write", "read"], allowedRoles: [] },
      ],
    }
    fs.writeFileSync(path.join(dir, ".opencode-security.json"), JSON.stringify(config))
    const loaded = await SecurityConfig.loadSecurityConfig(dir)
    const matching = loaded.rules?.filter((r) => r.pattern === ".opencode-security.json")
    expect(matching).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("SecurityConfig getMcpPolicy", () => {
  test("returns 'trusted' when no security config loaded", () => {
    SecurityConfig.resetConfig()
    expect(SecurityConfig.getMcpPolicy("some-server")).toBe("trusted")
  })

  test("returns 'enforced' when rules exist but no MCP config", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-mcp-"))
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

  test("returns server-specific policy when defined in MCP config", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-mcp-"))
    fs.mkdirSync(path.join(dir, ".git"))
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      mcp: {
        defaultPolicy: "enforced",
        servers: { "my-server": "trusted", "blocked-server": "blocked" },
      },
    }
    fs.writeFileSync(path.join(dir, ".opencode-security.json"), JSON.stringify(config))
    await SecurityConfig.loadSecurityConfig(dir)
    expect(SecurityConfig.getMcpPolicy("my-server")).toBe("trusted")
    expect(SecurityConfig.getMcpPolicy("blocked-server")).toBe("blocked")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("returns defaultPolicy from MCP config when server not listed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-mcp-"))
    fs.mkdirSync(path.join(dir, ".git"))
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      mcp: {
        defaultPolicy: "blocked",
        servers: {},
      },
    }
    fs.writeFileSync(path.join(dir, ".opencode-security.json"), JSON.stringify(config))
    await SecurityConfig.loadSecurityConfig(dir)
    expect(SecurityConfig.getMcpPolicy("unlisted-server")).toBe("blocked")
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
