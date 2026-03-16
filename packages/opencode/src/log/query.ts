import { z } from "zod"
import { Database, NotFoundError, eq, and, gte, lte, desc, sql, inArray } from "../storage/db"
import {
  LlmLogTable,
  LlmLogRequestTable,
  LlmLogResponseTable,
  LlmLogTokensTable,
  LlmLogToolCallTable,
  LlmLogHookTable,
  LlmLogAnnotationTable,
} from "./log.sql"
import { Identifier } from "../id/id"
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
    input_tokens: number | null
    output_tokens: number | null
    cost: number | null
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
          input_tokens: LlmLogTokensTable.input_tokens,
          output_tokens: LlmLogTokensTable.output_tokens,
          cost: LlmLogTokensTable.cost,
          time_created: LlmLogTable.time_created,
          time_updated: LlmLogTable.time_updated,
        })
        .from(LlmLogTable)
        .leftJoin(LlmLogTokensTable, eq(LlmLogTable.id, LlmLogTokensTable.llm_log_id))
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
          systemPrompt = Buffer.from(Bun.gunzipSync(Buffer.from(requestRow.system_prompt as ArrayBuffer))).toString("utf-8")
        } catch {
          systemPrompt = "(decompression failed)"
        }
        try {
          messages = JSON.parse(
            Buffer.from(Bun.gunzipSync(Buffer.from(requestRow.messages as ArrayBuffer))).toString("utf-8"),
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
              Buffer.from(Bun.gunzipSync(Buffer.from(responseRow.raw_response as ArrayBuffer))).toString("utf-8"),
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

  // --- Stats ---

  export const StatsFilters = z
    .object({
      session_id: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      provider: z.string().optional(),
      time_start: z.number().optional(),
      time_end: z.number().optional(),
      group_by: z.enum(["model", "agent", "session", "hour", "day"]).optional(),
    })
    .optional()

  export type StatsFilters = z.infer<typeof StatsFilters>

  export interface StatsSummary {
    total_requests: number
    total_input_tokens: number
    total_output_tokens: number
    total_reasoning_tokens: number
    total_cache_read_tokens: number
    total_cache_write_tokens: number
    total_cost: number
    avg_duration_ms: number
    avg_input_tokens: number
    avg_output_tokens: number
  }

  export interface StatsGrouped {
    group: string
    request_count: number
    input_tokens: number
    output_tokens: number
    reasoning_tokens: number
    cost: number
    avg_duration_ms: number
  }

  export interface StatsResult {
    summary: StatsSummary
    grouped: StatsGrouped[]
  }

  function buildStatsConditions(parsed: NonNullable<StatsFilters>): SQL | undefined {
    const conditions: SQL[] = []
    if (parsed.session_id) conditions.push(eq(LlmLogTable.session_id, parsed.session_id))
    if (parsed.agent) conditions.push(eq(LlmLogTable.agent, parsed.agent))
    if (parsed.model) conditions.push(eq(LlmLogTable.model, parsed.model))
    if (parsed.provider) conditions.push(eq(LlmLogTable.provider, parsed.provider))
    if (parsed.time_start) conditions.push(gte(LlmLogTable.time_start, parsed.time_start))
    if (parsed.time_end) conditions.push(lte(LlmLogTable.time_start, parsed.time_end))
    return conditions.length > 0 ? and(...conditions) : undefined
  }

  export function stats(filters?: z.input<typeof StatsFilters>): StatsResult {
    const parsed = StatsFilters.parse(filters) ?? {}
    const where = buildStatsConditions(parsed)

    return Database.use((db) => {
      const summaryRow = db
        .select({
          total_requests: sql<number>`count(*)`,
          total_input_tokens: sql<number>`coalesce(sum(${LlmLogTokensTable.input_tokens}), 0)`,
          total_output_tokens: sql<number>`coalesce(sum(${LlmLogTokensTable.output_tokens}), 0)`,
          total_reasoning_tokens: sql<number>`coalesce(sum(${LlmLogTokensTable.reasoning_tokens}), 0)`,
          total_cache_read_tokens: sql<number>`coalesce(sum(${LlmLogTokensTable.cache_read_tokens}), 0)`,
          total_cache_write_tokens: sql<number>`coalesce(sum(${LlmLogTokensTable.cache_write_tokens}), 0)`,
          total_cost: sql<number>`coalesce(sum(${LlmLogTokensTable.cost}), 0)`,
          avg_duration_ms: sql<number>`coalesce(avg(${LlmLogTable.duration_ms}), 0)`,
          avg_input_tokens: sql<number>`coalesce(avg(${LlmLogTokensTable.input_tokens}), 0)`,
          avg_output_tokens: sql<number>`coalesce(avg(${LlmLogTokensTable.output_tokens}), 0)`,
        })
        .from(LlmLogTable)
        .leftJoin(LlmLogTokensTable, eq(LlmLogTable.id, LlmLogTokensTable.llm_log_id))
        .where(where)
        .get()

      const summary: StatsSummary = {
        total_requests: summaryRow?.total_requests ?? 0,
        total_input_tokens: summaryRow?.total_input_tokens ?? 0,
        total_output_tokens: summaryRow?.total_output_tokens ?? 0,
        total_reasoning_tokens: summaryRow?.total_reasoning_tokens ?? 0,
        total_cache_read_tokens: summaryRow?.total_cache_read_tokens ?? 0,
        total_cache_write_tokens: summaryRow?.total_cache_write_tokens ?? 0,
        total_cost: summaryRow?.total_cost ?? 0,
        avg_duration_ms: Math.round(summaryRow?.avg_duration_ms ?? 0),
        avg_input_tokens: Math.round(summaryRow?.avg_input_tokens ?? 0),
        avg_output_tokens: Math.round(summaryRow?.avg_output_tokens ?? 0),
      }

      let grouped: StatsGrouped[] = []
      const groupBy = parsed.group_by
      if (groupBy) {
        let groupExpr: SQL
        if (groupBy === "hour") {
          groupExpr = sql`cast(${LlmLogTable.time_start} / 3600000 * 3600000 as integer)`
        } else if (groupBy === "day") {
          groupExpr = sql`cast(${LlmLogTable.time_start} / 86400000 * 86400000 as integer)`
        } else if (groupBy === "model") {
          groupExpr = sql`${LlmLogTable.model}`
        } else if (groupBy === "agent") {
          groupExpr = sql`${LlmLogTable.agent}`
        } else {
          groupExpr = sql`${LlmLogTable.session_id}`
        }

        grouped = db
          .select({
            group: sql<string>`${groupExpr}`,
            request_count: sql<number>`count(*)`,
            input_tokens: sql<number>`coalesce(sum(${LlmLogTokensTable.input_tokens}), 0)`,
            output_tokens: sql<number>`coalesce(sum(${LlmLogTokensTable.output_tokens}), 0)`,
            reasoning_tokens: sql<number>`coalesce(sum(${LlmLogTokensTable.reasoning_tokens}), 0)`,
            cost: sql<number>`coalesce(sum(${LlmLogTokensTable.cost}), 0)`,
            avg_duration_ms: sql<number>`coalesce(avg(${LlmLogTable.duration_ms}), 0)`,
          })
          .from(LlmLogTable)
          .leftJoin(LlmLogTokensTable, eq(LlmLogTable.id, LlmLogTokensTable.llm_log_id))
          .where(where)
          .groupBy(groupExpr)
          .orderBy(desc(sql`count(*)`))
          .all()
          .map((r) => ({
            ...r,
            group: String(r.group),
            avg_duration_ms: Math.round(r.avg_duration_ms),
          }))
      }

      return { summary, grouped }
    })
  }

  // --- Analyze ---

  export const AnalyzeFilters = z
    .object({
      session_id: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      provider: z.string().optional(),
      time_start: z.number().optional(),
      time_end: z.number().optional(),
    })
    .optional()

  export type AnalyzeFilters = z.infer<typeof AnalyzeFilters>

  export interface Suggestion {
    category: string
    description: string
    impact: {
      tokens?: number
      cost?: number
    }
    recommended_action: string
  }

  export interface AnalyzeResult {
    suggestions: Suggestion[]
    top_large_tool_outputs: Array<{
      tool_name: string
      output_bytes: number
      llm_log_id: string
    }>
    cache_hit_rate: number
    reasoning_token_ratio: number
  }

  export function analyze(filters?: z.input<typeof AnalyzeFilters>): AnalyzeResult {
    const parsed = AnalyzeFilters.parse(filters) ?? {}
    const where = buildStatsConditions(parsed)

    return Database.use((db) => {
      const suggestions: Suggestion[] = []

      // 1. Top 10 largest tool outputs
      const topToolOutputs = db
        .select({
          tool_name: LlmLogToolCallTable.tool_name,
          output_bytes: LlmLogToolCallTable.output_bytes,
          llm_log_id: LlmLogToolCallTable.llm_log_id,
        })
        .from(LlmLogToolCallTable)
        .innerJoin(LlmLogTable, eq(LlmLogToolCallTable.llm_log_id, LlmLogTable.id))
        .where(where)
        .orderBy(desc(LlmLogToolCallTable.output_bytes))
        .limit(10)
        .all()
        .filter((r) => r.output_bytes != null && r.output_bytes > 0)

      if (topToolOutputs.length > 0) {
        const largestBytes = topToolOutputs[0].output_bytes!
        if (largestBytes > 50000) {
          suggestions.push({
            category: "oversized_tool_output",
            description: `Largest tool output is ${Math.round(largestBytes / 1024)}KB (${topToolOutputs[0].tool_name}). Large outputs consume tokens and slow responses.`,
            impact: { tokens: Math.round(largestBytes / 4) },
            recommended_action:
              "Consider truncating tool outputs or using more targeted queries to reduce output size.",
          })
        }
      }

      // 2. Cache hit rate
      const tokenSums = db
        .select({
          total_input: sql<number>`coalesce(sum(${LlmLogTokensTable.input_tokens}), 0)`,
          total_cache_read: sql<number>`coalesce(sum(${LlmLogTokensTable.cache_read_tokens}), 0)`,
          total_cache_write: sql<number>`coalesce(sum(${LlmLogTokensTable.cache_write_tokens}), 0)`,
          total_output: sql<number>`coalesce(sum(${LlmLogTokensTable.output_tokens}), 0)`,
          total_reasoning: sql<number>`coalesce(sum(${LlmLogTokensTable.reasoning_tokens}), 0)`,
          total_cost: sql<number>`coalesce(sum(${LlmLogTokensTable.cost}), 0)`,
          record_count: sql<number>`count(*)`,
        })
        .from(LlmLogTokensTable)
        .innerJoin(LlmLogTable, eq(LlmLogTokensTable.llm_log_id, LlmLogTable.id))
        .where(where)
        .get()

      const totalInput = tokenSums?.total_input ?? 0
      const totalCacheRead = tokenSums?.total_cache_read ?? 0
      const totalCacheWrite = tokenSums?.total_cache_write ?? 0
      const totalOutput = tokenSums?.total_output ?? 0
      const totalReasoning = tokenSums?.total_reasoning ?? 0
      const totalCost = tokenSums?.total_cost ?? 0
      const recordCount = tokenSums?.record_count ?? 0

      const cacheHitRate = totalInput > 0 ? totalCacheRead / totalInput : 0

      if (recordCount > 5 && cacheHitRate < 0.3 && totalCacheWrite > 0) {
        const potentialSavings = Math.round(totalInput * 0.5 * 0.9)
        suggestions.push({
          category: "cache_hit_rate",
          description: `Cache hit rate is ${(cacheHitRate * 100).toFixed(1)}%. Cache writes exist but reads are low, suggesting prompt structure changes between calls.`,
          impact: { tokens: potentialSavings },
          recommended_action:
            "Keep system prompt and context stable between calls to improve cache hit rates. Avoid unnecessary prompt modifications.",
        })
      }

      // 3. Repeated context ratio — check if sessions have many requests with similar input sizes
      const sessionCounts = db
        .select({
          session_id: LlmLogTable.session_id,
          req_count: sql<number>`count(*)`,
          avg_input: sql<number>`coalesce(avg(${LlmLogTokensTable.input_tokens}), 0)`,
        })
        .from(LlmLogTable)
        .innerJoin(LlmLogTokensTable, eq(LlmLogTable.id, LlmLogTokensTable.llm_log_id))
        .where(where)
        .groupBy(LlmLogTable.session_id)
        .having(sql`count(*) > 5`)
        .all()

      for (const session of sessionCounts) {
        if (session.avg_input > 100000) {
          suggestions.push({
            category: "repeated_context",
            description: `Session ${session.session_id.substring(0, 8)}... has ${session.req_count} requests with avg ${Math.round(session.avg_input)} input tokens. High input token count across many requests suggests repeated context.`,
            impact: { tokens: Math.round(session.avg_input * session.req_count * 0.3) },
            recommended_action:
              "Consider using context compaction or summarization to reduce repeated input tokens across session requests.",
          })
        }
      }

      // 4. High-cost model usage detection
      const modelCosts = db
        .select({
          model: LlmLogTable.model,
          request_count: sql<number>`count(*)`,
          total_cost: sql<number>`coalesce(sum(${LlmLogTokensTable.cost}), 0)`,
          avg_cost: sql<number>`coalesce(avg(${LlmLogTokensTable.cost}), 0)`,
        })
        .from(LlmLogTable)
        .innerJoin(LlmLogTokensTable, eq(LlmLogTable.id, LlmLogTokensTable.llm_log_id))
        .where(where)
        .groupBy(LlmLogTable.model)
        .orderBy(desc(sql`sum(${LlmLogTokensTable.cost})`))
        .all()

      if (modelCosts.length > 1 && totalCost > 0) {
        const topModel = modelCosts[0]
        const topModelCostRatio = topModel.total_cost / totalCost
        if (topModelCostRatio > 0.8 && topModel.request_count > 3) {
          suggestions.push({
            category: "high_cost_model",
            description: `Model "${topModel.model}" accounts for ${(topModelCostRatio * 100).toFixed(0)}% of total cost ($${(topModel.total_cost / 1_000_000).toFixed(4)}).`,
            impact: { cost: Math.round(topModel.total_cost * 0.3) },
            recommended_action:
              "Consider using a smaller model for simpler tasks (e.g., exploration, file reading) to reduce costs.",
          })
        }
      }

      // 5. Reasoning token ratio
      const totalAllTokens = totalInput + totalOutput
      const reasoningRatio = totalAllTokens > 0 ? totalReasoning / totalAllTokens : 0

      if (recordCount > 3 && reasoningRatio > 0.5) {
        suggestions.push({
          category: "reasoning_token_ratio",
          description: `Reasoning tokens are ${(reasoningRatio * 100).toFixed(0)}% of total tokens (${totalReasoning} reasoning out of ${totalAllTokens} total).`,
          impact: { tokens: Math.round(totalReasoning * 0.3) },
          recommended_action:
            "Consider reducing think mode budget for straightforward tasks, or switching to a non-reasoning model when deep thinking isn't needed.",
        })
      }

      return {
        suggestions,
        top_large_tool_outputs: topToolOutputs.map((r) => ({
          tool_name: r.tool_name,
          output_bytes: r.output_bytes ?? 0,
          llm_log_id: r.llm_log_id,
        })),
        cache_hit_rate: Math.round(cacheHitRate * 10000) / 10000,
        reasoning_token_ratio: Math.round(reasoningRatio * 10000) / 10000,
      }
    })
  }

  // --- Annotate ---

  export const AnnotationInput = z.object({
    type: z.enum(["hallucination", "quality", "note"]),
    content: z.string().min(1),
    marked_text: z.string().optional(),
  })

  export type AnnotationInput = z.infer<typeof AnnotationInput>

  export function annotate(llmLogId: string, input: AnnotationInput): { id: string } {
    const parsed = AnnotationInput.parse(input)

    return Database.use((db) => {
      const row = db.select({ id: LlmLogTable.id }).from(LlmLogTable).where(eq(LlmLogTable.id, llmLogId)).get()
      if (!row) throw new NotFoundError({ message: `LLM log not found: ${llmLogId}` })

      const id = Identifier.ascending("log")
      const now = Date.now()
      db.insert(LlmLogAnnotationTable)
        .values({
          id,
          llm_log_id: llmLogId,
          type: parsed.type,
          content: parsed.content,
          marked_text: parsed.marked_text ?? null,
          time_created: now,
          time_updated: now,
        })
        .run()

      return { id }
    })
  }

  export function deleteAnnotation(annotationId: string): void {
    Database.use((db) => {
      const row = db
        .select({ id: LlmLogAnnotationTable.id })
        .from(LlmLogAnnotationTable)
        .where(eq(LlmLogAnnotationTable.id, annotationId))
        .get()
      if (!row) throw new NotFoundError({ message: `Annotation not found: ${annotationId}` })

      db.delete(LlmLogAnnotationTable).where(eq(LlmLogAnnotationTable.id, annotationId)).run()
    })
  }

  // --- Cleanup ---

  export const CleanupOptions = z
    .object({
      max_age_days: z.number().min(1).optional(),
      max_records: z.number().min(1).optional(),
      force: z.boolean().default(false),
    })
    .optional()

  export type CleanupOptions = z.infer<typeof CleanupOptions>

  export interface CleanupResult {
    deleted_by_age: number
    deleted_by_count: number
    total_deleted: number
    protected_count: number
  }

  export function cleanup(options?: z.input<typeof CleanupOptions>): CleanupResult {
    const parsed = CleanupOptions.parse(options)
    const maxAgeDays = parsed?.max_age_days
    const maxRecords = parsed?.max_records
    const force = parsed?.force ?? false

    let deletedByAge = 0
    let deletedByCount = 0
    let protectedCount = 0

    return Database.use((db) => {
      const countWhere = (where: SQL | undefined): number => {
        const result = db.select({ count: sql<number>`count(*)` }).from(LlmLogTable).where(where).get()
        return result?.count ?? 0
      }

      // 1. Delete by age
      if (maxAgeDays) {
        const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
        const forceAgeCutoff = Date.now() - maxAgeDays * 2 * 24 * 60 * 60 * 1000

        if (force) {
          deletedByAge = countWhere(lte(LlmLogTable.time_start, cutoff))
          db.delete(LlmLogTable).where(lte(LlmLogTable.time_start, cutoff)).run()
        } else {
          const annotatedIds = [...new Set(
            db.select({ llm_log_id: LlmLogAnnotationTable.llm_log_id }).from(LlmLogAnnotationTable).all().map((r) => r.llm_log_id),
          )]

          if (annotatedIds.length > 0) {
            // Delete annotated records older than 2x max_age
            const veryOldAnnotatedWhere = and(lte(LlmLogTable.time_start, forceAgeCutoff), inArray(LlmLogTable.id, annotatedIds))
            deletedByAge += countWhere(veryOldAnnotatedWhere)
            db.delete(LlmLogTable).where(veryOldAnnotatedWhere).run()

            // Re-fetch remaining annotated IDs
            const remainingAnnotatedIds = [...new Set(
              db.select({ llm_log_id: LlmLogAnnotationTable.llm_log_id }).from(LlmLogAnnotationTable).all().map((r) => r.llm_log_id),
            )]

            // Count protected (annotated + old but within 2x)
            if (remainingAnnotatedIds.length > 0) {
              protectedCount += countWhere(and(lte(LlmLogTable.time_start, cutoff), inArray(LlmLogTable.id, remainingAnnotatedIds)))
            }

            // Delete non-annotated old records
            const nonAnnotatedOldWhere = remainingAnnotatedIds.length > 0
              ? and(
                  lte(LlmLogTable.time_start, cutoff),
                  sql`${LlmLogTable.id} NOT IN (${sql.join(remainingAnnotatedIds.map((id) => sql`${id}`), sql`,`)})`,
                )
              : lte(LlmLogTable.time_start, cutoff)
            deletedByAge += countWhere(nonAnnotatedOldWhere)
            db.delete(LlmLogTable).where(nonAnnotatedOldWhere).run()
          } else {
            deletedByAge = countWhere(lte(LlmLogTable.time_start, cutoff))
            db.delete(LlmLogTable).where(lte(LlmLogTable.time_start, cutoff)).run()
          }
        }
      }

      // 2. Delete by max_records (keep newest N records)
      if (maxRecords) {
        const total = countWhere(undefined)

        if (total > maxRecords) {
          const excess = total - maxRecords

          let candidates = db
            .select({ id: LlmLogTable.id })
            .from(LlmLogTable)
            .orderBy(LlmLogTable.time_start)
            .limit(excess)
            .all()
            .map((r) => r.id)

          if (!force && candidates.length > 0) {
            const annotatedIds = db
              .select({ llm_log_id: LlmLogAnnotationTable.llm_log_id })
              .from(LlmLogAnnotationTable)
              .where(inArray(LlmLogAnnotationTable.llm_log_id, candidates))
              .all()
              .map((r) => r.llm_log_id)
            const annotatedSet = new Set(annotatedIds)
            protectedCount += candidates.filter((id) => annotatedSet.has(id)).length
            candidates = candidates.filter((id) => !annotatedSet.has(id))
          }

          if (candidates.length > 0) {
            deletedByCount = candidates.length
            db.delete(LlmLogTable).where(inArray(LlmLogTable.id, candidates)).run()
          }
        }
      }

      return {
        deleted_by_age: deletedByAge,
        deleted_by_count: deletedByCount,
        total_deleted: deletedByAge + deletedByCount,
        protected_count: protectedCount,
      }
    })
  }

  export function reset(): { deleted: number } {
    return Database.use((db) => {
      const result = db.select({ count: sql<number>`count(*)` }).from(LlmLogTable).get()
      const count = result?.count ?? 0
      db.delete(LlmLogTable).run()
      return { deleted: count }
    })
  }
}
