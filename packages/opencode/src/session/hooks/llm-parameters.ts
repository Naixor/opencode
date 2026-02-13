import { Log } from "../../util/log"
import { HookChain } from "./index"

export namespace LLMParameterHooks {
  const log = Log.create({ service: "hooks.llm-parameters" })

  // --- think-mode (PreLLMChain, priority 50) ---
  // Set Claude thinking parameter based on task complexity / variant

  const THINKING_BUDGET_MAX = 32000
  const THINKING_BUDGET_DEFAULT = 16000

  function registerThinkMode(): void {
    HookChain.register("think-mode", "pre-llm", 50, async (ctx) => {
      if (!ctx.variant) return

      // Only apply thinking to Claude models
      if (!ctx.model.includes("claude")) return

      if (ctx.variant === "max") {
        ctx.providerOptions = ctx.providerOptions ?? {}
        ctx.providerOptions.thinking = {
          type: "enabled",
          budgetTokens: THINKING_BUDGET_MAX,
        }
        log.info("think-mode set to max", {
          sessionID: ctx.sessionID,
          thinkingBudget: THINKING_BUDGET_MAX,
        })
        return
      }

      if (ctx.variant === "quick") {
        ctx.providerOptions = ctx.providerOptions ?? {}
        ctx.providerOptions.thinking = {
          type: "disabled",
        }
        log.info("think-mode disabled for quick variant", {
          sessionID: ctx.sessionID,
        })
        return
      }

      // Default variant -> default thinking budget
      ctx.providerOptions = ctx.providerOptions ?? {}
      ctx.providerOptions.thinking = {
        type: "enabled",
        budgetTokens: THINKING_BUDGET_DEFAULT,
      }
      log.info("think-mode set to default", {
        sessionID: ctx.sessionID,
        thinkingBudget: THINKING_BUDGET_DEFAULT,
      })
    })
  }

  // --- anthropic-effort (PreLLMChain, priority 60) ---
  // Set Anthropic effort level based on variant

  const EFFORT_MAP: Record<string, string> = {
    max: "high",
    quick: "low",
  }
  const DEFAULT_EFFORT = "medium"

  function registerAnthropicEffort(): void {
    HookChain.register("anthropic-effort", "pre-llm", 60, async (ctx) => {
      if (!ctx.variant) return

      // Only apply effort to Anthropic/Claude models
      if (!ctx.model.includes("claude")) return

      const effort = EFFORT_MAP[ctx.variant] ?? DEFAULT_EFFORT
      ctx.providerOptions = ctx.providerOptions ?? {}
      ctx.providerOptions.effort = effort
      log.info("anthropic-effort set", {
        sessionID: ctx.sessionID,
        variant: ctx.variant,
        effort,
      })
    })
  }

  // --- Register all LLM parameter hooks ---

  export function register(): void {
    registerThinkMode()
    registerAnthropicEffort()
  }
}
