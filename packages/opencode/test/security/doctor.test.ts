import { test, expect, beforeEach } from "bun:test"
import { runSecurityDoctor } from "../../src/security/doctor"
import { SecurityConfig } from "../../src/security/config"
import fs from "fs/promises"
import path from "path"
import os from "os"

let testDir: string

beforeEach(async () => {
  testDir = path.join(os.tmpdir(), `security-doctor-test-${Date.now()}`)
  await fs.mkdir(testDir, { recursive: true })
  SecurityConfig.resetConfig()
})

async function writeConfig(config: unknown) {
  await fs.writeFile(path.join(testDir, ".opencode-security.json"), JSON.stringify(config, null, 2))
  // Initialize a git repo so findSecurityConfigs works
  await fs.mkdir(path.join(testDir, ".git"), { recursive: true })
  await SecurityConfig.loadSecurityConfig(testDir)
}

test("no config file produces info diagnostic", async () => {
  await fs.mkdir(path.join(testDir, ".git"), { recursive: true })
  await SecurityConfig.loadSecurityConfig(testDir)
  const diagnostics = await runSecurityDoctor(testDir)
  const configInfo = diagnostics.find((d) => d.category === "config" && d.level === "info")
  expect(configInfo).toBeDefined()
  expect(configInfo!.message).toContain("No .opencode-security.json found")
})

test("invalid JSON produces error diagnostic", async () => {
  await fs.mkdir(path.join(testDir, ".git"), { recursive: true })
  await fs.writeFile(path.join(testDir, ".opencode-security.json"), "{ invalid json }")
  await SecurityConfig.loadSecurityConfig(testDir)
  const diagnostics = await runSecurityDoctor(testDir)
  const parseError = diagnostics.find((d) => d.category === "config" && d.level === "error")
  expect(parseError).toBeDefined()
  expect(parseError!.message).toContain("Invalid JSON")
})

test("discovers config files in subdirectories", async () => {
  await fs.mkdir(path.join(testDir, ".git"), { recursive: true })
  // Root config
  await fs.writeFile(
    path.join(testDir, ".opencode-security.json"),
    JSON.stringify({ version: "1.0" }),
  )
  // Subdirectory config
  await fs.mkdir(path.join(testDir, "packages", "app"), { recursive: true })
  await fs.writeFile(
    path.join(testDir, "packages", "app", ".opencode-security.json"),
    JSON.stringify({ version: "1.0", rules: [{ pattern: ".env", type: "file", deniedOperations: ["read"], allowedRoles: [] }] }),
  )
  await SecurityConfig.loadSecurityConfig(testDir)
  const diagnostics = await runSecurityDoctor(testDir)
  const found = diagnostics.find((d) => d.category === "config" && d.message.includes("2 security config file"))
  expect(found).toBeDefined()
})

test("subdirectory configs are included in merge chain", async () => {
  await fs.mkdir(path.join(testDir, ".git"), { recursive: true })
  // Root config
  await fs.writeFile(
    path.join(testDir, ".opencode-security.json"),
    JSON.stringify({ version: "1.0" }),
  )
  // Subdirectory config — should now be loaded
  await fs.mkdir(path.join(testDir, "packages", "app"), { recursive: true })
  await fs.writeFile(
    path.join(testDir, "packages", "app", ".opencode-security.json"),
    JSON.stringify({ version: "1.0", rules: [{ pattern: ".env", type: "file", deniedOperations: ["read"], allowedRoles: [] }] }),
  )
  await SecurityConfig.loadSecurityConfig(testDir)
  const diagnostics = await runSecurityDoctor(testDir)
  // Should NOT have "NOT in active merge chain" warning
  const inactive = diagnostics.find((d) => d.message.includes("NOT in active merge chain"))
  expect(inactive).toBeUndefined()
  // Both configs should be reported as valid
  const validInfos = diagnostics.filter((d) => d.category === "config" && d.message.includes("valid"))
  expect(validInfos.length).toBe(2)
})

test("schema validation error produces error diagnostic", async () => {
  await fs.mkdir(path.join(testDir, ".git"), { recursive: true })
  await fs.writeFile(
    path.join(testDir, ".opencode-security.json"),
    JSON.stringify({ version: 123 }),
  )
  await SecurityConfig.loadSecurityConfig(testDir)
  const diagnostics = await runSecurityDoctor(testDir)
  const schemaError = diagnostics.find((d) => d.category === "schema" && d.level === "error")
  expect(schemaError).toBeDefined()
})

test("undefined role reference produces warning", async () => {
  await writeConfig({
    version: "1.0",
    roles: [{ name: "admin", level: 100 }],
    rules: [
      {
        pattern: ".env",
        type: "file",
        deniedOperations: ["read"],
        allowedRoles: ["admin", "nonexistent"],
      },
    ],
  })
  const diagnostics = await runSecurityDoctor(testDir)
  const roleWarn = diagnostics.find((d) => d.category === "roles" && d.level === "warn")
  expect(roleWarn).toBeDefined()
  expect(roleWarn!.message).toContain("nonexistent")
})

test("empty allowedRoles produces info", async () => {
  await writeConfig({
    version: "1.0",
    rules: [
      {
        pattern: ".env",
        type: "file",
        deniedOperations: ["read"],
        allowedRoles: [],
      },
    ],
  })
  const diagnostics = await runSecurityDoctor(testDir)
  const info = diagnostics.find((d) => d.category === "roles" && d.message.includes("empty allowedRoles"))
  expect(info).toBeDefined()
})

test("empty deniedOperations produces warning", async () => {
  await writeConfig({
    version: "1.0",
    rules: [
      {
        pattern: ".env",
        type: "file",
        deniedOperations: [],
        allowedRoles: [],
      },
    ],
  })
  const diagnostics = await runSecurityDoctor(testDir)
  const warn = diagnostics.find((d) => d.category === "rules" && d.level === "warn")
  expect(warn).toBeDefined()
  expect(warn!.message).toContain("empty deniedOperations")
})

test("write-only deny rule produces sandbox warning", async () => {
  await writeConfig({
    version: "1.0",
    rules: [
      {
        pattern: "dist",
        type: "directory",
        deniedOperations: ["write"],
        allowedRoles: [],
      },
    ],
  })
  const diagnostics = await runSecurityDoctor(testDir)
  const warn = diagnostics.find((d) => d.category === "sandbox" && d.level === "warn")
  expect(warn).toBeDefined()
  expect(warn!.message).toContain("write-only deny")
})

test("duplicate rules produces warning", async () => {
  await writeConfig({
    version: "1.0",
    rules: [
      { pattern: ".env", type: "file", deniedOperations: ["read", "write"], allowedRoles: [] },
      { pattern: ".env", type: "file", deniedOperations: ["read", "write"], allowedRoles: [] },
    ],
  })
  const diagnostics = await runSecurityDoctor(testDir)
  const dup = diagnostics.find((d) => d.category === "redundant" && d.level === "warn")
  expect(dup).toBeDefined()
  expect(dup!.message).toContain("Duplicate rules")
})

test("overly broad glob pattern ** produces warning", async () => {
  await writeConfig({
    version: "1.0",
    rules: [
      { pattern: "**", type: "directory", deniedOperations: ["read"], allowedRoles: [] },
    ],
  })
  const diagnostics = await runSecurityDoctor(testDir)
  const warn = diagnostics.find((d) => d.category === "glob" && d.level === "warn")
  expect(warn).toBeDefined()
  expect(warn!.message).toContain("ALL files")
})

test("absolute path pattern produces warning", async () => {
  await writeConfig({
    version: "1.0",
    rules: [
      { pattern: "/etc/passwd", type: "file", deniedOperations: ["read"], allowedRoles: [] },
    ],
  })
  const diagnostics = await runSecurityDoctor(testDir)
  const warn = diagnostics.find((d) => d.category === "glob" && d.level === "warn")
  expect(warn).toBeDefined()
  expect(warn!.message).toContain("absolute path")
})

test("valid config with no issues produces only info diagnostics", async () => {
  await writeConfig({
    version: "1.0",
    roles: [{ name: "admin", level: 100 }],
    rules: [
      { pattern: ".env", type: "file", deniedOperations: ["read", "write"], allowedRoles: ["admin"] },
    ],
    allowlist: [
      { pattern: "src/**", type: "directory" },
    ],
  })
  const diagnostics = await runSecurityDoctor(testDir)
  const errors = diagnostics.filter((d) => d.level === "error")
  const warnings = diagnostics.filter((d) => d.level === "warn")
  expect(errors.length).toBe(0)
  expect(warnings.length).toBe(0)
})

test("subdirectory config rules are merged into resolved config", async () => {
  await fs.mkdir(path.join(testDir, ".git"), { recursive: true })
  await fs.writeFile(
    path.join(testDir, ".opencode-security.json"),
    JSON.stringify({
      version: "1.0",
      rules: [{ pattern: ".env", type: "file", deniedOperations: ["read"], allowedRoles: [] }],
    }),
  )
  await fs.mkdir(path.join(testDir, "packages", "core"), { recursive: true })
  await fs.writeFile(
    path.join(testDir, "packages", "core", ".opencode-security.json"),
    JSON.stringify({
      version: "1.0",
      rules: [{ pattern: "**/*.key", type: "file", deniedOperations: ["read", "write"], allowedRoles: [] }],
    }),
  )
  await SecurityConfig.loadSecurityConfig(testDir)
  const config = SecurityConfig.getSecurityConfig()
  // Both root and subdirectory rules should be merged
  expect(config.rules?.length).toBe(2)
  const patterns = config.rules?.map((r) => r.pattern) ?? []
  expect(patterns).toContain(".env")
  expect(patterns).toContain("**/*.key")
})

test("deny/allowlist overlap produces info", async () => {
  await writeConfig({
    version: "1.0",
    rules: [
      { pattern: "src/secrets/**", type: "directory", deniedOperations: ["read"], allowedRoles: [] },
    ],
    allowlist: [
      { pattern: "src/**", type: "directory" },
    ],
  })
  const diagnostics = await runSecurityDoctor(testDir)
  const overlap = diagnostics.find((d) => d.category === "overlap")
  expect(overlap).toBeDefined()
  expect(overlap!.message).toContain("overlaps")
})
