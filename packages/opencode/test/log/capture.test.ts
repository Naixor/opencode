import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { HookChain } from "../../src/session/hooks"
import { registerAllHooks } from "../../src/session/hooks/register"
import { Database, eq } from "../../src/storage/db"
import { LlmLogResponseTable, LlmLogTable } from "../../src/log/log.sql"
import { SessionTable } from "../../src/session/session.sql"
import { currentLlmLogState } from "../../src/log/log-state"
import { count, sql } from "drizzle-orm"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { LlmLog } from "../../src/log/query"

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

  test("response capture reads persisted assistant parts when message metadata has no parts", async () => {
    await withInstance(async () => {
      const session = await Session.create({})
      const now = Date.now()
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        parentID: "msg-parent",
        role: "assistant",
        mode: "memory-extractor",
        agent: "memory-extractor",
        path: {
          cwd: Instance.directory,
          root: Instance.worktree,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: "test/model",
        providerID: "test",
        time: {
          created: now,
        },
        sessionID: session.id,
      } satisfies MessageV2.Assistant)

      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: session.id,
        type: "text",
        text: '{"items":[]}',
      } satisfies MessageV2.TextPart)

      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: session.id,
        type: "tool",
        callID: "call-1",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "foo.txt" },
          output: "ok",
          title: "Reads file",
          metadata: {},
          time: {
            start: now,
            end: now + 1,
          },
        },
      } satisfies MessageV2.ToolPart)

      await HookChain.execute("pre-llm", {
        sessionID: session.id,
        system: ["prompt"],
        agent: "memory-extractor",
        model: "test/model",
        messages: [{ role: "user", content: "hello" }],
      })

      await HookChain.execute("session-lifecycle", {
        sessionID: session.id,
        event: "step.finished",
        data: {
          usage: {
            cost: 0,
            tokens: {
              total: 3,
              input: 1,
              output: 2,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          finishReason: "stop",
          model: { id: "test/model" },
          assistantMessage: msg,
          response: {
            id: "res_1",
            modelId: "test/model",
            timestamp: new Date(now),
            headers: { "x-test": "1" },
          },
        },
      })

      const logId = currentLlmLogState().get(session.id)?.logId
      expect(logId).toBeDefined()

      const row = Database.use((db) =>
        db.select().from(LlmLogResponseTable).where(eq(LlmLogResponseTable.llm_log_id, logId!)).get(),
      )

      expect(row?.completion_text).toBe('{"items":[]}')
      expect(row?.tool_calls).toEqual([
        {
          id: "call-1",
          name: "read",
          args: { filePath: "foo.txt" },
        },
      ])
    })
  })

  test("list reaps stale pending logs that never finished as aborted", async () => {
    await withInstance(async () => {
      const sessionID = "test-cap-stale-abort"
      ensureSession(sessionID)

      await HookChain.execute("pre-llm", {
        sessionID,
        system: ["prompt"],
        agent: "oracle",
        model: "test/model",
        messages: [],
      })

      const now = Date.now()
      Database.use((db) => {
        db.update(LlmLogTable)
          .set({
            time_start: now - 6 * 60 * 1000,
            time_created: now - 6 * 60 * 1000,
            time_updated: now - 6 * 60 * 1000,
          })
          .where(eq(LlmLogTable.session_id, sessionID))
          .run()
      })

      const result = LlmLog.list({ session_id: sessionID })
      expect(result.items).toHaveLength(1)
      expect(result.items[0]?.status).toBe("aborted")
      expect(result.items[0]?.time_end).toBeGreaterThan(0)
      expect(result.items[0]?.duration_ms).toBeGreaterThan(0)
    })
  })

  test("get reaps stale pending logs with captured response as success or error", async () => {
    await withInstance(async () => {
      const successID = "test-cap-stale-success"
      const errorID = "test-cap-stale-error"
      ensureSession(successID)
      ensureSession(errorID)

      await HookChain.execute("pre-llm", {
        sessionID: successID,
        system: ["prompt"],
        agent: "oracle",
        model: "test/model",
        messages: [],
      })
      await HookChain.execute("pre-llm", {
        sessionID: errorID,
        system: ["prompt"],
        agent: "oracle",
        model: "test/model",
        messages: [],
      })

      const successLog = Database.use((db) =>
        db.select().from(LlmLogTable).where(eq(LlmLogTable.session_id, successID)).get(),
      )
      const errorLog = Database.use((db) =>
        db.select().from(LlmLogTable).where(eq(LlmLogTable.session_id, errorID)).get(),
      )
      expect(successLog?.id).toBeTruthy()
      expect(errorLog?.id).toBeTruthy()

      const now = Date.now()
      Database.use((db) => {
        db.update(LlmLogTable)
          .set({
            time_start: now - 6 * 60 * 1000,
            time_created: now - 6 * 60 * 1000,
            time_updated: now - 6 * 60 * 1000,
          })
          .where(eq(LlmLogTable.id, successLog!.id))
          .run()
        db.update(LlmLogTable)
          .set({
            time_start: now - 6 * 60 * 1000,
            time_created: now - 6 * 60 * 1000,
            time_updated: now - 6 * 60 * 1000,
          })
          .where(eq(LlmLogTable.id, errorLog!.id))
          .run()
        db.insert(LlmLogResponseTable)
          .values({
            id: Identifier.ascending("log"),
            llm_log_id: successLog!.id,
            completion_text: "done",
            tool_calls: null,
            raw_response: null,
            error: null,
          })
          .run()
        db.insert(LlmLogResponseTable)
          .values({
            id: Identifier.ascending("log"),
            llm_log_id: errorLog!.id,
            completion_text: null,
            tool_calls: null,
            raw_response: null,
            error: { message: "boom" },
          })
          .run()
      })

      expect(LlmLog.get(successLog!.id).status).toBe("success")
      expect(LlmLog.get(errorLog!.id).status).toBe("error")
    })
  })
})
