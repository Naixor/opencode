import { Log } from "../util/log"
import { HookChain } from "../session/hooks"
import { Instance } from "../project/instance"
import { Database } from "../storage/db"
import { LlmLogTable, LlmLogRequestTable, LlmLogResponseTable, LlmLogTokensTable } from "./log.sql"
import { Identifier } from "../id/id"
import { Config } from "../config/config"
import { eq } from "drizzle-orm"

export namespace LlmLogCapture {
  const log = Log.create({ service: "llm-log-capture" })

  // Per-instance state: Map<sessionID, { logId, timeStart }>
  const currentLogState = Instance.state(() => new Map<string, { logId: string; timeStart: number }>())

  export function getCurrentLogId(sessionID: string): string | undefined {
    return currentLogState().get(sessionID)?.logId
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

        currentLogState().set(ctx.sessionID, { logId: llmLogId, timeStart: now })
        log.info("captured pre-llm log", { llmLogId, sessionID: ctx.sessionID, agent: ctx.agent })
      } catch (err) {
        log.error("failed to capture pre-llm log", {
          error: err instanceof Error ? err.message : String(err),
          sessionID: ctx.sessionID,
        })
      }
    })

    HookChain.register("llm-log-response-capture", "session-lifecycle", 999, async (ctx) => {
      if (ctx.event !== "step.finished") return

      const config = await Config.get()
      if (!config.llmLog?.enabled) return

      const logState = currentLogState().get(ctx.sessionID)
      if (!logState) return
      const { logId: llmLogId, timeStart } = logState

      const data = ctx.data as {
        usage: {
          cost: number
          tokens: {
            total: number
            input: number
            output: number
            reasoning: number
            cache: { write: number; read: number }
          }
        }
        finishReason: string
        model: { id: string; cost?: Record<string, any> }
        assistantMessage: { id: string; parts?: any[] }
      }

      const now = Date.now()

      try {
        // Extract completion text and tool calls from assistant message parts
        let completionText = ""
        const toolCalls: Array<{ id: string; name: string; args: any }> = []

        if (data.assistantMessage.parts) {
          for (const part of data.assistantMessage.parts) {
            if (part.type === "text") {
              completionText += part.text ?? ""
            } else if (part.type === "tool-invocation" || part.type === "tool-call") {
              toolCalls.push({
                id: part.toolCallId ?? part.id ?? "",
                name: part.toolName ?? part.name ?? "",
                args: part.args ?? {},
              })
            }
          }
        }

        const status = data.finishReason === "error" ? "error" : data.finishReason === "abort" ? "aborted" : "success"

        const rawResponseData = {
          finishReason: data.finishReason,
          modelId: data.model.id,
        }
        const rawResponse = Bun.gzipSync(Buffer.from(JSON.stringify(rawResponseData)))

        Database.use((db) => {
          db.insert(LlmLogResponseTable)
            .values({
              id: Identifier.ascending("log"),
              llm_log_id: llmLogId,
              completion_text: completionText || null,
              tool_calls: toolCalls.length > 0 ? toolCalls : null,
              raw_response: rawResponse,
              error: status === "error" ? { finishReason: data.finishReason } : null,
            })
            .run()

          db.insert(LlmLogTokensTable)
            .values({
              id: Identifier.ascending("log"),
              llm_log_id: llmLogId,
              input_tokens: data.usage.tokens.input,
              output_tokens: data.usage.tokens.output,
              reasoning_tokens: data.usage.tokens.reasoning,
              cache_read_tokens: data.usage.tokens.cache.read,
              cache_write_tokens: data.usage.tokens.cache.write,
              cost: Math.round(data.usage.cost * 1_000_000),
            })
            .run()

          db.update(LlmLogTable)
            .set({
              time_end: now,
              duration_ms: now - timeStart,
              status,
            })
            .where(eq(LlmLogTable.id, llmLogId))
            .run()
        })

        log.info("captured response log", { llmLogId, sessionID: ctx.sessionID, status })
      } catch (err) {
        log.error("failed to capture response log", {
          error: err instanceof Error ? err.message : String(err),
          sessionID: ctx.sessionID,
          llmLogId,
        })
      }
    })
  }
}
