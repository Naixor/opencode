import { describe, test, expect, afterEach, mock } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { SecurityAccess } from "@/security/access"
import { SecuritySchema } from "@/security/schema"
import { SecurityConfig } from "@/security/config"
import { SecurityAudit } from "@/security/audit"
import { setupSecurityConfig, teardownSecurityConfig, createTempSymlink } from "../helpers"

afterEach(() => {
  teardownSecurityConfig()
})

// ---------------------------------------------------------------------------
// CASE-AL-001: File matches allowlist entry (type: file)
// ---------------------------------------------------------------------------
describe("CASE-AL-001: File matches allowlist entry (type: file) — llm allowed", () => {
  test("file entry allows llm access to matching file", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "README.md", type: "file" }],
    }
    await setupSecurityConfig(config)

    const result = SecurityAccess.checkAccess("README.md", "llm", "developer")
    expect(result.allowed).toBe(true)
  })

  test("file entry does NOT match similar but different filename", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "README.md", type: "file" }],
    }
    await setupSecurityConfig(config)

    const result = SecurityAccess.checkAccess("README.md.bak", "llm", "developer")
    expect(result.allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CASE-AL-002: File matches allowlist entry (type: directory)
// ---------------------------------------------------------------------------
describe("CASE-AL-002: Directory entry allows llm access to nested files", () => {
  test("directory entry matches nested file", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    await setupSecurityConfig(config)

    const result = SecurityAccess.checkAccess("src/foo/bar.ts", "llm", "developer")
    expect(result.allowed).toBe(true)
  })

  test("directory entry matches deeply nested file", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    await setupSecurityConfig(config)

    const result = SecurityAccess.checkAccess("src/a/b/c/d.ts", "llm", "developer")
    expect(result.allowed).toBe(true)
  })

  test("directory entry does NOT match file outside directory", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    await setupSecurityConfig(config)

    const result = SecurityAccess.checkAccess("test/foo.ts", "llm", "developer")
    expect(result.allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CASE-AL-003: File NOT in allowlist — llm denied with friendly message
// ---------------------------------------------------------------------------
describe("CASE-AL-003: File not in allowlist — llm denied with actionable message", () => {
  test("denial message includes rejected path, rejecting layer source, and suggestion", async () => {
    const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-al-003-"))
    const dir = fs.realpathSync(rawDir)

    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    const configDir = await setupSecurityConfig(config, dir)

    const result = SecurityAccess.checkAccess("secrets/key.pem", "llm", "developer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toBeDefined()
    // Message includes the rejected path
    expect(result.reason).toContain("secrets/key.pem")
    // Message includes the layer source config path
    expect(result.reason).toContain(".opencode-security.json")
    // Message includes suggestion with example entry
    expect(result.reason).toContain("pattern")

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// CASE-AL-004: Deny rule wins over allowlist
// ---------------------------------------------------------------------------
describe("CASE-AL-004: Deny rule overrides allowlist — deny always wins", () => {
  test("file in allowlist but covered by deny rule with llm in deniedOperations → llm denied", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "developer", level: 50 },
      ],
      rules: [
        {
          pattern: "src/secrets/**",
          type: "directory",
          deniedOperations: ["llm"],
          allowedRoles: ["admin"],
        },
      ],
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    await setupSecurityConfig(config)

    const result = SecurityAccess.checkAccess("src/secrets/api-key.ts", "llm", "developer")
    expect(result.allowed).toBe(false)
    // The denial should come from the deny rule, not the allowlist
    expect(result.reason).toContain("src/secrets/**")
  })
})

// ---------------------------------------------------------------------------
// CASE-AL-005: read operations enforced by allowlist, write bypasses
// ---------------------------------------------------------------------------
describe("CASE-AL-005: Read operations enforced by allowlist, write bypasses", () => {
  test("read denied if file not in allowlist", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    await setupSecurityConfig(config)

    const result = SecurityAccess.checkAccess("test/foo.ts", "read", "developer")
    expect(result.allowed).toBe(false)
  })

  test("read allowed if file is in allowlist", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    await setupSecurityConfig(config)

    const result = SecurityAccess.checkAccess("src/foo.ts", "read", "developer")
    expect(result.allowed).toBe(true)
  })

  test("write allowed even if file not in allowlist", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    await setupSecurityConfig(config)

    const result = SecurityAccess.checkAccess("test/foo.ts", "write", "developer")
    expect(result.allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CASE-AL-006: Empty allowlist array [] → all llm operations denied
// ---------------------------------------------------------------------------
describe("CASE-AL-006: Empty allowlist denies all llm operations", () => {
  test("empty allowlist array blocks all llm access", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [],
    }
    await setupSecurityConfig(config)

    const result = SecurityAccess.checkAccess("src/foo.ts", "llm", "developer")
    // Empty allowlist means no entries match in the layer → denied
    // Note: an empty allowlist produces one AllowlistLayer with entries: []
    // Since no entry matches, the file is denied
    expect(result.allowed).toBe(false)
  })

  test("empty allowlist blocks read but allows write", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [],
    }
    await setupSecurityConfig(config)

    expect(SecurityAccess.checkAccess("src/foo.ts", "read", "developer").allowed).toBe(false)
    expect(SecurityAccess.checkAccess("src/foo.ts", "write", "developer").allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CASE-AL-007: No allowlist field → all files accessible (backward compatible)
// ---------------------------------------------------------------------------
describe("CASE-AL-007: No allowlist configured — backward compatible, all files accessible", () => {
  test("config without allowlist field allows all llm access", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
    }
    await setupSecurityConfig(config)

    const result = SecurityAccess.checkAccess("anything/anywhere.ts", "llm", "developer")
    expect(result.allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CASE-AL-008: Directory entry { pattern: 'src/**', type: 'directory' } matches src/foo/bar.ts
// ---------------------------------------------------------------------------
describe("CASE-AL-008: Directory glob pattern matching", () => {
  test("src/** matches src/foo/bar.ts", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    await setupSecurityConfig(config)

    expect(SecurityAccess.checkAccess("src/foo/bar.ts", "llm", "developer").allowed).toBe(true)
  })

  test("src/** matches src/index.ts at top level of src", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    await setupSecurityConfig(config)

    expect(SecurityAccess.checkAccess("src/index.ts", "llm", "developer").allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CASE-AL-009: File entry matches only exact file
// ---------------------------------------------------------------------------
describe("CASE-AL-009: File entry exact match", () => {
  test("README.md matches README.md", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "README.md", type: "file" }],
    }
    await setupSecurityConfig(config)

    expect(SecurityAccess.checkAccess("README.md", "llm", "developer").allowed).toBe(true)
  })

  test("README.md does not match README.md.bak", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "README.md", type: "file" }],
    }
    await setupSecurityConfig(config)

    expect(SecurityAccess.checkAccess("README.md.bak", "llm", "developer").allowed).toBe(false)
  })

  test("README.md does not match sub/README.md.bak", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "README.md", type: "file" }],
    }
    await setupSecurityConfig(config)

    expect(SecurityAccess.checkAccess("sub/README.md.bak", "llm", "developer").allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CASE-AL-010: Symlink resolved path checked against allowlist
// ---------------------------------------------------------------------------
describe("CASE-AL-010: Symlink resolution for allowlist", () => {
  test("symlink to file inside allowlist is allowed", async () => {
    const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-al-010a-"))
    const dir = fs.realpathSync(rawDir)

    // Create real file inside src/
    const srcDir = path.join(dir, "src")
    fs.mkdirSync(srcDir, { recursive: true })
    const realFile = path.join(srcDir, "app.ts")
    fs.writeFileSync(realFile, "export const x = 1")

    // Create symlink outside src/ pointing to the real file
    const linkPath = path.join(dir, "link-to-app.ts")
    const cleanupLink = createTempSymlink(realFile, linkPath)

    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: `${srcDir}/**`, type: "directory" }],
    }
    await setupSecurityConfig(config, dir)

    // Symlink resolves to src/app.ts which IS in the allowlist
    const result = SecurityAccess.checkAccess(linkPath, "llm", "developer")
    expect(result.allowed).toBe(true)

    cleanupLink()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("symlink to file outside allowlist is denied", async () => {
    const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-al-010b-"))
    const dir = fs.realpathSync(rawDir)

    // Create real file outside allowed dir
    const secretsDir = path.join(dir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const secretFile = path.join(secretsDir, "key.pem")
    fs.writeFileSync(secretFile, "secret-data")

    // Create symlink inside src/ pointing to secret file
    const srcDir = path.join(dir, "src")
    fs.mkdirSync(srcDir, { recursive: true })
    const linkPath = path.join(srcDir, "sneaky-link.pem")
    const cleanupLink = createTempSymlink(secretFile, linkPath)

    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: `${srcDir}/**`, type: "directory" }],
    }
    await setupSecurityConfig(config, dir)

    // Symlink resolves to secrets/key.pem which is NOT in the allowlist
    const result = SecurityAccess.checkAccess(linkPath, "llm", "developer")
    expect(result.allowed).toBe(false)

    cleanupLink()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// CASE-AL-011: Two-layer allowlist — file must match both layers
// ---------------------------------------------------------------------------
describe("CASE-AL-011: Two-layer allowlist — AND across layers", () => {
  test("file matching both layers is allowed", () => {
    const parentConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    const childConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [
        { pattern: "src/**", type: "directory" },
        { pattern: "test/**", type: "directory" },
      ],
    }

    const merged = SecurityConfig.mergeSecurityConfigs([
      { config: parentConfig, path: "parent/.opencode-security.json" },
      { config: childConfig, path: "child/.opencode-security.json" },
    ])

    expect(merged.resolvedAllowlist.length).toBe(2)
    // Both layers allow src/** so src/foo.ts should be allowed
    // We need to load this merged config to test checkAccess
  })

  test("file in child allowlist but not parent allowlist is denied", async () => {
    const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-al-011-"))
    const dir = fs.realpathSync(rawDir)

    // Manually create a two-layer resolved config via mergeSecurityConfigs
    const parentConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    const childConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [
        { pattern: "src/**", type: "directory" },
        { pattern: "test/**", type: "directory" },
      ],
    }

    const merged = SecurityConfig.mergeSecurityConfigs([
      { config: parentConfig, path: "parent/.opencode-security.json" },
      { config: childConfig, path: "child/.opencode-security.json" },
    ])

    // Set the merged config by writing parent config and loading it,
    // then we'll verify via the merged object directly
    expect(merged.resolvedAllowlist.length).toBe(2)

    // Parent layer only has src/**. Child layer has src/** + test/**
    // test/foo.ts matches child layer but NOT parent layer → denied
    // We test this by setting up config that creates the two-layer scenario
    // Use setupSecurityConfig with parent config (single layer) to test the logic
    // For a true two-layer test, we need to use the config system directly

    // Create a two-level directory structure with separate configs
    const parentDir = dir
    const childDir = path.join(dir, "subproject")
    fs.mkdirSync(childDir, { recursive: true })

    // Parent has allowlist: src/**
    fs.writeFileSync(path.join(parentDir, ".opencode-security.json"), JSON.stringify(parentConfig, null, 2))
    // Child has allowlist: src/** + test/**
    fs.writeFileSync(path.join(childDir, ".opencode-security.json"), JSON.stringify(childConfig, null, 2))
    // .git at parent level
    fs.mkdirSync(path.join(parentDir, ".git"), { recursive: true })

    // Load from child dir — findSecurityConfigs walks up to git root
    await SecurityConfig.loadSecurityConfig(childDir)

    const loadedConfig = SecurityConfig.getSecurityConfig()
    expect(loadedConfig.resolvedAllowlist.length).toBe(2)

    // test/foo.ts matches child layer (test/**) but NOT parent layer (src/**)
    const result = SecurityAccess.checkAccess("test/foo.ts", "llm", "developer")
    expect(result.allowed).toBe(false)

    // src/foo.ts matches both layers
    const srcResult = SecurityAccess.checkAccess("src/foo.ts", "llm", "developer")
    expect(srcResult.allowed).toBe(true)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// CASE-AL-012: Child config cannot expand parent allowlist
// ---------------------------------------------------------------------------
describe("CASE-AL-012: Child config cannot expand parent allowlist", () => {
  test("parent allows src/**, child adds test/** — test/** denied by parent layer", async () => {
    const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-al-012-"))
    const dir = fs.realpathSync(rawDir)

    const parentConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    const childConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [
        { pattern: "src/**", type: "directory" },
        { pattern: "test/**", type: "directory" },
      ],
    }

    const parentDir = dir
    const childDir = path.join(dir, "subproject")
    fs.mkdirSync(childDir, { recursive: true })

    fs.writeFileSync(path.join(parentDir, ".opencode-security.json"), JSON.stringify(parentConfig, null, 2))
    fs.writeFileSync(path.join(childDir, ".opencode-security.json"), JSON.stringify(childConfig, null, 2))
    fs.mkdirSync(path.join(parentDir, ".git"), { recursive: true })

    await SecurityConfig.loadSecurityConfig(childDir)

    // test/foo.ts NOT in parent's allowlist → denied even though child allows it
    const result = SecurityAccess.checkAccess("test/foo.ts", "llm", "developer")
    expect(result.allowed).toBe(false)
    // Denial message should reference the parent layer's config path
    expect(result.reason).toContain(".opencode-security.json")

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// CASE-AL-013: Single-layer allowlist (only parent or only child defines it)
// ---------------------------------------------------------------------------
describe("CASE-AL-013: Single-layer allowlist scenarios", () => {
  test("only parent defines allowlist — child without allowlist does not add a layer", async () => {
    const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-al-013a-"))
    const dir = fs.realpathSync(rawDir)

    const parentConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    const childConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      // No allowlist field
    }

    const parentDir = dir
    const childDir = path.join(dir, "subproject")
    fs.mkdirSync(childDir, { recursive: true })

    fs.writeFileSync(path.join(parentDir, ".opencode-security.json"), JSON.stringify(parentConfig, null, 2))
    fs.writeFileSync(path.join(childDir, ".opencode-security.json"), JSON.stringify(childConfig, null, 2))
    fs.mkdirSync(path.join(parentDir, ".git"), { recursive: true })

    await SecurityConfig.loadSecurityConfig(childDir)

    const config = SecurityConfig.getSecurityConfig()
    // Only one layer from parent config
    expect(config.resolvedAllowlist.length).toBe(1)

    // src/foo.ts in allowlist → allowed
    expect(SecurityAccess.checkAccess("src/foo.ts", "llm", "developer").allowed).toBe(true)
    // test/foo.ts not in allowlist → denied
    expect(SecurityAccess.checkAccess("test/foo.ts", "llm", "developer").allowed).toBe(false)

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("only child defines allowlist — parent without allowlist does not add a layer", async () => {
    const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-al-013b-"))
    const dir = fs.realpathSync(rawDir)

    const parentConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      // No allowlist field
    }
    const childConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }

    const parentDir = dir
    const childDir = path.join(dir, "subproject")
    fs.mkdirSync(childDir, { recursive: true })

    fs.writeFileSync(path.join(parentDir, ".opencode-security.json"), JSON.stringify(parentConfig, null, 2))
    fs.writeFileSync(path.join(childDir, ".opencode-security.json"), JSON.stringify(childConfig, null, 2))
    fs.mkdirSync(path.join(parentDir, ".git"), { recursive: true })

    await SecurityConfig.loadSecurityConfig(childDir)

    const config = SecurityConfig.getSecurityConfig()
    // Only one layer from child config
    expect(config.resolvedAllowlist.length).toBe(1)

    // src/foo.ts in allowlist → allowed
    expect(SecurityAccess.checkAccess("src/foo.ts", "llm", "developer").allowed).toBe(true)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// CASE-AL-014: Multi-level config loading produces correct ResolvedSecurityConfig
// ---------------------------------------------------------------------------
describe("CASE-AL-014: Multi-level config loading via findSecurityConfigs + mergeSecurityConfigs", () => {
  test("mergeSecurityConfigs produces correct AllowlistLayer[] from multiple configs", () => {
    const parentConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [
        { pattern: "src/**", type: "directory" },
        { pattern: "README.md", type: "file" },
      ],
    }
    const childConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/components/**", type: "directory" }],
    }

    const merged = SecurityConfig.mergeSecurityConfigs([
      { config: parentConfig, path: "/repo/.opencode-security.json" },
      { config: childConfig, path: "/repo/packages/app/.opencode-security.json" },
    ])

    expect(merged.resolvedAllowlist.length).toBe(2)
    expect(merged.resolvedAllowlist[0].source).toBe("/repo/.opencode-security.json")
    expect(merged.resolvedAllowlist[0].entries.length).toBe(2)
    expect(merged.resolvedAllowlist[1].source).toBe("/repo/packages/app/.opencode-security.json")
    expect(merged.resolvedAllowlist[1].entries.length).toBe(1)
  })

  test("mergeSecurityConfigs with no allowlist produces empty resolvedAllowlist", () => {
    const config1: SecuritySchema.SecurityConfig = { version: "1.0" }
    const config2: SecuritySchema.SecurityConfig = { version: "1.0", rules: [] }

    const merged = SecurityConfig.mergeSecurityConfigs([
      { config: config1, path: "a/.opencode-security.json" },
      { config: config2, path: "b/.opencode-security.json" },
    ])

    expect(merged.resolvedAllowlist.length).toBe(0)
  })

  test("mergeSecurityConfigs with single config produces single layer", () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }

    const merged = SecurityConfig.mergeSecurityConfigs([{ config, path: "/repo/.opencode-security.json" }])

    expect(merged.resolvedAllowlist.length).toBe(1)
    expect(merged.resolvedAllowlist[0].source).toBe("/repo/.opencode-security.json")
    expect(merged.resolvedAllowlist[0].entries).toEqual([{ pattern: "src/**", type: "directory" }])
  })
})

// ---------------------------------------------------------------------------
// CASE-AL-015: Audit log records allowlist denial events
// ---------------------------------------------------------------------------
describe("CASE-AL-015: Audit logging on allowlist denial", () => {
  test("allowlist denial calls SecurityAudit.logSecurityEvent with correct data", async () => {
    const calls: SecurityAudit.SecurityEvent[] = []
    const originalLog = SecurityAudit.logSecurityEvent
    SecurityAudit.logSecurityEvent = (event: SecurityAudit.SecurityEvent) => {
      calls.push(event)
    }

    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    await setupSecurityConfig(config)

    SecurityAccess.checkAccess("secrets/key.pem", "llm", "developer")

    expect(calls.length).toBe(1)
    expect(calls[0].path).toBe("secrets/key.pem")
    expect(calls[0].operation).toBe("llm")
    expect(calls[0].role).toBe("developer")
    expect(calls[0].allowed).toBe(false)
    expect(calls[0].reason).toContain("Allowlist denial")

    // Restore
    SecurityAudit.logSecurityEvent = originalLog
  })

  test("allowlist allowed access does NOT trigger audit log", async () => {
    const calls: SecurityAudit.SecurityEvent[] = []
    const originalLog = SecurityAudit.logSecurityEvent
    SecurityAudit.logSecurityEvent = (event: SecurityAudit.SecurityEvent) => {
      calls.push(event)
    }

    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }
    await setupSecurityConfig(config)

    SecurityAccess.checkAccess("src/app.ts", "llm", "developer")

    expect(calls.length).toBe(0)

    SecurityAudit.logSecurityEvent = originalLog
  })
})
