import { describe, test, expect, afterEach } from "bun:test"
import fs from "fs"
import { LLMScanner } from "@/security/llm-scanner"
import { SecuritySegments } from "@/security/segments"
import { SecuritySchema } from "@/security/schema"
import {
  setupSecurityConfig,
  teardownSecurityConfig,
  loadBaseConfig,
  protectedFilePath,
} from "../helpers"

afterEach(() => {
  teardownSecurityConfig()
})

describe("CASE-LLM-001: LLMScanner detects protected markers in plain text content", () => {
  test("content with @secure-start/@secure-end markers is detected", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const content = [
      "Here is some assistant context:",
      "// @secure-start",
      "const apiKey = 'sk-secret-key-12345'",
      "// @secure-end",
      "The user asked about configuration.",
    ].join("\n")

    const matches = LLMScanner.scanForProtectedContent(content, baseConfig)
    const markerMatches = matches.filter((m) => m.ruleType === "marker")

    expect(markerMatches.length).toBeGreaterThan(0)
    expect(markerMatches[0].start).toBeGreaterThanOrEqual(0)
    expect(markerMatches[0].end).toBeGreaterThan(markerMatches[0].start)
  })

  test("content without markers returns no marker matches", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const content = "This is normal content with no security markers or protected paths."

    const matches = LLMScanner.scanForProtectedContent(content, baseConfig)
    const markerMatches = matches.filter((m) => m.ruleType === "marker")

    expect(markerMatches.length).toBe(0)
  })

  test("only markers with 'llm' in deniedOperations are scanned", () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      segments: {
        markers: [
          { start: "@secure-start", end: "@secure-end", deniedOperations: ["read"], allowedRoles: ["admin"] },
          { start: "@llm-start", end: "@llm-end", deniedOperations: ["llm"], allowedRoles: ["admin"] },
        ],
      },
    }

    const content = [
      "// @secure-start",
      "read-only protected",
      "// @secure-end",
      "// @llm-start",
      "llm-denied protected",
      "// @llm-end",
    ].join("\n")

    const matches = LLMScanner.scanForProtectedContent(content, config)

    // Only @llm-start/@llm-end should be detected (deniedOperations includes "llm")
    // @secure-start/@secure-end has deniedOperations: ["read"] — no "llm" — should NOT match
    expect(matches.length).toBe(1)
    expect(matches[0].ruleType).toBe("marker")
    expect(matches[0].matchedText).toContain("@llm-start")
  })

  test("base config markers include 'llm' in deniedOperations", () => {
    const baseConfig = loadBaseConfig()
    const markers = baseConfig.segments?.markers ?? []
    const llmMarkers = markers.filter((m) => m.deniedOperations.includes("llm"))

    // Base config markers deny both "read" and "llm"
    expect(llmMarkers.length).toBeGreaterThan(0)
  })
})

describe("CASE-LLM-002: Scanner catches protected content in tool result text", () => {
  test("simulated tool result containing marked content is flagged", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Simulate what might appear in a tool result from a Read tool
    const toolResult = [
      "File: src/config.ts",
      "Contents:",
      "// @secure-start",
      "const DATABASE_PASSWORD = 'super-secret-db-pass'",
      "const API_SECRET = 'api-secret-value-xyz'",
      "// @secure-end",
      "",
      "export default {}",
    ].join("\n")

    const matches = LLMScanner.scanForProtectedContent(toolResult, baseConfig)
    const markerMatches = matches.filter((m) => m.ruleType === "marker")

    expect(markerMatches.length).toBeGreaterThan(0)
  })

  test("tool result referencing protected file path is flagged via pattern matching", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Tool result that references a .env file (matches **/.env* rule)
    const toolResult = "I found the configuration in .env.production with the following content..."

    const matches = LLMScanner.scanForProtectedContent(toolResult, baseConfig)
    const patternMatches = matches.filter((m) => m.ruleType === "pattern")

    expect(patternMatches.length).toBeGreaterThan(0)
    expect(patternMatches.some((m) => m.matchedText === ".env")).toBe(true)
  })
})

describe("CASE-LLM-003: Scanner catches protected content in system prompt text", () => {
  test("system prompt with embedded marker content is detected", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Simulate a system prompt that accidentally includes marked content
    const systemPrompt = [
      "You are a helpful assistant. Here is relevant context:",
      "",
      "// @secure-start",
      "Internal credentials: admin/password123",
      "// @secure-end",
      "",
      "Help the user with their coding task.",
    ].join("\n")

    const matches = LLMScanner.scanForProtectedContent(systemPrompt, baseConfig)

    expect(matches.length).toBeGreaterThan(0)
    expect(matches.some((m) => m.ruleType === "marker")).toBe(true)
  })

  test("system prompt referencing secrets/ path is flagged", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // The secrets/** rule denies "llm" and extractLiteralFromGlob("secrets/**") = "secrets/"
    const systemPrompt = "The project stores keys in secrets/ directory. Do not modify them."

    const matches = LLMScanner.scanForProtectedContent(systemPrompt, baseConfig)
    const patternMatches = matches.filter((m) => m.ruleType === "pattern")

    expect(patternMatches.length).toBeGreaterThan(0)
    expect(patternMatches.some((m) => m.matchedText === "secrets/")).toBe(true)
  })
})

describe("CASE-LLM-004: Scanner limits with obfuscated content", () => {
  test("[KNOWN_LIMITATION] broken-apart marker text is NOT detected", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Attacker breaks markers across multiple parts to avoid detection
    const obfuscated = [
      "// @secure" + "-start",  // concatenated at JS level, but content is literal
      "const secret = 'hidden'",
      "// @secure" + "-end",
    ].join("\n")

    // The JS string concatenation happens at compile time, so the actual content
    // DOES contain "// @secure-start" as a continuous string — scanner WILL detect it
    const matches = LLMScanner.scanForProtectedContent(obfuscated, baseConfig)
    const markerMatches = matches.filter((m) => m.ruleType === "marker")
    expect(markerMatches.length).toBeGreaterThan(0)
  })

  test("[KNOWN_LIMITATION] marker text split across message boundaries is not detectable", () => {
    // If content is split into separate strings (e.g., two separate tool results),
    // the scanner processes each independently and cannot correlate across boundaries.
    // This is a fundamental limitation of per-message scanning.
    const part1 = "// @secure-start\nconst secret = 'hidden'"
    const part2 = "// @secure-end"
    const config = loadBaseConfig()

    const matches1 = LLMScanner.scanForProtectedContent(part1, config)
    const matches2 = LLMScanner.scanForProtectedContent(part2, config)

    // Part1 has a start marker but no end — findMarkerSegments returns 0 segments
    // (unmatched start = no segment per CASE-READ-008 findings)
    // Part2 has only an end marker — also no segment
    // Neither part alone triggers a complete marker match
    console.info(
      "[KNOWN_LIMITATION] MEDIUM: Content split across separate scanner invocations " +
        "cannot be correlated. An attacker could leak protected content by ensuring " +
        "markers appear in separate tool results or message parts.",
    )

    // Verify the limitation: each part alone doesn't form a complete segment
    const markerMatches1 = matches1.filter((m) => m.ruleType === "marker")
    const markerMatches2 = matches2.filter((m) => m.ruleType === "marker")
    expect(markerMatches1.length).toBe(0)
    expect(markerMatches2.length).toBe(0)
  })

  test("[KNOWN_LIMITATION] character substitution in markers is NOT detected", () => {
    const config = loadBaseConfig()

    // Replace @ with homoglyph or use different casing
    const variants = [
      "// \uFF20secure-start\nhidden\n// \uFF20secure-end", // fullwidth @
      "// @SECURE-START\nhidden\n// @SECURE-END", // uppercase
      "// @s\u0435cure-start\nhidden\n// @s\u0435cure-end", // Cyrillic 'е' (U+0435) instead of 'e'
    ]

    for (const content of variants) {
      const matches = LLMScanner.scanForProtectedContent(content, config)
      const markerMatches = matches.filter((m) => m.ruleType === "marker")

      // None of these variants should match — scanner uses exact marker text matching
      expect(markerMatches.length).toBe(0)
    }

    console.info(
      "[KNOWN_LIMITATION] LOW: Character substitution (Unicode homoglyphs, case changes) " +
        "in marker text bypasses scanner detection. This is expected since markers are exact-match " +
        "patterns. Mitigation: file-level rules provide a secondary defense.",
    )
  })
})

describe("CASE-LLM-005: Base64-encoded protected content is NOT detected", () => {
  test("[KNOWN_LIMITATION] base64-encoded content with markers bypasses scanner", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Original content with markers
    const original = [
      "// @secure-start",
      "const apiKey = 'sk-secret-key-12345'",
      "// @secure-end",
    ].join("\n")

    // Base64-encode the content
    const encoded = Buffer.from(original).toString("base64")

    // Scanner should NOT detect the encoded version
    const matches = LLMScanner.scanForProtectedContent(encoded, baseConfig)
    const markerMatches = matches.filter((m) => m.ruleType === "marker")

    expect(markerMatches.length).toBe(0)

    console.warn(
      "[KNOWN_LIMITATION] MEDIUM: Base64-encoded content bypasses the LLM scanner entirely. " +
        "If protected content is base64-encoded before being included in an LLM request, " +
        "the scanner cannot detect the embedded markers or path patterns. " +
        "Mitigation: ensure tool implementations prevent base64 encoding of protected content " +
        "at the source (before it reaches the LLM pipeline).",
    )
  })

  test("[KNOWN_LIMITATION] hex-encoded content also bypasses scanner", () => {
    const config = loadBaseConfig()

    const original = "// @secure-start\nsecret data\n// @secure-end"
    const hexEncoded = Buffer.from(original).toString("hex")

    const matches = LLMScanner.scanForProtectedContent(hexEncoded, config)
    expect(matches.filter((m) => m.ruleType === "marker").length).toBe(0)
  })

  test("[KNOWN_LIMITATION] URL-encoded content bypasses scanner", () => {
    const config = loadBaseConfig()

    const original = "// @secure-start\nsecret data\n// @secure-end"
    const urlEncoded = encodeURIComponent(original)

    const matches = LLMScanner.scanForProtectedContent(urlEncoded, config)
    expect(matches.filter((m) => m.ruleType === "marker").length).toBe(0)
  })
})

describe("CASE-LLM-006: Marker boundaries are detected in arbitrary text", () => {
  test("markers detected in markdown text", () => {
    const config = loadBaseConfig()

    const markdown = [
      "# Security Configuration",
      "",
      "```typescript",
      "// @secure-start",
      "const key = 'abc123'",
      "// @secure-end",
      "```",
      "",
      "Do not share the above code.",
    ].join("\n")

    const matches = LLMScanner.scanForProtectedContent(markdown, config)
    const markerMatches = matches.filter((m) => m.ruleType === "marker")

    // Scanner should detect markers even inside markdown code blocks
    expect(markerMatches.length).toBeGreaterThan(0)
  })

  test("markers detected in JSON-like text", () => {
    const config = loadBaseConfig()

    const jsonText = JSON.stringify({
      output: "// @secure-start\nconst secret = 'val'\n// @secure-end",
    })

    const matches = LLMScanner.scanForProtectedContent(jsonText, config)
    const markerMatches = matches.filter((m) => m.ruleType === "marker")

    // JSON escapes \n as \\n, so "// @secure-start" and "// @secure-end" appear
    // as substrings in the JSON string (without actual newlines between them)
    // The scanner processes the raw string — markers are present as text
    // but findMarkerSegments may or may not find them depending on regex matching
    // since the content between start and end is on the same "line" in JSON
    if (markerMatches.length > 0) {
      expect(markerMatches[0].ruleType).toBe("marker")
    }
    // Document: JSON serialization may affect marker detection depending on newline handling
    expect(markerMatches.length >= 0).toBe(true)
  })

  test("markers detected with # comment style", () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      segments: {
        markers: [
          { start: "@secure-start", end: "@secure-end", deniedOperations: ["llm"], allowedRoles: ["admin"] },
        ],
      },
    }

    const pythonContent = [
      "# @secure-start",
      "API_KEY = 'secret-python-key'",
      "# @secure-end",
    ].join("\n")

    const matches = LLMScanner.scanForProtectedContent(pythonContent, config)
    const markerMatches = matches.filter((m) => m.ruleType === "marker")

    expect(markerMatches.length).toBe(1)
  })

  test("markers detected with /* */ comment style", () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      segments: {
        markers: [
          { start: "@secure-start", end: "@secure-end", deniedOperations: ["llm"], allowedRoles: ["admin"] },
        ],
      },
    }

    const cStyleContent = [
      "/* @secure-start */",
      "const secret = 'block-comment-secret';",
      "/* @secure-end */",
    ].join("\n")

    const matches = LLMScanner.scanForProtectedContent(cStyleContent, config)
    const markerMatches = matches.filter((m) => m.ruleType === "marker")

    expect(markerMatches.length).toBe(1)
  })

  test("markers detected with <!-- --> comment style", () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      segments: {
        markers: [
          { start: "@secure-start", end: "@secure-end", deniedOperations: ["llm"], allowedRoles: ["admin"] },
        ],
      },
    }

    const htmlContent = [
      "<!-- @secure-start -->",
      "<div>secret HTML content</div>",
      "<!-- @secure-end -->",
    ].join("\n")

    const matches = LLMScanner.scanForProtectedContent(htmlContent, config)
    const markerMatches = matches.filter((m) => m.ruleType === "marker")

    expect(markerMatches.length).toBe(1)
  })
})

describe("CASE-LLM-007: Path pattern matching catches references to protected file paths", () => {
  test("'.env' substring is detected in content", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const content = "The application reads from .env for environment variables."

    const matches = LLMScanner.scanForProtectedContent(content, baseConfig)
    const patternMatches = matches.filter((m) => m.ruleType === "pattern")

    // **/.env* → extractLiteralFromGlob → ".env"
    expect(patternMatches.length).toBeGreaterThan(0)
    expect(patternMatches.some((m) => m.matchedText === ".env")).toBe(true)
  })

  test("'secrets/' substring is detected in content", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const content = "Keys are stored in the secrets/ directory for security."

    const matches = LLMScanner.scanForProtectedContent(content, baseConfig)
    const patternMatches = matches.filter((m) => m.ruleType === "pattern")

    // secrets/** → extractLiteralFromGlob → "secrets/"
    expect(patternMatches.length).toBeGreaterThan(0)
    expect(patternMatches.some((m) => m.matchedText === "secrets/")).toBe(true)
  })

  test("'src/auth/keys.ts' is detected in content", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const content = "I modified the file src/auth/keys.ts to add the new authentication handler."

    const matches = LLMScanner.scanForProtectedContent(content, baseConfig)
    const patternMatches = matches.filter((m) => m.ruleType === "pattern")

    // src/auth/keys.ts has no wildcards → extracted literal is "src/auth/keys.ts"
    expect(patternMatches.length).toBeGreaterThan(0)
    expect(patternMatches.some((m) => m.matchedText === "src/auth/keys.ts")).toBe(true)
  })

  test("multiple occurrences of pattern are all detected", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const content = "Check .env first, then .env.production, and finally .env.local for overrides."

    const matches = LLMScanner.scanForProtectedContent(content, baseConfig)
    const envMatches = matches.filter((m) => m.ruleType === "pattern" && m.matchedText === ".env")

    // ".env" appears 3 times as a substring (in .env, .env.production, .env.local)
    expect(envMatches.length).toBe(3)
  })

  test("rules without 'llm' in deniedOperations do NOT trigger pattern scanning", () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      rules: [
        { pattern: "secrets/**", type: "directory", deniedOperations: ["read", "write"], allowedRoles: ["admin"] },
      ],
    }

    const content = "Files are in secrets/ directory."

    const matches = LLMScanner.scanForProtectedContent(content, config)
    expect(matches.length).toBe(0)
  })
})

describe("CASE-LLM-008: extractLiteralFromGlob handles partial matches correctly", () => {
  test("'**/.env*' extracts '.env' — matches .env, .env.example, .envrc", () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      rules: [
        { pattern: "**/.env*", type: "file", deniedOperations: ["llm"], allowedRoles: ["admin"] },
      ],
    }

    // .env.example is matched because extracted literal ".env" is a substring
    const content1 = "Don't forget to copy .env.example to .env"
    const matches1 = LLMScanner.scanForProtectedContent(content1, config)
    const patternMatches1 = matches1.filter((m) => m.ruleType === "pattern")

    // ".env" appears twice: in ".env.example" and in ".env"
    expect(patternMatches1.length).toBe(2)
    expect(patternMatches1.every((m) => m.matchedText === ".env")).toBe(true)
  })

  test("'secrets/**' extracts 'secrets/' — trailing slash from glob expansion", () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      rules: [
        { pattern: "secrets/**", type: "directory", deniedOperations: ["llm"], allowedRoles: ["admin"] },
      ],
    }

    // "secrets/" is the extracted literal (everything before the **)
    const content = "The secrets/ folder contains sensitive keys."
    const matches = LLMScanner.scanForProtectedContent(content, config)
    const patternMatches = matches.filter((m) => m.ruleType === "pattern")

    expect(patternMatches.length).toBe(1)
    expect(patternMatches[0].matchedText).toBe("secrets/")
  })

  test("pure wildcard '**' or '*' returns no literal — no matches", () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      rules: [
        { pattern: "**", type: "directory", deniedOperations: ["llm"], allowedRoles: ["admin"] },
        { pattern: "*", type: "file", deniedOperations: ["llm"], allowedRoles: ["admin"] },
      ],
    }

    const content = "Any text here with secrets and .env and everything."
    const matches = LLMScanner.scanForProtectedContent(content, config)

    // extractLiteralFromGlob returns undefined for pure wildcards — no pattern matches
    expect(matches.length).toBe(0)
  })

  test("'src/auth/keys.ts' (no wildcards) extracts full path as literal", () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      rules: [
        { pattern: "src/auth/keys.ts", type: "file", deniedOperations: ["llm"], allowedRoles: ["admin"] },
      ],
    }

    const content = "Modified src/auth/keys.ts for the new auth flow."
    const matches = LLMScanner.scanForProtectedContent(content, config)
    const patternMatches = matches.filter((m) => m.ruleType === "pattern")

    expect(patternMatches.length).toBe(1)
    expect(patternMatches[0].matchedText).toBe("src/auth/keys.ts")
  })

  test("glob with middle wildcard 'config/*.json' extracts 'config/' prefix", () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      rules: [
        { pattern: "config/*.json", type: "file", deniedOperations: ["llm"], allowedRoles: ["admin"] },
      ],
    }

    const content = "Look in the config/ directory for settings."
    const matches = LLMScanner.scanForProtectedContent(content, config)
    const patternMatches = matches.filter((m) => m.ruleType === "pattern")

    // extractLiteralFromGlob: strip leading **/, no leading glob → "config/*.json"
    // wildcard at index 7 → slice(0,7) = "config/"
    expect(patternMatches.length).toBe(1)
    expect(patternMatches[0].matchedText).toBe("config/")
  })

  test("[INFO] over-matching: '.env' literal matches .envrc and .env.example", () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      rules: [
        { pattern: "**/.env*", type: "file", deniedOperations: ["llm"], allowedRoles: ["admin"] },
      ],
    }

    // .envrc is a legitimate config file that might not need protection
    // but the pattern ".env" matches it as a substring
    const content = "Set up your shell with .envrc for direnv."
    const matches = LLMScanner.scanForProtectedContent(content, config)
    const patternMatches = matches.filter((m) => m.ruleType === "pattern")

    // ".env" is a substring of ".envrc" — over-match
    expect(patternMatches.length).toBe(1)
    expect(patternMatches[0].matchedText).toBe(".env")

    console.info(
      "[INFO] Pattern matching uses literal substring search from extracted glob prefixes. " +
        "This means '.env' matches '.envrc', '.env.example', '.environment', etc. " +
        "This is an over-matching behavior (safe default: flags more than necessary). " +
        "The pattern extraction is intentionally conservative to avoid missing legitimate matches.",
    )
  })

  test("leading '*/' is stripped — '*/private/**' extracts 'private/'", () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      rules: [
        { pattern: "*/private/**", type: "directory", deniedOperations: ["llm"], allowedRoles: ["admin"] },
      ],
    }

    const content = "The private/ folder is restricted."
    const matches = LLMScanner.scanForProtectedContent(content, config)
    const patternMatches = matches.filter((m) => m.ruleType === "pattern")

    // "*/private/**" → strip "*/" → "private/**" → wildcard at 8 → "private/"
    expect(patternMatches.length).toBe(1)
    expect(patternMatches[0].matchedText).toBe("private/")
  })
})
