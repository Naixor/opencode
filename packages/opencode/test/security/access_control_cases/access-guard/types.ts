/**
 * Access Guard Types
 *
 * OS-level filesystem monitor that captures actual macOS syscalls on protected files
 * as ground-truth verification for the security access control system.
 */

export type AccessOperation = "read" | "write" | "rename" | "delete" | "create"

export interface AccessEvent {
  timestamp: number
  pid: number
  process: string
  syscall: string
  path: string
  operation: AccessOperation
  flaggedAsProtected: boolean
  result: "observed" | "error"
}

export interface MonitorConfig {
  protectedPatterns: string[]
  pid?: number
  cwd?: string
  logPath?: string
  privileged: boolean
}

export interface ComplianceViolation {
  event: AccessEvent
  reason: string
  severity: "critical" | "high" | "medium" | "low" | "info"
  appLogMatch: boolean
}

export interface MonitorReport {
  mode: "privileged" | "unprivileged"
  startTime: number
  endTime: number
  totalEvents: number
  protectedAccesses: AccessEvent[]
  complianceViolations: ComplianceViolation[]
  eventsByPath: Record<string, AccessEvent[]>
  eventsByOperation: Record<AccessOperation, AccessEvent[]>
  warnings: string[]
}

export interface AuditLogEntry {
  timestamp: string
  role: string
  operation: string
  path: string
  result: "allowed" | "denied"
  reason?: string
  ruleTriggered?: string
  contentHash?: string
}

export interface MonitorHandle {
  stop(): Promise<AccessEvent[]>
}
