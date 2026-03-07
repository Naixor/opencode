import { sqliteTable, text, integer, blob, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "@/storage/schema.sql"

export const LlmLogTable = sqliteTable(
  "llm_log",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    agent: text().notNull(),
    model: text().notNull(),
    provider: text().notNull(),
    variant: text(),
    status: text().notNull().default("pending"),
    time_start: integer().notNull(),
    time_end: integer(),
    duration_ms: integer(),
    ...Timestamps,
  },
  (table) => [
    index("llm_log_session_idx").on(table.session_id),
    index("llm_log_agent_idx").on(table.agent),
    index("llm_log_model_idx").on(table.model),
    index("llm_log_provider_idx").on(table.provider),
    index("llm_log_status_idx").on(table.status),
    index("llm_log_time_start_idx").on(table.time_start),
  ],
)

export const LlmLogRequestTable = sqliteTable("llm_log_request", {
  id: text().primaryKey(),
  llm_log_id: text()
    .notNull()
    .references(() => LlmLogTable.id, { onDelete: "cascade" }),
  system_prompt: blob().notNull(),
  messages: blob().notNull(),
  tools: text({ mode: "json" }),
  options: text({ mode: "json" }),
  ...Timestamps,
})

export const LlmLogResponseTable = sqliteTable("llm_log_response", {
  id: text().primaryKey(),
  llm_log_id: text()
    .notNull()
    .references(() => LlmLogTable.id, { onDelete: "cascade" }),
  completion_text: text(),
  tool_calls: text({ mode: "json" }),
  raw_response: blob(),
  error: text({ mode: "json" }),
  ...Timestamps,
})

export const LlmLogTokensTable = sqliteTable("llm_log_tokens", {
  id: text().primaryKey(),
  llm_log_id: text()
    .notNull()
    .references(() => LlmLogTable.id, { onDelete: "cascade" }),
  input_tokens: integer().notNull().default(0),
  output_tokens: integer().notNull().default(0),
  reasoning_tokens: integer().notNull().default(0),
  cache_read_tokens: integer().notNull().default(0),
  cache_write_tokens: integer().notNull().default(0),
  cost: integer().notNull().default(0),
  ...Timestamps,
})

export const LlmLogToolCallTable = sqliteTable(
  "llm_log_tool_call",
  {
    id: text().primaryKey(),
    llm_log_id: text()
      .notNull()
      .references(() => LlmLogTable.id, { onDelete: "cascade" }),
    call_id: text(),
    tool_name: text().notNull(),
    input: text({ mode: "json" }),
    output: text({ mode: "json" }),
    title: text(),
    status: text(),
    time_start: integer(),
    time_end: integer(),
    duration_ms: integer(),
    output_bytes: integer(),
    ...Timestamps,
  },
  (table) => [
    index("llm_log_tool_call_log_idx").on(table.llm_log_id),
    index("llm_log_tool_call_name_idx").on(table.tool_name),
  ],
)

export const LlmLogHookTable = sqliteTable(
  "llm_log_hook",
  {
    id: text().primaryKey(),
    llm_log_id: text()
      .notNull()
      .references(() => LlmLogTable.id, { onDelete: "cascade" }),
    hook_name: text().notNull(),
    chain_type: text().notNull(),
    priority: integer().notNull(),
    modified_fields: text({ mode: "json" }),
    duration_ms: integer(),
    ...Timestamps,
  },
  (table) => [index("llm_log_hook_log_idx").on(table.llm_log_id)],
)

export const LlmLogAnnotationTable = sqliteTable(
  "llm_log_annotation",
  {
    id: text().primaryKey(),
    llm_log_id: text()
      .notNull()
      .references(() => LlmLogTable.id, { onDelete: "cascade" }),
    type: text().notNull(),
    content: text().notNull(),
    marked_text: text(),
    ...Timestamps,
  },
  (table) => [index("llm_log_annotation_log_idx").on(table.llm_log_id)],
)
