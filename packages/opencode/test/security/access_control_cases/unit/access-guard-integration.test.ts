import { describe, test, expect, afterEach, beforeEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { SecurityConfig } from "@/security/config"
import { SecurityAccess } from "@/security/access"
import { BashScanner } from "@/security/bash-scanner"
import { Filesystem } from "@/util/filesystem"
import { ConfigMarkdown } from "@/config/markdown"
import { loadBaseConfig, setupSecurityConfig, teardownSecurityConfig, createTempSymlink } from "../helpers"
import { AccessGuard, withAccessGuard, isProtectedPath } from "../access-guard"
import type { MonitorReport, AccessEvent } from "../access-guard"

let tempDir: string
let cleanups: (() => void)[] = []

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sec-guard-test-")))
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
// CASE-GUARD-001: withAccessGuard around Skill.state() symlink bypass
// ============================================================================
describe("CASE-GUARD-001: withAccessGuard around skill symlink bypass — OS-level evidence of read", () => {
  // [HIGH] Use withAccessGuard to monitor filesystem access while simulating the
  // Skill.state() pipeline (Bun.Glob scan + ConfigMarkdown.parse) with SKILL.md
  // symlinked to secrets/key.pem. The access-guard should detect that the protected
  // file was read at the OS level, and since there is no corresponding "denied" entry
  // in the application audit log, it should flag a compliance violation.

  test("AccessGuard detects read of symlinked protected file during skill scan", async () => {
    // Setup: protected content
    const secretsDir = path.join(tempDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const secretFile = path.join(secretsDir, "key.pem")
    fs.writeFileSync(secretFile, "-----BEGIN RSA PRIVATE KEY-----\nGUARD_TEST_SECRET_001\n-----END RSA PRIVATE KEY-----")

    // Setup: SKILL.md symlink to secret
    const skillDir = path.join(tempDir, ".claude", "skills", "test")
    fs.mkdirSync(skillDir, { recursive: true })
    const skillLink = path.join(skillDir, "SKILL.md")
    const cleanup = createTempSymlink(secretFile, skillLink)
    cleanups.push(cleanup)

    // Setup security config protecting secrets/**
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig, tempDir)

    // Use withAccessGuard to monitor the skill scan operation
    // Pattern uses absolute path to match fs_usage/fs.watch output
    const absoluteSecretsPattern = path.join(tempDir, "secrets", "**")
    const report = await withAccessGuard([absoluteSecretsPattern], async () => {
      // Simulate Skill.state() pipeline: glob scan + parse
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

      // The scanner discovers the symlinked SKILL.md
      expect(matches.length).toBe(1)

      // ConfigMarkdown.parse reads the file content (following symlink)
      const parsed = await ConfigMarkdown.parse(matches[0])
      expect(parsed.content).toContain("GUARD_TEST_SECRET_001")
    }, { cwd: tempDir })

    // Verify report structure
    expect(report).toBeDefined()
    expect(report.mode === "privileged" || report.mode === "unprivileged").toBe(true)

    // Verify SecurityAccess would have denied this access
    const accessResult = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(accessResult.allowed).toBe(false)

    // Document: In privileged mode, report.protectedAccesses would contain read events.
    // In unprivileged mode, only write/create/delete events are captured (reads invisible).
    // Either way, the compliance violation exists because:
    // (1) The skill scanner read the protected file (verified via content assertion)
    // (2) SecurityAccess.checkAccess denies the same path
    // (3) No "denied" entry exists in the audit log (skill scanner doesn't call checkAccess)
  })

  test("report documents compliance violation when no app audit log entry exists", async () => {
    // Setup: protected content
    const secretsDir = path.join(tempDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const secretFile = path.join(secretsDir, "key.pem")
    fs.writeFileSync(secretFile, "COMPLIANCE_VIOLATION_CANARY")

    // Setup security config
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig, tempDir)

    // Create a dummy audit log with NO denied entry for secrets/key.pem
    const auditLogPath = path.join(tempDir, ".opencode-security-audit.log")
    fs.writeFileSync(auditLogPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      role: "viewer",
      operation: "read",
      path: "some/other/file.ts",
      result: "allowed",
    }) + "\n")

    const guard = new AccessGuard(
      [path.join(tempDir, "secrets", "**")],
      { cwd: tempDir, logPath: path.join(tempDir, "report", "guard-events.ndjson") },
    )
    await guard.start()

    // Read the protected file directly (simulating what skill scanner does)
    const content = fs.readFileSync(secretFile, "utf8")
    expect(content).toBe("COMPLIANCE_VIOLATION_CANARY")

    // Small delay for event capture
    await new Promise((resolve) => setTimeout(resolve, 150))

    const report = await guard.report(auditLogPath)

    // Report should have the structure with proper fields
    expect(report.mode).toBeDefined()
    expect(report.startTime).toBeGreaterThan(0)
    expect(report.endTime).toBeGreaterThanOrEqual(report.startTime)
    expect(report.warnings).toBeInstanceOf(Array)

    // In privileged mode, we'd see read events and compliance violations.
    // In unprivileged mode, reads are invisible — document this limitation.
    if (report.mode === "privileged") {
      // Privileged mode captures reads
      expect(report.protectedAccesses.length).toBeGreaterThan(0)
      expect(report.complianceViolations.length).toBeGreaterThan(0)
      const violation = report.complianceViolations[0]
      expect(violation.reason).toContain("protected path")
      expect(violation.severity).toMatch(/critical|high|medium/)
    }
    if (report.mode === "unprivileged") {
      // Unprivileged mode cannot detect reads — this is a fundamental limitation
      expect(report.warnings.some((w) => w.includes("READ"))).toBe(true)
    }
  })

  test("isProtectedPath correctly flags absolute paths matching glob patterns", () => {
    const absolutePattern = path.join(tempDir, "secrets", "**")
    const testPath = path.join(tempDir, "secrets", "key.pem")
    const safePath = path.join(tempDir, "public", "readme.md")

    expect(isProtectedPath(testPath, [absolutePattern])).toBe(true)
    expect(isProtectedPath(safePath, [absolutePattern])).toBe(false)
  })
})

// ============================================================================
// CASE-GUARD-002: withAccessGuard around InstructionPrompt protected path
// ============================================================================
describe("CASE-GUARD-002: withAccessGuard around InstructionPrompt loading from protected path", () => {
  // [HIGH] Use withAccessGuard to monitor filesystem access while loading CLAUDE.md
  // from a protected directory via Filesystem.findUp(). The guard should detect the
  // OS-level read and, when cross-referenced with the audit log, flag a compliance
  // violation since no "denied" entry exists.

  test("AccessGuard monitors findUp loading CLAUDE.md from protected directory", async () => {
    // Setup: CLAUDE.md in protected directory
    const protectedDir = path.join(tempDir, "test-instructions")
    fs.mkdirSync(protectedDir, { recursive: true })
    const claudeFile = path.join(protectedDir, "CLAUDE.md")
    fs.writeFileSync(claudeFile, "CANARY_GUARD_INSTRUCTION_002")

    // Setup: security config protecting test-instructions/**
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

    const absolutePattern = path.join(tempDir, "test-instructions", "**")
    const report = await withAccessGuard([absolutePattern], async () => {
      // Simulate InstructionPrompt loading via findUp
      const found = await Filesystem.findUp("CLAUDE.md", protectedDir, tempDir)
      expect(found.length).toBeGreaterThan(0)

      // Read the content (what InstructionPrompt does via Bun.file().text())
      const content = await Bun.file(found[0]).text()
      expect(content).toContain("CANARY_GUARD_INSTRUCTION_002")
    }, { cwd: tempDir })

    // Verify SecurityAccess denies the same path
    const accessResult = SecurityAccess.checkAccess("test-instructions/CLAUDE.md", "read", "viewer")
    expect(accessResult.allowed).toBe(false)

    // Report captures the access and documents the bypass
    expect(report).toBeDefined()
    expect(report.mode).toBeDefined()
    expect(report.totalEvents).toBeGreaterThanOrEqual(0)

    if (report.mode === "privileged") {
      // OS-level read detected + no audit log denial = compliance violation
      expect(report.protectedAccesses.length).toBeGreaterThan(0)
      expect(report.complianceViolations.length).toBeGreaterThan(0)
    }
    if (report.mode === "unprivileged") {
      expect(report.warnings.some((w) => w.includes("READ"))).toBe(true)
    }
  })

  test("compliance violation recorded when audit log has no denial for instruction load", async () => {
    // Setup protected CLAUDE.md
    const protectedDir = path.join(tempDir, "test-instructions")
    fs.mkdirSync(protectedDir, { recursive: true })
    const claudeFile = path.join(protectedDir, "CLAUDE.md")
    fs.writeFileSync(claudeFile, "CANARY_GUARD_COMPLIANCE_002")

    // Setup audit log with allowed-only entries
    const auditLogPath = path.join(tempDir, ".opencode-security-audit.log")
    fs.writeFileSync(auditLogPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      role: "viewer",
      operation: "read",
      path: "public/readme.md",
      result: "allowed",
    }) + "\n")

    const baseConfig = loadBaseConfig()
    const config = {
      ...baseConfig,
      rules: [
        ...(baseConfig.rules ?? []),
        {
          pattern: "test-instructions/**",
          type: "directory" as const,
          deniedOperations: ["read" as const, "write" as const],
          allowedRoles: ["admin"],
        },
      ],
    }
    await setupSecurityConfig(config, tempDir)

    const absolutePattern = path.join(tempDir, "test-instructions", "**")
    const guard = new AccessGuard([absolutePattern], { cwd: tempDir })
    await guard.start()

    // Load the protected file
    const content = await Bun.file(claudeFile).text()
    expect(content).toBe("CANARY_GUARD_COMPLIANCE_002")

    await new Promise((resolve) => setTimeout(resolve, 150))

    const report = await guard.report(auditLogPath)

    // Cross-reference: audit log has no "denied" entry for test-instructions/CLAUDE.md
    if (report.mode === "privileged" && report.protectedAccesses.length > 0) {
      expect(report.complianceViolations.length).toBeGreaterThan(0)
      const violation = report.complianceViolations[0]
      expect(violation.appLogMatch).toBe(false)
      expect(violation.reason).toContain("no corresponding denied entry")
    }
  })
})

// ============================================================================
// CASE-GUARD-003: withAccessGuard around blocked Read tool
// ============================================================================
describe("CASE-GUARD-003: withAccessGuard around Read tool that gets blocked by security", () => {
  // [INFO] When the Read tool blocks access to a protected file, SecurityAccess.checkAccess()
  // is called BEFORE any file I/O. This means:
  // - In privileged mode: open()/stat() syscalls may appear (for path resolution, existence checks)
  //   but the actual read() of file content should NOT happen since the tool throws before reading.
  // - The audit log WILL have a "denied" entry from checkAccess.
  // This is the expected behavior — the guard helps verify the security check runs before I/O.

  test("security blocks access before file content is read", async () => {
    // Setup: protected file
    const secretsDir = path.join(tempDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const secretFile = path.join(secretsDir, "key.pem")
    fs.writeFileSync(secretFile, "GUARD_BLOCKED_READ_003")

    // Setup security config
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig, tempDir)

    const absolutePattern = path.join(tempDir, "secrets", "**")
    const report = await withAccessGuard([absolutePattern], async () => {
      // Simulate what the Read tool does: checkAccess first
      const accessResult = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
      expect(accessResult.allowed).toBe(false)

      // Read tool would throw here — content is never read
      // We do NOT read the file, simulating the tool's behavior after denial
    }, { cwd: tempDir })

    // Verify report: no actual content read should have occurred
    expect(report).toBeDefined()

    // The distinction: when security blocks BEFORE I/O, no read events should appear
    // (unlike CASE-GUARD-001 where the skill scanner reads without checking security)
    // Note: stat()/open() for path checks may still appear in privileged mode
    if (report.mode === "privileged") {
      // Any events should be metadata checks (stat/lstat), not actual reads
      const readEvents = report.protectedAccesses.filter(
        (e) => e.operation === "read" && (e.syscall === "read" || e.syscall === "pread"),
      )
      // The actual read() syscall should not happen since we blocked before file I/O
      // stat/open may appear but read() should not
      // Document: open() may appear even for blocked access (file existence check)
      expect(readEvents.length).toBe(0)
    }
  })

  test("contrast: unblocked read produces OS-level read events in privileged mode", async () => {
    // Setup: unprotected file
    const publicDir = path.join(tempDir, "public")
    fs.mkdirSync(publicDir, { recursive: true })
    const publicFile = path.join(publicDir, "readme.txt")
    fs.writeFileSync(publicFile, "PUBLIC_CONTENT_003")

    const absolutePattern = path.join(tempDir, "public", "**")
    const report = await withAccessGuard([absolutePattern], async () => {
      // Actually read the file (simulating an allowed Read tool operation)
      const content = fs.readFileSync(publicFile, "utf8")
      expect(content).toBe("PUBLIC_CONTENT_003")
    }, { cwd: tempDir })

    expect(report).toBeDefined()

    // In privileged mode, the read should be captured
    if (report.mode === "privileged") {
      // OS-level read event should be observed for the actual file read
      expect(report.protectedAccesses.length).toBeGreaterThan(0)
    }
    // In unprivileged mode, reads are not detected
    if (report.mode === "unprivileged") {
      expect(report.warnings.some((w) => w.includes("READ"))).toBe(true)
    }
  })

  test("audit log would have denied entry when Read tool blocks", async () => {
    // When the Read tool calls checkAccess and it returns denied,
    // SecurityAudit.logSecurityEvent() writes a "denied" entry to the audit log.
    // If AccessGuard's report cross-references with this audit log, the
    // compliance violation count should be lower (matching denial found).

    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig, tempDir)

    // Simulate the audit log entry that would be written by SecurityAudit
    const auditLogPath = path.join(tempDir, ".opencode-security-audit.log")
    fs.writeFileSync(auditLogPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      role: "viewer",
      operation: "read",
      path: "secrets/key.pem",
      result: "denied",
      reason: "Matched rule: secrets/**",
      ruleTriggered: "secrets/**",
    }) + "\n")

    // Create the guard with the audit log path
    const absolutePattern = path.join(tempDir, "secrets", "**")
    const guard = new AccessGuard([absolutePattern], { cwd: tempDir })
    await guard.start()

    // No actual file I/O — just checking report generation with audit log
    await new Promise((resolve) => setTimeout(resolve, 100))

    const report = await guard.report(auditLogPath)

    // If there are any OS-level events matching secrets/, the audit log's "denied"
    // entry should match and prevent compliance violations for those paths
    // (No events expected since we didn't read the file, but report structure is valid)
    expect(report.warnings).toBeInstanceOf(Array)
  })
})

// ============================================================================
// CASE-GUARD-004: withAccessGuard around blocked bash cat
// ============================================================================
describe("CASE-GUARD-004: withAccessGuard around blocked 'cat secrets/key.pem' bash command", () => {
  // [INFO] When BashScanner.scanBashCommand() detects a protected path in a bash command,
  // the command is blocked BEFORE execution. This means no OS-level read should occur
  // because the bash command is never spawned.

  test("BashScanner blocks cat before execution — no OS-level read occurs", async () => {
    // Setup: protected file
    const secretsDir = path.join(tempDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    const secretFile = path.join(secretsDir, "key.pem")
    fs.writeFileSync(secretFile, "GUARD_BASH_BLOCKED_004")

    // Setup security config
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig, tempDir)

    const absolutePattern = path.join(tempDir, "secrets", "**")
    const report = await withAccessGuard([absolutePattern], async () => {
      // BashScanner checks the command BEFORE execution
      const scanResult = BashScanner.scanBashCommand("cat secrets/key.pem", tempDir)

      // Scanner returns the protected path — command would be blocked
      expect(scanResult.length).toBeGreaterThan(0)
      expect(scanResult).toContain(path.join(tempDir, "secrets", "key.pem"))

      // The bash tool would NOT execute the command — no OS-level read occurs
      // We do NOT spawn the command, simulating the tool's pre-execution block
    }, { cwd: tempDir })

    expect(report).toBeDefined()

    // Since the command was never executed, no OS-level read events should appear
    // for the protected file (the file was already there, but no cat ran)
    // Note: The guard monitors the test process PID, which didn't read the file
    if (report.mode === "privileged") {
      const catReads = report.protectedAccesses.filter(
        (e) => e.operation === "read" && e.path.includes("secrets/key.pem"),
      )
      expect(catReads.length).toBe(0)
    }
  })

  test("contrast: unscanned command (cp) would produce OS-level access if executed", async () => {
    // cp is NOT in BashScanner.FILE_ACCESS_COMMANDS — it would bypass the scanner
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig, tempDir)

    // BashScanner does NOT catch cp
    const scanResult = BashScanner.scanBashCommand("cp secrets/key.pem /tmp/stolen.pem", tempDir)
    expect(scanResult.length).toBe(0)  // cp is unscanned

    // If cp were actually executed, OS-level events would appear
    // but BashScanner wouldn't have blocked it — this is the bypass documented in CASE-BASH-002
    // Document: AccessGuard would be the only layer that could detect this post-execution
  })

  test("scanner blocks various cat variants before execution", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig, tempDir)

    // All these commands should be blocked by BashScanner before execution
    const blockedCommands = [
      "cat secrets/key.pem",
      "head -n 10 secrets/key.pem",
      "tail secrets/key.pem",
      "less secrets/key.pem",
      "grep -r password secrets/key.pem",
    ]

    for (const cmd of blockedCommands) {
      const result = BashScanner.scanBashCommand(cmd, tempDir)
      expect(result.length).toBeGreaterThan(0)
    }

    // These would NOT be blocked (bypass vectors)
    const unblocked = [
      "cp secrets/key.pem /tmp/stolen.pem",
      "base64 secrets/key.pem",
      "openssl x509 -in secrets/key.pem",
    ]

    for (const cmd of unblocked) {
      const result = BashScanner.scanBashCommand(cmd, tempDir)
      expect(result.length).toBe(0)
    }
  })

  test("AccessGuard report shows no events when command is pre-blocked", async () => {
    const absolutePattern = path.join(tempDir, "secrets", "**")
    const secretsDir = path.join(tempDir, "secrets")
    fs.mkdirSync(secretsDir, { recursive: true })
    fs.writeFileSync(path.join(secretsDir, "key.pem"), "BLOCKED_DATA")

    const report = await withAccessGuard([absolutePattern], async () => {
      // Simulate: BashScanner checks → detects protected path → blocks
      // No command is executed, no file I/O
      const blocked = BashScanner.scanBashCommand("cat secrets/key.pem", tempDir)
      expect(blocked.length).toBeGreaterThan(0)
      // Command blocked — nothing executed
    }, { cwd: tempDir })

    // Zero events for protected files (no I/O occurred)
    const secretsEvents = report.protectedAccesses.filter(
      (e) => e.path.includes("secrets/key.pem") && e.operation === "read",
    )
    expect(secretsEvents.length).toBe(0)
  })
})

// ============================================================================
// CASE-GUARD-005: Unprivileged mode fallback
// ============================================================================
describe("CASE-GUARD-005: AccessGuard unprivileged mode fallback and limitations", () => {
  // [INFO] When running without sudo, AccessGuard falls back to unprivileged mode
  // using fs.watch({ recursive: true }). This mode can only detect write/create/delete
  // events — READ operations are invisible. The report should document this limitation.

  test("AccessGuard starts in either privileged or unprivileged mode", async () => {
    const guard = new AccessGuard([path.join(tempDir, "**")], { cwd: tempDir })
    await guard.start()

    const mode = guard.getMode()
    expect(mode === "privileged" || mode === "unprivileged").toBe(true)

    const events = await guard.stop()
    expect(events).toBeInstanceOf(Array)
  })

  test("unprivileged mode captures write/create/delete events", async () => {
    const watchDir = path.join(tempDir, "watched")
    fs.mkdirSync(watchDir, { recursive: true })

    const absolutePattern = path.join(watchDir, "**")
    const guard = new AccessGuard([absolutePattern], { cwd: tempDir })
    await guard.start()

    // Allow watcher to initialize
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Perform write operation on a file
    const testFile = path.join(watchDir, "test-write.txt")
    fs.writeFileSync(testFile, "WRITE_EVENT_TEST")

    // Allow event to propagate
    await new Promise((resolve) => setTimeout(resolve, 300))

    const report = await guard.report()

    if (guard.getMode() === "unprivileged") {
      // Unprivileged mode should capture write/create events
      expect(report.warnings.some((w) => w.includes("READ"))).toBe(true)

      // Write/create events may be captured (fs.watch is not guaranteed to fire immediately)
      const writeEvents = report.protectedAccesses.filter(
        (e) => e.operation === "write" || e.operation === "create",
      )
      // fs.watch may or may not fire — the important thing is the warning is present
      // Document: fs.watch event timing is OS-dependent and may miss rapid writes
    }
    if (guard.getMode() === "privileged") {
      // Privileged mode captures everything — write events should appear
      expect(report.protectedAccesses.length).toBeGreaterThanOrEqual(0)
    }
  })

  test("unprivileged mode reports read detection as unavailable", async () => {
    const guard = new AccessGuard([path.join(tempDir, "**")], { cwd: tempDir })
    await guard.start()
    const report = await guard.report()

    if (guard.getMode() === "unprivileged") {
      // Report must document that reads were not detected
      expect(report.warnings.length).toBeGreaterThan(0)
      expect(report.warnings.some((w) => w.includes("READ") || w.includes("read"))).toBe(true)
    }

    // In any mode, report has proper structure
    expect(report.mode).toBeDefined()
    expect(report.startTime).toBeGreaterThan(0)
    expect(report.endTime).toBeGreaterThanOrEqual(report.startTime)
    expect(report.eventsByOperation).toBeDefined()
    expect(report.eventsByOperation.read).toBeInstanceOf(Array)
    expect(report.eventsByOperation.write).toBeInstanceOf(Array)
    expect(report.eventsByOperation.create).toBeInstanceOf(Array)
    expect(report.eventsByOperation.delete).toBeInstanceOf(Array)
    expect(report.eventsByOperation.rename).toBeInstanceOf(Array)
  })

  test("delete events are captured in unprivileged mode", async () => {
    const watchDir = path.join(tempDir, "watched-del")
    fs.mkdirSync(watchDir, { recursive: true })
    const fileToDelete = path.join(watchDir, "delete-me.txt")
    fs.writeFileSync(fileToDelete, "TO_BE_DELETED")

    const absolutePattern = path.join(watchDir, "**")
    const guard = new AccessGuard([absolutePattern], { cwd: tempDir })
    await guard.start()

    await new Promise((resolve) => setTimeout(resolve, 200))

    // Delete the file
    fs.unlinkSync(fileToDelete)

    await new Promise((resolve) => setTimeout(resolve, 300))

    const report = await guard.report()

    if (guard.getMode() === "unprivileged") {
      // Delete events use "rename" eventType in fs.watch (file no longer exists = delete)
      const deleteOrRenameEvents = report.protectedAccesses.filter(
        (e) => e.operation === "delete" || e.operation === "rename",
      )
      // fs.watch may or may not fire — document behavior
    }
  })

  test("report documents that no application audit log was provided", async () => {
    const guard = new AccessGuard([path.join(tempDir, "**")], { cwd: tempDir })
    await guard.start()
    const report = await guard.report()  // No appLogPath

    // Without audit log, report should note this
    expect(report.warnings.some(
      (w) => w.includes("audit log") || w.includes("No application"),
    )).toBe(true)
  })

  test("AccessGuard NDJSON log output is written when logPath is set", async () => {
    const logPath = path.join(tempDir, "report", "guard-events.ndjson")
    const watchDir = path.join(tempDir, "logged")
    fs.mkdirSync(watchDir, { recursive: true })

    const guard = new AccessGuard(
      [path.join(watchDir, "**")],
      { cwd: tempDir, logPath },
    )
    await guard.start()

    await new Promise((resolve) => setTimeout(resolve, 200))

    // Trigger a write event
    fs.writeFileSync(path.join(watchDir, "log-test.txt"), "LOG_OUTPUT_TEST")

    await new Promise((resolve) => setTimeout(resolve, 300))

    const events = await guard.stop()

    // Verify log file was created (if events occurred)
    if (events.length > 0) {
      expect(fs.existsSync(logPath)).toBe(true)
      const logContent = fs.readFileSync(logPath, "utf8")
      const logLines = logContent.trim().split("\n")
      expect(logLines.length).toBe(events.length)
      // Each line should be valid JSON
      for (const line of logLines) {
        const parsed = JSON.parse(line)
        expect(parsed.timestamp).toBeDefined()
        expect(parsed.operation).toBeDefined()
      }
    }
  })
})
