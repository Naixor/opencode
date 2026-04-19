import { describe, test, expect, spyOn } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import type { Config } from "../../src/config/config"
import { Memory } from "../../src/memory/memory"
import { MemoryStorage } from "../../src/memory/storage"
import { MemoryInject } from "../../src/memory/engine/injector"
import { registerMemoryInjector } from "../../src/memory/hooks/inject"
import { registerHitTracker } from "../../src/memory/hooks/hit-tracker"
import { MemoryHindsightRetain } from "../../src/memory/hindsight/retain"
import { MemoryHindsightRecall } from "../../src/memory/hindsight/recall"
import { MemoryHindsightState } from "../../src/memory/hindsight/state"
import { MemoryRecall } from "../../src/memory/engine/recall"
import { HookChain } from "../../src/session/hooks"
import { tmpdir } from "../fixture/fixture"

async function withInstance<T>(fn: () => Promise<T>, config?: Partial<Config.Info>): Promise<T> {
  await using tmp = await tmpdir({ git: true, config })
  return Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await MemoryStorage.clear()
      return fn()
    },
  })
}

const hindsight = {
  enabled: true,
  mode: "embedded" as const,
  extract: true,
  recall: true,
  backfill: true,
  auto_start: true,
  workspace_scope: "worktree" as const,
  context_max_items: 6,
  context_max_tokens: 1200,
}

describe("Memory Hooks (unit-level)", () => {
  describe("inject hook logic — MemoryInject", () => {
    test("formatMemoriesForPrompt generates correct XML block", () => {
      const memories: Memory.Info[] = [
        {
          id: "mem_1",
          content: "Use Hono for HTTP",
          categories: ["tool"],
          scope: "personal",
          tags: ["framework"],
          status: "confirmed",
          score: 5.0,
          baseScore: 5.0,
          useCount: 3,
          hitCount: 1,
          source: { sessionID: "s1", method: "manual" },
          citations: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          inject: false,
        },
      ]

      const result = MemoryInject.formatMemoriesForPrompt(memories)
      expect(result).toContain("<memory>")
      expect(result).toContain("</memory>")
      expect(result).toContain("tool:")
      expect(result).toContain("Use Hono for HTTP")
      expect(result).toContain("#framework")
    })

    test("formatMemoriesForPrompt returns empty for no memories", () => {
      expect(MemoryInject.formatMemoriesForPrompt([])).toBe("")
    })

    test("formatMemoriesForPrompt shows team scope", () => {
      const memories: Memory.Info[] = [
        {
          id: "mem_team1",
          content: "API convention: snake_case",
          categories: ["pattern"],
          scope: "team",
          tags: [],
          status: "confirmed",
          score: 3.0,
          baseScore: 3.0,
          useCount: 0,
          hitCount: 0,
          source: { sessionID: "s1", method: "pulled" },
          citations: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          inject: false,
        },
      ]

      const result = MemoryInject.formatMemoriesForPrompt(memories)
      expect(result).toContain("[team]")
    })

    test("formatMemoriesForPrompt groups memories by category", () => {
      const memories = [
        makeMemory({ id: "mem_tool", categories: ["tool"], content: "Use Bun" }),
        makeMemory({ id: "mem_style", categories: ["style"], content: "No semicolons" }),
      ]

      const result = MemoryInject.formatMemoriesForPrompt(memories)
      expect(result.indexOf("style:")).toBeLessThan(result.indexOf("tool:"))
    })

    test("formatConflictWarning generates warning block", () => {
      const conflicts = [{ memoryA: "mem_1", memoryB: "mem_2", reason: "Different framework choices" }]
      const result = MemoryInject.formatConflictWarning(conflicts)
      expect(result).toContain("<memory-conflicts>")
      expect(result).toContain("Different framework choices")
    })

    test("formatConflictWarning returns empty for no conflicts", () => {
      expect(MemoryInject.formatConflictWarning([])).toBe("")
    })
  })

  describe("inject hook logic — recall cache", () => {
    test("cacheRecallResult and getCachedRecall roundtrip", () => {
      const sessionID = "ses_cache_test_" + Date.now()
      MemoryInject.cacheRecallResult(
        sessionID,
        {
          relevant: ["mem_1", "mem_2"],
          conflicts: [],
        },
        5,
      )

      const cached = MemoryInject.getCachedRecall(sessionID)
      expect(cached).toBeTruthy()
      expect(cached!.relevant).toEqual(["mem_1", "mem_2"])
      expect(cached!.count).toBe(5)

      // Cleanup
      MemoryInject.clearCache(sessionID)
      expect(MemoryInject.getCachedRecall(sessionID)).toBeUndefined()
    })

    test("shouldReRecall returns true on first call", () => {
      const sessionID = "ses_rerecall_" + Date.now()
      expect(MemoryInject.shouldReRecall(sessionID, 5)).toBe(true)
    })

    test("shouldReRecall returns false when recently cached", () => {
      const sessionID = "ses_rerecall2_" + Date.now()
      MemoryInject.cacheRecallResult(sessionID, { relevant: [], conflicts: [] }, 5)
      expect(MemoryInject.shouldReRecall(sessionID, 6)).toBe(false)
      MemoryInject.clearCache(sessionID)
    })

    test("shouldReRecall returns true after RE_RECALL_INTERVAL", () => {
      const sessionID = "ses_rerecall3_" + Date.now()
      MemoryInject.cacheRecallResult(sessionID, { relevant: [], conflicts: [] }, 3)
      // RECALL_THRESHOLD is 3, RE_RECALL_INTERVAL is 5
      expect(MemoryInject.shouldReRecall(sessionID, 8)).toBe(true)
      MemoryInject.clearCache(sessionID)
    })

    test("shouldReRecall returns true when dirty", async () => {
      await withInstance(async () => {
        const sessionID = "ses_rerecall_dirty"
        MemoryInject.cacheRecallResult(sessionID, { relevant: [], conflicts: [] }, 3)
        // Mark dirty simulates user running /remember
        Memory.markDirty(sessionID)
        expect(MemoryInject.shouldReRecall(sessionID, 4)).toBe(true)
        MemoryInject.clearCache(sessionID)
      })
    })
  })

  describe("legacy memory compatibility", () => {
    test("injector migrates legacy category records and still injects memory", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          HookChain.reset()
          MemoryInject.reset()
          await MemoryStorage.clear()

          const dir = path.join(Global.Path.data, "memory", encodeURIComponent(tmp.path))
          const file = path.join(dir, "personal.json")
          const now = Date.now()
          await fs.mkdir(dir, { recursive: true })
          await Bun.write(
            file,
            JSON.stringify(
              {
                memories: {
                  mem_legacy: {
                    id: "mem_legacy",
                    content: "Use Hono for HTTP",
                    category: "tool",
                    scope: "personal",
                    status: "confirmed",
                    tags: ["framework"],
                    citations: [],
                    score: 1,
                    baseScore: 1,
                    useCount: 0,
                    hitCount: 0,
                    source: { sessionID: "ses_legacy", method: "manual" },
                    createdAt: now,
                    updatedAt: now,
                    inject: false,
                  },
                },
                meta: {},
              },
              null,
              2,
            ),
          )
          MemoryStorage.invalidate()

          registerMemoryInjector()

          const ctx: HookChain.PreLLMContext = {
            sessionID: "ses_legacy",
            system: ["base"],
            agent: "sisyphus",
            model: "claude-sonnet-4-5-20250929",
            messages: [{ role: "user", content: "remember project rules" }],
          }

          await HookChain.execute("pre-llm", ctx)

          expect(ctx.system.some((item) => item.includes("Use Hono for HTTP"))).toBe(true)

          const text = await Bun.file(file).text()
          expect(text).toContain('"categories": [')
          expect(text).not.toContain('"category": "tool"')
        },
      })
    })

    test("injector errors are surfaced instead of swallowed", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          HookChain.reset()
          MemoryInject.reset()
          await MemoryStorage.clear()

          const dir = path.join(Global.Path.data, "memory", encodeURIComponent(tmp.path))
          const file = path.join(dir, "personal.json")
          await fs.mkdir(dir, { recursive: true })
          await Bun.write(file, JSON.stringify({ memories: { broken: { id: "broken" } }, meta: {} }, null, 2))
          MemoryStorage.invalidate()

          registerMemoryInjector()

          const ctx: HookChain.PreLLMContext = {
            sessionID: "ses_broken",
            system: ["base"],
            agent: "sisyphus",
            model: "claude-sonnet-4-5-20250929",
            messages: [{ role: "user", content: "hello" }],
          }

          await expect(HookChain.execute("pre-llm", ctx)).rejects.toThrow("memory injector failed")
        },
      })
    })
  })

  describe("inject hook logic — phase selection", () => {
    test("getPhase returns full for early conversation", () => {
      expect(MemoryInject.getPhase(0)).toBe("full")
      expect(MemoryInject.getPhase(1)).toBe("full")
      expect(MemoryInject.getPhase(2)).toBe("full")
    })

    test("getPhase returns recall after threshold", () => {
      expect(MemoryInject.getPhase(3)).toBe("recall")
      expect(MemoryInject.getPhase(10)).toBe("recall")
    })
  })

  describe("authoritative lifecycle boundaries", () => {
    test("early pre-llm injection uses hindsight recall when llm recall is not triggered", async () => {
      await withInstance(
        async () => {
          HookChain.reset()
          MemoryInject.reset()
          registerMemoryInjector()

          const retain = spyOn(MemoryHindsightRetain, "memory").mockResolvedValue({
            status: "retained",
            document_id: "mem:test",
            result: { success: true, bank_id: "bank_test", items_count: 1, async: false },
          })

          const one = await Memory.create({
            content: "Use Hono routes for APIs",
            categories: ["tool"],
            scope: "personal",
            source: { sessionID: "ses_hs", method: "manual" },
          })
          const two = await Memory.create({
            content: "Use Drizzle for schema changes",
            categories: ["pattern"],
            scope: "personal",
            source: { sessionID: "ses_hs", method: "manual" },
          })

          const hs = spyOn(MemoryHindsightRecall, "query").mockResolvedValue({
            raw: { results: [] } as never,
            hits: 1,
            candidates: [
              {
                memory: two,
                memory_id: two.id,
                document_id: `mem:test:${two.id}`,
                rank: 1,
                score: 0.91,
                reason: "document_id",
              },
            ],
            drops: [],
          })
          const llm = spyOn(MemoryRecall, "invoke")

          try {
            const ctx: HookChain.PreLLMContext = {
              sessionID: "ses_hs",
              system: ["base"],
              agent: "sisyphus",
              model: "claude-sonnet-4-5-20250929",
              messages: [{ role: "user", content: "how should I wire routes?" }],
            }

            await HookChain.execute("pre-llm", ctx)

            expect(hs).toHaveBeenCalled()
            expect(llm).not.toHaveBeenCalled()
            expect(ctx.system.some((item) => item.includes(two.content))).toBe(true)
            expect(ctx.system.some((item) => item.includes(one.content))).toBe(false)
          } finally {
            retain.mockRestore()
            hs.mockRestore()
            llm.mockRestore()
          }
        },
        {
          memory: {
            hindsight,
          },
        },
      )
    })

    test("early pre-llm injection falls back to full pool when hindsight recall is empty", async () => {
      await withInstance(
        async () => {
          HookChain.reset()
          MemoryInject.reset()
          registerMemoryInjector()

          const retain = spyOn(MemoryHindsightRetain, "memory").mockResolvedValue({
            status: "retained",
            document_id: "mem:test",
            result: { success: true, bank_id: "bank_test", items_count: 1, async: false },
          })

          const one = await Memory.create({
            content: "Use Hono routes for APIs",
            categories: ["tool"],
            scope: "personal",
            source: { sessionID: "ses_hs_empty", method: "manual" },
          })
          const two = await Memory.create({
            content: "Use Drizzle for schema changes",
            categories: ["pattern"],
            scope: "personal",
            source: { sessionID: "ses_hs_empty", method: "manual" },
          })

          const hs = spyOn(MemoryHindsightRecall, "query").mockResolvedValue({
            raw: { results: [] } as never,
            hits: 0,
            candidates: [],
            drops: [],
          })
          const llm = spyOn(MemoryRecall, "invoke")

          try {
            const ctx: HookChain.PreLLMContext = {
              sessionID: "ses_hs_empty",
              system: ["base"],
              agent: "sisyphus",
              model: "claude-sonnet-4-5-20250929",
              messages: [{ role: "user", content: "how should I wire routes?" }],
            }

            await HookChain.execute("pre-llm", ctx)

            expect(hs).toHaveBeenCalled()
            expect(llm).not.toHaveBeenCalled()
            expect(ctx.system.some((item) => item.includes(one.content))).toBe(true)
            expect(ctx.system.some((item) => item.includes(two.content))).toBe(true)
          } finally {
            retain.mockRestore()
            hs.mockRestore()
            llm.mockRestore()
          }
        },
        {
          memory: {
            hindsight,
          },
        },
      )
    })

    test("inject hook still consumes local memories when hindsight ranking is enabled", async () => {
      await withInstance(
        async () => {
          HookChain.reset()
          MemoryInject.reset()
          registerMemoryInjector()

          const retain = spyOn(MemoryHindsightRetain, "memory").mockResolvedValue({
            status: "retained",
            document_id: "mem:test",
            result: { success: true, bank_id: "bank_test", items_count: 1, async: false },
          })

          const mem = await Memory.create({
            content: "Use Hono routes for APIs",
            categories: ["tool"],
            scope: "personal",
            source: { sessionID: "ses_local", method: "manual" },
          })

          const stub = spyOn(MemoryRecall, "invoke").mockResolvedValue({
            relevant: [mem.id],
            conflicts: [],
          })

          try {
            const ctx: HookChain.PreLLMContext = {
              sessionID: "ses_local",
              system: ["base"],
              agent: "sisyphus",
              model: "claude-sonnet-4-5-20250929",
              messages: [
                { role: "user", content: "first" },
                { role: "assistant", content: "ok" },
                { role: "user", content: "second" },
                { role: "assistant", content: "ok" },
                { role: "user", content: "third" },
              ],
            }

            await HookChain.execute("pre-llm", ctx)

            expect(stub).toHaveBeenCalled()
            expect(ctx.system.some((item) => item.includes(mem.content))).toBe(true)
            expect(ctx.system.some((item) => item.includes("document_id"))).toBe(false)

            const next = await Memory.get(mem.id)
            expect(next?.useCount).toBe(1)
          } finally {
            retain.mockRestore()
            stub.mockRestore()
          }
        },
        {
          memory: {
            hindsight,
          },
        },
      )
    })

    test("hit tracker still updates local records when hindsight is enabled", async () => {
      await withInstance(
        async () => {
          HookChain.reset()
          MemoryInject.reset()
          registerHitTracker()

          const retain = spyOn(MemoryHindsightRetain, "memory").mockResolvedValue({
            status: "retained",
            document_id: "mem:test",
            result: { success: true, bank_id: "bank_test", items_count: 1, async: false },
          })

          const mem = await Memory.create({
            content: "Hono routing conventions stay local",
            categories: ["pattern"],
            scope: "personal",
            source: { sessionID: "ses_hit", method: "manual" },
          })

          MemoryInject.cacheRecallResult(
            "ses_hit",
            {
              relevant: [mem.id],
              conflicts: [],
            },
            3,
          )

          const ctx: HookChain.PostToolContext = {
            sessionID: "ses_hit",
            toolName: "write",
            args: {},
            result: {
              output: "The Hono routing conventions stay local in this write result.",
            },
            agent: "sisyphus",
          }

          await HookChain.execute("post-tool", ctx)

          const next = await Memory.get(mem.id)
          expect(next?.hitCount).toBe(1)
          retain.mockRestore()
        },
        {
          memory: {
            hindsight,
          },
        },
      )
    })

    test("completed backfill sidecar does not break local reads or injection when hindsight is disabled", async () => {
      await withInstance(
        async () => {
          HookChain.reset()
          MemoryInject.reset()
          registerMemoryInjector()

          const mem = await Memory.create({
            content: "Keep local memory reads authoritative",
            categories: ["pattern"],
            scope: "personal",
            source: { sessionID: "ses_disabled", method: "manual" },
          })

          await MemoryHindsightState.save({
            version: 1,
            bank_id: "bank_done",
            workspace_hash: "hash_done",
            workspace_scope: "worktree",
            updated_at: 0,
            backfill: {
              status: "completed",
              mode: "auto",
              started_at: 1,
              updated_at: 0,
              completed_at: 2,
              cursor: mem.id,
              last_memory_id: mem.id,
              last_document_id: `mem:hash_done:${mem.id}`,
              processed: 1,
              succeeded: 1,
              failed: 0,
              skipped: 0,
              batch_size: 1,
              operation_ids: [],
              failures: [],
            },
          })

          expect((await Memory.list()).map((item) => item.id)).toContain(mem.id)

          const stub = spyOn(MemoryRecall, "invoke").mockResolvedValue({
            relevant: [mem.id],
            conflicts: [],
          })

          try {
            const ctx: HookChain.PreLLMContext = {
              sessionID: "ses_disabled",
              system: ["base"],
              agent: "sisyphus",
              model: "claude-sonnet-4-5-20250929",
              messages: [
                { role: "user", content: "first" },
                { role: "assistant", content: "ok" },
                { role: "user", content: "second" },
                { role: "assistant", content: "ok" },
                { role: "user", content: "third" },
              ],
            }

            await HookChain.execute("pre-llm", ctx)

            expect(ctx.system.some((item) => item.includes(mem.content))).toBe(true)
          } finally {
            stub.mockRestore()
          }
        },
        {
          memory: {
            hindsight: {
              ...hindsight,
              enabled: false,
            },
          },
        },
      )
    })
  })

  describe("inject hook logic — buildCandidatePool", () => {
    test("includes all manual memories", () => {
      const memories = [
        makeMemory({ id: "mem_manual", source: { method: "manual", sessionID: "s1" }, score: 0.1 }),
        makeMemory({ id: "mem_auto", source: { method: "auto", sessionID: "s2" }, score: 0.5 }),
      ]
      const pool = MemoryInject.buildCandidatePool(memories)
      expect(pool.find((m) => m.id === "mem_manual")).toBeTruthy()
    })

    test("includes pinned memories", () => {
      const memories = [
        makeMemory({ id: "mem_pinned", inject: true, source: { method: "auto", sessionID: "s1" }, score: 0.01 }),
        makeMemory({ id: "mem_auto", source: { method: "auto", sessionID: "s2" }, score: 5.0 }),
      ]
      const pool = MemoryInject.buildCandidatePool(memories)
      expect(pool.find((m) => m.id === "mem_pinned")).toBeTruthy()
    })

    test("sorts auto memories by score", () => {
      const memories = [
        makeMemory({ id: "mem_low", source: { method: "auto", sessionID: "s1" }, score: 1.0 }),
        makeMemory({ id: "mem_high", source: { method: "auto", sessionID: "s2" }, score: 9.0 }),
      ]
      const pool = MemoryInject.buildCandidatePool(memories)
      expect(pool.length).toBe(2)
      // High score should appear in the pool
      expect(pool.find((m) => m.id === "mem_high")).toBeTruthy()
    })
  })

  describe("countUserMessages", () => {
    test("counts user role messages", () => {
      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "how" },
        { role: "system", content: "..." },
      ]
      expect(MemoryInject.countUserMessages(messages)).toBe(2)
    })

    test("returns 0 for empty messages", () => {
      expect(MemoryInject.countUserMessages([])).toBe(0)
    })
  })
})

function makeMemory(overrides: Partial<Memory.Info> & { id: string }): Memory.Info {
  const now = Date.now()
  return {
    content: "test memory",
    categories: ["context"],
    scope: "personal",
    status: "confirmed",
    tags: [],
    citations: [],
    score: 1.0,
    baseScore: 1.0,
    useCount: 0,
    hitCount: 0,
    source: { sessionID: "s1", method: "manual" },
    createdAt: now,
    updatedAt: now,
    inject: false,
    ...overrides,
  } as Memory.Info
}
