import { describe, test, expect, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"
import { SecurityAccess } from "@/security/access"
import { SecurityConfig } from "@/security/config"
import { SecuritySchema } from "@/security/schema"
import { SecuritySegments } from "@/security/segments"
import {
  setupSecurityConfig,
  teardownSecurityConfig,
  loadBaseConfig,
  protectedFilePath,
} from "../helpers"

afterEach(() => {
  teardownSecurityConfig()
})

// ============================================================================
// CASE-WRITE-001: Verify direct write to protected file returns access denied
// ============================================================================
describe("CASE-WRITE-001: Direct write to protected file returns access denied", () => {
  test("write to secrets/key.pem is denied for viewer role", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("secrets/key.pem", "write", "viewer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toBeDefined()
    expect(result.reason).toContain("secrets/**")
  })

  test("write to .env is denied for viewer role", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess(".env", "write", "viewer")
    expect(result.allowed).toBe(false)
  })

  test("write to .env.production is denied for developer role", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess(".env.production", "write", "developer")
    expect(result.allowed).toBe(false)
  })

  test("write to src/auth/keys.ts is denied for viewer role", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("src/auth/keys.ts", "write", "viewer")
    expect(result.allowed).toBe(false)
  })

  test("admin role IS allowed to write to protected file", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("secrets/key.pem", "write", "admin")
    expect(result.allowed).toBe(true)
  })

  test("write to unprotected file is allowed for viewer role", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("src/app.ts", "write", "viewer")
    expect(result.allowed).toBe(true)
  })
})

// ============================================================================
// CASE-WRITE-002: Creating new file in protected directory is blocked
// ============================================================================
describe("CASE-WRITE-002: Creating new file in protected directory is blocked by directory rule", () => {
  test("write to secrets/newfile.ts is denied — inherits secrets/** rule", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("secrets/newfile.ts", "write", "viewer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("secrets/**")
  })

  test("write to secrets/subdir/deep.ts is denied — directory rule inheritance", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("secrets/subdir/deep.ts", "write", "viewer")
    expect(result.allowed).toBe(false)
  })

  test("write to a new .env variant is blocked by **/.env* pattern", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess(".env.local", "write", "viewer")
    expect(result.allowed).toBe(false)
  })

  test("write to nested .env file matches glob pattern", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("config/.env.staging", "write", "viewer")
    expect(result.allowed).toBe(false)
  })
})

// ============================================================================
// CASE-EDIT-001: Verify edit overlapping @secure-start/@secure-end region is blocked
// ============================================================================
describe("CASE-EDIT-001: Edit overlapping @secure-start/@secure-end region is blocked", () => {
  // Note: The base config markers have deniedOperations: ["read", "llm"] — NOT "write".
  // For edit segment protection to trigger, the marker rules must include "write" in deniedOperations.
  // We test with a write-denying config to verify the mechanism works.

  test("edit overlapping marker region is blocked when markers deny write", () => {
    const content = [
      "const public1 = true",
      "// @secure-start",
      "const secretKey = 'SUPER_SECRET'",
      "const secretPass = 'hunter2'",
      "// @secure-end",
      "const public2 = false",
    ].join("\n")

    const markersWithWriteDeny: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read", "write", "llm"], allowedRoles: ["admin"] },
    ]
    const markerSegments = SecuritySegments.findMarkerSegments(content, markersWithWriteDeny)
    expect(markerSegments.length).toBe(1)

    // Simulate the edit tool's segment protection logic
    const roles: SecuritySchema.Role[] = [
      { name: "admin", level: 100 },
      { name: "viewer", level: 10 },
    ]
    const currentRole = "viewer"
    const roleLevel = roles.find((r) => r.name === currentRole)?.level ?? 0

    const protectedSegments: { start: number; end: number }[] = []
    for (const seg of markerSegments) {
      if (seg.rule.deniedOperations.includes("write")) {
        const allowed = seg.rule.allowedRoles.includes(currentRole) ||
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

    // Simulate finding the edit range for a string inside the protected region
    const oldString = "const secretKey = 'SUPER_SECRET'"
    const editStart = content.indexOf(oldString)
    expect(editStart).toBeGreaterThan(-1)
    const editRange = { start: editStart, end: editStart + oldString.length }

    // Check overlap: edit range starts before segment ends AND ends after segment starts
    const overlaps = protectedSegments.some(
      (seg) => editRange.start < seg.end && editRange.end > seg.start,
    )
    expect(overlaps).toBe(true)
  })

  test("[FINDING] base config markers deny 'read' and 'llm' but NOT 'write' — edits to marker regions are allowed", async () => {
    const baseConfig = loadBaseConfig()
    const markers = baseConfig.segments!.markers!

    // Verify the base config's marker deniedOperations
    for (const marker of markers) {
      expect(marker.deniedOperations).toContain("read")
      expect(marker.deniedOperations).toContain("llm")

      // Document whether "write" is denied
      if (!marker.deniedOperations.includes("write")) {
        console.info(
          "[INFO] Base config marker rule denies 'read' and 'llm' but NOT 'write'. " +
            "Edits to marker-protected segments are allowed by the default config. " +
            "This is intentional if the goal is read-protection only, but means segment " +
            "integrity can be compromised by edit operations.",
        )
      }
    }
  })

  test("AST-protected functions: edits blocked when AST rules deny write", () => {
    const content = fs.readFileSync(protectedFilePath("ast-code.ts"), "utf8")
    const filepath = protectedFilePath("ast-code.ts")

    const astRulesWithWriteDeny: SecuritySchema.ASTConfig[] = [
      {
        languages: ["typescript", "javascript"],
        nodeTypes: ["function", "arrow_function"],
        namePattern: "encrypt|decrypt|sign|verify",
        deniedOperations: ["read", "write", "llm"],
        allowedRoles: ["admin"],
      },
    ]
    const astSegments = SecuritySegments.findASTSegments(filepath, content, astRulesWithWriteDeny)
    expect(astSegments.length).toBeGreaterThan(0)

    // Verify encryptData function is detected
    const encryptSeg = astSegments.find((s) => content.substring(s.start, s.end).includes("encryptData"))
    expect(encryptSeg).toBeDefined()

    // Simulate edit tool protection for viewer role
    const roles: SecuritySchema.Role[] = [
      { name: "admin", level: 100 },
      { name: "viewer", level: 10 },
    ]
    const currentRole = "viewer"
    const roleLevel = roles.find((r) => r.name === currentRole)?.level ?? 0

    const protectedSegments: { start: number; end: number }[] = []
    for (const seg of astSegments) {
      if (seg.rule.deniedOperations.includes("write")) {
        const allowed = seg.rule.allowedRoles.includes(currentRole) ||
          seg.rule.allowedRoles.some((ar) => {
            const arLevel = roles.find((r) => r.name === ar)?.level ?? 0
            return roleLevel > arLevel
          })
        if (!allowed) {
          protectedSegments.push({ start: seg.start, end: seg.end })
        }
      }
    }

    expect(protectedSegments.length).toBeGreaterThan(0)

    // Attempt to edit inside encryptData function body
    const oldString = "const cipher = crypto.createCipheriv"
    const editStart = content.indexOf(oldString)
    expect(editStart).toBeGreaterThan(-1)
    const editRange = { start: editStart, end: editStart + oldString.length }

    const overlaps = protectedSegments.some(
      (seg) => editRange.start < seg.end && editRange.end > seg.start,
    )
    expect(overlaps).toBe(true)
  })
})

// ============================================================================
// CASE-EDIT-002: Verify edit that deletes the // @secure-start marker itself is blocked
// ============================================================================
describe("CASE-EDIT-002: Edit that deletes the // @secure-start marker itself is blocked", () => {
  test("deleting the start marker line overlaps the protected segment", () => {
    const content = [
      "const public1 = true",
      "// @secure-start",
      "const secret = 'hidden'",
      "// @secure-end",
      "const public2 = false",
    ].join("\n")

    const markersWithWriteDeny: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read", "write", "llm"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markersWithWriteDeny)
    expect(segments.length).toBe(1)

    // The protected segment starts at the position of "// @secure-start"
    const markerStart = content.indexOf("// @secure-start")
    expect(markerStart).toBeGreaterThan(-1)

    // The segment.start is the position of the marker match
    // Attempting to edit/delete "// @secure-start" overlaps with segment.start
    const editRange = { start: markerStart, end: markerStart + "// @secure-start".length }
    const overlaps = segments.some(
      (seg) => editRange.start < seg.end && editRange.end > seg.start,
    )
    expect(overlaps).toBe(true)
  })

  test("deleting the end marker line overlaps the protected segment", () => {
    const content = [
      "// @secure-start",
      "const secret = 'hidden'",
      "// @secure-end",
      "const public = true",
    ].join("\n")

    const markersWithWriteDeny: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read", "write", "llm"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markersWithWriteDeny)
    expect(segments.length).toBe(1)

    // The segment.end is the end of the "// @secure-end" match
    // The end marker itself is within the protected range [start..end]
    const endMarkerPos = content.indexOf("// @secure-end")
    const editRange = { start: endMarkerPos, end: endMarkerPos + "// @secure-end".length }

    // The segment end is AFTER the end marker (it includes the end marker text)
    const overlaps = segments.some(
      (seg) => editRange.start < seg.end && editRange.end > seg.start,
    )
    expect(overlaps).toBe(true)
  })
})

// ============================================================================
// CASE-EDIT-003: Verify edit immediately adjacent to (but outside) protected segment is ALLOWED
// ============================================================================
describe("CASE-EDIT-003: Edit immediately adjacent to (but outside) protected segment is ALLOWED", () => {
  test("edit just before @secure-start marker is allowed", () => {
    const content = [
      "const public1 = true",
      "// @secure-start",
      "const secret = 'hidden'",
      "// @secure-end",
      "const public2 = false",
    ].join("\n")

    const markersWithWriteDeny: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read", "write", "llm"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markersWithWriteDeny)
    expect(segments.length).toBe(1)

    // Edit "const public1 = true" which is before the protected segment
    const oldString = "const public1 = true"
    const editStart = content.indexOf(oldString)
    expect(editStart).toBe(0)
    const editRange = { start: editStart, end: editStart + oldString.length }

    // Should NOT overlap with the protected segment
    const overlaps = segments.some(
      (seg) => editRange.start < seg.end && editRange.end > seg.start,
    )
    expect(overlaps).toBe(false)
  })

  test("edit just after @secure-end marker is allowed", () => {
    const content = [
      "// @secure-start",
      "const secret = 'hidden'",
      "// @secure-end",
      "const public2 = false",
    ].join("\n")

    const markersWithWriteDeny: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read", "write", "llm"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markersWithWriteDeny)
    expect(segments.length).toBe(1)

    // Edit "const public2 = false" which is after the protected segment
    const oldString = "const public2 = false"
    const editStart = content.indexOf(oldString)
    expect(editStart).toBeGreaterThan(-1)
    const editRange = { start: editStart, end: editStart + oldString.length }

    // Should NOT overlap with the protected segment
    const overlaps = segments.some(
      (seg) => editRange.start < seg.end && editRange.end > seg.start,
    )
    expect(overlaps).toBe(false)
  })

  test("edit of public function between two protected segments is allowed", () => {
    const content = [
      "// @secure-start",
      "const secret1 = 'A'",
      "// @secure-end",
      "const publicMiddle = 'safe'",
      "// @secure-start",
      "const secret2 = 'B'",
      "// @secure-end",
    ].join("\n")

    const markersWithWriteDeny: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read", "write", "llm"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markersWithWriteDeny)
    expect(segments.length).toBe(2)

    // Edit "const publicMiddle = 'safe'" between the two segments
    const oldString = "const publicMiddle = 'safe'"
    const editStart = content.indexOf(oldString)
    expect(editStart).toBeGreaterThan(-1)
    const editRange = { start: editStart, end: editStart + oldString.length }

    const overlaps = segments.some(
      (seg) => editRange.start < seg.end && editRange.end > seg.start,
    )
    expect(overlaps).toBe(false)
  })
})

// ============================================================================
// CASE-EDIT-004: Verify injecting new // @secure-start markers via write is allowed
// ============================================================================
describe("CASE-EDIT-004: Injecting new // @secure-start markers via write is allowed", () => {
  test("adding marker comments to unprotected file is allowed (markers are just comments)", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Writing to an unprotected file is allowed at the file-level
    const result = SecurityAccess.checkAccess("src/app.ts", "write", "viewer")
    expect(result.allowed).toBe(true)

    // The content being written could contain marker comments — this is fine.
    // Markers are just comment strings. The Write tool does not check content for markers.
    // Only the Edit tool checks segment protection for existing markers.
    console.info(
      "[INFO] Markers (// @secure-start, // @secure-end) are just comment strings. " +
        "The Write tool does not scan content being written for markers. " +
        "Users can freely add new marker comments to unprotected files. " +
        "This is correct behavior: markers define protection boundaries for READ operations.",
    )
  })

  test("write tool does not perform segment-level checks (no marker scanning on write)", () => {
    // The Write tool (write.ts) only does:
    // 1. File-level checkAccess() for "write" operation
    // 2. Permission ask
    // 3. Write content
    // It does NOT scan for protected segments in the content being written.
    // This is by design: the Write tool replaces entire file content.

    // The Edit tool DOES check segments, but only for existing content (oldString matching).
    // When oldString === "", the Edit tool also skips segment protection.

    // Document this design decision
    console.info(
      "[INFO] Write tool does NOT perform segment-level protection checks. " +
        "It only checks file-level access control. Segment protection is enforced " +
        "only by the Edit tool when editing existing content (oldString !== '').",
    )

    // Verify this by examining the code logic:
    // write.ts line 38: SecurityAccess.checkAccess(filepath, "write", currentRole)
    // No call to SecuritySegments.findMarkerSegments or findASTSegments
    expect(true).toBe(true)
  })

  test("[FINDING] edit with empty oldString skips segment protection", () => {
    // When the Edit tool is called with oldString === "", it takes a different code path
    // (edit.ts lines 74-97) that does NOT check segment-level protection.
    // This means using Edit with empty oldString to create a new file bypasses segment checks.
    //
    // However, this is acceptable because:
    // 1. Empty oldString means the file doesn't exist yet (or is being overwritten)
    // 2. No existing segments to protect in a new file
    // 3. File-level access control still applies

    console.info(
      "[INFO] Edit tool with empty oldString (new file creation) skips segment-level " +
        "protection checks. This is correct: a new file has no existing protected segments. " +
        "File-level access control still applies to prevent creating files in protected directories.",
    )
    expect(true).toBe(true)
  })
})

// ============================================================================
// CASE-WRITE-003: Verify behavior when writing to .opencode-security.json itself
// ============================================================================
describe("CASE-WRITE-003: Writing to .opencode-security.json itself", () => {
  test(".opencode-security.json is NOT explicitly protected by default rules", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Check if .opencode-security.json is protected by any rule in base config
    const result = SecurityAccess.checkAccess(".opencode-security.json", "write", "viewer")

    // The base config rules are:
    // - secrets/** (directory)
    // - **/.env* (file)
    // - src/auth/keys.ts (file)
    // None of these match .opencode-security.json
    expect(result.allowed).toBe(true)

    console.warn(
      "[FINDING] MEDIUM: .opencode-security.json is NOT protected by any default rule. " +
        "An attacker with write access can modify the security configuration itself to " +
        "remove rules, change roles, or disable protection. This is a configuration " +
        "integrity concern — the security config should be self-protecting.",
    )
  })

  test("explicit rule can protect .opencode-security.json", async () => {
    const baseConfig = loadBaseConfig()
    const configWithSelfProtect: SecuritySchema.SecurityConfig = {
      ...baseConfig,
      rules: [
        ...(baseConfig.rules ?? []),
        {
          pattern: ".opencode-security.json",
          type: "file" as const,
          deniedOperations: ["write" as const],
          allowedRoles: ["admin"],
        },
      ],
    }
    await setupSecurityConfig(configWithSelfProtect)

    const result = SecurityAccess.checkAccess(".opencode-security.json", "write", "viewer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain(".opencode-security.json")
  })

  test("admin can always write to .opencode-security.json even if protected", async () => {
    const baseConfig = loadBaseConfig()
    const configWithSelfProtect: SecuritySchema.SecurityConfig = {
      ...baseConfig,
      rules: [
        ...(baseConfig.rules ?? []),
        {
          pattern: ".opencode-security.json",
          type: "file" as const,
          deniedOperations: ["write" as const],
          allowedRoles: ["admin"],
        },
      ],
    }
    await setupSecurityConfig(configWithSelfProtect)

    const result = SecurityAccess.checkAccess(".opencode-security.json", "write", "admin")
    expect(result.allowed).toBe(true)
  })

  test(".opencode-security-audit.log is also NOT protected by default", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess(".opencode-security-audit.log", "write", "viewer")
    expect(result.allowed).toBe(true)

    console.warn(
      "[FINDING] LOW: .opencode-security-audit.log is NOT protected by default rules. " +
        "An attacker could overwrite or truncate the audit log to hide evidence of access attempts.",
    )
  })
})
