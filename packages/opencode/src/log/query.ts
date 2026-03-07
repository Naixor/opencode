import { z } from "zod"
import { Database, NotFoundError, eq, and, gte, lte, desc, sql } from "../storage/db"
import {
  LlmLogTable,
  LlmLogRequestTable,
  LlmLogResponseTable,
  LlmLogTokensTable,
  LlmLogToolCallTable,
  LlmLogHookTable,
  LlmLogAnnotationTable,
} from "./log.sql"
import { Log } from "../util/log"
import type { SQL } from "../storage/db"

export namespace LlmLog {
  const log = Log.create({ service: "llm-log-query" })

  export const ListFilters = z
    .object({
      session_id: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      provider: z.string().optional(),
      status: z.string().optional(),
      time_start: z.number().optional(),
      time_end: z.number().optional(),
      limit: z.number().min(1).max(1000).default(50),
      offset: z.number().min(0).default(0),
    })
    .optional()

  export type ListFilters = z.infer<typeof ListFilters>

  export interface ListItem {
    id: string
    session_id: string
    agent: string
    model: string
    provider: string
    variant: string | null
    status: string
    time_start: number
    time_end: number | null
    duration_ms: number | null
    time_created: number
    time_updated: number
  }

  export function list(filters?: z.input<typeof ListFilters>): { items: ListItem[]; total: number } {
    const parsed = ListFilters.parse(filters) ?? { limit: 50, offset: 0 }

    const conditions: SQL[] = []
    if (parsed.session_id) conditions.push(eq(LlmLogTable.session_id, parsed.session_id))
    if (parsed.agent) conditions.push(eq(LlmLogTable.agent, parsed.agent))
    if (parsed.model) conditions.push(eq(LlmLogTable.model, parsed.model))
    if (parsed.provider) conditions.push(eq(LlmLogTable.provider, parsed.provider))
    if (parsed.status) conditions.push(eq(LlmLogTable.status, parsed.status))
    if (parsed.time_start) conditions.push(gte(LlmLogTable.time_start, parsed.time_start))
    if (parsed.time_end) conditions.push(lte(LlmLogTable.time_start, parsed.time_end))

    const where = conditions.length > 0 ? and(...conditions) : undefined

    return Database.use((db) => {
      const items = db
        .select({
          id: LlmLogTable.id,
          session_id: LlmLogTable.session_id,
          agent: LlmLogTable.agent,
          model: LlmLogTable.model,
          provider: LlmLogTable.provider,
          variant: LlmLogTable.variant,
          status: LlmLogTable.status,
          time_start: LlmLogTable.time_start,
          time_end: LlmLogTable.time_end,
          duration_ms: LlmLogTable.duration_ms,
          time_created: LlmLogTable.time_created,
          time_updated: LlmLogTable.time_updated,
        })
        .from(LlmLogTable)
        .where(where)
        .orderBy(desc(LlmLogTable.time_start))
        .limit(parsed.limit)
        .offset(parsed.offset)
        .all()

      const countResult = db
        .select({ count: sql<number>`count(*)` })
        .from(LlmLogTable)
        .where(where)
        .get()

      return { items, total: countResult?.count ?? 0 }
    })
  }

  export interface Detail {
    id: string
    session_id: string
    agent: string
    model: string
    provider: string
    variant: string | null
    status: string
    time_start: number
    time_end: number | null
    duration_ms: number | null
    request: {
      system_prompt: string
      messages: any[]
      tools: any
      options: any
    } | null
    response: {
      completion_text: string | null
      tool_calls: any
      raw_response: any
      error: any
    } | null
    tokens: {
      input_tokens: number
      output_tokens: number
      reasoning_tokens: number
      cache_read_tokens: number
      cache_write_tokens: number
      cost: number
    } | null
    tool_calls: Array<{
      id: string
      call_id: string | null
      tool_name: string
      input: any
      output: any
      title: string | null
      status: string | null
      time_start: number | null
      duration_ms: number | null
      output_bytes: number | null
    }>
    hooks: Array<{
      id: string
      hook_name: string
      chain_type: string
      priority: number
      modified_fields: any
      duration_ms: number | null
    }>
    annotations: Array<{
      id: string
      type: string
      content: string
      marked_text: string | null
      time_created: number
    }>
  }

  export function get(id: string): Detail {
    return Database.use((db) => {
      const row = db.select().from(LlmLogTable).where(eq(LlmLogTable.id, id)).get()
      if (!row) throw new NotFoundError({ message: `LLM log not found: ${id}` })

      const requestRow = db
        .select()
        .from(LlmLogRequestTable)
        .where(eq(LlmLogRequestTable.llm_log_id, id))
        .get()

      let request: Detail["request"] = null
      if (requestRow) {
        let systemPrompt = ""
        let messages: any[] = []
        try {
          systemPrompt = Bun.gunzipSync(Buffer.from(requestRow.system_prompt as ArrayBuffer)).toString()
        } catch {
          systemPrompt = "(decompression failed)"
        }
        try {
          messages = JSON.parse(
            Bun.gunzipSync(Buffer.from(requestRow.messages as ArrayBuffer)).toString(),
          )
        } catch {
          messages = []
        }
        request = {
          system_prompt: systemPrompt,
          messages,
          tools: requestRow.tools,
          options: requestRow.options,
        }
      }

      const responseRow = db
        .select()
        .from(LlmLogResponseTable)
        .where(eq(LlmLogResponseTable.llm_log_id, id))
        .get()

      let response: Detail["response"] = null
      if (responseRow) {
        let rawResponse: any = null
        if (responseRow.raw_response) {
          try {
            rawResponse = JSON.parse(
              Bun.gunzipSync(Buffer.from(responseRow.raw_response as ArrayBuffer)).toString(),
            )
          } catch {
            rawResponse = null
          }
        }
        response = {
          completion_text: responseRow.completion_text,
          tool_calls: responseRow.tool_calls,
          raw_response: rawResponse,
          error: responseRow.error,
        }
      }

      const tokensRow = db
        .select()
        .from(LlmLogTokensTable)
        .where(eq(LlmLogTokensTable.llm_log_id, id))
        .get()

      const tokens: Detail["tokens"] = tokensRow
        ? {
            input_tokens: tokensRow.input_tokens,
            output_tokens: tokensRow.output_tokens,
            reasoning_tokens: tokensRow.reasoning_tokens,
            cache_read_tokens: tokensRow.cache_read_tokens,
            cache_write_tokens: tokensRow.cache_write_tokens,
            cost: tokensRow.cost,
          }
        : null

      const toolCalls = db
        .select()
        .from(LlmLogToolCallTable)
        .where(eq(LlmLogToolCallTable.llm_log_id, id))
        .orderBy(LlmLogToolCallTable.time_start)
        .all()
        .map((tc) => ({
          id: tc.id,
          call_id: tc.call_id,
          tool_name: tc.tool_name,
          input: tc.input,
          output: tc.output,
          title: tc.title,
          status: tc.status,
          time_start: tc.time_start,
          duration_ms: tc.duration_ms,
          output_bytes: tc.output_bytes,
        }))

      const hooks = db
        .select()
        .from(LlmLogHookTable)
        .where(eq(LlmLogHookTable.llm_log_id, id))
        .orderBy(LlmLogHookTable.chain_type, LlmLogHookTable.priority)
        .all()
        .map((h) => ({
          id: h.id,
          hook_name: h.hook_name,
          chain_type: h.chain_type,
          priority: h.priority,
          modified_fields: h.modified_fields,
          duration_ms: h.duration_ms,
        }))

      const annotations = db
        .select()
        .from(LlmLogAnnotationTable)
        .where(eq(LlmLogAnnotationTable.llm_log_id, id))
        .orderBy(LlmLogAnnotationTable.time_created)
        .all()
        .map((a) => ({
          id: a.id,
          type: a.type,
          content: a.content,
          marked_text: a.marked_text,
          time_created: a.time_created,
        }))

      return {
        id: row.id,
        session_id: row.session_id,
        agent: row.agent,
        model: row.model,
        provider: row.provider,
        variant: row.variant,
        status: row.status,
        time_start: row.time_start,
        time_end: row.time_end,
        duration_ms: row.duration_ms,
        request,
        response,
        tokens,
        tool_calls: toolCalls,
        hooks,
        annotations,
      }
    })
  }
}
