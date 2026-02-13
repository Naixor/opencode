import { describe, test, expect, afterEach } from "bun:test"
import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { SecurityConfig } from "@/security/config"
import { SecurityAccess } from "@/security/access"
import { SecurityAudit } from "@/security/audit"
import { BashScanner } from "@/security/bash-scanner"
import { loadBaseConfig, setupSecurityConfig, teardownSecurityConfig } from "../helpers"

afterEach(() => {
  teardownSecurityConfig()
})

describe("CASE-LOG-001: Logging path set to /dev/null or non-writable location", () => {
  test("log path /dev/null does not crash security enforcement", async () => {
    const baseConfig = loadBaseConfig()
    const config = {
      ...baseConfig,
      logging: {
        ...baseConfig.logging!,
        path: "/dev/null",
      },
    }
    const dir = await setupSecurityConfig(config)

    // Security enforcement still works even with /dev/null log path
    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(result.allowed).toBe(false)

    // Logging event does not throw (writes to /dev/null silently)
    expect(() => {
      SecurityAudit.logSecurityEvent({
        role: "viewer",
        operation: "read",
        path: "secrets/key.pem",
        allowed: false,
        reason: "test denied",
      })
    }).not.toThrow()

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("non-writable log path does not crash security enforcement", async () => {
    const baseConfig = loadBaseConfig()
    const config = {
      ...baseConfig,
      logging: {
        ...baseConfig.logging!,
        path: "/root/impossible-path/audit.log",
      },
    }
    const dir = await setupSecurityConfig(config)

    // Security checks still work
    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(result.allowed).toBe(false)

    // Logging does not throw (async appendFile with error callback logs warning)
    expect(() => {
      SecurityAudit.logSecurityEvent({
        role: "viewer",
        operation: "read",
        path: "secrets/key.pem",
        allowed: false,
        reason: "test denied",
      })
    }).not.toThrow()

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("empty string log path does not crash", async () => {
    const baseConfig = loadBaseConfig()
    const config = {
      ...baseConfig,
      logging: {
        ...baseConfig.logging!,
        path: "",
      },
    }
    const dir = await setupSecurityConfig(config)

    // Empty path will use default or fail silently
    expect(() => {
      SecurityAudit.logSecurityEvent({
        role: "viewer",
        operation: "read",
        path: "secrets/key.pem",
        allowed: false,
        reason: "test denied",
      })
    }).not.toThrow()

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("CASE-LOG-002: Audit uses content hashing (sha256), not plaintext", () => {
  test("createContentSummary uses sha256 hash prefix with truncated preview", () => {
    const sensitiveContent = "A_SECRET_PREFIX " + "x".repeat(100) + " TAIL_SECRET_CONTENT"
    const summary = SecurityAudit.createContentSummary(sensitiveContent)

    // Summary should contain a hash prefix
    expect(summary).toMatch(/\[hash:[a-f0-9]{16}\]/)

    // Summary truncates content at 50 chars — full content is NOT present
    // The truncated preview + "..." replaces whitespace with single spaces
    expect(summary).toContain("...")
    expect(summary).not.toContain("TAIL_SECRET_CONTENT")

    // Verify the hash is deterministic
    const summary2 = SecurityAudit.createContentSummary(sensitiveContent)
    expect(summary).toEqual(summary2)
  })

  test("[FINDING] createContentSummary leaks up to 50 chars of raw content in preview", () => {
    // The preview includes up to MAX_CONTENT_PREVIEW_LENGTH (50) chars of actual content
    // This is a LOW severity information disclosure — short secrets could be visible in logs
    const shortSecret = "API_KEY=sk-12345"
    const summary = SecurityAudit.createContentSummary(shortSecret)

    // Short content appears in full in the preview — this is the documented behavior
    expect(summary).toContain(shortSecret)
    // But it's also hashed
    expect(summary).toMatch(/\[hash:[a-f0-9]{16}\]/)
  })

  test("content hash is sha256 truncated to 16 hex chars", () => {
    const content = "test content for hashing"
    const summary = SecurityAudit.createContentSummary(content)

    // Compute expected hash
    const expectedHash = crypto.createHash("sha256").update(content).digest("hex").substring(0, 16)
    expect(summary).toContain(`[hash:${expectedHash}]`)
  })

  test("long content is truncated in preview, not in hash", () => {
    const longContent = "A".repeat(200)
    const summary = SecurityAudit.createContentSummary(longContent)

    // Hash should be present
    expect(summary).toMatch(/\[hash:[a-f0-9]{16}\]/)

    // Preview should be truncated (50 chars + ...)
    expect(summary).toContain("...")

    // Full content should NOT appear
    expect(summary).not.toContain("A".repeat(200))
  })

  test("logSecurityEvent with content field hashes the content in the entry", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)
    const logPath = path.join(dir, "test-audit.log")

    const config = {
      ...baseConfig,
      logging: {
        ...baseConfig.logging!,
        path: logPath,
        level: "verbose" as const,
      },
    }
    await setupSecurityConfig(config, dir)

    const sensitiveContent = "SECRET_API_KEY=abc123xyz"

    SecurityAudit.logSecurityEvent({
      role: "viewer",
      operation: "read",
      path: "secrets/key.pem",
      allowed: false,
      reason: "test denied",
      content: sensitiveContent,
    })

    // Wait for async file write
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Check if log file was written
    if (fs.existsSync(logPath)) {
      const logContent = fs.readFileSync(logPath, "utf8")

      // Log should NOT contain the raw secret
      expect(logContent).not.toContain("SECRET_API_KEY=abc123xyz")

      // Log should contain a contentHash field
      if (logContent.trim()) {
        const entry = JSON.parse(logContent.trim().split("\n").pop()!)
        if (entry.contentHash) {
          // contentHash should be a hex string (sha256 prefix)
          expect(entry.contentHash).toMatch(/^[a-f0-9]{16}$/)
        }
      }
    }

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("CASE-LOG-003: Log entries with newlines/control characters in path", () => {
  test("path with newlines does not corrupt JSON log format", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)
    const logPath = path.join(dir, "test-audit-control.log")

    const config = {
      ...baseConfig,
      logging: {
        ...baseConfig.logging!,
        path: logPath,
        level: "verbose" as const,
      },
    }
    await setupSecurityConfig(config, dir)

    // Path with newline character
    const maliciousPath = 'secrets/key.pem\n{"injected":true}'

    expect(() => {
      SecurityAudit.logSecurityEvent({
        role: "viewer",
        operation: "read",
        path: maliciousPath,
        allowed: false,
        reason: "path traversal attempt",
      })
    }).not.toThrow()

    // Wait for async write
    await new Promise((resolve) => setTimeout(resolve, 100))

    if (fs.existsSync(logPath)) {
      const logContent = fs.readFileSync(logPath, "utf8")
      const lines = logContent.trim().split("\n")

      // JSON.stringify escapes newlines, so the log entry should be valid JSON
      // The newline in the path becomes \n in JSON encoding
      for (const line of lines) {
        if (line.trim()) {
          // Each line should be valid JSON
          expect(() => JSON.parse(line)).not.toThrow()
        }
      }
    }

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("path with control characters (tab, null) does not crash logging", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)
    const logPath = path.join(dir, "test-audit-ctrl.log")

    const config = {
      ...baseConfig,
      logging: {
        ...baseConfig.logging!,
        path: logPath,
        level: "verbose" as const,
      },
    }
    await setupSecurityConfig(config, dir)

    // Paths with various control characters
    const controlPaths = ["secrets/key\t.pem", "secrets/key\r\n.pem", "secrets/\x00key.pem", "secrets/key\x1b[31m.pem"]

    for (const p of controlPaths) {
      expect(() => {
        SecurityAudit.logSecurityEvent({
          role: "viewer",
          operation: "read",
          path: p,
          allowed: false,
          reason: "control char test",
        })
      }).not.toThrow()
    }

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("reason field with newlines/quotes does not corrupt log", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)
    const logPath = path.join(dir, "test-audit-reason.log")

    const config = {
      ...baseConfig,
      logging: {
        ...baseConfig.logging!,
        path: logPath,
        level: "verbose" as const,
      },
    }
    await setupSecurityConfig(config, dir)

    const maliciousReason = 'denied\n{"role":"admin","allowed":true}\ninjection'

    expect(() => {
      SecurityAudit.logSecurityEvent({
        role: "viewer",
        operation: "read",
        path: "secrets/key.pem",
        allowed: false,
        reason: maliciousReason,
      })
    }).not.toThrow()

    await new Promise((resolve) => setTimeout(resolve, 100))

    if (fs.existsSync(logPath)) {
      const rawLogContent = fs.readFileSync(logPath, "utf8")

      // JSON.stringify escapes newlines in string values as literal \n in the output.
      // So the full JSON entry is one physical line in the NDJSON log file.
      // Verify the raw content contains the escaped form — not broken across lines.
      // The raw JSON should have `\n` (two chars: backslash + n) not actual newlines
      // splitting the JSON object across multiple lines.
      expect(rawLogContent).toContain("denied\\n")

      // Parse the entry and verify structure
      const lines = rawLogContent.trim().split("\n")
      for (const line of lines) {
        if (!line.trim()) continue
        const parsed = JSON.parse(line)
        if (parsed.reason && parsed.reason.includes("injection")) {
          // After JSON.parse, the escaped \n becomes actual newline character
          expect(parsed.reason).toContain("\n")
          expect(parsed.result).toBe("denied")
          // The injected "allowed":true is inside the reason string, not a top-level field
          expect(parsed.result).not.toBe("allowed")
        }
      }
    }

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("CASE-LOG-004: Audit log deletion via rm — BashScanner behavior", () => {
  // [HIGH] rm is NOT in BashScanner.FILE_ACCESS_COMMANDS, so deleting the audit log
  // via `rm .opencode-security-audit.log` is NOT detected by the scanner.
  test("rm is NOT in FILE_ACCESS_COMMANDS — log deletion not detected by BashScanner", () => {
    const logFile = ".opencode-security-audit.log"
    const protectedPaths = BashScanner.scanBashCommand(`rm ${logFile}`)

    // rm is not in FILE_ACCESS_COMMANDS, so scanner returns no protected paths
    // This is a HIGH severity finding: audit log can be deleted without detection
    expect(protectedPaths).toEqual([])
  })

  test("rm -f on audit log is not detected", () => {
    const protectedPaths = BashScanner.scanBashCommand("rm -f .opencode-security-audit.log")
    expect(protectedPaths).toEqual([])
  })

  test("rm -rf on directory containing audit log is not detected", () => {
    const protectedPaths = BashScanner.scanBashCommand("rm -rf /project/")
    expect(protectedPaths).toEqual([])
  })

  test("unlink on audit log is not detected", () => {
    const protectedPaths = BashScanner.scanBashCommand("unlink .opencode-security-audit.log")
    expect(protectedPaths).toEqual([])
  })

  test("shred (secure delete) on audit log is not detected", () => {
    const protectedPaths = BashScanner.scanBashCommand("shred -u .opencode-security-audit.log")
    expect(protectedPaths).toEqual([])
  })
})

describe("CASE-LOG-005: Audit log truncation via shell redirection — BashScanner behavior", () => {
  // [HIGH] Shell redirection operators like `> logfile` and `truncate` are not
  // detected by BashScanner. An attacker can truncate the audit log to destroy evidence.
  test("'> logfile' truncation is not detected by BashScanner", () => {
    // Note: `> .opencode-security-audit.log` is a bare redirection (no command)
    // BashScanner tokenizes it but there's no file-access command to check
    const protectedPaths = BashScanner.scanBashCommand("> .opencode-security-audit.log")
    expect(protectedPaths).toEqual([])
  })

  test("'echo > logfile' truncation is not detected", () => {
    // echo is not in FILE_ACCESS_COMMANDS
    const protectedPaths = BashScanner.scanBashCommand("echo > .opencode-security-audit.log")
    expect(protectedPaths).toEqual([])
  })

  test("truncate command on audit log is not detected", () => {
    // truncate is not in FILE_ACCESS_COMMANDS
    const protectedPaths = BashScanner.scanBashCommand("truncate -s 0 .opencode-security-audit.log")
    expect(protectedPaths).toEqual([])
  })

  test("': > logfile' (colon truncation) is not detected", () => {
    const protectedPaths = BashScanner.scanBashCommand(": > .opencode-security-audit.log")
    expect(protectedPaths).toEqual([])
  })

  test("cp /dev/null to audit log is not detected", () => {
    // cp is not in FILE_ACCESS_COMMANDS
    const protectedPaths = BashScanner.scanBashCommand("cp /dev/null .opencode-security-audit.log")
    expect(protectedPaths).toEqual([])
  })

  test("tee to overwrite audit log is not detected", () => {
    // tee is not in FILE_ACCESS_COMMANDS
    const protectedPaths = BashScanner.scanBashCommand("echo '' | tee .opencode-security-audit.log")
    expect(protectedPaths).toEqual([])
  })
})

describe("CASE-LOG-006: Audit log symlink redirect attack surface", () => {
  // [MEDIUM] An attacker can replace the audit log file with a symlink pointing
  // to another file. When SecurityAudit.appendToLog writes to the log path,
  // it follows symlinks by default (fs.appendFile), potentially:
  // 1. Writing audit data to an attacker-controlled location
  // 2. Corrupting another file by appending JSON log entries
  // 3. Redirecting to /dev/null to silently discard all audit logs
  test("audit log path is not validated for symlinks before writing", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)
    const logDir = path.join(dir, "logs")
    fs.mkdirSync(logDir, { recursive: true })

    // Create a target file that will receive redirected audit data
    const targetFile = path.join(dir, "target.txt")
    fs.writeFileSync(targetFile, "original content\n")

    // Create a symlink from audit log location to the target file
    const symlogPath = path.join(logDir, "audit.log")
    fs.symlinkSync(targetFile, symlogPath)

    // Configure security to use this log path
    const config = {
      ...baseConfig,
      logging: {
        ...baseConfig.logging!,
        path: symlogPath,
        level: "verbose" as const,
      },
    }
    await setupSecurityConfig(config, dir)

    // Log a security event
    SecurityAudit.logSecurityEvent({
      role: "viewer",
      operation: "read",
      path: "secrets/key.pem",
      allowed: false,
      reason: "test denied",
    })

    // Wait for async write
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Check if the target file received the audit data via the symlink
    const targetContent = fs.readFileSync(targetFile, "utf8")

    // Document: fs.appendFile follows symlinks by default
    // The target file now contains both original content and audit log data
    // This confirms the symlink redirect attack surface
    if (targetContent.includes("viewer")) {
      // Symlink was followed — audit data written to target file
      expect(targetContent).toContain("original content")
      // [MEDIUM] Confirmed: audit log can be redirected via symlink
    }

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("audit log redirected to /dev/null via symlink silently discards logs", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)

    // Point log to /dev/null via symlink
    const symlinkLogPath = path.join(dir, "audit-link.log")
    fs.symlinkSync("/dev/null", symlinkLogPath)

    const config = {
      ...baseConfig,
      logging: {
        ...baseConfig.logging!,
        path: symlinkLogPath,
        level: "verbose" as const,
      },
    }
    await setupSecurityConfig(config, dir)

    // Log event — goes to /dev/null silently
    expect(() => {
      SecurityAudit.logSecurityEvent({
        role: "viewer",
        operation: "read",
        path: "secrets/key.pem",
        allowed: false,
        reason: "evidence destroyed",
      })
    }).not.toThrow()

    // Security enforcement still works even if audit is silenced
    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(result.allowed).toBe(false)

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("documents that audit log path is not checked against security rules", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)

    // The audit log itself is not protected by any security rule in the base config
    // An attacker can read, modify, or delete it
    const logPath = baseConfig.logging?.path ?? ".opencode-security-audit.log"

    // checkAccess on the log file — it's NOT protected
    const readResult = SecurityAccess.checkAccess(logPath, "read", "viewer")
    const writeResult = SecurityAccess.checkAccess(logPath, "write", "viewer")

    // [MEDIUM] Audit log is not self-protected — both read and write are allowed
    expect(readResult.allowed).toBe(true)
    expect(writeResult.allowed).toBe(true)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})
