import { describe, test, expect, afterEach } from "bun:test"
import { SecurityConfig } from "@/security/config"
import { SecurityAccess } from "@/security/access"
import { BashScanner } from "@/security/bash-scanner"
import { PermissionNext } from "@/permission/next"
import { loadBaseConfig, setupSecurityConfig, teardownSecurityConfig } from "../helpers"

afterEach(() => {
  teardownSecurityConfig()
})

describe("CASE-AGENT-001: Permission layering — plan agent removes edit tools at LLM level, security checks run inside tool", () => {
  // [INFO] The plan agent uses PermissionNext to disable edit tools (edit: { "*": "deny" }).
  // PermissionNext.disabled() removes edit tools from the tool list BEFORE the LLM sees them.
  // Security checks (SecurityAccess.checkAccess) run INSIDE tool implementations.
  // Plan agent denial wins because the tool is never called — the LLM never sees it.

  test("documents permission layering: plan agent restricts edits via evaluate, not disabled()", () => {
    // Plan agent permission config uses pattern-based edit control
    const planPermission = PermissionNext.fromConfig({
      "*": "allow",
      edit: {
        "*": "deny",
        ".opencode/plans/*.md": "allow",
      },
    })

    // PermissionNext.disabled() checks if the LAST matching rule for a permission
    // has pattern: "*" and action: "deny". Since the plan agent's last edit rule
    // is `.opencode/plans/*.md: allow`, edit tools are NOT fully disabled.
    // Instead, they remain visible to the LLM but are restricted by evaluate().
    const allTools = ["read", "edit", "write", "patch", "multiedit", "grep", "glob", "bash"]
    const disabledSet = PermissionNext.disabled(allTools, planPermission)

    // Edit tools are NOT disabled by disabled() — they're still visible to the LLM
    // because the last matching rule has a specific pattern, not "*"
    expect(disabledSet.has("edit")).toBe(false)

    // Read tools are also not disabled
    expect(disabledSet.has("read")).toBe(false)
    expect(disabledSet.has("bash")).toBe(false)

    // However, evaluate() blocks edits on non-plan files at RUNTIME
    const editRegular = PermissionNext.evaluate("edit", "src/main.ts", planPermission)
    expect(editRegular.action).toBe("deny")

    // And allows edits on plan files
    const editPlan = PermissionNext.evaluate("edit", ".opencode/plans/my-plan.md", planPermission)
    expect(editPlan.action).toBe("allow")

    // A fully deny config (no specific allow patterns) WOULD use disabled()
    const fullDenyPermission = PermissionNext.fromConfig({
      "*": "allow",
      edit: "deny", // Simple deny = pattern "*"
    })
    const fullDisabledSet = PermissionNext.disabled(allTools, fullDenyPermission)
    const editTools = ["edit", "write", "patch", "multiedit"]
    for (const tool of editTools) {
      expect(fullDisabledSet.has(tool)).toBe(true)
    }
  })

  test("PermissionNext.evaluate denies edit on wildcard pattern for plan agent", () => {
    const planPermission = PermissionNext.fromConfig({
      "*": "allow",
      edit: {
        "*": "deny",
        ".opencode/plans/*.md": "allow",
      },
    })

    // Editing a regular file: denied by plan agent rules
    const regularEdit = PermissionNext.evaluate("edit", "src/main.ts", planPermission)
    expect(regularEdit.action).toBe("deny")

    // Editing a plan file: allowed by specific override
    const planEdit = PermissionNext.evaluate("edit", ".opencode/plans/my-plan.md", planPermission)
    expect(planEdit.action).toBe("allow")
  })

  test("PermissionNext denial is independent layer from SecurityAccess denial", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // SecurityAccess blocks secrets/key.pem for read by viewer
    const securityResult = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(securityResult.allowed).toBe(false)

    // PermissionNext blocks edit tools independently
    const planPermission = PermissionNext.fromConfig({ edit: { "*": "deny" } })
    const permResult = PermissionNext.evaluate("edit", "secrets/key.pem", planPermission)
    expect(permResult.action).toBe("deny")

    // Both layers deny independently — they are not coupled
    // If PermissionNext allows and SecurityAccess denies → still blocked
    // If PermissionNext denies → tool never called, SecurityAccess never reached
  })
})

describe("CASE-AGENT-002: Security protects plan file paths even if plan agent allows editing them", () => {
  test("SecurityAccess.checkAccess blocks read on plan paths when explicitly protected", async () => {
    // Create config that protects .opencode/plans/ directory
    const config = loadBaseConfig()
    const protectedConfig = {
      ...config,
      rules: [
        ...(config.rules ?? []),
        {
          pattern: ".opencode/plans/**",
          type: "directory" as const,
          deniedOperations: ["read" as const, "write" as const],
          allowedRoles: ["admin"],
        },
      ],
    }
    await setupSecurityConfig(protectedConfig)

    // Plan agent PermissionNext allows edit on plan files
    const planPermission = PermissionNext.fromConfig({
      edit: {
        "*": "deny",
        ".opencode/plans/*.md": "allow",
      },
    })
    const permResult = PermissionNext.evaluate("edit", ".opencode/plans/my-plan.md", planPermission)
    expect(permResult.action).toBe("allow")

    // But SecurityAccess.checkAccess would STILL block the operation
    const secResult = SecurityAccess.checkAccess(".opencode/plans/my-plan.md", "write", "viewer")
    expect(secResult.allowed).toBe(false)

    // Security layer inside the tool would deny even though PermissionNext allows
  })

  test("SecurityAccess.checkAccess blocks write on plan paths when protected", async () => {
    const config = loadBaseConfig()
    const protectedConfig = {
      ...config,
      rules: [
        ...(config.rules ?? []),
        {
          pattern: ".opencode/plans/**",
          type: "directory" as const,
          deniedOperations: ["write" as const],
          allowedRoles: ["admin"],
        },
      ],
    }
    await setupSecurityConfig(protectedConfig)

    // Write operation blocked by security even for plan paths
    const result = SecurityAccess.checkAccess(".opencode/plans/my-plan.md", "write", "viewer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain(".opencode/plans/**")
  })
})

describe("CASE-AGENT-003: SecurityAccess.checkAccess blocks reads on protected files for lowest role", () => {
  test("checkAccess('secrets/key.pem', 'read', 'viewer') blocks read — this is what plan agent's read tools hit", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // The plan agent's read tool would call checkAccess with the lowest role (viewer)
    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("secrets/**")
    expect(result.reason).toContain("read")
  })

  test("checkAccess blocks .env files for lowest role", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const envResult = SecurityAccess.checkAccess(".env", "read", "viewer")
    expect(envResult.allowed).toBe(false)

    const envProdResult = SecurityAccess.checkAccess(".env.production", "read", "viewer")
    expect(envProdResult.allowed).toBe(false)
  })

  test("checkAccess blocks src/auth/keys.ts for lowest role", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("src/auth/keys.ts", "read", "viewer")
    expect(result.allowed).toBe(false)
  })

  test("checkAccess allows non-protected files for lowest role", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("src/main.ts", "read", "viewer")
    expect(result.allowed).toBe(true)
  })
})

describe("CASE-AGENT-004: BashScanner.scanBashCommand detects cat on protected paths", () => {
  test("scanBashCommand('cat secrets/key.pem') returns the protected path", () => {
    const cwd = "/project"
    const paths = BashScanner.scanBashCommand("cat secrets/key.pem", cwd)
    expect(paths).toContain("/project/secrets/key.pem")
  })

  test("scanBashCommand detects head/tail/less on protected paths", () => {
    const cwd = "/project"

    const headPaths = BashScanner.scanBashCommand("head secrets/key.pem", cwd)
    expect(headPaths).toContain("/project/secrets/key.pem")

    const tailPaths = BashScanner.scanBashCommand("tail .env", cwd)
    expect(tailPaths).toContain("/project/.env")

    const lessPaths = BashScanner.scanBashCommand("less src/auth/keys.ts", cwd)
    expect(lessPaths).toContain("/project/src/auth/keys.ts")
  })

  test("scanBashCommand detects grep on protected paths", () => {
    const cwd = "/project"
    // grep -r extracts the directory path (trailing slash resolved away by path.resolve)
    const paths = BashScanner.scanBashCommand("grep -r 'password' secrets/", cwd)
    expect(paths).toContain("/project/secrets")
  })

  test("in plan mode context, scanned paths + checkAccess = bash command blocked", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Step 1: Scanner extracts paths from command
    const cwd = "/project"
    const scannedPaths = BashScanner.scanBashCommand("cat secrets/key.pem", cwd)
    expect(scannedPaths.length).toBeGreaterThan(0)

    // Step 2: checkAccess blocks the path (this is what bash.ts does internally)
    // Note: the actual bash tool would use the resolved absolute path
    const readResult = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(readResult.allowed).toBe(false)

    // Combined: scanner finds path → checkAccess blocks → command denied
  })
})

describe("CASE-AGENT-005: SecurityAccess.checkAccess for grep/glob protected paths is independent of agent permission system", () => {
  test("checkAccess blocks grep on protected file regardless of agent type", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // SecurityAccess does not know about agents — it only sees (path, operation, role)
    // Both build agent and plan agent hit the same checkAccess
    const readSecrets = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(readSecrets.allowed).toBe(false)

    const readEnv = SecurityAccess.checkAccess(".env", "read", "viewer")
    expect(readEnv.allowed).toBe(false)
  })

  test("checkAccess uses role, not agent identity — agent is not a parameter", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // checkAccess signature: checkAccess(filePath, operation, role)
    // There is no agent parameter — the function is agent-agnostic
    // Both plan and build agents call getDefaultRole(config) which returns the lowest role
    const viewerResult = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(viewerResult.allowed).toBe(false)

    // Higher role gets access (developer is level 50, viewer is level 10)
    const devResult = SecurityAccess.checkAccess("secrets/key.pem", "read", "developer")
    expect(devResult.allowed).toBe(false) // Still blocked — allowedRoles is ["admin"]

    // Admin role (level 100) gets access
    const adminResult = SecurityAccess.checkAccess("secrets/key.pem", "read", "admin")
    expect(adminResult.allowed).toBe(true)
  })

  test("glob-style protected paths are checked identically for any agent context", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // .env* pattern matches .env and .env.production
    const env = SecurityAccess.checkAccess(".env", "read", "viewer")
    expect(env.allowed).toBe(false)

    const envProd = SecurityAccess.checkAccess(".env.production", "read", "viewer")
    expect(envProd.allowed).toBe(false)

    // Non-protected file is allowed
    const readme = SecurityAccess.checkAccess("README.md", "read", "viewer")
    expect(readme.allowed).toBe(true)
  })
})

describe("CASE-AGENT-006: Session permission overrides (PermissionNext) are independent from SecurityAccess", () => {
  // [INFO] PermissionNext controls which tools the agent can USE.
  // SecurityAccess controls which files the tool can ACCESS.
  // A PermissionNext "allow" on edit does NOT bypass SecurityAccess.checkAccess inside the tool.

  test("documents that PermissionNext allow does NOT bypass SecurityAccess deny", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Session override: allow all edits (overrides plan agent's deny)
    const sessionOverride = PermissionNext.fromConfig({
      edit: { "*": "allow" },
    })
    const editResult = PermissionNext.evaluate("edit", "secrets/key.pem", sessionOverride)
    expect(editResult.action).toBe("allow") // PermissionNext says "allow"

    // But SecurityAccess still blocks
    const securityResult = SecurityAccess.checkAccess("secrets/key.pem", "write", "viewer")
    expect(securityResult.allowed).toBe(false) // SecurityAccess says "denied"

    // The tool would hit SecurityAccess.checkAccess AFTER PermissionNext allows
    // PermissionNext allow + SecurityAccess deny = BLOCKED
  })

  test("PermissionNext deny + SecurityAccess allow = tool never called", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Plan agent denies edit tools
    const planPermission = PermissionNext.fromConfig({
      edit: { "*": "deny" },
    })
    const permResult = PermissionNext.evaluate("edit", "src/main.ts", planPermission)
    expect(permResult.action).toBe("deny") // PermissionNext blocks

    // SecurityAccess would allow (non-protected file)
    const secResult = SecurityAccess.checkAccess("src/main.ts", "write", "viewer")
    expect(secResult.allowed).toBe(true) // SecurityAccess allows

    // Result: tool never called because PermissionNext denied first
    // PermissionNext deny + SecurityAccess allow = BLOCKED (PermissionNext wins by preventing invocation)
  })

  test("PermissionNext allow + SecurityAccess allow = tool succeeds", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Build agent allows edit
    const buildPermission = PermissionNext.fromConfig({
      "*": "allow",
    })
    const permResult = PermissionNext.evaluate("edit", "src/main.ts", buildPermission)
    expect(permResult.action).toBe("allow")

    // SecurityAccess allows (non-protected file)
    const secResult = SecurityAccess.checkAccess("src/main.ts", "write", "viewer")
    expect(secResult.allowed).toBe(true)

    // Both layers allow = operation succeeds
  })

  test("documents layering: PermissionNext is gate 1, SecurityAccess is gate 2", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Gate 1: PermissionNext (agent-level tool access)
    // Gate 2: SecurityAccess (file-level security)
    // Both must allow for the operation to succeed
    // If Gate 1 denies, Gate 2 is never reached (tool not called)
    // If Gate 1 allows but Gate 2 denies, the tool throws an error

    // Example: plan agent trying to read secrets
    const planReadPermission = PermissionNext.fromConfig({ "*": "allow" }) // plan allows reads
    const gate1 = PermissionNext.evaluate("read", "secrets/key.pem", planReadPermission)
    expect(gate1.action).toBe("allow") // Gate 1 passes

    const gate2 = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(gate2.allowed).toBe(false) // Gate 2 blocks

    // Net result: operation blocked by SecurityAccess (inside the tool)
  })
})

describe("CASE-AGENT-007: SecurityAccess.checkAccess blocks writes regardless of which agent is active", () => {
  test("checkAccess('secrets/key.pem', 'write', 'viewer') blocks writes", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("secrets/key.pem", "write", "viewer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("secrets/**")
  })

  test("checkAccess blocks writes to .env files for lowest role", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const envResult = SecurityAccess.checkAccess(".env", "write", "viewer")
    expect(envResult.allowed).toBe(false)

    const envProdResult = SecurityAccess.checkAccess(".env.production", "write", "viewer")
    expect(envProdResult.allowed).toBe(false)
  })

  test("write denial is agent-agnostic — same result for any agent using viewer role", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // The role "viewer" is what all tools use via getDefaultRole()
    // getDefaultRole returns the role with the lowest level
    // Both build and plan agents use this same function

    // Verify writes are blocked for all protected paths
    const secretsWrite = SecurityAccess.checkAccess("secrets/key.pem", "write", "viewer")
    expect(secretsWrite.allowed).toBe(false)

    const envWrite = SecurityAccess.checkAccess(".env", "write", "viewer")
    expect(envWrite.allowed).toBe(false)

    const keysWrite = SecurityAccess.checkAccess("src/auth/keys.ts", "write", "viewer")
    expect(keysWrite.allowed).toBe(false)
  })

  test("admin role can write to protected files — role hierarchy applies to writes too", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const adminWrite = SecurityAccess.checkAccess("secrets/key.pem", "write", "admin")
    expect(adminWrite.allowed).toBe(true)
  })

  test("non-protected files allow writes regardless of role", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("src/main.ts", "write", "viewer")
    expect(result.allowed).toBe(true)
  })
})
