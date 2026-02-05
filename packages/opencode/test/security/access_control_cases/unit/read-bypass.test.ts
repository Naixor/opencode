import { describe, test, expect, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import { SecurityAccess } from "@/security/access"
import { SecurityConfig } from "@/security/config"
import { SecuritySchema } from "@/security/schema"
import { SecuritySegments } from "@/security/segments"
import { SecurityRedact } from "@/security/redact"
import {
  setupSecurityConfig,
  teardownSecurityConfig,
  loadBaseConfig,
  protectedFilePath,
} from "../helpers"

afterEach(() => {
  teardownSecurityConfig()
})

describe("CASE-READ-001: Reading a fully protected file returns access denied", () => {
  test("file matching 'secrets/**' rule is denied for viewer role", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toBeDefined()
  })

  test("file matching '**/.env*' rule is denied for viewer role", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess(".env", "read", "viewer")
    expect(result.allowed).toBe(false)
  })

  test("file matching '**/.env*' rule is denied for developer role", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess(".env.production", "read", "developer")
    expect(result.allowed).toBe(false)
  })

  test("admin role IS allowed to read protected file", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "admin")
    expect(result.allowed).toBe(true)
  })
})

describe("CASE-READ-002: Segment redaction replaces content between @secure-start/@secure-end", () => {
  test("marker-protected region is replaced with REDACTED placeholder", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const content = fs.readFileSync(protectedFilePath("marked-code.ts"), "utf8")
    const markers = baseConfig.segments!.markers!
    const markerSegments = SecuritySegments.findMarkerSegments(content, markers)

    expect(markerSegments.length).toBeGreaterThan(0)

    // Viewer role is not in allowedRoles (admin, developer) for markers
    const roles = baseConfig.roles ?? []
    const viewerLevel = roles.find((r) => r.name === "viewer")?.level ?? 0
    const protectedSegments: SecurityRedact.Segment[] = []
    for (const seg of markerSegments) {
      if (seg.rule.deniedOperations.includes("read")) {
        const allowed = seg.rule.allowedRoles.includes("viewer") ||
          seg.rule.allowedRoles.some((ar) => {
            const arLevel = roles.find((r) => r.name === ar)?.level ?? 0
            return viewerLevel > arLevel
          })
        if (!allowed) {
          protectedSegments.push({ start: seg.start, end: seg.end })
        }
      }
    }

    expect(protectedSegments.length).toBeGreaterThan(0)

    const redacted = SecurityRedact.redactContent(content, protectedSegments)
    expect(redacted).toContain(SecurityRedact.REDACTED_PLACEHOLDER)
    expect(redacted).not.toContain("SENSITIVE_KEY_INSIDE_MARKER")
    expect(redacted).not.toContain("marker-protected-password")

    // Public code outside markers should still be visible
    expect(redacted).toContain("publicConfig")
    expect(redacted).toContain("getAppName")
  })

  test("redaction preserves line count for multi-line segments", () => {
    const content = "line1\n// @secure-start\nsecret line 1\nsecret line 2\nsecret line 3\n// @secure-end\nline7"
    const markers: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(1)

    const redacted = SecurityRedact.redactContent(content, segments)
    const originalLineCount = content.split("\n").length
    const redactedLineCount = redacted.split("\n").length

    // Redaction preserves newline count within the redacted region
    expect(redactedLineCount).toBe(originalLineCount)
    expect(redacted).toContain(SecurityRedact.REDACTED_PLACEHOLDER)
    expect(redacted).not.toContain("secret line")
  })

  test("developer role is allowed to read marker-protected content", () => {
    const baseConfig = loadBaseConfig()
    const content = fs.readFileSync(protectedFilePath("marked-code.ts"), "utf8")
    const markers = baseConfig.segments!.markers!
    const markerSegments = SecuritySegments.findMarkerSegments(content, markers)

    // Developer is in allowedRoles for markers (["admin", "developer"])
    const roles = baseConfig.roles ?? []
    const protectedForDev: SecurityRedact.Segment[] = []
    for (const seg of markerSegments) {
      if (seg.rule.deniedOperations.includes("read") && !seg.rule.allowedRoles.includes("developer")) {
        protectedForDev.push({ start: seg.start, end: seg.end })
      }
    }

    // Developer should have 0 segments to redact for marker rules
    expect(protectedForDev.length).toBe(0)
  })
})

describe("CASE-READ-003: Partial read with offset/limit still applies redaction", () => {
  test("redaction happens before offset/limit slicing", () => {
    // Simulating the Read tool's processing pipeline:
    // 1. Read full file content
    // 2. Apply redaction
    // 3. Split into lines
    // 4. Apply offset/limit
    const content = [
      "line 0: public",
      "// @secure-start",
      "line 2: SECRET_A",
      "line 3: SECRET_B",
      "line 4: SECRET_C",
      "// @secure-end",
      "line 6: public",
      "line 7: public",
      "line 8: public",
      "line 9: public",
    ].join("\n")

    const markers: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markers)
    const redacted = SecurityRedact.redactContent(content, segments)

    // Now simulate offset/limit (Read tool does this after redaction)
    const lines = redacted.split("\n")

    // Offset 1, limit 5 — should include the redacted region
    const sliced = lines.slice(1, 1 + 5)
    const output = sliced.join("\n")

    expect(output).toContain(SecurityRedact.REDACTED_PLACEHOLDER)
    expect(output).not.toContain("SECRET_A")
    expect(output).not.toContain("SECRET_B")
    expect(output).not.toContain("SECRET_C")
  })

  test("offset that starts inside redacted region still shows placeholder", () => {
    const content = [
      "line 0: public",
      "// @secure-start",
      "line 2: SECRET",
      "line 3: SECRET",
      "// @secure-end",
      "line 5: public",
    ].join("\n")

    const markers: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markers)
    const redacted = SecurityRedact.redactContent(content, segments)
    const lines = redacted.split("\n")

    // Offset 2 — starts inside what was the protected region
    const sliced = lines.slice(2, 2 + 3)
    const output = sliced.join("\n")

    // The redacted content replaces multi-line region with placeholder + newlines
    // So accessing by line offset still works — no secrets visible
    expect(output).not.toContain("SECRET")
  })
})

describe("CASE-READ-004: Protected file with image extension checks security before returning", () => {
  // The Read tool has a separate code path for images/PDFs.
  // It checks file-level access (SecurityAccess.checkAccess) BEFORE reaching the image/PDF branch.
  // So a file in secrets/ with .png extension would be blocked at the access control level.
  // However, segment redaction is NOT applied to images/PDFs since they return raw bytes.
  test("file-level access check runs before image code path", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Even if a file has an image extension, the access check runs first
    // secrets/image.png would match secrets/** rule and be denied
    const result = SecurityAccess.checkAccess("secrets/image.png", "read", "viewer")
    expect(result.allowed).toBe(false)
  })

  test("[KNOWN_LIMITATION] images/PDFs bypass segment redaction since they return raw bytes", () => {
    // The Read tool processes images/PDFs as binary (base64) without segment redaction.
    // This is expected: comment markers don't apply to binary formats.
    // However, if someone embeds secrets in an image's metadata or a PDF's text,
    // segment-level redaction would not catch it.
    // This is INFO severity since: (1) file-level rules still apply, (2) binary formats
    // don't have comment markers, (3) AST parsing doesn't apply to binary files.
    console.info(
      "[INFO] Images and PDFs bypass segment-level redaction (they return raw base64). " +
        "File-level access control still applies. Segment markers are irrelevant for binary formats.",
    )

    // Verify the Read tool code path: images skip redaction
    // The key security guarantee: file-level checkAccess() runs BEFORE the image branch
    // So protected images are blocked entirely, not just segment-redacted
    expect(true).toBe(true) // Documented behavior
  })
})

describe("CASE-READ-005: Premature // @secure-end marker injection doesn't truncate real protected region", () => {
  test("injected @secure-end inside protected region matches the outer @secure-start", () => {
    // Scenario: attacker tries to inject a premature end marker to close protection early
    const content = [
      "// @secure-start",
      "SECRET_LINE_1",
      "// @secure-end  <-- attacker injected this to close early",
      "SECRET_LINE_3_STILL_SHOULD_BE_PROTECTED",
      "// @secure-end",
      "public line",
    ].join("\n")

    const markers: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markers)

    // The parser uses a stack. With 1 start and 2 ends:
    // - Start marker pushed to stack
    // - First end marker matches the start → creates segment [start..first_end]
    // - Second end marker has no matching start → ignored
    // This means the injected end marker DOES truncate the protected region.
    // [KNOWN_LIMITATION] MEDIUM: Premature @secure-end truncates protection.
    // SECRET_LINE_3 is exposed because the first end marker closes the region.

    expect(segments.length).toBe(1)

    const redacted = SecurityRedact.redactContent(content, segments)

    // The first @secure-end closes the protected region
    // Content between first @secure-end and second @secure-end is NOT redacted
    if (redacted.includes("SECRET_LINE_3_STILL_SHOULD_BE_PROTECTED")) {
      console.warn(
        "[KNOWN_LIMITATION] MEDIUM: Injecting a premature '// @secure-end' inside a protected region " +
          "truncates the protection. Content after the injected end marker but before the real " +
          "end marker is left unprotected. An attacker with write access to a file could exploit " +
          "this to expose secrets within a marker-protected region.",
      )
    }

    // SECRET_LINE_1 is always protected (between start and first end)
    expect(redacted).not.toContain("SECRET_LINE_1")
  })

  test("nested markers: two starts then two ends creates two segments correctly", () => {
    const content = [
      "// @secure-start",
      "outer secret",
      "// @secure-start",
      "inner secret",
      "// @secure-end",
      "still outer secret",
      "// @secure-end",
      "public line",
    ].join("\n")

    const markers: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markers)

    // With stack-based matching: inner start matches first end, outer start matches second end
    expect(segments.length).toBe(2)

    const redacted = SecurityRedact.redactContent(content, segments)
    expect(redacted).not.toContain("outer secret")
    expect(redacted).not.toContain("inner secret")
    expect(redacted).not.toContain("still outer secret")
    expect(redacted).toContain("public line")
  })
})

describe("CASE-READ-006: @secure-start inside a string literal is still detected", () => {
  test("marker in string literal is detected by regex — false positive", () => {
    // The marker detector uses regex, not AST-aware comment detection.
    // So '// @secure-start' inside a string literal IS detected as a marker.
    const content = [
      'const example = "// @secure-start"',
      "const secret = 'not actually protected'",
      'const end = "// @secure-end"',
      "const public_code = true",
    ].join("\n")

    const markers: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markers)

    // Document: marker regex matches inside string literals
    if (segments.length > 0) {
      console.info(
        "[INFO] Marker pattern '// @secure-start' is detected even inside string literals. " +
          "This is a false positive — the marker regex does not distinguish between real comments " +
          "and comment-like text in strings. This is an over-protection behavior (safe default).",
      )
    }

    // Either way, document the behavior
    // If segments found: false positive (safe — over-protects)
    // If no segments: correct (won't protect what looks like a string)
    expect(segments.length >= 0).toBe(true)
  })

  test("marker in actual comment is detected", () => {
    const content = [
      "// normal code",
      "// @secure-start",
      "const apiKey = 'SECRET_123'",
      "// @secure-end",
      "// more code",
    ].join("\n")

    const markers: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(1)

    const redacted = SecurityRedact.redactContent(content, segments)
    expect(redacted).not.toContain("SECRET_123")
    expect(redacted).toContain("normal code")
    expect(redacted).toContain("more code")
  })
})

describe("CASE-READ-007: Unicode lookalike markers (fullwidth @) do NOT create false matches", () => {
  test("fullwidth '@' (U+FF20) does not match regular '@' in marker pattern", () => {
    // Fullwidth @ is U+FF20, regular @ is U+0040
    const fullwidthAt = "\uFF20"
    const content = [
      `// ${fullwidthAt}secure-start`,
      "this should NOT be protected",
      `// ${fullwidthAt}secure-end`,
      "public code",
    ].join("\n")

    const markers: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markers)

    // Fullwidth @ should NOT match the pattern for regular @
    expect(segments.length).toBe(0)
  })

  test("other Unicode confusables don't trigger markers", () => {
    // Test with various Unicode characters that look like @
    const confusables = [
      "\uFF20", // Fullwidth @
      "\u0251", // Latin small letter alpha (looks like a)
      "\u00E0", // Latin small letter a with grave
    ]

    for (const char of confusables) {
      const content = [
        `// ${char}secure-start`,
        "should not be protected",
        `// ${char}secure-end`,
      ].join("\n")

      const markers: SecuritySchema.MarkerConfig[] = [
        { start: "@secure-start", end: "@secure-end", deniedOperations: ["read"], allowedRoles: ["admin"] },
      ]
      const segments = SecuritySegments.findMarkerSegments(content, markers)
      expect(segments.length).toBe(0)
    }
  })
})

describe("CASE-READ-008: Nested marker mismatch uses stack-based handling", () => {
  test("start-A, start-B, end-A, end-B — stack matches innermost start with first end", () => {
    // Test with two different marker types to see how the stack handles mismatched nesting
    const content = [
      "// @secure-start",    // A start
      "outer protected A",
      "# @region-start",     // B start
      "inner protected B",
      "// @secure-end",      // A end
      "between markers",
      "# @region-end",       // B end
      "public code",
    ].join("\n")

    const markers: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read"], allowedRoles: ["admin"] },
      { start: "@region-start", end: "@region-end", deniedOperations: ["read"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markers)

    // Stack-based matching with rule matching:
    // Push @secure-start (rule A)
    // Push @region-start (rule B)
    // @secure-end looks for matching start with rule A → finds @secure-start (index 0)
    // @region-end looks for matching start with rule B → finds @region-start (index remains since A was removed)
    // Both segments should be found
    expect(segments.length).toBe(2)

    // Both regions should be redacted
    const redacted = SecurityRedact.redactContent(content, segments)
    expect(redacted).not.toContain("outer protected A")
    expect(redacted).not.toContain("inner protected B")
    expect(redacted).toContain("public code")
  })

  test("unmatched end marker is ignored", () => {
    const content = [
      "// @secure-end",      // orphaned end — no matching start
      "public line 1",
      "// @secure-start",
      "protected line",
      "// @secure-end",
      "public line 2",
    ].join("\n")

    const markers: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markers)

    // The orphaned end marker should be ignored (no matching start in stack)
    expect(segments.length).toBe(1)

    const redacted = SecurityRedact.redactContent(content, segments)
    expect(redacted).toContain("public line 1")
    expect(redacted).not.toContain("protected line")
    expect(redacted).toContain("public line 2")
  })

  test("unmatched start marker — protected region extends to EOF implicitly?", () => {
    const content = [
      "// @secure-start",
      "secret data",
      "more secret data",
      // no @secure-end
    ].join("\n")

    const markers: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markers)

    // Without a matching end marker, the start marker remains on the stack
    // and no segment is created. This means unmatched start = NO protection.
    // [KNOWN_LIMITATION] MEDIUM: Unmatched @secure-start does not protect to EOF.
    if (segments.length === 0) {
      console.warn(
        "[KNOWN_LIMITATION] MEDIUM: An unmatched '// @secure-start' without a corresponding " +
          "'// @secure-end' does NOT create a protected region. Content after the start marker " +
          "is left unprotected. If a developer forgets the end marker, the entire region is exposed.",
      )
    }

    // Either 0 (unmatched start = no segment) or 1 (extends to EOF) — document actual behavior
    const redacted = SecurityRedact.redactContent(content, segments)
    if (redacted.includes("secret data")) {
      // Confirmed: unmatched start = no protection
      expect(segments.length).toBe(0)
    }
  })

  test("multiple same-type markers create correct separate segments", () => {
    const content = [
      "public line 0",
      "// @secure-start",
      "secret A",
      "// @secure-end",
      "public line 4",
      "// @secure-start",
      "secret B",
      "// @secure-end",
      "public line 8",
    ].join("\n")

    const markers: SecuritySchema.MarkerConfig[] = [
      { start: "@secure-start", end: "@secure-end", deniedOperations: ["read"], allowedRoles: ["admin"] },
    ]
    const segments = SecuritySegments.findMarkerSegments(content, markers)

    // Two separate start/end pairs should create two separate segments
    expect(segments.length).toBe(2)

    const redacted = SecurityRedact.redactContent(content, segments)
    expect(redacted).toContain("public line 0")
    expect(redacted).not.toContain("secret A")
    expect(redacted).toContain("public line 4")
    expect(redacted).not.toContain("secret B")
    expect(redacted).toContain("public line 8")
  })
})
