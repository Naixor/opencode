/**
 * Reporter
 *
 * Aggregates AccessEvents by path and operation, cross-references with the application
 * security audit log (.opencode-security-audit.log), and produces a MonitorReport
 * with compliance violations.
 *
 * A ComplianceViolation is recorded when the OS observed a filesystem access to a protected
 * path but the application audit log has no corresponding "denied" entry.
 */

import fs from "fs"
import path from "path"
import type { AccessEvent, AccessOperation, AuditLogEntry, ComplianceViolation, MonitorReport } from "./types"

function safeParseJson(line: string): AuditLogEntry | undefined {
  try {
    const parsed = JSON.parse(line)
    if (parsed && typeof parsed === "object" && "path" in parsed) {
      return parsed as AuditLogEntry
    }
    return undefined
  } catch {
    return undefined
  }
}

function loadAuditEntries(logPath: string): AuditLogEntry[] {
  if (!fs.existsSync(logPath)) return []

  const content = fs.readFileSync(logPath, "utf8")
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(safeParseJson)
    .filter((entry): entry is AuditLogEntry => entry !== undefined)
}

function findDeniedEntry(entries: AuditLogEntry[], filePath: string, operation: string): AuditLogEntry | undefined {
  return entries.find(
    (entry) =>
      entry.result === "denied" &&
      (entry.path === filePath || filePath.endsWith(entry.path) || entry.path.endsWith(path.basename(filePath))),
  )
}

function classifyViolationSeverity(event: AccessEvent): "critical" | "high" | "medium" | "low" | "info" {
  if (event.operation === "read" && event.flaggedAsProtected) return "high"
  if (event.operation === "write" && event.flaggedAsProtected) return "critical"
  if (event.operation === "delete" && event.flaggedAsProtected) return "high"
  if (event.operation === "create" && event.flaggedAsProtected) return "medium"
  return "info"
}

export function generateReport(
  events: AccessEvent[],
  startTime: number,
  endTime: number,
  mode: "privileged" | "unprivileged",
  appLogPath?: string,
): MonitorReport {
  const protectedAccesses = events.filter((e) => e.flaggedAsProtected)

  const auditEntries = appLogPath ? loadAuditEntries(appLogPath) : []

  const complianceViolations: ComplianceViolation[] = []
  for (const event of protectedAccesses) {
    const appDeny = findDeniedEntry(auditEntries, event.path, event.operation)
    if (appDeny) continue

    complianceViolations.push({
      event,
      reason: appLogPath
        ? `OS recorded ${event.operation} on protected path "${event.path}" (syscall: ${event.syscall}) but no corresponding denied entry found in application audit log`
        : `OS recorded ${event.operation} on protected path "${event.path}" (syscall: ${event.syscall}) — no application audit log provided for cross-reference`,
      severity: classifyViolationSeverity(event),
      appLogMatch: false,
    })
  }

  const eventsByPath: Record<string, AccessEvent[]> = {}
  for (const event of events) {
    const existing = eventsByPath[event.path] ?? []
    existing.push(event)
    eventsByPath[event.path] = existing
  }

  const eventsByOperation: Record<AccessOperation, AccessEvent[]> = {
    read: [],
    write: [],
    create: [],
    delete: [],
    rename: [],
  }
  for (const event of events) {
    eventsByOperation[event.operation].push(event)
  }

  const warnings: string[] = []
  if (mode === "unprivileged") {
    warnings.push(
      "Running in unprivileged mode: READ operations were NOT detected. Only write/create/delete events are captured.",
    )
  }
  if (!appLogPath) {
    warnings.push("No application audit log path provided. Compliance violations are based on OS observations only.")
  }

  return {
    mode,
    startTime,
    endTime,
    totalEvents: events.length,
    protectedAccesses,
    complianceViolations,
    eventsByPath,
    eventsByOperation,
    warnings,
  }
}

export function writeReport(report: MonitorReport, outputPath: string): void {
  const dir = path.dirname(outputPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2))
}
