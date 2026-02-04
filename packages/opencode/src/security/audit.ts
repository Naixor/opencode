import { SecurityConfig } from "./config"
import { Log } from "../util/log"
import crypto from "crypto"
import fs from "fs"

export namespace SecurityAudit {
  const log = Log.create({ service: "security-audit" })

  export interface SecurityEvent {
    role: string
    operation: "read" | "write" | "llm"
    path: string
    allowed: boolean
    reason?: string
    rulePattern?: string
    content?: string
  }

  interface AuditLogEntry {
    timestamp: string
    role: string
    operation: string
    path: string
    result: "allowed" | "denied"
    reason?: string
    ruleTriggered?: string
    contentHash?: string
  }

  const MAX_CONTENT_PREVIEW_LENGTH = 50
  const DEFAULT_LOG_PATH = ".opencode-security-audit.log"

  function getLogPath(): string {
    const config = SecurityConfig.getSecurityConfig()
    return config.logging?.path ?? DEFAULT_LOG_PATH
  }

  function getLogLevel(): "verbose" | "normal" {
    const config = SecurityConfig.getSecurityConfig()
    return config.logging?.level ?? "normal"
  }

  function hashContent(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex").substring(0, 16)
  }

  function truncateContent(content: string): string {
    if (content.length <= MAX_CONTENT_PREVIEW_LENGTH) {
      return content
    }
    return content.substring(0, MAX_CONTENT_PREVIEW_LENGTH) + "..."
  }

  function formatEntry(event: SecurityEvent): AuditLogEntry {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      role: event.role,
      operation: event.operation,
      path: event.path,
      result: event.allowed ? "allowed" : "denied",
    }

    if (event.reason) {
      entry.reason = event.reason
    }

    if (event.rulePattern) {
      entry.ruleTriggered = event.rulePattern
    }

    if (event.content) {
      entry.contentHash = hashContent(event.content)
    }

    return entry
  }

  function shouldLog(event: SecurityEvent): boolean {
    const level = getLogLevel()

    if (level === "verbose") {
      return true
    }

    return !event.allowed
  }

  function appendToLog(entry: AuditLogEntry): void {
    const logPath = getLogPath()
    const line = JSON.stringify(entry) + "\n"

    fs.appendFile(logPath, line, (err) => {
      if (err) {
        log.warn("failed to write audit log entry", { path: logPath, error: err.message })
      }
    })
  }

  export function logSecurityEvent(event: SecurityEvent): void {
    if (!shouldLog(event)) {
      return
    }

    const entry = formatEntry(event)
    appendToLog(entry)

    if (event.allowed) {
      log.debug("security access allowed", {
        role: event.role,
        operation: event.operation,
        path: event.path,
      })
    } else {
      log.info("security access denied", {
        role: event.role,
        operation: event.operation,
        path: event.path,
        reason: event.reason,
      })
    }
  }

  export function createContentSummary(content: string): string {
    const hash = hashContent(content)
    const preview = truncateContent(content.replace(/\s+/g, " "))
    return `[hash:${hash}] ${preview}`
  }
}
