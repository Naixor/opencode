/**
 * Unprivileged Monitor
 *
 * Uses `fs.watch(dir, { recursive: true })` for detecting write/create/delete operations
 * without requiring root privileges.
 *
 * WARNING: READ operations will NOT be detected in unprivileged mode.
 * Only filesystem mutations (write, create, rename, delete) trigger fs.watch events.
 */

import fs from "fs"
import path from "path"
import type { AccessEvent, AccessOperation, MonitorConfig, MonitorHandle } from "./types"
import { isProtectedPath } from "./parser"

function mapWatchEventType(eventType: string, filename: string, watchDir: string): { operation: AccessOperation; path: string } | undefined {
  const fullPath = path.resolve(watchDir, filename)
  const exists = fs.existsSync(fullPath)

  if (eventType === "rename") {
    return {
      operation: exists ? "create" : "delete",
      path: fullPath,
    }
  }

  if (eventType === "change") {
    return {
      operation: "write",
      path: fullPath,
    }
  }

  return undefined
}

export function startUnprivilegedMonitor(config: MonitorConfig): MonitorHandle {
  const events: AccessEvent[] = []
  const watchers: fs.FSWatcher[] = []
  let stopped = false

  console.warn("[access-guard] WARNING: Running in unprivileged mode. READ operations will NOT be detected.")

  const dirs = new Set<string>()
  for (const pattern of config.protectedPatterns) {
    const parts = pattern.split("/")
    const dirParts: string[] = []
    for (const part of parts) {
      if (part.includes("*") || part.includes("?") || part.includes("[")) break
      dirParts.push(part)
    }
    const dir = dirParts.join("/") || (config.cwd ?? process.cwd())
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      dirs.add(dir)
    }
  }

  if (dirs.size === 0 && config.cwd) {
    dirs.add(config.cwd)
  }

  for (const dir of dirs) {
    const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (stopped || !filename) return

      const mapped = mapWatchEventType(eventType, filename, dir)
      if (!mapped) return

      const flaggedAsProtected = isProtectedPath(mapped.path, config.protectedPatterns)

      events.push({
        timestamp: Date.now(),
        pid: process.pid,
        process: "bun",
        syscall: eventType,
        path: mapped.path,
        operation: mapped.operation,
        flaggedAsProtected,
        result: "observed",
      })
    })

    watchers.push(watcher)
  }

  const stopFn = async (): Promise<AccessEvent[]> => {
    if (stopped) return events
    stopped = true

    for (const watcher of watchers) {
      watcher.close()
    }

    // Allow pending events to flush
    await new Promise((resolve) => setTimeout(resolve, 100))

    return events
  }

  return { stop: stopFn }
}
