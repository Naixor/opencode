import { describe, it, test, expect, mock, spyOn, afterEach } from "bun:test"
import { MemoryRecall } from "../../src/memory/engine/recall"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import type { Memory } from "../../src/memory/memory"

describe("MemoryRecall", () => {
  describe("Result schema", () => {
    it("should validate a valid recall result", () => {
      const data = {
        relevant: ["mem_abc", "mem_def"],
        conflicts: [{ memoryA: "mem_abc", memoryB: "mem_def", reason: "Conflicting framework choice" }],
      }
      const parsed = MemoryRecall.Result.parse(data)
      expect(parsed.relevant).toHaveLength(2)
      expect(parsed.conflicts).toHaveLength(1)
      expect(parsed.conflicts[0].reason).toBe("Conflicting framework choice")
    })

    it("should validate empty recall result", () => {
      const parsed = MemoryRecall.Result.parse({ relevant: [], conflicts: [] })
      expect(parsed.relevant).toHaveLength(0)
      expect(parsed.conflicts).toHaveLength(0)
    })

    it("should reject missing fields", () => {
      expect(() => MemoryRecall.Result.parse({})).toThrow()
      expect(() => MemoryRecall.Result.parse({ relevant: [] })).toThrow()
    })

    it("should reject invalid conflict structure", () => {
      expect(() => MemoryRecall.Result.parse({ relevant: [], conflicts: [{ memoryA: "x" }] })).toThrow()
    })
  })

  describe("invoke — error paths", () => {
    const spies: Array<ReturnType<typeof spyOn>> = []

    afterEach(() => {
      for (const s of spies) s.mockRestore()
      spies.length = 0
    })

    function mem(id: string): Memory.Info {
      const now = Date.now()
      return {
        id,
        content: "test",
        category: "context",
        scope: "personal",
        status: "confirmed",
        tags: [],
        citations: [],
        score: 1,
        baseScore: 1,
        useCount: 0,
        hitCount: 0,
        source: { sessionID: "s", method: "manual" },
        createdAt: now,
        updatedAt: now,
        inject: false,
      } as Memory.Info
    }

    const input = {
      sessionID: "ses_test",
      memories: [mem("mem_1"), mem("mem_2")],
      recentMessages: [{ role: "user", content: "hello" }],
    }

    test("fallback when Config.get() throws", async () => {
      // No stubs → Config.get() fails → catch → fallback
      const result = await MemoryRecall.invoke(input)
      expect(result.relevant).toEqual(["mem_1", "mem_2"])
      expect(result.conflicts).toEqual([])
    }, 15000)

    test("fallback when Provider.defaultModel() throws", async () => {
      spies.push(
        spyOn(Config, "get").mockResolvedValue({ memory: {} } as any),
        spyOn(Provider, "defaultModel").mockRejectedValue(new Error("no provider")),
      )
      const result = await MemoryRecall.invoke(input)
      expect(result.relevant).toEqual(["mem_1", "mem_2"])
      expect(result.conflicts).toEqual([])
    })

    test("sync throw in Config.get() still returns fallback", async () => {
      spies.push(
        spyOn(Config, "get").mockImplementation(() => {
          throw new Error("sync boom")
        }),
      )
      const result = await MemoryRecall.invoke(input)
      expect(result.relevant).toEqual(["mem_1", "mem_2"])
      expect(result.conflicts).toEqual([])
    })
  })
})
