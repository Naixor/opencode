import { Log } from "../../util/log"
import { HookChain } from "./index"
import { Todo } from "../todo"

export namespace AgentEnforcementHooks {
  const log = Log.create({ service: "hooks.agent-enforcement" })

  // --- Per-session stop signal tracking ---

  const stopSignals = new Map<string, boolean>()

  export function resetStopSignals(): void {
    stopSignals.clear()
  }

  function hasStopSignal(sessionID: string): boolean {
    return stopSignals.get(sessionID) === true
  }

  // --- todo-continuation-enforcer (SessionLifecycleChain, priority 200) ---
  // When agent stops with incomplete todos, inject continuation prompt

  function registerTodoContinuationEnforcer(): void {
    HookChain.register("todo-continuation-enforcer", "session-lifecycle", 200, async (ctx) => {
      if (ctx.event !== "agent.stopped") return

      // Check if stop signal was received for this session
      if (hasStopSignal(ctx.sessionID)) {
        log.info("todo-continuation-enforcer skipped due to stop signal", { sessionID: ctx.sessionID })
        return
      }

      const todos = await Todo.get(ctx.sessionID)
      const incomplete = todos.filter(
        (t) => t.status !== "completed" && t.status !== "cancelled",
      )

      if (incomplete.length === 0) return

      const data = ctx.data as Record<string, unknown> | undefined
      ctx.data = {
        ...data,
        continuation: true,
        message: `You have ${incomplete.length} incomplete task${incomplete.length === 1 ? "" : "s"} remaining. Please continue working on them:\n${incomplete.map((t) => `- [${t.status}] ${t.content}`).join("\n")}`,
      }
      log.info("todo-continuation-enforcer triggered", {
        sessionID: ctx.sessionID,
        incompleteTodos: incomplete.length,
      })
    })
  }

  // --- stop-continuation-guard (SessionLifecycleChain, priority 190) ---
  // Detect explicit stop signal from user, prevent todo-continuation-enforcer from triggering

  function registerStopContinuationGuard(): void {
    HookChain.register("stop-continuation-guard", "session-lifecycle", 190, async (ctx) => {
      if (ctx.event !== "agent.stopped") return

      const data = ctx.data as { userStop?: boolean } | undefined
      if (!data?.userStop) return

      stopSignals.set(ctx.sessionID, true)
      log.info("stop-continuation-guard activated", { sessionID: ctx.sessionID })
    })
  }

  // --- subagent-question-blocker (PreToolChain, priority 100) ---
  // When agent is subagent, block question tool calls

  function registerSubagentQuestionBlocker(): void {
    HookChain.register("subagent-question-blocker", "pre-tool", 100, async (ctx) => {
      if (ctx.toolName !== "question") return

      // Check if the current agent is a subagent
      // The agent field in PreToolContext carries the agent name
      // We check ctx.args._isSubagent which can be set by the caller
      // or we check the agent mode from context
      const isSubagent = (ctx.args._isSubagent as boolean | undefined) === true

      if (!isSubagent) return

      ctx.args._blocked = true
      ctx.args._blockedMessage = "Proceed autonomously without asking questions. You are operating as a sub-agent and cannot ask interactive questions."
      log.info("subagent-question-blocker triggered", {
        sessionID: ctx.sessionID,
        agent: ctx.agent,
      })
    })
  }

  // --- Register all enforcement hooks ---

  export function register(): void {
    registerStopContinuationGuard()
    registerTodoContinuationEnforcer()
    registerSubagentQuestionBlocker()
  }
}
