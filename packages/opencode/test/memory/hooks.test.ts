import { describe, test, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Memory } from "../../src/memory/memory"
import { MemoryStorage } from "../../src/memory/storage"
import { MemoryInject } from "../../src/memory/engine/injector"
import { registerMemoryInjector } from "../../src/memory/hooks/inject"
import { HookChain } from "../../src/session/hooks"
import { tmpdir } from "../fixture/fixture"

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  return Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await MemoryStorage.clear()
      return fn()
    },
  })
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
