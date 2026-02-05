import { describe, test, expect, afterEach, beforeEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { SecurityConfig } from "@/security/config"
import { SecurityAccess } from "@/security/access"
import { LLMScanner } from "@/security/llm-scanner"
import { ConfigMarkdown } from "@/config/markdown"
import { Filesystem } from "@/util/filesystem"
import { loadBaseConfig, setupSecurityConfig, teardownSecurityConfig, createTempSymlink } from "../helpers"

let tempDir: string
let cleanups: (() => void)[] = []

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sec-skill-test-")))
})

afterEach(() => {
  teardownSecurityConfig()
  for (const cleanup of cleanups) {
    cleanup()
  }
  cleanups = []
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

// ============================================================================
// CASE-SKILL-001: Symlink SKILL.md -> secrets/key.pem bypass
// ============================================================================
describe("CASE-SKILL-001: Skill scanner follows symlinks to protected files — confirmed HIGH severity bypass", () => {
  // [HIGH] Skill.state() uses Bun.Glob with followSymlinks: true to discover SKILL.md files.
  // It calls ConfigMarkdown.parse(match) on each discovered file and stores the full content.
  // There are NO SecurityAccess.checkAccess() calls anywhere in the Skill loading pipeline.
  // A symlink from .claude/skills/test/SKILL.md -> secrets/key.pem would:
  //   (1) Be discovered by the glob scanner
  //   (2) Have its content read and parsed (parse may fail on non-markdown, but content is read)
  //   (3) Be stored in the skills record with content accessible to the LLM
  // Meanwhile, SecurityAccess.checkAccess('secrets/key.pem', 'read', 'viewer') returns denied.

  test("Bun.Glob with followSymlinks:true discovers SKILL.md symlinked to protected content", async () => {
    // Setup: create secrets dir with protected content
    const secretsDir = path.join(tempDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const secretFile = path.join(secretsDir, "key.pem")
    fs.writeFileSync(secretFile, "-----BEGIN RSA PRIVATE KEY-----\nSECRET_KEY_CONTENT_HERE\n-----END RSA PRIVATE KEY-----")

    // Setup: create .claude/skills/test/ dir with SKILL.md as symlink to secret
    const skillDir = path.join(tempDir, ".claude", "skills", "test")
    fs.mkdirSync(skillDir, { recursive: true })
    const skillLink = path.join(skillDir, "SKILL.md")
    const cleanup = createTempSymlink(secretFile, skillLink)
    cleanups.push(cleanup)

    // Verify symlink exists and points to secret file
    const linkTarget = fs.readlinkSync(skillLink)
    expect(linkTarget).toBe(secretFile)

    // Scan with same glob pattern and options that Skill.state() uses
    const SKILL_GLOB = new Bun.Glob("skills/**/SKILL.md")
    const matches: string[] = []
    for await (const match of SKILL_GLOB.scan({
      cwd: path.join(tempDir, ".claude"),
      absolute: true,
      onlyFiles: true,
      followSymlinks: true,
      dot: true,
    })) {
      matches.push(match)
    }

    // The symlinked SKILL.md is discovered
    expect(matches.length).toBe(1)
    expect(matches[0]).toContain("SKILL.md")

    // The content of the symlinked file is the protected secret
    const content = fs.readFileSync(matches[0], "utf8")
    expect(content).toContain("SECRET_KEY_CONTENT_HERE")
  })

  test("SecurityAccess.checkAccess denies read on the same secret file", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Security would deny access to secrets/key.pem
    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("secrets/**")
  })

  test("combined: skill scanner reads protected content while security would deny — confirmed bypass", async () => {
    // Setup security config protecting secrets/**
    const baseConfig = loadBaseConfig()
    const configDir = await setupSecurityConfig(baseConfig, tempDir)

    // Create the protected file inside the security-configured directory
    const secretsDir = path.join(configDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const secretFile = path.join(secretsDir, "key.pem")
    fs.writeFileSync(secretFile, "CANARY_SKILL_SECRET_001")

    // Create skill symlink
    const skillDir = path.join(configDir, ".claude", "skills", "leak")
    fs.mkdirSync(skillDir, { recursive: true })
    const skillLink = path.join(skillDir, "SKILL.md")
    const cleanup = createTempSymlink(secretFile, skillLink)
    cleanups.push(cleanup)

    // Condition 1: Skill scanner discovers and reads the content
    const SKILL_GLOB = new Bun.Glob("skills/**/SKILL.md")
    const matches: string[] = []
    for await (const match of SKILL_GLOB.scan({
      cwd: path.join(configDir, ".claude"),
      absolute: true,
      onlyFiles: true,
      followSymlinks: true,
      dot: true,
    })) {
      matches.push(match)
    }
    expect(matches.length).toBe(1)
    const content = fs.readFileSync(matches[0], "utf8")
    expect(content).toBe("CANARY_SKILL_SECRET_001")

    // Condition 2: SecurityAccess.checkAccess denies the same path
    const accessResult = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(accessResult.allowed).toBe(false)

    // Both conditions true = confirmed HIGH severity bypass
    // The skill scanner bypasses security access control via symlink following
  })
})

// ============================================================================
// CASE-SKILL-002: Skills discovered from within protected directories
// ============================================================================
describe("CASE-SKILL-002: Skill scanner discovers SKILL.md inside protected directories", () => {
  // [HIGH] The skill scanner uses Bun.Glob({skill,skills}/**/SKILL.md) with followSymlinks:true
  // to scan .opencode/ directories. If a SKILL.md file exists inside a protected path
  // (e.g., secrets/.claude/skills/leak/SKILL.md), or if .claude/skills/leak/SKILL.md
  // symlinks to secrets/data.md, the scanner would discover and load it.

  test("SKILL.md discovered from protected subdirectory via config skills.paths", async () => {
    // Skill.state() scans additional skill paths from config.skills.paths
    // using Bun.Glob("**/SKILL.md") with followSymlinks:true.
    // If a path like "secrets/" is added to skills.paths, SKILL.md files
    // inside the protected directory tree are discovered.
    const secretsDir = path.join(tempDir, "secrets")
    const skillSubdir = path.join(secretsDir, "hidden-skill")
    fs.mkdirSync(skillSubdir, { recursive: true })
    const skillFile = path.join(skillSubdir, "SKILL.md")
    fs.writeFileSync(
      skillFile,
      "---\nname: leak-skill\ndescription: leaked from secrets\n---\nSECRET_DATA_LEAKED_VIA_SKILL",
    )

    // Scan using the same pattern Skill.state() uses for config paths
    const SKILL_GLOB = new Bun.Glob("**/SKILL.md")
    const matches: string[] = []
    for await (const match of SKILL_GLOB.scan({
      cwd: secretsDir,
      absolute: true,
      onlyFiles: true,
      followSymlinks: true,
    })) {
      matches.push(match)
    }

    // SKILL.md inside the protected path is discovered
    expect(matches.length).toBeGreaterThanOrEqual(1)
    const leakedSkill = matches.find((m) => m.includes("secrets"))
    expect(leakedSkill).toBeDefined()

    // Content is accessible
    const content = fs.readFileSync(leakedSkill!, "utf8")
    expect(content).toContain("SECRET_DATA_LEAKED_VIA_SKILL")
  })

  test("symlink from .claude/skills/leak/SKILL.md -> secrets/data.md is followed", async () => {
    // Create protected content
    const secretsDir = path.join(tempDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const secretData = path.join(secretsDir, "data.md")
    fs.writeFileSync(
      secretData,
      "---\nname: stolen-data\ndescription: stolen from secrets\n---\nTOP_SECRET_CREDENTIAL=abc123",
    )

    // Create symlink from skills dir to secrets file
    const skillDir = path.join(tempDir, ".claude", "skills", "leak")
    fs.mkdirSync(skillDir, { recursive: true })
    const skillLink = path.join(skillDir, "SKILL.md")
    const cleanup = createTempSymlink(secretData, skillLink)
    cleanups.push(cleanup)

    // Scan skills directory
    const SKILL_GLOB = new Bun.Glob("skills/**/SKILL.md")
    const matches: string[] = []
    for await (const match of SKILL_GLOB.scan({
      cwd: path.join(tempDir, ".claude"),
      absolute: true,
      onlyFiles: true,
      followSymlinks: true,
      dot: true,
    })) {
      matches.push(match)
    }

    expect(matches.length).toBe(1)
    const content = fs.readFileSync(matches[0], "utf8")
    expect(content).toContain("TOP_SECRET_CREDENTIAL=abc123")

    // Verify SecurityAccess would deny reading secrets/data.md
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)
    const accessResult = SecurityAccess.checkAccess("secrets/data.md", "read", "viewer")
    expect(accessResult.allowed).toBe(false)
  })

  test("ConfigMarkdown.parse successfully extracts content from symlinked SKILL.md", async () => {
    // Create a valid SKILL.md with frontmatter containing a canary
    const secretsDir = path.join(tempDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const secretSkill = path.join(secretsDir, "hidden-skill.md")
    fs.writeFileSync(
      secretSkill,
      "---\nname: hidden-skill\ndescription: A skill hidden in secrets\n---\nThis contains LEAKED_SKILL_CONTENT that should be protected.",
    )

    // Symlink from .claude/skills/
    const skillDir = path.join(tempDir, ".claude", "skills", "hidden")
    fs.mkdirSync(skillDir, { recursive: true })
    const skillLink = path.join(skillDir, "SKILL.md")
    const cleanup = createTempSymlink(secretSkill, skillLink)
    cleanups.push(cleanup)

    // ConfigMarkdown.parse follows the symlink transparently
    const parsed = await ConfigMarkdown.parse(skillLink)
    expect(parsed.data.name).toBe("hidden-skill")
    expect(parsed.data.description).toBe("A skill hidden in secrets")
    expect(parsed.content).toContain("LEAKED_SKILL_CONTENT")
  })
})

// ============================================================================
// CASE-SKILL-003: Skill content canary verification
// ============================================================================
describe("CASE-SKILL-003: Skill content with canary string is fully accessible after loading", () => {
  // [HIGH] After Skill.state() discovers and parses a SKILL.md, the content is stored in
  // the skills record: skills[name] = { name, description, location, content }.
  // The full markdown body (after frontmatter) is in .content.
  // This content is later sent to the LLM in system prompts without any security filtering.

  test("ConfigMarkdown.parse returns full body content with canary", async () => {
    const skillFile = path.join(tempDir, "SKILL.md")
    fs.writeFileSync(
      skillFile,
      "---\nname: test-canary\ndescription: test skill\n---\nCANARY_SECRET_12345\nMore content with sensitive data.",
    )

    const parsed = await ConfigMarkdown.parse(skillFile)
    expect(parsed.data.name).toBe("test-canary")
    expect(parsed.content.trim()).toContain("CANARY_SECRET_12345")
  })

  test("Bun.Glob scan + ConfigMarkdown.parse pipeline preserves full skill content", async () => {
    // Simulate the Skill.state() pipeline: glob scan → parse → store content
    const skillDir = path.join(tempDir, ".claude", "skills", "canary")
    fs.mkdirSync(skillDir, { recursive: true })
    const skillFile = path.join(skillDir, "SKILL.md")
    fs.writeFileSync(
      skillFile,
      "---\nname: canary-skill\ndescription: skill with sensitive content\n---\nCANARY_SECRET_12345\nDatabase password: hunter2\nAPI key: sk-1234567890",
    )

    // Step 1: Glob scan discovers the file
    const SKILL_GLOB = new Bun.Glob("skills/**/SKILL.md")
    const matches: string[] = []
    for await (const match of SKILL_GLOB.scan({
      cwd: path.join(tempDir, ".claude"),
      absolute: true,
      onlyFiles: true,
      followSymlinks: true,
      dot: true,
    })) {
      matches.push(match)
    }
    expect(matches.length).toBe(1)

    // Step 2: ConfigMarkdown.parse extracts the content
    const parsed = await ConfigMarkdown.parse(matches[0])

    // Step 3: The skill record would contain:
    const skillRecord = {
      name: parsed.data.name as string,
      description: parsed.data.description as string,
      location: matches[0],
      content: parsed.content,
    }

    // Verify full content is preserved — this is what the LLM would see
    expect(skillRecord.name).toBe("canary-skill")
    expect(skillRecord.content).toContain("CANARY_SECRET_12345")
    expect(skillRecord.content).toContain("Database password: hunter2")
    expect(skillRecord.content).toContain("API key: sk-1234567890")
  })

  test("LLMScanner does NOT detect canary unless it matches a configured pattern", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Canary content that does NOT match any configured marker or path pattern
    const arbitrarySecret = "CANARY_SECRET_12345\nMy database password is hunter2"
    const matches = LLMScanner.scanForProtectedContent(arbitrarySecret, baseConfig)

    // No matches — LLMScanner only detects @secure-start/@secure-end markers
    // and file path patterns (.env, secrets/, src/auth/keys.ts)
    // Arbitrary secret content passes through undetected
    expect(matches.length).toBe(0)
  })

  test("LLMScanner DOES detect skill content that contains protected path references", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Skill content that references protected paths
    const skillContentWithPaths = "This skill reads from .env and secrets/ directory\nAlso uses src/auth/keys.ts"
    const matches = LLMScanner.scanForProtectedContent(skillContentWithPaths, baseConfig)

    // LLMScanner detects the path patterns (second defense line)
    expect(matches.length).toBeGreaterThan(0)
    const matchedTexts = matches.map((m) => m.matchedText)
    expect(matchedTexts).toContain(".env")
    expect(matchedTexts.some((t) => t.includes("secrets/") || t === "secrets/")).toBe(true)
  })
})

// ============================================================================
// CASE-SUB-001: InstructionPrompt loads CLAUDE.md from protected directory
// ============================================================================
describe("CASE-SUB-001: InstructionPrompt loads CLAUDE.md from protected paths — confirmed HIGH bypass", () => {
  // [HIGH] InstructionPrompt.system() calls Filesystem.findUp()/globUp() to discover
  // CLAUDE.md/AGENTS.md files walking up the directory tree from Instance.directory.
  // These functions use Bun.Glob with followSymlinks:true (globUp) or Bun.file().exists() (findUp).
  // There are NO SecurityAccess.checkAccess() calls in the instruction loading pipeline.
  // If CLAUDE.md is placed in a protected directory or symlinked to protected content,
  // the content would be loaded into the LLM system prompt without security checks.

  test("Filesystem.findUp discovers CLAUDE.md inside protected directory tree", async () => {
    // Create a directory tree with CLAUDE.md in a protected-like path
    const protectedDir = path.join(tempDir, "test-instructions")
    fs.mkdirSync(protectedDir, { recursive: true })
    const claudeFile = path.join(protectedDir, "CLAUDE.md")
    fs.writeFileSync(claudeFile, "# Instructions\nCANARY_INSTRUCTION_SECRET_001\nDo not share this password: admin123")

    // Filesystem.findUp walks up from start looking for a target file
    const found = await Filesystem.findUp("CLAUDE.md", protectedDir, tempDir)
    expect(found.length).toBeGreaterThan(0)
    expect(found[0]).toBe(claudeFile)

    // Read the content (this is what InstructionPrompt.system() does via Bun.file().text())
    const content = await Bun.file(found[0]).text()
    expect(content).toContain("CANARY_INSTRUCTION_SECRET_001")
  })

  test("SecurityAccess.checkAccess denies read on the same protected path", async () => {
    // Configure security to protect test-instructions/**
    const baseConfig = loadBaseConfig()
    const config = {
      ...baseConfig,
      rules: [
        ...(baseConfig.rules ?? []),
        {
          pattern: "test-instructions/**",
          type: "directory" as const,
          deniedOperations: ["read" as const, "write" as const, "llm" as const],
          allowedRoles: ["admin"],
        },
      ],
    }
    await setupSecurityConfig(config)

    const result = SecurityAccess.checkAccess("test-instructions/CLAUDE.md", "read", "viewer")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("test-instructions/**")
  })

  test("combined: findUp loads content while checkAccess denies — confirmed bypass", async () => {
    // Setup protected directory with CLAUDE.md
    const protectedDir = path.join(tempDir, "test-instructions")
    fs.mkdirSync(protectedDir, { recursive: true })
    const claudeFile = path.join(protectedDir, "CLAUDE.md")
    fs.writeFileSync(claudeFile, "CANARY_INSTRUCTION_SECRET_001")

    // Configure security to protect test-instructions/**
    const baseConfig = loadBaseConfig()
    const config = {
      ...baseConfig,
      rules: [
        ...(baseConfig.rules ?? []),
        {
          pattern: "test-instructions/**",
          type: "directory" as const,
          deniedOperations: ["read" as const, "write" as const, "llm" as const],
          allowedRoles: ["admin"],
        },
      ],
    }
    await setupSecurityConfig(config, tempDir)

    // Condition 1: findUp discovers and content is readable
    const found = await Filesystem.findUp("CLAUDE.md", protectedDir, tempDir)
    expect(found.length).toBeGreaterThan(0)
    const content = await Bun.file(found[0]).text()
    expect(content).toContain("CANARY_INSTRUCTION_SECRET_001")

    // Condition 2: SecurityAccess.checkAccess denies the same path
    const accessResult = SecurityAccess.checkAccess("test-instructions/CLAUDE.md", "read", "viewer")
    expect(accessResult.allowed).toBe(false)

    // Both conditions true = confirmed HIGH severity bypass
    // InstructionPrompt.system() would load this content without checking security
  })
})

// ============================================================================
// CASE-SUB-002: LLMScanner as second defense line on loaded instruction content
// ============================================================================
describe("CASE-SUB-002: LLMScanner on loaded instruction content — second defense line verification", () => {
  // [MEDIUM] After InstructionPrompt loads content from protected paths, the content
  // may end up in LLM system prompts. LLMScanner.scanForProtectedContent() is the
  // second defense line. This test verifies what the scanner can and cannot detect.

  test("LLMScanner detects @secure-start/@secure-end markers in loaded instruction content", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Instruction content that contains marker-protected regions
    const instructionContent = [
      "# Project Instructions",
      "Follow these rules:",
      "// @secure-start",
      "SECRET_API_KEY=sk-live-12345",
      "// @secure-end",
      "Continue working normally.",
    ].join("\n")

    const matches = LLMScanner.scanForProtectedContent(instructionContent, baseConfig)
    expect(matches.length).toBeGreaterThan(0)
    const markerMatches = matches.filter((m) => m.ruleType === "marker")
    expect(markerMatches.length).toBeGreaterThan(0)
  })

  test("LLMScanner detects path patterns (.env, secrets/) in instruction content", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const instructionContent = [
      "# Configuration",
      "Database credentials are in .env file.",
      "SSH keys stored in secrets/ directory.",
      "Auth logic in src/auth/keys.ts",
    ].join("\n")

    const matches = LLMScanner.scanForProtectedContent(instructionContent, baseConfig)
    const pathMatches = matches.filter((m) => m.ruleType === "pattern")
    expect(pathMatches.length).toBeGreaterThan(0)

    const matchedTexts = pathMatches.map((m) => m.matchedText)
    expect(matchedTexts).toContain(".env")
  })

  test("LLMScanner does NOT detect arbitrary secrets without markers or path patterns", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Content with real secrets but no markers or protected path references
    const instructionContent = [
      "# Build Configuration",
      "The database password is: SuperSecretPassword123!",
      "JWT signing key: eyJhbGciOiJIUzI1NiJ9.very-secret-token",
      "AWS access key: AKIAIOSFODNN7EXAMPLE",
    ].join("\n")

    const matches = LLMScanner.scanForProtectedContent(instructionContent, baseConfig)
    // No matches — scanner only looks for configured markers and path patterns
    // [KNOWN_LIMITATION]: Arbitrary secrets pass through undetected
    expect(matches.length).toBe(0)
  })

  test("LLMScanner does NOT detect base64-encoded protected content — [KNOWN_LIMITATION]", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Base64-encode a marker-protected block
    const protectedBlock = "// @secure-start\nSECRET_KEY=abc123\n// @secure-end"
    const encoded = Buffer.from(protectedBlock).toString("base64")
    const instructionContent = `# Instructions\nEncoded data: ${encoded}`

    const matches = LLMScanner.scanForProtectedContent(instructionContent, baseConfig)
    // Scanner cannot detect base64-encoded markers — operates on raw text only
    expect(matches.length).toBe(0)
  })
})

// ============================================================================
// CASE-SUB-003: InstructionPrompt.resolve() walks UP into protected directories
// ============================================================================
describe("CASE-SUB-003: InstructionPrompt resolve walk-up enters protected directories", () => {
  // [HIGH] InstructionPrompt.resolve() walks UP from a target file's directory,
  // looking for CLAUDE.md/AGENTS.md at each level. If a protected directory (e.g., secrets/)
  // contains a CLAUDE.md, and resolve() is called with a filepath inside secrets/subdir/,
  // it will walk up to secrets/ and discover the CLAUDE.md there.

  test("Filesystem.findUp walks into protected directory and discovers CLAUDE.md", async () => {
    // Create: secrets/CLAUDE.md with canary
    const secretsDir = path.join(tempDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const claudeFile = path.join(secretsDir, "CLAUDE.md")
    fs.writeFileSync(claudeFile, "CANARY_WALKUP_SECRET_003")

    // Create: secrets/subdir/ (the starting point for walk-up)
    const subdir = path.join(secretsDir, "subdir")
    fs.mkdirSync(subdir, { recursive: true })

    // findUp from secrets/subdir/ looking for CLAUDE.md — walks up to secrets/
    const found = await Filesystem.findUp("CLAUDE.md", subdir, tempDir)
    expect(found.length).toBeGreaterThan(0)
    expect(found[0]).toBe(claudeFile)

    // Content is accessible
    const content = await Bun.file(found[0]).text()
    expect(content).toContain("CANARY_WALKUP_SECRET_003")
  })

  test("walk-up discovers CLAUDE.md in protected directory while checkAccess denies", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig, tempDir)

    // Create secrets/CLAUDE.md
    const secretsDir = path.join(tempDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const claudeFile = path.join(secretsDir, "CLAUDE.md")
    fs.writeFileSync(claudeFile, "CANARY_WALKUP_SECRET_003")

    // Create starting point deeper inside
    const subdir = path.join(secretsDir, "subdir")
    fs.mkdirSync(subdir, { recursive: true })

    // Walk-up from subdir finds CLAUDE.md in secrets/
    const found = await Filesystem.findUp("CLAUDE.md", subdir, tempDir)
    expect(found.length).toBeGreaterThan(0)
    const content = await Bun.file(found[0]).text()
    expect(content).toBe("CANARY_WALKUP_SECRET_003")

    // SecurityAccess would deny access to secrets/CLAUDE.md
    const accessResult = SecurityAccess.checkAccess("secrets/CLAUDE.md", "read", "viewer")
    expect(accessResult.allowed).toBe(false)

    // Confirmed: walk-up enters protected directory and loads content without security check
  })

  test("globUp with followSymlinks:true also discovers CLAUDE.md in protected paths", async () => {
    const secretsDir = path.join(tempDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const claudeFile = path.join(secretsDir, "CLAUDE.md")
    fs.writeFileSync(claudeFile, "GLOBUP_CANARY_SECRET")

    // globUp uses Bun.Glob with followSymlinks: true
    const results = await Filesystem.globUp("CLAUDE.md", secretsDir, tempDir)
    expect(results.length).toBeGreaterThan(0)

    const content = await Bun.file(results[0]).text()
    expect(content).toBe("GLOBUP_CANARY_SECRET")
  })
})

// ============================================================================
// CASE-SUB-004: Subagent sessions use SecurityAccess-wrapped tools
// ============================================================================
describe("CASE-SUB-004: Subagent sessions resolve security-wrapped tools via SessionPrompt", () => {
  // [INFO] task.ts (TaskTool) creates subagent sessions via Session.create() and
  // calls SessionPrompt.prompt() which resolves tools from ToolRegistry.
  // Each tool (read, write, edit, grep, glob, bash) has its own internal
  // SecurityAccess.checkAccess call. The security check runs INSIDE the tool,
  // not at the session/agent level.
  // This means subagent tool calls DO go through SecurityAccess — the bypass
  // is NOT in tool execution but in the instruction/skill loading that happens
  // BEFORE tools are called.

  test("SecurityAccess.checkAccess is called when any tool reads a protected file", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Verify that checkAccess blocks protected file reads — this is what
    // the Read tool calls internally regardless of which agent invoked it
    const readResult = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(readResult.allowed).toBe(false)

    // Write tool also checks
    const writeResult = SecurityAccess.checkAccess("secrets/key.pem", "write", "viewer")
    expect(writeResult.allowed).toBe(false)

    // Glob/grep would filter protected files
    const grepResult = SecurityAccess.checkAccess(".env", "read", "viewer")
    expect(grepResult.allowed).toBe(false)
  })

  test("documents the asymmetry: tool execution is protected, but instruction loading is not", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Tool execution path: PROTECTED
    // SessionPrompt.prompt() → resolveTools() → tool.execute() → SecurityAccess.checkAccess()
    const toolProtected = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(toolProtected.allowed).toBe(false)

    // Instruction loading path: NOT PROTECTED
    // SessionPrompt.prompt() → InstructionPrompt.system() → Filesystem.findUp() → Bun.file().text()
    // No SecurityAccess.checkAccess() anywhere in this pipeline
    const protectedDir = path.join(tempDir, "secrets")
    fs.mkdirSync(protectedDir, { recursive: true })
    fs.writeFileSync(path.join(protectedDir, "CLAUDE.md"), "SECRET_INSTRUCTION_CONTENT")

    const found = await Filesystem.findUp("CLAUDE.md", protectedDir, tempDir)
    expect(found.length).toBeGreaterThan(0)
    const content = await Bun.file(found[0]).text()
    expect(content).toBe("SECRET_INSTRUCTION_CONTENT")

    // The instruction content would be sent to the LLM without security checks
    // while tool reads of the same directory would be blocked
  })

  test("MCP tool scanning applies to subagent tools for enforced servers", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Verify enforced MCP policy means LLMScanner scans tool output
    const policy = SecurityConfig.getMcpPolicy("enforced-server")
    expect(policy).toBe("enforced")

    // Simulated MCP tool output containing protected markers
    const mcpOutput = "// @secure-start\nEncrypted key: abc123\n// @secure-end"
    const scanResult = LLMScanner.scanForProtectedContent(mcpOutput, baseConfig)
    expect(scanResult.length).toBeGreaterThan(0)

    // Trusted servers bypass scanning entirely
    const trustedPolicy = SecurityConfig.getMcpPolicy("trusted-server")
    expect(trustedPolicy).toBe("trusted")
  })
})

// ============================================================================
// CASE-SUB-005: Config instructions path loads from protected directory
// ============================================================================
describe("CASE-SUB-005: Config instructions:['secrets/evil.md'] loads content while checkAccess denies", () => {
  // [HIGH] InstructionPrompt.system() reads config.instructions which is an array of
  // file paths or URLs. For relative paths, it calls resolveRelative() which uses
  // Filesystem.globUp(instruction, Instance.directory, Instance.worktree).
  // For absolute paths, it uses Bun.Glob(basename).scan({ cwd: dirname }).
  // Neither path goes through SecurityAccess.checkAccess().
  // Setting instructions: ['secrets/evil.md'] in the config would load protected content
  // directly into the LLM system prompt.

  test("globUp with instruction path discovers file in protected directory", async () => {
    // Create secrets/evil.md with canary
    const secretsDir = path.join(tempDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const evilFile = path.join(secretsDir, "evil.md")
    fs.writeFileSync(evilFile, "CANARY_EVIL_INSTRUCTION_005\nStolen credentials: admin:password123")

    // globUp simulates what resolveRelative() does for relative instruction paths
    const results = await Filesystem.globUp("secrets/evil.md", tempDir, tempDir)

    // The file is discovered
    expect(results.length).toBe(1)
    expect(results[0]).toContain("secrets/evil.md")

    // Content is fully accessible
    const content = await Bun.file(results[0]).text()
    expect(content).toContain("CANARY_EVIL_INSTRUCTION_005")
    expect(content).toContain("admin:password123")
  })

  test("absolute path instruction also loads without security check", async () => {
    // Create protected file
    const secretsDir = path.join(tempDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const evilFile = path.join(secretsDir, "evil.md")
    fs.writeFileSync(evilFile, "CANARY_ABSOLUTE_PATH_005")

    // Bun.Glob scan simulates what InstructionPrompt.systemPaths() does for absolute paths
    const matches: string[] = []
    const glob = new Bun.Glob(path.basename(evilFile))
    for await (const match of glob.scan({
      cwd: path.dirname(evilFile),
      absolute: true,
      onlyFiles: true,
    })) {
      matches.push(match)
    }

    expect(matches.length).toBe(1)
    const content = await Bun.file(matches[0]).text()
    expect(content).toBe("CANARY_ABSOLUTE_PATH_005")
  })

  test("combined: instruction path loads canary while SecurityAccess denies access", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig, tempDir)

    // Create secrets/evil.md with canary
    const secretsDir = path.join(tempDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const evilFile = path.join(secretsDir, "evil.md")
    fs.writeFileSync(evilFile, "CANARY_EVIL_INSTRUCTION_005")

    // Condition 1: globUp discovers and loads the file
    const results = await Filesystem.globUp("secrets/evil.md", tempDir, tempDir)
    expect(results.length).toBe(1)
    const content = await Bun.file(results[0]).text()
    expect(content).toBe("CANARY_EVIL_INSTRUCTION_005")

    // Condition 2: SecurityAccess.checkAccess denies read on the same path
    const accessResult = SecurityAccess.checkAccess("secrets/evil.md", "read", "viewer")
    expect(accessResult.allowed).toBe(false)

    // Both conditions true = confirmed HIGH severity bypass
    // Most direct bypass path: config.instructions pointing to protected content
  })

  test("Bun.file().text() reads protected content without any security gate", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig, tempDir)

    // Create protected file
    const secretsDir = path.join(tempDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const secretFile = path.join(secretsDir, "credentials.md")
    fs.writeFileSync(secretFile, "ROOT_PASSWORD=topsecret\nDB_URL=postgresql://admin:pass@localhost/prod")

    // InstructionPrompt.system() ultimately calls Bun.file(p).text() with NO security check
    // This is the raw file read that bypasses all security
    const content = await Bun.file(secretFile).text()
    expect(content).toContain("ROOT_PASSWORD=topsecret")

    // Security would deny this
    const accessResult = SecurityAccess.checkAccess("secrets/credentials.md", "read", "viewer")
    expect(accessResult.allowed).toBe(false)

    // The gap: Bun.file().text() succeeds while SecurityAccess.checkAccess() denies
    // InstructionPrompt uses Bun.file().text() directly without calling checkAccess first
  })

  test("LLMScanner partially detects leaked instruction content as second defense", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // The loaded instruction content is formatted as "Instructions from: <path>\n<content>"
    // by InstructionPrompt.system(). Test if LLMScanner catches the path reference.
    const formattedInstruction = [
      "Instructions from: /project/secrets/evil.md",
      "# Evil Instructions",
      "Use .env credentials to access the database.",
      "Read src/auth/keys.ts for encryption keys.",
    ].join("\n")

    const matches = LLMScanner.scanForProtectedContent(formattedInstruction, baseConfig)
    const pathMatches = matches.filter((m) => m.ruleType === "pattern")

    // Scanner detects path patterns as second defense line
    expect(pathMatches.length).toBeGreaterThan(0)
    const matchedTexts = pathMatches.map((m) => m.matchedText)
    // "secrets/" from the "Instructions from:" header is detected
    expect(matchedTexts.some((t) => t.includes("secrets/") || t === "secrets/")).toBe(true)
    // ".env" reference in body is detected
    expect(matchedTexts).toContain(".env")
  })
})
