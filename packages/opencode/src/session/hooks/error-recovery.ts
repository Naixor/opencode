import { Log } from "../../util/log"
import { HookChain } from "./index"

export namespace ErrorRecoveryHooks {
  const log = Log.create({ service: "hooks.error-recovery" })

  // --- Edit error recovery (PostToolChain, priority 100) ---
  // Detects edit tool failures and injects recovery guidance

  const EDIT_ERROR_PATTERNS = [
    {
      match: "oldString not found",
      message:
        "RECOVERY: The oldString was not found in the file. Re-read the file to get the exact current content, then retry with the correct oldString that matches exactly (including whitespace and indentation).",
    },
    {
      match: "Found multiple matches",
      message:
        "RECOVERY: The oldString matched multiple locations. Provide more surrounding context lines in oldString to uniquely identify the correct match.",
    },
    {
      match: "oldString and newString must be different",
      message:
        "RECOVERY: oldString and newString are identical. Ensure newString contains the actual changes you want to make.",
    },
  ]

  function registerEditErrorRecovery(): void {
    HookChain.register("edit-error-recovery", "post-tool", 100, async (ctx) => {
      if (ctx.toolName !== "edit") return
      const output = ctx.result.output
      for (const pattern of EDIT_ERROR_PATTERNS) {
        if (output.includes(pattern.match)) {
          ctx.result.output = output + "\n\n" + pattern.message
          log.info("edit error recovery injected", { pattern: pattern.match, sessionID: ctx.sessionID })
          return
        }
      }
    })
  }

  // --- Context window limit recovery (SessionLifecycleChain, priority 10) ---
  // On context_window_exceeded error, signals compaction before retry

  function registerContextWindowLimitRecovery(): void {
    HookChain.register("context-window-limit-recovery", "session-lifecycle", 10, async (ctx) => {
      if (ctx.event !== "session.error") return
      const errorData = ctx.data as { error?: { name?: string; data?: { message?: string } } } | undefined
      const errorName = errorData?.error?.name
      const errorMessage = errorData?.error?.data?.message ?? ""
      if (errorName === "APIError" && errorMessage.includes("context_window_exceeded")) {
        ctx.data = {
          ...ctx.data,
          recovery: "compact",
          message: "Context window exceeded. Triggering compaction before retry.",
        }
        log.info("context window limit recovery triggered", { sessionID: ctx.sessionID })
      }
    })
  }

  // --- Delegate task retry (PostToolChain, priority 200) ---
  // On delegate_task failure, injects retry guidance with exponential backoff hint

  function registerDelegateTaskRetry(): void {
    HookChain.register("delegate-task-retry", "post-tool", 200, async (ctx) => {
      if (ctx.toolName !== "delegate_task" && ctx.toolName !== "task") return
      const output = ctx.result.output
      const isFailure =
        output.includes("Error") ||
        output.includes("error") ||
        output.includes("failed") ||
        output.includes("Failed") ||
        output.includes("timed out") ||
        output.includes("Timed out")
      if (!isFailure) return

      const retryCount = (ctx.result.metadata as { retryCount?: number } | undefined)?.retryCount ?? 0
      if (retryCount >= 1) {
        ctx.result.output =
          output + "\n\nRECOVERY: Delegate task has failed after retry. Consider an alternative approach or investigate the root cause."
        log.info("delegate task retry exhausted", { sessionID: ctx.sessionID, retryCount })
        return
      }

      const delay = 1000 * Math.pow(2, retryCount) // 1s first, 2s second
      ctx.result.output =
        output +
        `\n\nRECOVERY: Delegate task failed. Retry recommended after ${delay}ms delay. This is retry attempt ${retryCount + 1} of 2.`
      ctx.result.metadata = { ...(ctx.result.metadata as Record<string, unknown> | undefined), retryCount: retryCount + 1 }
      log.info("delegate task retry suggested", { sessionID: ctx.sessionID, delay, retryCount: retryCount + 1 })
    })
  }

  // --- Iterative error recovery (PostToolChain, priority 300) ---
  // Detects repeated identical error patterns (3+ occurrences), injects corrective guidance

  const errorHistory = new Map<string, Map<string, number>>()

  export function resetErrorHistory(): void {
    errorHistory.clear()
  }

  function getErrorKey(output: string): string {
    // Normalize error output to detect repeated patterns
    // Extract first line or first 200 chars as the error signature
    const firstLine = output.split("\n")[0] ?? ""
    return firstLine.slice(0, 200).trim()
  }

  function registerIterativeErrorRecovery(): void {
    HookChain.register("iterative-error-recovery", "post-tool", 300, async (ctx) => {
      const output = ctx.result.output
      // Only track outputs that look like errors
      const isError =
        output.includes("Error") ||
        output.includes("error:") ||
        output.includes("failed") ||
        output.includes("FAILED") ||
        output.includes("not found") ||
        output.includes("denied")
      if (!isError) return

      const key = getErrorKey(output)
      if (!key) return

      const sessionErrors = errorHistory.get(ctx.sessionID) ?? new Map<string, number>()
      const count = (sessionErrors.get(key) ?? 0) + 1
      sessionErrors.set(key, count)
      errorHistory.set(ctx.sessionID, sessionErrors)

      if (count >= 3) {
        ctx.result.output =
          output +
          `\n\nRECOVERY: This same error has occurred ${count} times. You appear to be in a loop. Stop and reconsider your approach. Try: 1) Re-read the relevant file(s) to get fresh context. 2) Use a different strategy. 3) If stuck, explain the problem and ask for guidance.`
        log.info("iterative error recovery triggered", { sessionID: ctx.sessionID, count, errorKey: key })
      }
    })
  }

  // --- Register all error recovery hooks ---

  export function register(): void {
    registerEditErrorRecovery()
    registerContextWindowLimitRecovery()
    registerDelegateTaskRetry()
    registerIterativeErrorRecovery()
  }
}
