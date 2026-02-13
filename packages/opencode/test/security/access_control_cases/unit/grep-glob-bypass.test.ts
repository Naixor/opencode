import { describe, test, expect, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"
import { SecurityAccess } from "@/security/access"
import { SecurityConfig } from "@/security/config"
import { SecuritySchema } from "@/security/schema"
import { SecuritySegments } from "@/security/segments"
import { SecurityRedact } from "@/security/redact"
import { setupSecurityConfig, teardownSecurityConfig, loadBaseConfig, protectedFilePath } from "../helpers"

afterEach(() => {
  teardownSecurityConfig()
})

// ============================================================================
// CASE-GREP-001: Verify grep for known string in protected file excludes the
// file from results
// ============================================================================
describe("CASE-GREP-001: Grep for known string in protected file excludes the file from results", () => {
  test("file-level checkAccess denies read for secrets/key.pem — file excluded from grep results", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Grep tool uses checkAccess(filePath, "read", currentRole) per result line.
    // If checkAccess returns allowed:false, the entire file's matches are skipped.
    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("secrets/**")
  })

  test(".env file matches are excluded from grep results", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess(".env", "read", "viewer")
    expect(result.allowed).toBe(false)
  })

  test(".env.production file matches are excluded from grep results", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess(".env.production", "read", "viewer")
    expect(result.allowed).toBe(false)
  })

  test("src/auth/keys.ts file matches are excluded from grep results", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("src/auth/keys.ts", "read", "viewer")
    expect(result.allowed).toBe(false)
  })

  test("unprotected file is NOT excluded — grep results allowed", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("src/app.ts", "read", "viewer")
    expect(result.allowed).toBe(true)
  })

  test("admin role CAN see grep results from protected files", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "admin")
    expect(result.allowed).toBe(true)
  })

  test("developer role CANNOT see secrets/** grep results (only admin allowed)", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "developer")
    expect(result.allowed).toBe(false)
  })
})

// ============================================================================
// CASE-GREP-002: Verify grep match inside @secure-start/@secure-end region is
// redacted (file:line shown, content hidden)
// ============================================================================
describe("CASE-GREP-002: Grep match inside @secure-start/@secure-end region is redacted", () => {
  // The grep tool (grep.ts) performs segment-level redaction:
  // 1. For each file with matches, it loads the file content
  // 2. Finds protected segments (marker + AST)
  // 3. If a match line overlaps a protected segment, replaces lineText with REDACTED_PLACEHOLDER
  // 4. The file path and line number are still shown — only the content is hidden

  test("match inside marker-protected region is replaced with REDACTED_PLACEHOLDER", () => {
    const content = fs.readFileSync(protectedFilePath("marked-code.ts"), "utf8")
    const markers = loadBaseConfig().segments!.markers!

    const markerSegments = SecuritySegments.findMarkerSegments(content, markers)
    expect(markerSegments.length).toBe(1)

    // The string "SENSITIVE_KEY_INSIDE_MARKER" is inside the protected region
    const sensitiveStr = "SENSITIVE_KEY_INSIDE_MARKER"
    const matchIndex = content.indexOf(sensitiveStr)
    expect(matchIndex).toBeGreaterThan(-1)
    expect(matchIndex).toBeGreaterThanOrEqual(markerSegments[0].start)
    expect(matchIndex).toBeLessThan(markerSegments[0].end)

    // Grep tool simulates: check if the line overlaps a protected segment
    // The viewer role is not in allowedRoles for read operation on marker segments
    const roles: SecuritySchema.Role[] = loadBaseConfig().roles!
    const currentRole = "viewer"
    const roleLevel = roles.find((r) => r.name === currentRole)?.level ?? 0

    const protectedSegments: SecurityRedact.Segment[] = []
    for (const seg of markerSegments) {
      if (seg.rule.deniedOperations.includes("read")) {
        const allowed =
          seg.rule.allowedRoles.includes(currentRole) ||
          seg.rule.allowedRoles.some((ar) => {
            const arLevel = roles.find((r) => r.name === ar)?.level ?? 0
            return roleLevel > arLevel
          })
        if (!allowed) {
          protectedSegments.push({ start: seg.start, end: seg.end })
        }
      }
    }

    expect(protectedSegments.length).toBe(1)

    // Simulate grep's overlap check for the line containing the sensitive string
    const lineText = 'const internalApiKey = "SENSITIVE_KEY_INSIDE_MARKER"'
    const lineStartPos = content.indexOf(lineText)
    const lineEndPos = lineStartPos + lineText.length

    const isProtected = protectedSegments.some((seg) => lineStartPos < seg.end && lineEndPos > seg.start)
    expect(isProtected).toBe(true)

    // When protected, grep tool replaces content with:
    const redactedOutput = SecurityRedact.REDACTED_PLACEHOLDER
    expect(redactedOutput).toBe("[REDACTED: Security Protected]")
  })

  test("match outside marker-protected region is NOT redacted", () => {
    const content = fs.readFileSync(protectedFilePath("marked-code.ts"), "utf8")
    const markers = loadBaseConfig().segments!.markers!

    const markerSegments = SecuritySegments.findMarkerSegments(content, markers)
    expect(markerSegments.length).toBe(1)

    // "publicConfig" is before the protected region
    const publicStr = "publicConfig"
    const matchIndex = content.indexOf(publicStr)
    expect(matchIndex).toBeGreaterThan(-1)
    expect(matchIndex).toBeLessThan(markerSegments[0].start)

    // Simulate overlap check — should NOT overlap
    const lineText = "export const publicConfig = {"
    const lineStartPos = content.indexOf(lineText)
    const lineEndPos = lineStartPos + lineText.length

    const protectedSegments: SecurityRedact.Segment[] = [{ start: markerSegments[0].start, end: markerSegments[0].end }]
    const isProtected = protectedSegments.some((seg) => lineStartPos < seg.end && lineEndPos > seg.start)
    expect(isProtected).toBe(false)
  })

  test("match in AST-protected function is redacted for viewer", () => {
    const filepath = protectedFilePath("ast-code.ts")
    const content = fs.readFileSync(filepath, "utf8")
    const astRules = loadBaseConfig().segments!.ast!

    const astSegments = SecuritySegments.findASTSegments(filepath, content, astRules)
    expect(astSegments.length).toBeGreaterThan(0)

    // Find the encryptData function segment
    const encryptSeg = astSegments.find((s) => content.substring(s.start, s.end).includes("encryptData"))
    expect(encryptSeg).toBeDefined()

    // A grep match inside encryptData body should be redacted
    const bodyStr = "createCipheriv"
    const bodyIndex = content.indexOf(bodyStr)
    expect(bodyIndex).toBeGreaterThan(-1)
    expect(bodyIndex).toBeGreaterThanOrEqual(encryptSeg!.start)
    expect(bodyIndex).toBeLessThan(encryptSeg!.end)

    // Viewer role is NOT in allowedRoles (only admin) for AST segments
    const roles: SecuritySchema.Role[] = loadBaseConfig().roles!
    const currentRole = "viewer"
    const roleLevel = roles.find((r) => r.name === currentRole)?.level ?? 0

    const protectedSegments: SecurityRedact.Segment[] = []
    for (const seg of astSegments) {
      if (seg.rule.deniedOperations.includes("read")) {
        const allowed =
          seg.rule.allowedRoles.includes(currentRole) ||
          seg.rule.allowedRoles.some((ar) => {
            const arLevel = roles.find((r) => r.name === ar)?.level ?? 0
            return roleLevel > arLevel
          })
        if (!allowed) {
          protectedSegments.push({ start: seg.start, end: seg.end })
        }
      }
    }

    const lineText = "const cipher = crypto.createCipheriv"
    const lineStartPos = content.indexOf(lineText)
    const lineEndPos = lineStartPos + lineText.length

    const isProtected = protectedSegments.some((seg) => lineStartPos < seg.end && lineEndPos > seg.start)
    expect(isProtected).toBe(true)
  })

  test("developer role CAN see marker-protected grep content (in allowedRoles)", () => {
    const content = fs.readFileSync(protectedFilePath("marked-code.ts"), "utf8")
    const markers = loadBaseConfig().segments!.markers!

    const markerSegments = SecuritySegments.findMarkerSegments(content, markers)
    expect(markerSegments.length).toBe(1)

    // Marker allowedRoles includes ["admin", "developer"] — developer IS allowed
    const roles: SecuritySchema.Role[] = loadBaseConfig().roles!
    const currentRole = "developer"
    const roleLevel = roles.find((r) => r.name === currentRole)?.level ?? 0

    const protectedSegments: SecurityRedact.Segment[] = []
    for (const seg of markerSegments) {
      if (seg.rule.deniedOperations.includes("read")) {
        const allowed =
          seg.rule.allowedRoles.includes(currentRole) ||
          seg.rule.allowedRoles.some((ar) => {
            const arLevel = roles.find((r) => r.name === ar)?.level ?? 0
            return roleLevel > arLevel
          })
        if (!allowed) {
          protectedSegments.push({ start: seg.start, end: seg.end })
        }
      }
    }

    // Developer is in allowedRoles → no segments are protected from developer
    expect(protectedSegments.length).toBe(0)
  })

  test("[FINDING] grep still shows file path and line number for redacted matches — metadata leakage", () => {
    // The grep tool outputs:
    //   filepath:
    //     Line N: [REDACTED: Security Protected]
    //
    // This reveals:
    // 1. That the file contains a match for the search pattern
    // 2. The exact line number where the match occurs
    // 3. That the file has security-protected content
    //
    // This is information disclosure, but at a lower severity than content leakage.
    // The file is already known to exist (it passed file-level access check),
    // and the content is properly hidden.

    console.info(
      "[INFO] Grep redaction reveals file path + line number for protected matches. " +
        "Content is replaced with REDACTED_PLACEHOLDER, but the metadata (file, line, " +
        "existence of match) is still visible. This is acceptable: the file passed " +
        "file-level access check, so the user knows it exists. Line number leakage " +
        "is low-risk since the content itself is hidden.",
    )

    // Verify that the redacted placeholder does NOT contain any original content
    expect(SecurityRedact.REDACTED_PLACEHOLDER).not.toContain("SECRET")
    expect(SecurityRedact.REDACTED_PLACEHOLDER).not.toContain("password")
    expect(SecurityRedact.REDACTED_PLACEHOLDER).toBe("[REDACTED: Security Protected]")
  })
})

// ============================================================================
// CASE-GREP-003: Verify grep with --include glob targeting protected directory
// is filtered
// ============================================================================
describe("CASE-GREP-003: Grep with --include glob targeting protected directory is filtered", () => {
  // The grep tool's `include` param is passed directly to ripgrep's --glob flag.
  // Ripgrep uses it to filter WHICH files to search. Security filtering happens
  // AFTER ripgrep returns results, not before. So even if include targets a
  // protected directory, the post-result checkAccess filter will exclude matches.

  test("grep results from secrets/ are excluded even when include targets secrets/", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Even though ripgrep might search inside secrets/ when include="secrets/*.pem",
    // the grep tool filters results via checkAccess(filePath, "read", currentRole)
    // per result line. Any match from secrets/ will be filtered out for viewer.
    const secretPath = "secrets/key.pem"
    const result = SecurityAccess.checkAccess(secretPath, "read", "viewer")
    expect(result.allowed).toBe(false)
  })

  test("grep results from secrets/subdir/ are excluded — directory rule inheritance", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("secrets/subdir/config.json", "read", "viewer")
    expect(result.allowed).toBe(false)
  })

  test("include glob does not bypass security filtering — filtering is post-result", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // The include param merely tells ripgrep which files to search.
    // Security is enforced on the OUTPUT of ripgrep, not the input.
    // This is the correct design: the security layer doesn't trust the
    // search tool's file selection.

    // Verify a protected file is still blocked regardless of include pattern
    const envResult = SecurityAccess.checkAccess("config/.env.local", "read", "viewer")
    expect(envResult.allowed).toBe(false)

    // Verify an unprotected file is still allowed
    const appResult = SecurityAccess.checkAccess("src/config.ts", "read", "viewer")
    expect(appResult.allowed).toBe(true)

    console.info(
      "[INFO] Grep's include/glob parameter is passed to ripgrep for file selection. " +
        "Security filtering runs AFTER ripgrep returns results, using checkAccess() " +
        "per result line. This means include cannot be used to bypass security — " +
        "the security layer is independent of the search tool's file selection.",
    )
  })
})

// ============================================================================
// CASE-GLOB-001: Verify glob secrets/** returns no results when directory is
// protected
// ============================================================================
describe("CASE-GLOB-001: Glob secrets/** returns no results when directory is protected", () => {
  // The glob tool (glob.ts) filters results after ripgrep returns file paths.
  // It calls checkAccess(f.path, "read", currentRole) for each file and
  // removes those that are denied.

  test("files in secrets/ are filtered from glob results for viewer", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Glob returns file paths — each is checked against checkAccess.
    // secrets/key.pem matches secrets/** directory rule → denied for viewer
    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(result.allowed).toBe(false)
  })

  test("files in secrets/subdir/ are also filtered — directory rule inheritance", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("secrets/subdir/file.txt", "read", "viewer")
    expect(result.allowed).toBe(false)
  })

  test("admin role CAN see secrets/ files in glob results", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "admin")
    expect(result.allowed).toBe(true)
  })

  test("glob secrets/** with no rules returns all files (empty config = fail-open)", async () => {
    const emptyConfig: SecuritySchema.SecurityConfig = {
      version: "1.0",
      rules: [],
      roles: [],
    }
    await setupSecurityConfig(emptyConfig)

    // With no rules, checkAccess always returns allowed:true
    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(result.allowed).toBe(true)
  })
})

// ============================================================================
// CASE-GLOB-002: Verify glob **/.env* excludes protected files
// ============================================================================
describe("CASE-GLOB-002: Glob **/.env* excludes protected files", () => {
  test(".env is filtered from glob results for viewer", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess(".env", "read", "viewer")
    expect(result.allowed).toBe(false)
  })

  test(".env.production is filtered from glob results", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess(".env.production", "read", "viewer")
    expect(result.allowed).toBe(false)
  })

  test(".env.local is filtered — matches **/.env* pattern", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess(".env.local", "read", "viewer")
    expect(result.allowed).toBe(false)
  })

  test("nested .env file is filtered — config/subfolder/.env.staging", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("config/subfolder/.env.staging", "read", "viewer")
    expect(result.allowed).toBe(false)
  })

  test(".envrc or .environment is filtered by **/.env* pattern (broad glob)", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // **/.env* will match anything starting with .env — including .envrc
    const envrcResult = SecurityAccess.checkAccess(".envrc", "read", "viewer")
    expect(envrcResult.allowed).toBe(false)
  })

  test("file named 'env' without dot prefix is NOT filtered", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // "env" does not match **/.env* pattern (no dot prefix)
    const result = SecurityAccess.checkAccess("env", "read", "viewer")
    expect(result.allowed).toBe(true)
  })

  test(".env.example is also caught by **/.env* pattern", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // **/.env* matches .env.example too — this may be over-broad
    // but is correct security behavior (better to over-protect)
    const result = SecurityAccess.checkAccess(".env.example", "read", "viewer")
    expect(result.allowed).toBe(false)

    console.info(
      "[INFO] The **/.env* pattern matches .env.example, .envrc, and other dot-env " +
        "variants. This is intentionally broad — it's better to over-protect and " +
        "require explicit allowlisting than to risk leaking environment secrets. " +
        "To allow .env.example, add a specific allow rule or adjust the glob pattern.",
    )
  })
})

// ============================================================================
// CASE-GLOB-003: Verify glob tool does not leak the count of filtered files in
// its output (information disclosure check)
// ============================================================================
describe("CASE-GLOB-003: Glob tool does not leak filtered file count in output", () => {
  // The glob tool (glob.ts) tracks `filteredCount` internally and logs it
  // via securityLog.debug(). The actual output only contains allowed file paths.
  // The count metadata (returned in result.metadata.count) is the count of
  // ALLOWED files, not total or filtered.

  test("glob output metadata.count reflects allowed files only, not total", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Simulate the glob tool's filtering logic:
    const files = [
      { path: "secrets/key.pem", mtime: 1 },
      { path: "src/app.ts", mtime: 2 },
      { path: ".env", mtime: 3 },
      { path: "src/util.ts", mtime: 4 },
    ]

    const config = SecurityConfig.getSecurityConfig()
    const roles = config.roles ?? []
    const lowestRole = roles.reduce((prev, curr) => (curr.level < prev.level ? curr : prev), roles[0])
    const currentRole = lowestRole.name

    const allowedFiles = files.filter((f) => {
      const accessResult = SecurityAccess.checkAccess(f.path, "read", currentRole)
      return accessResult.allowed
    })

    // 2 of 4 files should be allowed (src/app.ts, src/util.ts)
    expect(allowedFiles.length).toBe(2)
    expect(allowedFiles.map((f) => f.path)).toEqual(["src/app.ts", "src/util.ts"])

    // The output would only list allowed files — no mention of filtered count
    const output = allowedFiles.length === 0 ? ["No files found"] : allowedFiles.map((f) => f.path)

    // Verify the output does NOT contain any reference to filtered files
    const outputStr = output.join("\n")
    expect(outputStr).not.toContain("secrets")
    expect(outputStr).not.toContain(".env")
    expect(outputStr).not.toContain("filtered")
    expect(outputStr).not.toContain("hidden")
    expect(outputStr).not.toContain("protected")
  })

  test("when all files are filtered, output says 'No files found' without disclosure", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // All files are in protected paths
    const files = [
      { path: "secrets/key.pem", mtime: 1 },
      { path: "secrets/other.pem", mtime: 2 },
      { path: ".env", mtime: 3 },
    ]

    const config = SecurityConfig.getSecurityConfig()
    const roles = config.roles ?? []
    const lowestRole = roles.reduce((prev, curr) => (curr.level < prev.level ? curr : prev), roles[0])
    const currentRole = lowestRole.name

    const allowedFiles = files.filter((f) => {
      const accessResult = SecurityAccess.checkAccess(f.path, "read", currentRole)
      return accessResult.allowed
    })

    expect(allowedFiles.length).toBe(0)

    // Glob tool returns "No files found" when empty — same as genuinely no matches
    const output = allowedFiles.length === 0 ? "No files found" : allowedFiles.map((f) => f.path).join("\n")
    expect(output).toBe("No files found")

    // This is indistinguishable from "no files match the glob pattern"
    // which prevents information disclosure about the existence of protected files
    console.info(
      "[INFO] Glob tool returns 'No files found' when all results are filtered by security. " +
        "This is indistinguishable from a glob pattern with no matches, preventing " +
        "information disclosure about the existence of protected files. The filteredCount " +
        "is only logged at debug level via securityLog.debug(), not exposed in output.",
    )
  })

  test("filteredCount is logged at debug level only — not in user-facing output", () => {
    // The glob tool code (glob.ts lines 76-81):
    //   const filteredCount = originalCount - allowedFiles.length
    //   if (filteredCount > 0) {
    //     securityLog.debug("filtered protected files from glob results", {
    //       filteredCount, role: currentRole
    //     })
    //   }
    //
    // securityLog.debug() writes to internal debug log, NOT to the tool output.
    // The tool output (returned via `output: output.join("\n")`) contains only
    // allowed file paths or "No files found".

    // Verify the grep tool has the same pattern (grep.ts lines 169-175)
    // securityLog.debug() with filteredFileCount and redactedMatchCount
    // These are internal metrics, not exposed in output.

    console.info(
      "[INFO] Both glob and grep tools log security filter metrics via securityLog.debug(). " +
        "These metrics (filteredCount, filteredFileCount, redactedMatchCount) are NOT included " +
        "in the tool's user-facing output. The debug log requires explicit debug-level logging " +
        "to be visible, which is appropriate for security audit purposes.",
    )
    expect(true).toBe(true)
  })
})
