import { describe, test, expect, beforeEach } from "bun:test"
import { MemoryInject } from "../../src/memory/engine/injector"
import type { Memory } from "../../src/memory/memory"

function makeMemory(overrides?: Partial<Memory.Info>): Memory.Info {
  const now = Date.now()
  return {
    id: "mem_" + Math.random().toString(36).slice(2),
    content: "test content",
    category: "pattern",
    scope: "personal",
    status: "confirmed",
    tags: [],
    source: { sessionID: "sess_1", method: "auto" as const },
    citations: [],
    inject: false,
    score: 5.0,
    baseScore: 5.0,
    useCount: 0,
    hitCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Memory.Info
}

describe("MemoryInject", () => {
  describe("buildCandidatePool", () => {
    test("includes all manual memories", () => {
      const manual = makeMemory({ source: { sessionID: "s1", method: "manual" }, score: 1.0 })
      const auto = makeMemory({ source: { sessionID: "s1", method: "auto" }, score: 10.0 })
      const pool = MemoryInject.buildCandidatePool([manual, auto])
      expect(pool).toContain(manual)
      expect(pool).toContain(auto)
    })

    test("includes memories with inject: true as manual", () => {
      const injected = makeMemory({ inject: true, source: { sessionID: "s1", method: "auto" } })
      const pool = MemoryInject.buildCandidatePool([injected])
      expect(pool).toContain(injected)
    })

    test("includes pulled memories as manual", () => {
      const pulled = makeMemory({ source: { sessionID: "s1", method: "pulled" } })
      const pool = MemoryInject.buildCandidatePool([pulled])
      expect(pool).toContain(pulled)
    })

    test("sorts auto memories by score descending", () => {
      const low = makeMemory({ id: "low", score: 1.0, source: { sessionID: "s1", method: "auto" } })
      const mid = makeMemory({ id: "mid", score: 5.0, source: { sessionID: "s1", method: "auto" } })
      const high = makeMemory({ id: "high", score: 10.0, source: { sessionID: "s1", method: "auto" } })

      const pool = MemoryInject.buildCandidatePool([low, high, mid])
      // All should be included (well under limit)
      expect(pool.length).toBe(3)
      // Auto memories are sorted by score
      const autoInPool = pool.filter((m) => !m.inject && m.source.method !== "manual")
      expect(autoInPool[0].id).toBe("high")
      expect(autoInPool[1].id).toBe("mid")
      expect(autoInPool[2].id).toBe("low")
    })

    test("returns empty for empty input", () => {
      expect(MemoryInject.buildCandidatePool([])).toEqual([])
    })
  })

  describe("getPhase", () => {
    test("returns 'full' for low message count", () => {
      expect(MemoryInject.getPhase(0)).toBe("full")
      expect(MemoryInject.getPhase(1)).toBe("full")
      expect(MemoryInject.getPhase(2)).toBe("full")
    })

    test("returns 'recall' at threshold", () => {
      expect(MemoryInject.getPhase(3)).toBe("recall")
      expect(MemoryInject.getPhase(10)).toBe("recall")
    })
  })

  describe("shouldReRecall", () => {
    test("returns true when no cache exists", () => {
      expect(MemoryInject.shouldReRecall("new-session", 5)).toBe(true)
    })

    test("returns false when cache is fresh", () => {
      MemoryInject.cacheRecallResult("sess_a", { relevant: [], conflicts: [] }, 5)
      expect(MemoryInject.shouldReRecall("sess_a", 6)).toBe(false)
    })

    test("returns true after RE_RECALL_INTERVAL messages", () => {
      MemoryInject.cacheRecallResult("sess_b", { relevant: [], conflicts: [] }, 5)
      expect(MemoryInject.shouldReRecall("sess_b", 10)).toBe(true) // 10 - 5 = 5 >= RE_RECALL_INTERVAL
    })
  })

  describe("formatMemoriesForPrompt", () => {
    test("returns empty string for no memories", () => {
      expect(MemoryInject.formatMemoriesForPrompt([])).toBe("")
    })

    test("formats memories with category tags", () => {
      const m = makeMemory({ content: "Always use semicolons", category: "style", tags: ["formatting"] })
      const result = MemoryInject.formatMemoriesForPrompt([m])
      expect(result).toContain("<memory>")
      expect(result).toContain("style:")
      expect(result).toContain("Always use semicolons")
      expect(result).toContain("#formatting")
      expect(result).toContain("</memory>")
    })

    test("marks team memories", () => {
      const m = makeMemory({ scope: "team", content: "Team convention" })
      const result = MemoryInject.formatMemoriesForPrompt([m])
      expect(result).toContain("[team]")
    })

    test("clips long memories and limits tags", () => {
      const m = makeMemory({
        content: "a".repeat(220),
        tags: ["one", "two", "three", "four"],
      })
      const result = MemoryInject.formatMemoriesForPrompt([m])
      expect(result).toContain("...")
      expect(result).toContain("#one #two #three +1")
    })
  })

  describe("formatConflictWarning", () => {
    test("returns empty for no conflicts", () => {
      expect(MemoryInject.formatConflictWarning([])).toBe("")
    })

    test("formats conflict warnings", () => {
      const result = MemoryInject.formatConflictWarning([
        { memoryA: "mem_1", memoryB: "mem_2", reason: "contradictory style rules" },
      ])
      expect(result).toContain("<memory-conflicts>")
      expect(result).toContain("mem_1")
      expect(result).toContain("contradictory style rules")
    })
  })

  describe("countUserMessages", () => {
    test("counts only user role messages", () => {
      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "help" },
        { role: "system", content: "you are..." },
      ]
      expect(MemoryInject.countUserMessages(messages)).toBe(2)
    })

    test("returns 0 for empty messages", () => {
      expect(MemoryInject.countUserMessages([])).toBe(0)
    })
  })

  describe("cache management", () => {
    test("cacheRecallResult and getCachedRecall round-trip", () => {
      MemoryInject.cacheRecallResult("sess_x", { relevant: ["m1", "m2"], conflicts: [] }, 3)
      const cached = MemoryInject.getCachedRecall("sess_x")
      expect(cached).toBeDefined()
      expect(cached!.relevant).toEqual(["m1", "m2"])
      expect(cached!.count).toBe(3)
    })

    test("clearCache removes entry", () => {
      MemoryInject.cacheRecallResult("sess_y", { relevant: [], conflicts: [] }, 1)
      MemoryInject.clearCache("sess_y")
      expect(MemoryInject.getCachedRecall("sess_y")).toBeUndefined()
    })
  })
})
