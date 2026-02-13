/**
 * Privileged Monitor
 *
 * Spawns `sudo fs_usage -f filesystem -w -p <pid>` to capture all filesystem syscalls
 * for a specific process. Requires root privileges (via sudo).
 *
 * Provides comprehensive read/write/create/delete/rename monitoring at the kernel level.
 */

import { spawn } from "child_process"
import type { ChildProcess } from "child_process"
import type { AccessEvent, MonitorConfig, MonitorHandle } from "./types"
import { parseFsUsageLine } from "./parser"

export function startPrivilegedMonitor(config: MonitorConfig): MonitorHandle {
  const events: AccessEvent[] = []
  const pid = config.pid ?? process.pid

  const args = ["fs_usage", "-f", "filesystem", "-w", "-p", String(pid)]

  let child: ChildProcess | undefined
  let stopped = false

  const ready = new Promise<void>((resolve) => {
    child = spawn("sudo", args, {
      stdio: ["ignore", "pipe", "pipe"],
    })

    let buffer = ""

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.trim()) continue
        const event = parseFsUsageLine(line, config)
        if (event) {
          events.push(event)
        }
      }
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString()
      if (msg.includes("Password:") || msg.includes("sudo:")) {
        // sudo is prompting for password — this should not happen in automated tests
        // if it does, the monitor won't work properly
        console.warn("[access-guard] sudo requires a password — privileged monitoring unavailable")
      }
    })

    child.on("error", (err) => {
      console.warn(`[access-guard] fs_usage failed to start: ${err.message}`)
    })

    // Give fs_usage a moment to attach to the process
    setTimeout(resolve, 200)
  })

  const stopFn = async (): Promise<AccessEvent[]> => {
    if (stopped) return events
    stopped = true

    await ready

    if (child && !child.killed) {
      child.kill("SIGTERM")
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (child && !child.killed) child.kill("SIGKILL")
          resolve()
        }, 3000)

        child!.on("exit", () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }

    return events
  }

  return { stop: stopFn }
}

export async function isPrivilegedAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("sudo", ["-n", "true"], {
      stdio: ["ignore", "ignore", "ignore"],
    })
    child.on("exit", (code) => resolve(code === 0))
    child.on("error", () => resolve(false))
  })
}
