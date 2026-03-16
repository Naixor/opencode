import { Log } from "@/util/log"

/** Shared timeout constant (60s) used for grace period, activity timeout, idle timeout, and takeover cooldown. */
export const TIMEOUT = 60_000

const log = Log.create({ service: "lifecycle" })

/** Tracks SSE connection count and supports idle detection for auto-exit. */
export namespace Lifecycle {
  let connections = 0
  let grace: Timer | undefined
  let idle: Timer | undefined
  let exit: (() => Promise<void>) | undefined
  let enabled = false

  /** Number of active SSE connections. */
  export function count() {
    return connections
  }

  /** Enable auto-exit lifecycle (for --mode=auto workers). */
  export function enable(fn: () => Promise<void>) {
    enabled = true
    exit = fn
    resetIdle()
  }

  /** Called when an SSE client connects. */
  export function connect() {
    connections++
    log.info("sse connect", { connections })
    if (grace) {
      clearTimeout(grace)
      grace = undefined
    }
    resetIdle()
  }

  /** Called when an SSE client disconnects. */
  export function disconnect() {
    connections = Math.max(0, connections - 1)
    log.info("sse disconnect", { connections })
    if (connections === 0 && enabled) {
      // Start grace period — if no reconnect within TIMEOUT, exit
      grace = setTimeout(async () => {
        log.info("grace period expired, no clients — exiting")
        await exit?.()
      }, TIMEOUT)
    }
    resetIdle()
  }

  /** Reset the idle watchdog timer (5 minutes). */
  function resetIdle() {
    if (!enabled) return
    if (idle) clearTimeout(idle)
    idle = setTimeout(
      async () => {
        // Only exit if no connections AND no active sessions
        if (connections > 0) {
          resetIdle()
          return
        }
        log.info("idle timeout (5min), no connections — exiting")
        await exit?.()
      },
      5 * 60 * 1000,
    )
  }
}
