import { Log } from "../../util/log"
import { HookChain } from "./index"
import { SessionStatus } from "../status"

export namespace SessionLifecycleHooks {
  const log = Log.create({ service: "hooks.session-lifecycle" })

  // --- session-recovery (SessionLifecycleChain, priority 10) ---
  // On session start, check for crashed previous session (status stuck 'busy'), offer to resume

  function registerSessionRecovery(): void {
    HookChain.register("session-recovery", "session-lifecycle", 10, async (ctx) => {
      if (ctx.event !== "session.created") return

      const statuses = SessionStatus.list()
      const stuck: Array<{ sessionID: string }> = []
      for (const [sessionID, status] of Object.entries(statuses)) {
        if (status.type === "busy" && sessionID !== ctx.sessionID) {
          stuck.push({ sessionID })
        }
      }

      if (stuck.length === 0) return

      const data = ctx.data as Record<string, unknown> | undefined
      ctx.data = {
        ...data,
        recovery: true,
        stuckSessions: stuck.map((s) => s.sessionID),
        message: `Found ${stuck.length} session${stuck.length === 1 ? "" : "s"} with status 'busy' that may have crashed. Session${stuck.length === 1 ? "" : "s"}: ${stuck.map((s) => s.sessionID).join(", ")}. Consider resuming or cleaning up.`,
      }
      log.info("session-recovery detected stuck sessions", {
        sessionID: ctx.sessionID,
        stuckCount: stuck.length,
        stuckSessions: stuck.map((s) => s.sessionID),
      })
    })
  }

  // --- session-notification (SessionLifecycleChain, priority 300) ---
  // Platform-native notifications on task completion

  type NotificationConfig = {
    enabled: boolean
    sound: boolean
  }

  let notificationConfig: NotificationConfig = { enabled: true, sound: true }

  export function configureNotification(config: Partial<NotificationConfig>): void {
    notificationConfig = { ...notificationConfig, ...config }
  }

  export function getNotificationConfig(): NotificationConfig {
    return { ...notificationConfig }
  }

  // Track notifications sent for testing
  const notificationLog: Array<{ platform: string; title: string; message: string }> = []

  export function getNotificationLog(): ReadonlyArray<{ platform: string; title: string; message: string }> {
    return notificationLog
  }

  export function resetNotificationLog(): void {
    notificationLog.length = 0
  }

  async function sendNotification(title: string, message: string): Promise<void> {
    if (!notificationConfig.enabled) return

    const platform = process.platform
    const entry = { platform, title, message }
    notificationLog.push(entry)

    if (platform === "darwin") {
      const soundClause = notificationConfig.sound ? ' sound name "Submarine"' : ""
      const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"${soundClause}`
      const proc = Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" })
      await proc.exited.catch(() => {})
      log.info("notification sent via osascript", { title })
      return
    }

    if (platform === "linux") {
      const args = ["notify-send", title, message]
      const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" })
      await proc.exited.catch(() => {})
      log.info("notification sent via notify-send", { title })
      return
    }

    log.info("notification skipped, unsupported platform", { platform, title })
  }

  function registerSessionNotification(): void {
    HookChain.register("session-notification", "session-lifecycle", 300, async (ctx) => {
      if (ctx.event !== "agent.stopped") return

      await sendNotification("OpenCode", `Agent ${ctx.agent ?? "unknown"} has completed its task.`)
    })
  }

  // --- unstable-agent-babysitter (SessionLifecycleChain, priority 250) ---
  // Count consecutive failures per agent. After 3, inject diagnostic guidance

  const failureCounts = new Map<string, Map<string, number>>()

  export function resetFailureCounts(): void {
    failureCounts.clear()
  }

  export function getFailureCount(sessionID: string, agent: string): number {
    return failureCounts.get(sessionID)?.get(agent) ?? 0
  }

  function registerUnstableAgentBabysitter(): void {
    HookChain.register("unstable-agent-babysitter", "session-lifecycle", 250, async (ctx) => {
      const agent = ctx.agent ?? "unknown"
      const sessionCounts = failureCounts.get(ctx.sessionID) ?? new Map<string, number>()

      if (ctx.event === "agent.error") {
        const count = (sessionCounts.get(agent) ?? 0) + 1
        sessionCounts.set(agent, count)
        failureCounts.set(ctx.sessionID, sessionCounts)

        if (count >= 3) {
          const data = ctx.data as Record<string, unknown> | undefined
          ctx.data = {
            ...data,
            diagnostic: true,
            message: `Agent '${agent}' has failed ${count} consecutive times. Diagnostic guidance: 1) Check if the agent's model is available and responding. 2) Review recent error messages for patterns. 3) Consider switching to a different agent or model. 4) Check rate limits and API key validity.`,
          }
          log.info("unstable-agent-babysitter triggered", {
            sessionID: ctx.sessionID,
            agent,
            consecutiveFailures: count,
          })
        }
        return
      }

      // On non-error events from same agent, reset counter (success resets failures)
      if (ctx.event === "agent.stopped") {
        if (sessionCounts.has(agent)) {
          sessionCounts.set(agent, 0)
          failureCounts.set(ctx.sessionID, sessionCounts)
        }
      }
    })
  }

  // --- Register all session lifecycle hooks ---

  export function register(): void {
    registerSessionRecovery()
    registerSessionNotification()
    registerUnstableAgentBabysitter()
  }
}
