import { describe, test, expect, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { SecurityConfig } from "@/security/config"
import { SecurityAccess } from "@/security/access"
import { SecuritySchema } from "@/security/schema"
import { loadBaseConfig, setupSecurityConfig, teardownSecurityConfig } from "../helpers"

afterEach(() => {
  teardownSecurityConfig()
})

describe("CASE-CFG-001: Malformed JSON config causes fail-open", () => {
  // [KNOWN_LIMITATION] severity INFO
  // When the config file contains invalid JSON, the system falls back to an empty config
  // which means all access is allowed (fail-open behavior).
  test("malformed JSON results in empty config (fail-open) — all access allowed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-cfg-001-"))
    fs.mkdirSync(path.join(dir, ".git"))
    fs.writeFileSync(path.join(dir, ".opencode-security.json"), "{ invalid json !@#$ }")

    const config = await SecurityConfig.loadSecurityConfig(dir)

    // Empty config means no rules => fail-open
    expect(config.rules ?? []).toEqual([])
    expect(config.roles ?? []).toEqual([])

    // Verify access is allowed for everything when config is malformed
    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(result.allowed).toBe(true)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("CASE-CFG-002: Truncated config file causes fail-open, not crash", () => {
  test("truncated JSON does not crash and falls back to empty config", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-cfg-002-"))
    fs.mkdirSync(path.join(dir, ".git"))
    // Write valid-looking JSON that's been truncated mid-object
    fs.writeFileSync(
      path.join(dir, ".opencode-security.json"),
      '{"version":"1.0","roles":[{"name":"admin","level":100},{"na',
    )

    const config = await SecurityConfig.loadSecurityConfig(dir)

    expect(config.rules ?? []).toEqual([])
    expect(config.roles ?? []).toEqual([])
    expect(config.version).toBe("1.0")

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("empty file does not crash", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-cfg-002b-"))
    fs.mkdirSync(path.join(dir, ".git"))
    fs.writeFileSync(path.join(dir, ".opencode-security.json"), "")

    const config = await SecurityConfig.loadSecurityConfig(dir)

    // Should not crash and should return empty config
    expect(config.rules ?? []).toEqual([])

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("CASE-CFG-003: Config deletion after load — cached config continues to protect", () => {
  test("deleting config file after load does not remove protection", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)
    const configPath = path.join(dir, ".opencode-security.json")

    // Verify protection is active
    const beforeDelete = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(beforeDelete.allowed).toBe(false)

    // Delete the config file
    fs.rmSync(configPath, { force: true })
    expect(fs.existsSync(configPath)).toBe(false)

    // Cached config should still protect — getSecurityConfig uses in-memory cache
    const afterDelete = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(afterDelete.allowed).toBe(false)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("CASE-CFG-004: Child config cannot REMOVE restrictions from parent", () => {
  test("merging child config that allows secrets/public/ does not override parent protection of secrets/**", () => {
    const parentConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "viewer", level: 10 },
      ],
      rules: [
        {
          pattern: "secrets/**",
          type: "directory",
          deniedOperations: ["read", "write", "llm"],
          allowedRoles: ["admin"],
        },
      ],
    }

    const childConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "viewer", level: 10 },
      ],
      rules: [
        {
          pattern: "secrets/public/**",
          type: "directory",
          deniedOperations: [],
          allowedRoles: ["viewer"],
        },
      ],
    }

    // Merge: parent first (least specific), then child (most specific)
    const merged = SecurityConfig.mergeSecurityConfigs([{ config: parentConfig, path: "parent/.opencode-security.json" }, { config: childConfig, path: "child/.opencode-security.json" }])

    // Both rules should be present (union)
    expect(merged.rules).toHaveLength(2)

    // The parent's secrets/** restriction still exists in merged config
    const secretsRule = merged.rules!.find((r) => r.pattern === "secrets/**")
    expect(secretsRule).toBeDefined()
    expect(secretsRule!.deniedOperations).toContain("read")
  })

  test("parent protection still blocks access after merge", async () => {
    const parentConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "viewer", level: 10 },
      ],
      rules: [
        {
          pattern: "secrets/**",
          type: "directory",
          deniedOperations: ["read", "write", "llm"],
          allowedRoles: ["admin"],
        },
      ],
    }

    const childConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "viewer", level: 10 },
      ],
      rules: [],
    }

    const merged = SecurityConfig.mergeSecurityConfigs([{ config: parentConfig, path: "parent/.opencode-security.json" }, { config: childConfig, path: "child/.opencode-security.json" }])
    const dir = await setupSecurityConfig(merged)

    // Parent restriction on secrets/** should still block viewer
    const result = SecurityAccess.checkAccess("secrets/public/readme.md", "read", "viewer")
    expect(result.allowed).toBe(false)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("CASE-CFG-005: Conflicting role definitions across nested configs throws error", () => {
  test("same role name with different levels throws error", () => {
    const configA: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [{ name: "admin", level: 100 }],
    }

    const configB: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [{ name: "admin", level: 50 }],
    }

    expect(() => SecurityConfig.mergeSecurityConfigs([{ config: configA, path: "a/.opencode-security.json" }, { config: configB, path: "b/.opencode-security.json" }])).toThrow(
      /Role conflict.*admin.*100.*50/,
    )
  })

  test("same role name with same level does not throw", () => {
    const configA: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [{ name: "admin", level: 100 }],
    }

    const configB: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [{ name: "admin", level: 100 }],
    }

    const merged = SecurityConfig.mergeSecurityConfigs([{ config: configA, path: "a/.opencode-security.json" }, { config: configB, path: "b/.opencode-security.json" }])
    expect(merged.roles).toHaveLength(1)
    expect(merged.roles![0].name).toBe("admin")
    expect(merged.roles![0].level).toBe(100)
  })
})

describe("CASE-CFG-006: Config with empty rules means no protection", () => {
  test("empty rules array results in all access allowed", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "viewer", level: 10 },
      ],
      rules: [],
    }

    const dir = await setupSecurityConfig(config)

    // With no rules, all access should be allowed
    const readSecrets = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(readSecrets.allowed).toBe(true)

    const writeEnv = SecurityAccess.checkAccess(".env", "write", "viewer")
    expect(writeEnv.allowed).toBe(true)

    const llmAccess = SecurityAccess.checkAccess("src/auth/keys.ts", "llm", "viewer")
    expect(llmAccess.allowed).toBe(true)

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("undefined rules results in all access allowed", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
    }

    const dir = await setupSecurityConfig(config)

    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(result.allowed).toBe(true)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("CASE-CFG-007: Config with 1000+ rules does not crash or timeout", () => {
  test("loading and checking access with 1000 rules completes in < 5 seconds", async () => {
    const rules: SecuritySchema.Rule[] = Array.from({ length: 1000 }, (_, i) => ({
      pattern: `generated/path_${i}/**`,
      type: "directory" as const,
      deniedOperations: ["read" as const, "write" as const],
      allowedRoles: ["admin"],
    }))

    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "viewer", level: 10 },
      ],
      rules,
    }

    const start = performance.now()

    const dir = await setupSecurityConfig(config)

    // Check access against a path that doesn't match any rule
    const resultAllowed = SecurityAccess.checkAccess("safe/file.ts", "read", "viewer")
    expect(resultAllowed.allowed).toBe(true)

    // Check access against a path that matches one of the generated rules
    const resultBlocked = SecurityAccess.checkAccess("generated/path_500/file.ts", "read", "viewer")
    expect(resultBlocked.allowed).toBe(false)

    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(5000) // Must complete in < 5 seconds

    fs.rmSync(dir, { recursive: true, force: true })
  })
})
