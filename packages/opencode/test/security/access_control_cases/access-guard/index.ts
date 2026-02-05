// Access Guard — OS-level filesystem monitor
//
// Captures actual macOS syscalls on protected files as ground-truth verification.
// Auto-detects privileged vs unprivileged mode via `sudo -n true`.
//
// Usage:
//   const report = await withAccessGuard(["**/secrets/**"], async () => {
//     // perform operations that may access protected files
//   })
//   expect(report.complianceViolations.length).toBe(0)

import fs from "fs"
import path from "path"
import type { AccessEvent, MonitorConfig, MonitorHandle, MonitorReport } from "./types"
import { isPrivilegedAvailable, startPrivilegedMonitor } from "./privileged-monitor"
import { startUnprivilegedMonitor } from "./unprivileged-monitor"
import { generateReport } from "./reporter"

export class AccessGuard {
  private config: MonitorConfig
  private monitor: MonitorHandle | undefined
  private startTime = 0
  private mode: "privileged" | "unprivileged" = "unprivileged"

  constructor(patterns: string[], options?: { pid?: number; cwd?: string; logPath?: string }) {
    this.config = {
      protectedPatterns: patterns,
      pid: options?.pid,
      cwd: options?.cwd ?? process.cwd(),
      logPath: options?.logPath,
      privileged: false,
    }
  }

  async start(): Promise<void> {
    const privileged = await isPrivilegedAvailable()
    this.mode = privileged ? "privileged" : "unprivileged"
    this.config.privileged = privileged

    this.startTime = Date.now()

    this.monitor = privileged
      ? startPrivilegedMonitor(this.config)
      : startUnprivilegedMonitor(this.config)
  }

  async stop(): Promise<AccessEvent[]> {
    if (!this.monitor) return []

    const events = await this.monitor.stop()

    // Write NDJSON event log
    if (this.config.logPath) {
      const logDir = path.dirname(this.config.logPath)
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true })
      }
      const ndjson = events.map((e: AccessEvent) => JSON.stringify(e)).join("\n")
      fs.writeFileSync(this.config.logPath, ndjson + "\n")
    }

    this.monitor = undefined
    return events
  }

  async report(appLogPath?: string): Promise<MonitorReport> {
    const events = await this.stop()
    return generateReport(events, this.startTime, Date.now(), this.mode, appLogPath)
  }

  getMode(): "privileged" | "unprivileged" {
    return this.mode
  }
}

/**
 * Convenience wrapper: start monitoring, run testFn, stop and return report.
 */
export async function withAccessGuard(
  patterns: string[],
  testFn: () => void | Promise<void>,
  options?: { pid?: number; cwd?: string; logPath?: string; appLogPath?: string },
): Promise<MonitorReport> {
  const guard = new AccessGuard(patterns, options)
  await guard.start()

  try {
    await testFn()
  } finally {
    // Always stop and generate report even if testFn throws
  }

  return guard.report(options?.appLogPath)
}

export { generateReport, writeReport } from "./reporter"
export { parseFsUsageLine, isProtectedPath } from "./parser"
export { isPrivilegedAvailable } from "./privileged-monitor"
export type { AccessEvent, AccessOperation, MonitorConfig, MonitorHandle, MonitorReport, ComplianceViolation, AuditLogEntry } from "./types"
