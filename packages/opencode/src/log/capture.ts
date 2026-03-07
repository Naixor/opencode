import { Log } from "../util/log"
import { HookChain } from "../session/hooks"
import { Instance } from "../project/instance"
import { Database } from "../storage/db"
import { LlmLogTable, LlmLogRequestTable } from "./log.sql"
import { Identifier } from "../id/id"
import { Config } from "../config/config"

export namespace LlmLogCapture {
  const log = Log.create({ service: "llm-log-capture" })

  // Per-instance state: Map<sessionID, currentLlmLogId>
  const currentLogId = Instance.state(() => new Map<string, string>())

  export function getCurrentLogId(sessionID: string): string | undefined {
    return currentLogId().get(sessionID)
  }

  export function register(): void {
    HookChain.register("llm-log-capture", "pre-llm", 999, async (ctx) => {
      const config = await Config.get()
      if (!config.llmLog?.enabled) return

      const llmLogId = Identifier.ascending("log")
      const now = Date.now()

      try {
        const systemPrompt = Bun.gzipSync(Buffer.from(ctx.system.join("\n")))
        const messages = Bun.gzipSync(Buffer.from(JSON.stringify(ctx.messages)))

        Database.use((db) => {
          db.insert(LlmLogTable)
            .values({
              id: llmLogId,
              session_id: ctx.sessionID,
              agent: ctx.agent,
              model: ctx.model,
              provider: ctx.model.split("/")[0] ?? ctx.model,
              variant: ctx.variant ?? null,
              status: "pending",
              time_start: now,
            })
            .run()

          db.insert(LlmLogRequestTable)
            .values({
              id: Identifier.ascending("log"),
              llm_log_id: llmLogId,
              system_prompt: systemPrompt,
              messages: messages,
              tools: ctx.providerOptions ?? null,
              options: ctx.providerOptions ?? null,
            })
            .run()
        })

        currentLogId().set(ctx.sessionID, llmLogId)
        log.info("captured pre-llm log", { llmLogId, sessionID: ctx.sessionID, agent: ctx.agent })
      } catch (err) {
        log.error("failed to capture pre-llm log", {
          error: err instanceof Error ? err.message : String(err),
          sessionID: ctx.sessionID,
        })
      }
    })
  }
}
