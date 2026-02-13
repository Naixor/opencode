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

// ---------------------------------------------------------------------------
// CASE-INH-001: Child config cannot weaken parent
// Parent protects secrets/**, child allows secrets/public/ — parent wins
// Uses mergeSecurityConfigs and checkAccess
// ---------------------------------------------------------------------------
describe("CASE-INH-001: Child config cannot weaken parent — parent protects secrets/**, child allows secrets/public/", () => {
  const parentConfig: SecuritySchema.SecurityConfig = {
    version: "1.0",
    roles: [
      { name: "admin", level: 100 },
      { name: "developer", level: 50 },
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
      { name: "developer", level: 50 },
      { name: "viewer", level: 10 },
    ],
    rules: [
      {
        // Child tries to "allow" a sub-directory of secrets
        pattern: "secrets/public/**",
        type: "directory",
        deniedOperations: [],
        allowedRoles: ["viewer"],
      },
    ],
  }

  test("merged config unions rules — parent restriction on secrets/** still present", () => {
    const merged = SecurityConfig.mergeSecurityConfigs([parentConfig, childConfig])

    // Both rules should be present after merge
    expect(merged.rules?.length).toBe(2)

    const parentRule = merged.rules?.find((r) => r.pattern === "secrets/**")
    const childRule = merged.rules?.find((r) => r.pattern === "secrets/public/**")

    expect(parentRule).toBeDefined()
    expect(childRule).toBeDefined()
    expect(parentRule!.deniedOperations).toEqual(["read", "write", "llm"])
    expect(childRule!.deniedOperations).toEqual([])
  })

  test("checkAccess on secrets/public/readme.txt — parent rule STILL blocks viewer read", async () => {
    const merged = SecurityConfig.mergeSecurityConfigs([parentConfig, childConfig])
    await setupSecurityConfig(merged)

    // Even though child allows secrets/public/**, the parent rule secrets/** still denies
    const result = SecurityAccess.checkAccess("secrets/public/readme.txt", "read", "viewer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("secrets/**")
  })

  test("checkAccess on secrets/public/readme.txt — parent rule blocks developer write", async () => {
    const merged = SecurityConfig.mergeSecurityConfigs([parentConfig, childConfig])
    await setupSecurityConfig(merged)

    const result = SecurityAccess.checkAccess("secrets/public/readme.txt", "write", "developer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("secrets/**")
  })

  test("checkAccess on secrets/public/readme.txt — admin IS allowed (satisfies parent allowedRoles)", async () => {
    const merged = SecurityConfig.mergeSecurityConfigs([parentConfig, childConfig])
    await setupSecurityConfig(merged)

    const result = SecurityAccess.checkAccess("secrets/public/readme.txt", "read", "admin")
    expect(result.allowed).toBe(true)
  })

  test("child-only config (no merge) allows viewer access to secrets/public/ — but that's only if parent is absent", async () => {
    // Without parent config, child's permissive rule is the ONLY rule
    await setupSecurityConfig(childConfig)

    // Child rule has deniedOperations: [] so nothing is blocked
    const result = SecurityAccess.checkAccess("secrets/public/readme.txt", "read", "viewer")
    expect(result.allowed).toBe(true)
  })

  test("merge order does not matter — parent restriction always wins regardless of order", async () => {
    // Merge in reverse order: child first, parent second
    const mergedReverse = SecurityConfig.mergeSecurityConfigs([childConfig, parentConfig])
    await setupSecurityConfig(mergedReverse)

    const result = SecurityAccess.checkAccess("secrets/public/readme.txt", "read", "viewer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("secrets/**")
  })
})

// ---------------------------------------------------------------------------
// CASE-INH-002: Inheritance applies 7+ levels deep
// File at a/b/c/d/e/f/g/file.ts with rule on 'a/' is protected
// ---------------------------------------------------------------------------
describe("CASE-INH-002: Inheritance applies 7+ levels deep — rule on 'a/' protects a/b/c/d/e/f/g/file.ts", () => {
  test("directory rule at top level protects deeply nested file via inheritance chain", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "viewer", level: 10 },
      ],
      rules: [
        {
          pattern: "a/**",
          type: "directory",
          deniedOperations: ["read", "write"],
          allowedRoles: ["admin"],
        },
      ],
    }

    await setupSecurityConfig(config)

    // 7 levels deep: a/b/c/d/e/f/g/file.ts
    const result = SecurityAccess.checkAccess("a/b/c/d/e/f/g/file.ts", "read", "viewer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("a/**")
  })

  test("inheritance applies at 10+ levels deep", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "viewer", level: 10 },
      ],
      rules: [
        {
          pattern: "root/**",
          type: "directory",
          deniedOperations: ["read"],
          allowedRoles: ["admin"],
        },
      ],
    }

    await setupSecurityConfig(config)

    // 10 levels deep
    const deepPath = "root/1/2/3/4/5/6/7/8/9/10/file.txt"
    const result = SecurityAccess.checkAccess(deepPath, "read", "viewer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("root/**")
  })

  test("getInheritanceChain returns inherited rule for deeply nested path", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "viewer", level: 10 },
      ],
      rules: [
        {
          pattern: "a/**",
          type: "directory",
          deniedOperations: ["read"],
          allowedRoles: ["admin"],
        },
      ],
    }

    await setupSecurityConfig(config)

    const chain = SecurityAccess.getInheritanceChain("a/b/c/d/e/f/g/file.ts")
    expect(chain.length).toBeGreaterThanOrEqual(1)

    // The rule should be in the chain — either direct match (minimatch glob) or inherited
    const matchingRule = chain.find((ir) => ir.rule.pattern === "a/**")
    expect(matchingRule).toBeDefined()
  })

  test("file NOT under protected directory is allowed", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "viewer", level: 10 },
      ],
      rules: [
        {
          pattern: "a/**",
          type: "directory",
          deniedOperations: ["read"],
          allowedRoles: ["admin"],
        },
      ],
    }

    await setupSecurityConfig(config)

    // File outside the protected directory tree
    const result = SecurityAccess.checkAccess("b/c/d/e/f/g/file.ts", "read", "viewer")
    expect(result.allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CASE-INH-003: Overlapping rules — both apply and most restrictive wins
// src/** and src/auth/** — both apply to src/auth/keys.ts
// ---------------------------------------------------------------------------
describe("CASE-INH-003: Overlapping rules (src/** and src/auth/**) — both apply and most restrictive wins", () => {
  test("file matching both rules is blocked by the more restrictive one", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "developer", level: 50 },
        { name: "viewer", level: 10 },
      ],
      rules: [
        {
          // Broad rule: src/** allows developer
          pattern: "src/**",
          type: "directory",
          deniedOperations: ["write"],
          allowedRoles: ["developer"],
        },
        {
          // Narrow rule: src/auth/** only allows admin
          pattern: "src/auth/**",
          type: "directory",
          deniedOperations: ["read", "write"],
          allowedRoles: ["admin"],
        },
      ],
    }

    await setupSecurityConfig(config)

    // src/auth/keys.ts matches BOTH rules
    // Rule 1 (src/**): denies write for non-developer → developer IS allowed
    // Rule 2 (src/auth/**): denies read+write for non-admin → developer NOT allowed
    // Most restrictive wins = denied

    const resultRead = SecurityAccess.checkAccess("src/auth/keys.ts", "read", "developer")
    expect(resultRead.allowed).toBe(false)
    expect(resultRead.reason).toContain("src/auth/**")

    const resultWrite = SecurityAccess.checkAccess("src/auth/keys.ts", "write", "developer")
    expect(resultWrite.allowed).toBe(false)
    // Write is denied by BOTH rules for viewer, but for developer only src/auth/** blocks
    expect(resultWrite.reason).toContain("src/auth/**")
  })

  test("viewer is blocked by both rules on src/auth/keys.ts", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "developer", level: 50 },
        { name: "viewer", level: 10 },
      ],
      rules: [
        {
          pattern: "src/**",
          type: "directory",
          deniedOperations: ["write"],
          allowedRoles: ["developer"],
        },
        {
          pattern: "src/auth/**",
          type: "directory",
          deniedOperations: ["read", "write"],
          allowedRoles: ["admin"],
        },
      ],
    }

    await setupSecurityConfig(config)

    // Viewer is blocked by both:
    // src/** denies write (viewer level 10 < developer level 50 and not in allowedRoles)
    // src/auth/** denies read+write (viewer not admin)
    const resultRead = SecurityAccess.checkAccess("src/auth/keys.ts", "read", "viewer")
    expect(resultRead.allowed).toBe(false)

    const resultWrite = SecurityAccess.checkAccess("src/auth/keys.ts", "write", "viewer")
    expect(resultWrite.allowed).toBe(false)
  })

  test("admin passes BOTH rules and is allowed", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "developer", level: 50 },
        { name: "viewer", level: 10 },
      ],
      rules: [
        {
          pattern: "src/**",
          type: "directory",
          deniedOperations: ["write"],
          allowedRoles: ["developer"],
        },
        {
          pattern: "src/auth/**",
          type: "directory",
          deniedOperations: ["read", "write"],
          allowedRoles: ["admin"],
        },
      ],
    }

    await setupSecurityConfig(config)

    // Admin (level 100) satisfies both:
    // src/**: allowedRoles includes developer (level 50), admin level > 50 → allowed
    // src/auth/**: allowedRoles includes admin directly → allowed
    const resultRead = SecurityAccess.checkAccess("src/auth/keys.ts", "read", "admin")
    expect(resultRead.allowed).toBe(true)

    const resultWrite = SecurityAccess.checkAccess("src/auth/keys.ts", "write", "admin")
    expect(resultWrite.allowed).toBe(true)
  })

  test("file matching ONLY broad rule is allowed for developer, blocked for viewer", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "developer", level: 50 },
        { name: "viewer", level: 10 },
      ],
      rules: [
        {
          pattern: "src/**",
          type: "directory",
          deniedOperations: ["write"],
          allowedRoles: ["developer"],
        },
        {
          pattern: "src/auth/**",
          type: "directory",
          deniedOperations: ["read", "write"],
          allowedRoles: ["admin"],
        },
      ],
    }

    await setupSecurityConfig(config)

    // src/utils/helper.ts only matches src/** (not src/auth/**)
    // src/** denies write for non-developer → developer IS allowed (direct match)
    const devWrite = SecurityAccess.checkAccess("src/utils/helper.ts", "write", "developer")
    expect(devWrite.allowed).toBe(true)

    // Viewer is NOT in allowedRoles for src/** and level 10 < 50 → blocked
    const viewerWrite = SecurityAccess.checkAccess("src/utils/helper.ts", "write", "viewer")
    expect(viewerWrite.allowed).toBe(false)

    // Read is not denied by src/** rule → allowed for everyone
    const viewerRead = SecurityAccess.checkAccess("src/utils/helper.ts", "read", "viewer")
    expect(viewerRead.allowed).toBe(true)
  })

  test("getInheritanceChain returns both rules for overlapping path", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [
        { name: "admin", level: 100 },
        { name: "viewer", level: 10 },
      ],
      rules: [
        {
          pattern: "src/**",
          type: "directory",
          deniedOperations: ["write"],
          allowedRoles: ["admin"],
        },
        {
          pattern: "src/auth/**",
          type: "directory",
          deniedOperations: ["read", "write"],
          allowedRoles: ["admin"],
        },
      ],
    }

    await setupSecurityConfig(config)

    const chain = SecurityAccess.getInheritanceChain("src/auth/keys.ts")

    // Both rules should appear in the chain
    const srcRule = chain.find((ir) => ir.rule.pattern === "src/**")
    const authRule = chain.find((ir) => ir.rule.pattern === "src/auth/**")

    expect(srcRule).toBeDefined()
    expect(authRule).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// CASE-INH-004: Glob edge cases — **/test*, src/*/private/, [!.]env
// Test each against SecurityAccess.checkAccess()
// ---------------------------------------------------------------------------
describe("CASE-INH-004: Glob edge cases — **/test*, src/*/private/, [!.]env", () => {
  describe("pattern: **/test* — matches any path containing a segment starting with 'test'", () => {
    test("matches test-file.ts at root", async () => {
      const config: SecuritySchema.SecurityConfig = {
        version: "1.0",
        roles: [
          { name: "admin", level: 100 },
          { name: "viewer", level: 10 },
        ],
        rules: [
          {
            pattern: "**/test*",
            type: "file",
            deniedOperations: ["read"],
            allowedRoles: ["admin"],
          },
        ],
      }

      await setupSecurityConfig(config)

      const result = SecurityAccess.checkAccess("test-file.ts", "read", "viewer")
      expect(result.allowed).toBe(false)
    })

    test("matches deeply nested test-utils.ts", async () => {
      const config: SecuritySchema.SecurityConfig = {
        version: "1.0",
        roles: [
          { name: "admin", level: 100 },
          { name: "viewer", level: 10 },
        ],
        rules: [
          {
            pattern: "**/test*",
            type: "file",
            deniedOperations: ["read"],
            allowedRoles: ["admin"],
          },
        ],
      }

      await setupSecurityConfig(config)

      const result = SecurityAccess.checkAccess("src/utils/test-utils.ts", "read", "viewer")
      expect(result.allowed).toBe(false)
    })

    test("does NOT match 'contest.ts' (test must be at segment start for matchBase)", async () => {
      const config: SecuritySchema.SecurityConfig = {
        version: "1.0",
        roles: [
          { name: "admin", level: 100 },
          { name: "viewer", level: 10 },
        ],
        rules: [
          {
            pattern: "**/test*",
            type: "file",
            deniedOperations: ["read"],
            allowedRoles: ["admin"],
          },
        ],
      }

      await setupSecurityConfig(config)

      // minimatch with matchBase: "test*" matches the basename
      // "contest.ts" basename does not start with "test" → allowed
      const result = SecurityAccess.checkAccess("src/contest.ts", "read", "viewer")
      expect(result.allowed).toBe(true)
    })

    test("matches 'testing/' directory content when used as directory type", async () => {
      const config: SecuritySchema.SecurityConfig = {
        version: "1.0",
        roles: [
          { name: "admin", level: 100 },
          { name: "viewer", level: 10 },
        ],
        rules: [
          {
            pattern: "**/test*",
            type: "directory",
            deniedOperations: ["read"],
            allowedRoles: ["admin"],
          },
        ],
      }

      await setupSecurityConfig(config)

      // Directory rule with **/test* should protect files inside dirs starting with "test"
      const result = SecurityAccess.checkAccess("src/testing/helper.ts", "read", "viewer")
      expect(result.allowed).toBe(false)
    })
  })

  describe("pattern: src/*/private/ — single wildcard matches exactly one directory level", () => {
    test("matches src/module/private/secret.ts", async () => {
      const config: SecuritySchema.SecurityConfig = {
        version: "1.0",
        roles: [
          { name: "admin", level: 100 },
          { name: "viewer", level: 10 },
        ],
        rules: [
          {
            pattern: "src/*/private/**",
            type: "directory",
            deniedOperations: ["read"],
            allowedRoles: ["admin"],
          },
        ],
      }

      await setupSecurityConfig(config)

      const result = SecurityAccess.checkAccess("src/module/private/secret.ts", "read", "viewer")
      expect(result.allowed).toBe(false)
    })

    test("does NOT match src/a/b/private/secret.ts (single * does not match multiple levels)", async () => {
      const config: SecuritySchema.SecurityConfig = {
        version: "1.0",
        roles: [
          { name: "admin", level: 100 },
          { name: "viewer", level: 10 },
        ],
        rules: [
          {
            pattern: "src/*/private/**",
            type: "directory",
            deniedOperations: ["read"],
            allowedRoles: ["admin"],
          },
        ],
      }

      await setupSecurityConfig(config)

      // Single * matches only one directory level — src/a/b/private/ has two levels between src/ and private/
      const result = SecurityAccess.checkAccess("src/a/b/private/secret.ts", "read", "viewer")
      expect(result.allowed).toBe(true)
    })

    test("matches src/any-module/private/deep/nested/file.ts", async () => {
      const config: SecuritySchema.SecurityConfig = {
        version: "1.0",
        roles: [
          { name: "admin", level: 100 },
          { name: "viewer", level: 10 },
        ],
        rules: [
          {
            pattern: "src/*/private/**",
            type: "directory",
            deniedOperations: ["read"],
            allowedRoles: ["admin"],
          },
        ],
      }

      await setupSecurityConfig(config)

      // ** at the end matches all nested content
      const result = SecurityAccess.checkAccess("src/auth/private/deep/nested/file.ts", "read", "viewer")
      expect(result.allowed).toBe(false)
    })
  })

  describe("pattern: [!.]env — character class negation", () => {
    test("[!.]env matches files like 'aenv', '1env' but NOT '.env'", async () => {
      const config: SecuritySchema.SecurityConfig = {
        version: "1.0",
        roles: [
          { name: "admin", level: 100 },
          { name: "viewer", level: 10 },
        ],
        rules: [
          {
            pattern: "[!.]env",
            type: "file",
            deniedOperations: ["read"],
            allowedRoles: ["admin"],
          },
        ],
      }

      await setupSecurityConfig(config)

      // [!.] means any character EXCEPT '.'
      // "aenv" matches: 'a' is not '.', followed by 'env'
      const resultA = SecurityAccess.checkAccess("aenv", "read", "viewer")
      expect(resultA.allowed).toBe(false)

      // ".env" should NOT match [!.]env — the '.' IS the excluded character
      const resultDot = SecurityAccess.checkAccess(".env", "read", "viewer")
      expect(resultDot.allowed).toBe(true)
    })

    test("[!.]env does not match multi-char prefix like 'myenv'", async () => {
      const config: SecuritySchema.SecurityConfig = {
        version: "1.0",
        roles: [
          { name: "admin", level: 100 },
          { name: "viewer", level: 10 },
        ],
        rules: [
          {
            pattern: "[!.]env",
            type: "file",
            deniedOperations: ["read"],
            allowedRoles: ["admin"],
          },
        ],
      }

      await setupSecurityConfig(config)

      // [!.] matches exactly ONE character, so "myenv" (5 chars) does not match "[!.]env" (4 chars)
      const result = SecurityAccess.checkAccess("myenv", "read", "viewer")
      expect(result.allowed).toBe(true)
    })
  })

  describe("pattern: **/*.secret — double-star + extension matching", () => {
    test("matches files with .secret extension at any depth", async () => {
      const config: SecuritySchema.SecurityConfig = {
        version: "1.0",
        roles: [
          { name: "admin", level: 100 },
          { name: "viewer", level: 10 },
        ],
        rules: [
          {
            pattern: "**/*.secret",
            type: "file",
            deniedOperations: ["read"],
            allowedRoles: ["admin"],
          },
        ],
      }

      await setupSecurityConfig(config)

      const resultRoot = SecurityAccess.checkAccess("data.secret", "read", "viewer")
      expect(resultRoot.allowed).toBe(false)

      const resultNested = SecurityAccess.checkAccess("config/prod/api.secret", "read", "viewer")
      expect(resultNested.allowed).toBe(false)
    })

    test("does NOT match file without .secret extension", async () => {
      const config: SecuritySchema.SecurityConfig = {
        version: "1.0",
        roles: [
          { name: "admin", level: 100 },
          { name: "viewer", level: 10 },
        ],
        rules: [
          {
            pattern: "**/*.secret",
            type: "file",
            deniedOperations: ["read"],
            allowedRoles: ["admin"],
          },
        ],
      }

      await setupSecurityConfig(config)

      const result = SecurityAccess.checkAccess("config/prod/api.json", "read", "viewer")
      expect(result.allowed).toBe(true)
    })
  })

  describe("combination: merged configs with overlapping glob patterns", () => {
    test("merging configs with complementary glob patterns creates additive protection", async () => {
      const configA: SecuritySchema.SecurityConfig = {
        version: "1.0",
        roles: [
          { name: "admin", level: 100 },
          { name: "viewer", level: 10 },
        ],
        rules: [
          {
            pattern: "**/*.pem",
            type: "file",
            deniedOperations: ["read"],
            allowedRoles: ["admin"],
          },
        ],
      }

      const configB: SecuritySchema.SecurityConfig = {
        version: "1.0",
        roles: [
          { name: "admin", level: 100 },
          { name: "viewer", level: 10 },
        ],
        rules: [
          {
            pattern: "**/*.key",
            type: "file",
            deniedOperations: ["read"],
            allowedRoles: ["admin"],
          },
        ],
      }

      const merged = SecurityConfig.mergeSecurityConfigs([configA, configB])
      await setupSecurityConfig(merged)

      // Both patterns should be active
      const resultPem = SecurityAccess.checkAccess("certs/server.pem", "read", "viewer")
      expect(resultPem.allowed).toBe(false)

      const resultKey = SecurityAccess.checkAccess("certs/server.key", "read", "viewer")
      expect(resultKey.allowed).toBe(false)

      // Unrelated file should be allowed
      const resultJson = SecurityAccess.checkAccess("certs/config.json", "read", "viewer")
      expect(resultJson.allowed).toBe(true)
    })
  })
})
