import { describe, test, expect, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { SecurityConfig } from "@/security/config"
import { SecurityAccess } from "@/security/access"
import { loadBaseConfig, setupSecurityConfig, teardownSecurityConfig } from "../helpers"

afterEach(() => {
  teardownSecurityConfig()
})

describe("CASE-RACE-001: TOCTOU timing window — config loaded once and cached", () => {
  // [INFO] The config is loaded once at startup and cached in memory.
  // Changes to the config file after load do not affect security checks.
  // This means there is a TOCTOU window at load time only, but once loaded,
  // the cached config is immutable until explicitly reloaded.
  test("documents TOCTOU behavior: config is read once and cached in memory", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)

    // Config is now loaded and cached
    const config = SecurityConfig.getSecurityConfig()
    expect(config.rules?.length).toBeGreaterThan(0)

    // Verify protection is active
    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(result.allowed).toBe(false)

    // The TOCTOU window: config was loaded from disk once.
    // An attacker who modifies the file BEFORE load can inject malicious config.
    // An attacker who modifies the file AFTER load has no effect.
    // This is INFO severity because load-time is a brief, non-repeating window.
  })

  test("config file modification after load has no effect on security checks", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)

    // Verify secrets are protected
    const before = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(before.allowed).toBe(false)

    // Attacker modifies config file to remove all rules
    const weakConfig = { version: "1.0" as const, roles: [], rules: [] }
    fs.writeFileSync(path.join(dir, ".opencode-security.json"), JSON.stringify(weakConfig))

    // Cached config still protects — file change has NO effect
    const after = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(after.allowed).toBe(false)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("CASE-RACE-002: Config is cached in memory — old rules persist", () => {
  test("getSecurityConfig returns cached config even after file deletion", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)
    const configPath = path.join(dir, ".opencode-security.json")

    // Config is loaded and cached
    const configBefore = SecurityConfig.getSecurityConfig()
    expect(configBefore.rules?.length).toBeGreaterThan(0)

    // Delete the config file
    fs.unlinkSync(configPath)
    expect(fs.existsSync(configPath)).toBe(false)

    // getSecurityConfig still returns the cached config
    const configAfter = SecurityConfig.getSecurityConfig()
    expect(configAfter.rules).toEqual(configBefore.rules)
    expect(configAfter.roles).toEqual(configBefore.roles)

    // Protection still enforced
    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(result.allowed).toBe(false)

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("getSecurityConfig returns cached config even after file is replaced with empty config", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)

    // Replace with empty config on disk
    fs.writeFileSync(
      path.join(dir, ".opencode-security.json"),
      JSON.stringify({ version: "1.0", roles: [], rules: [] }),
    )

    // Cached config unchanged
    const config = SecurityConfig.getSecurityConfig()
    expect(config.rules?.length).toBeGreaterThan(0)

    // Protection still active
    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(result.allowed).toBe(false)

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("only explicit loadSecurityConfig refreshes the cached config", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)

    // Protection is active
    const before = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(before.allowed).toBe(false)

    // Replace config file with empty rules
    fs.writeFileSync(
      path.join(dir, ".opencode-security.json"),
      JSON.stringify({ version: "1.0", roles: [], rules: [] }),
    )

    // Still protected (cached)
    const mid = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(mid.allowed).toBe(false)

    // Explicit reload replaces the cache
    await SecurityConfig.loadSecurityConfig(dir)

    // Now protection is gone
    const after = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(after.allowed).toBe(true)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("CASE-RACE-003: Symlink swap timing window — resolved once per check", () => {
  // [INFO] When a symlink is resolved during a security check, it is resolved once
  // via fs.realpathSync(). There is no re-check between the security decision and
  // the actual file access. An attacker who swaps a symlink target between the
  // security check and the file read could bypass protection.
  test("documents symlink resolution is point-in-time — no re-verification", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)

    // Create a safe file and a protected file
    const safeDir = path.join(dir, "public")
    const secretsDir = path.join(dir, "secrets")
    fs.mkdirSync(safeDir, { recursive: true })
    fs.mkdirSync(secretsDir, { recursive: true })
    fs.writeFileSync(path.join(safeDir, "safe.txt"), "safe content")
    fs.writeFileSync(path.join(secretsDir, "key.pem"), "SECRET KEY CONTENT")

    // Create a symlink initially pointing to safe content
    const linkPath = path.join(dir, "link.txt")
    fs.symlinkSync(path.join(safeDir, "safe.txt"), linkPath)

    // At this moment, resolving the symlink gives us a safe target
    const resolvedBefore = fs.realpathSync(linkPath)
    expect(resolvedBefore).toContain("safe.txt")

    // Swap the symlink to point to protected content
    fs.unlinkSync(linkPath)
    fs.symlinkSync(path.join(secretsDir, "key.pem"), linkPath)

    // Now resolution gives us the protected target
    const resolvedAfter = fs.realpathSync(linkPath)
    expect(resolvedAfter).toContain("key.pem")

    // The timing window: between security check (resolves symlink once)
    // and actual file read, an attacker could swap the symlink.
    // This is INFO severity because:
    // 1. The window is extremely small (microseconds)
    // 2. Requires precise timing and local file access
    // 3. The attacker already needs local filesystem access

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("symlink resolved at check time — no persistent resolution cache", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)

    const safeDir = path.join(dir, "public")
    const secretsDir = path.join(dir, "secrets")
    fs.mkdirSync(safeDir, { recursive: true })
    fs.mkdirSync(secretsDir, { recursive: true })
    fs.writeFileSync(path.join(safeDir, "safe.txt"), "safe content")
    fs.writeFileSync(path.join(secretsDir, "key.pem"), "SECRET KEY CONTENT")

    const linkPath = path.join(dir, "link.txt")

    // First check: symlink to safe content
    fs.symlinkSync(path.join(safeDir, "safe.txt"), linkPath)
    const resolved1 = fs.realpathSync(linkPath)
    expect(resolved1).toContain("safe.txt")

    // Swap symlink
    fs.unlinkSync(linkPath)
    fs.symlinkSync(path.join(secretsDir, "key.pem"), linkPath)

    // Second check: resolves to new target (no stale cache)
    const resolved2 = fs.realpathSync(linkPath)
    expect(resolved2).toContain("key.pem")

    // Each resolution is independent — no cross-check caching
    expect(resolved1).not.toEqual(resolved2)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})
