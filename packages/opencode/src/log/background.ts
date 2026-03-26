import { Log } from "../util/log"
import { Database, eq } from "../storage/db"
import { LlmLogTable, LlmLogRequestTable, LlmLogResponseTable, LlmLogTokensTable } from "./log.sql"
import { Identifier } from "../id/id"
import { Config } from "../config/config"

const log = Log.create({ service: "llm-log-background" })

/**
 * Capture a background/internal LLM call (not going through the session hook pipeline).
 *
 * Used by memory extractor, recall agent, and other internal LLM calls
 * to ensure all LLM communication is visible in log-viewer.
 *
 * Returns helpers to record the response after the call completes.
 */
export async function captureBackground(opts: {
  sessionID: string
  agent: string
  model: string
  system: string
  messages: unknown[]
}): Promise<{ id: string; done: (result: BackgroundResult) => void } | undefined> {
  const config = await Config.get()
  if (config.llmLog?.enabled === false) return undefined

  const id = Identifier.ascending("log")
  const now = Date.now()

  try {
    const system = Bun.gzipSync(Buffer.from(opts.system))
    const messages = Bun.gzipSync(Buffer.from(JSON.stringify(opts.messages)))
    const provider = opts.model.split("/")[0] ?? opts.model

    Database.use((db) => {
      db.insert(LlmLogTable)
        .values({
          id,
          session_id: opts.sessionID,
          agent: opts.agent,
          model: opts.model,
          provider,
          variant: "background",
          status: "pending",
          time_start: now,
        })
        .run()

      db.insert(LlmLogRequestTable)
        .values({
          id: Identifier.ascending("log"),
          llm_log_id: id,
          system_prompt: system,
          messages,
          tools: null,
          options: null,
        })
        .run()
    })

    log.info("captured background llm call", { id, agent: opts.agent })

    return {
      id,
      done: (result) => finalize(id, now, result),
    }
  } catch (err) {
    log.error("failed to capture background llm call", {
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

interface BackgroundResult {
  text?: string
  usage?: {
    input: number
    output: number
    reasoning?: number
    cache?: { read: number; write: number }
  }
  cost?: number
  error?: string
  response?: {
    headers?: Record<string, string>
    id?: string
    modelId?: string
    timestamp?: Date
    body?: unknown
  }
  request?: {
    body?: unknown
  }
}

function finalize(id: string, start: number, result: BackgroundResult): void {
  const now = Date.now()
  const status = result.error ? "error" : "success"

  try {
    Database.use((db) => {
      const raw = result.response
        ? Bun.gzipSync(
            Buffer.from(
              JSON.stringify({
                id: result.response.id,
                modelId: result.response.modelId,
                timestamp: result.response.timestamp,
                headers: result.response.headers,
                body: result.response.body,
                requestBody: result.request?.body,
              }),
            ),
          )
        : null

      db.insert(LlmLogResponseTable)
        .values({
          id: Identifier.ascending("log"),
          llm_log_id: id,
          completion_text: result.text ?? null,
          tool_calls: null,
          raw_response: raw,
          error: result.error ? { message: result.error } : null,
        })
        .run()

      if (result.usage) {
        db.insert(LlmLogTokensTable)
          .values({
            id: Identifier.ascending("log"),
            llm_log_id: id,
            input_tokens: result.usage.input,
            output_tokens: result.usage.output,
            reasoning_tokens: result.usage.reasoning ?? 0,
            cache_read_tokens: result.usage.cache?.read ?? 0,
            cache_write_tokens: result.usage.cache?.write ?? 0,
            cost: result.cost ? Math.round(result.cost * 1_000_000) : 0,
          })
          .run()
      }

      // Store request body in options column if available
      if (result.request?.body) {
        db.update(LlmLogRequestTable)
          .set({ options: result.request.body })
          .where(eq(LlmLogRequestTable.llm_log_id, id))
          .run()
      }

      db.update(LlmLogTable)
        .set({
          time_end: now,
          duration_ms: now - start,
          status,
        })
        .where(eq(LlmLogTable.id, id))
        .run()
    })

    log.info("finalized background llm log", { id, status })
  } catch (err) {
    log.error("failed to finalize background llm log", {
      id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
