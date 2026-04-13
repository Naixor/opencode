import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Delivery } from "./schema"

export const SwarmRunTable = sqliteTable(
  "swarm_run",
  {
    id: text().primaryKey(),
    goal: text().notNull(),
    status: text().notNull().$type<Delivery.RunStatus>().default("pending"),
    phase: text().notNull().$type<Delivery.RunPhase>().default("plan"),
    phases: text({ mode: "json" })
      .notNull()
      .$type<Delivery.RunPhase[]>()
      .$default(() => [...Delivery.Phases]),
    gate: text({ mode: "json" })
      .notNull()
      .$type<Delivery.Gate>()
      .$default(() => Delivery.gate("plan")),
    created_at: integer()
      .notNull()
      .$default(() => Date.now()),
    updated_at: integer()
      .notNull()
      .$default(() => Date.now())
      .$onUpdate(() => Date.now()),
    owner_session_id: text().notNull(),
  },
  (table) => [
    index("swarm_run_status_idx").on(table.status),
    index("swarm_run_phase_idx").on(table.phase),
    index("swarm_run_owner_session_idx").on(table.owner_session_id),
  ],
)

export const RoleSpecTable = sqliteTable("role_spec", {
  role_id: text().primaryKey(),
  name: text().notNull(),
  responsibility: text().notNull(),
  skills: text({ mode: "json" }).notNull().$type<string[]>(),
  limits: text({ mode: "json" }).notNull().$type<string[]>(),
  approval_required: integer({ mode: "boolean" })
    .notNull()
    .$default(() => false),
})

export const WorkItemTable = sqliteTable(
  "work_item",
  {
    id: text().primaryKey(),
    swarm_run_id: text()
      .notNull()
      .references(() => SwarmRunTable.id),
    title: text().notNull(),
    status: text().notNull().$type<Delivery.WorkStatus>().default("pending"),
    owner_role_id: text()
      .notNull()
      .references(() => RoleSpecTable.role_id),
    blocked_by: text({ mode: "json" }).notNull().$type<string[]>(),
    scope: text({ mode: "json" }).notNull().$type<string[]>(),
    phase_gate: text().notNull().$type<Delivery.WorkPhaseGate>().default("plan"),
    gate: text({ mode: "json" })
      .notNull()
      .$type<Delivery.Gate>()
      .$default(() => Delivery.gate("plan")),
    verification: text({ mode: "json" }).notNull().$type<Delivery.Verification>(),
    small_mr_required: integer({ mode: "boolean" })
      .notNull()
      .$default(() => true),
  },
  (table) => [
    index("work_item_swarm_run_idx").on(table.swarm_run_id),
    index("work_item_status_idx").on(table.status),
    index("work_item_owner_role_idx").on(table.owner_role_id),
    index("work_item_phase_gate_idx").on(table.phase_gate),
    index("work_item_small_mr_required_idx").on(table.small_mr_required),
  ],
)

export const DecisionTable = sqliteTable(
  "decision",
  {
    id: text().primaryKey(),
    kind: text().notNull(),
    summary: text().notNull(),
    source: text().notNull(),
    status: text().notNull().$type<Delivery.DecisionStatus>().default("proposed"),
    requires_user_confirmation: integer({ mode: "boolean" })
      .notNull()
      .$default(() => false),
    applies_to: text({ mode: "json" }).notNull().$type<string[]>(),
    participants: text({ mode: "json" })
      .notNull()
      .$type<string[]>()
      .$default(() => []),
    candidate_outcomes: text({ mode: "json" })
      .notNull()
      .$type<string[]>()
      .$default(() => []),
    input_context: text().notNull().default(""),
    actions: text({ mode: "json" })
      .notNull()
      .$type<Delivery.DecisionAction[]>()
      .$default(() => []),
    related_question_id: text(),
    decided_by: text(),
    decided_at: integer(),
  },
  (table) => [
    index("decision_status_idx").on(table.status),
    index("decision_related_question_idx").on(table.related_question_id),
  ],
)

export const OpenQuestionTable = sqliteTable(
  "open_question",
  {
    id: text().primaryKey(),
    title: text().notNull(),
    context: text().notNull(),
    options: text({ mode: "json" }).notNull().$type<string[]>(),
    recommended_option: text(),
    status: text().notNull().$type<Delivery.OpenQuestionStatus>().default("open"),
    deadline_policy: text(),
    blocking: integer({ mode: "boolean" })
      .notNull()
      .$default(() => true),
    affects: text({ mode: "json" }).notNull().$type<string[]>(),
    related_decision_id: text(),
    raised_by: text().notNull(),
  },
  (table) => [
    index("open_question_status_idx").on(table.status),
    index("open_question_related_decision_idx").on(table.related_decision_id),
  ],
)
