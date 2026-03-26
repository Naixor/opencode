import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { HookChain } from "../../src/session/hooks"
import { registerAllHooks } from "../../src/session/hooks/register"
import { Database, eq } from "../../src/storage/db"
import { LlmLogTable } from "../../src/log/log.sql"
import { SessionTable } from "../../src/session/session.sql"
import { currentLlmLogState } from "../../src/log/log-state"
import { count, sql } from "drizzle-orm"

describe("LLM Log Capture", () => {
  function ensureSession(sessionID: string) {
    Database.use((db) => {
      const existing = db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
      if (existing) return
      db.insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Instance.project.id,
          slug: sessionID,
          directory: Instance.directory,
          title: "test",
          version: "0.0.0",
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
    })
  }

  function clearLogs() {
    Database.use((db) => {
      db.run(sql`DELETE FROM llm_log_hook`)
      db.run(sql`DELETE FROM llm_log_annotation`)
      db.run(sql`DELETE FROM llm_log_tool_call`)
      db.run(sql`DELETE FROM llm_log_tokens`)
      db.run(sql`DELETE FROM llm_log_response`)
      db.run(sql`DELETE FROM llm_log_request`)
      db.run(sql`DELETE FROM llm_log`)
    })
  }

  async function withInstance(fn: () => Promise<void>, config?: Record<string, unknown>) {
    await using tmp = await tmpdir({
      git: true,
      config: config ?? {},
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        HookChain.reset()
        registerAllHooks()
        clearLogs()
        await fn()
      },
    })
  }

  // --- registerAllHooks registers all hook namespaces ---

  test("registerAllHooks registers llm-log-capture hooks", () => {
    HookChain.reset()
    registerAllHooks()

    const preLlm = HookChain.listRegistered("pre-llm")
    const preTool = HookChain.listRegistered("pre-tool")
    const postTool = HookChain.listRegistered("post-tool")
    const lifecycle = HookChain.listRegistered("session-lifecycle")

    expect(preLlm.some((h) => h.name === "llm-log-capture")).toBe(true)
    expect(preTool.some((h) => h.name === "llm-log-tool-start")).toBe(true)
    expect(postTool.some((h) => h.name === "llm-log-tool-finish")).toBe(true)
    expect(lifecycle.some((h) => h.name === "llm-log-response-capture")).toBe(true)
    expect(lifecycle.some((h) => h.name === "llm-log-error-capture")).toBe(true)

    HookChain.reset()
  })

  test("registerAllHooks registers hooks from all namespaces", () => {
    HookChain.reset()
    registerAllHooks()

    const all = HookChain.listRegistered()
    const expected = [
      "directory-agents-injector",
      "keyword-detector",
      "edit-error-recovery",
      "tool-output-truncator",
      "subagent-question-blocker",
      "think-mode",
      "session-recovery",
      "llm-log-capture",
    ]

    for (const name of expected) {
      expect(all.some((h) => h.name === name)).toBe(true)
    }

    HookChain.reset()
  })

  // --- config.llmLog?.enabled === false guard ---
  // Bug: previously used `!config.llmLog?.enabled` which treated undefined as disabled.
  // Fix: use `config.llmLog?.enabled === false` so undefined config defaults to enabled.

  test("log capture fires when config.llmLog is undefined (default enabled)", async () => {
    await withInstance(async () => {
      const sessionID = "test-cap-undefined"
      ensureSession(sessionID)

      await HookChain.execute("pre-llm", {
        sessionID,
        system: ["You are helpful"],
        agent: "build",
        model: "test/model",
        messages: [{ role: "user", content: "hello" }],
      })

      const logCount = Database.use((db) =>
        db.select({ count: count() }).from(LlmLogTable).where(eq(LlmLogTable.session_id, sessionID)).get(),
      )
      expect(logCount?.count).toBeGreaterThan(0)
    })
  })

  test("log capture does NOT fire when config.llmLog.enabled is false", async () => {
    await withInstance(
      async () => {
        const sessionID = "test-cap-disabled"
        ensureSession(sessionID)

        await HookChain.execute("pre-llm", {
          sessionID,
          system: ["You are helpful"],
          agent: "build",
          model: "test/model",
          messages: [{ role: "user", content: "hello" }],
        })

        const logCount = Database.use((db) =>
          db.select({ count: count() }).from(LlmLogTable).where(eq(LlmLogTable.session_id, sessionID)).get(),
        )
        expect(logCount?.count).toBe(0)
      },
      { llmLog: { enabled: false } },
    )
  })

  test("log capture fires when config.llmLog.enabled is explicitly true", async () => {
    await withInstance(
      async () => {
        const sessionID = "test-cap-explicit"
        ensureSession(sessionID)

        await HookChain.execute("pre-llm", {
          sessionID,
          system: ["You are helpful"],
          agent: "build",
          model: "test/model",
          messages: [{ role: "user", content: "hello" }],
        })

        const logCount = Database.use((db) =>
          db.select({ count: count() }).from(LlmLogTable).where(eq(LlmLogTable.session_id, sessionID)).get(),
        )
        expect(logCount?.count).toBeGreaterThan(0)
      },
      { llmLog: { enabled: true } },
    )
  })

  // --- Log state tracking ---

  test("pre-llm hook stores log ID in per-instance state", async () => {
    await withInstance(async () => {
      const sessionID = "test-cap-state"
      ensureSession(sessionID)

      await HookChain.execute("pre-llm", {
        sessionID,
        system: ["prompt"],
        agent: "build",
        model: "test/model",
        messages: [],
      })

      const state = currentLlmLogState().get(sessionID)
      expect(state).toBeDefined()
      expect(state!.logId).toBeTruthy()
      expect(state!.timeStart).toBeGreaterThan(0)
    })
  })

  // --- Log record fields ---

  test("captured log record has correct fields", async () => {
    await withInstance(async () => {
      const sessionID = "test-cap-fields"
      ensureSession(sessionID)

      await HookChain.execute("pre-llm", {
        sessionID,
        system: ["system prompt"],
        agent: "sisyphus",
        model: "anthropic/claude-opus-4-6",
        variant: "max",
        messages: [{ role: "user", content: "test" }],
      })

      const record = Database.use((db) =>
        db.select().from(LlmLogTable).where(eq(LlmLogTable.session_id, sessionID)).get(),
      )

      expect(record).toBeDefined()
      expect(record!.session_id).toBe(sessionID)
      expect(record!.agent).toBe("sisyphus")
      expect(record!.model).toBe("anthropic/claude-opus-4-6")
      expect(record!.provider).toBe("anthropic")
      expect(record!.variant).toBe("max")
      expect(record!.status).toBe("pending")
      expect(record!.time_start).toBeGreaterThan(0)
    })
  })
})
