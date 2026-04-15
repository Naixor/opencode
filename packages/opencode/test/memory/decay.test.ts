import { describe, test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import type { Config } from "../../src/config/config"
import { MemoryDecay } from "../../src/memory/optimizer/decay"
import { Memory } from "../../src/memory/memory"
import { MemoryStorage } from "../../src/memory/storage"
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
  workspace_scope: "worktree" as const,
  context_max_items: 6,
  context_max_tokens: 1200,
}

function makeMemory(overrides?: Partial<Memory.Info>): Memory.Info {
  const now = Date.now()
  return {
    id: "mem_test",
    content: "test content",
    category: "pattern",
    scope: "personal",
    status: "confirmed",
    tags: [],
    source: { sessionId: "sess_1", method: "explicit" },
    inject: false,
    score: 10.0,
    baseScore: 10.0,
    useCount: 0,
    hitCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Memory.Info
}

describe("MemoryDecay", () => {
  describe("calculateDecay", () => {
    test("score stays high for recently used memory", () => {
      const memory = makeMemory({
        score: 10.0,
        lastUsedAt: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1 day ago
        useCount: 5,
        hitCount: 3,
      })
      const effective = MemoryDecay.calculateDecay(memory, 30)
      // decay is minimal after 1 day, usage/hit boost applies
      expect(effective).toBeGreaterThan(10.0)
    })

    test("score decays significantly after half-life", () => {
      const memory = makeMemory({
        score: 10.0,
        lastUsedAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
        useCount: 0,
        hitCount: 0,
      })
      const effective = MemoryDecay.calculateDecay(memory, 30)
      // After exactly one half-life: 10 * 0.5 * 1.0 * 1.0 = 5.0
      expect(effective).toBeCloseTo(5.0, 1)
    })

    test("score decays more after two half-lives", () => {
      const memory = makeMemory({
        score: 10.0,
        lastUsedAt: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 days ago
        useCount: 0,
        hitCount: 0,
      })
      const effective = MemoryDecay.calculateDecay(memory, 30)
      // After two half-lives: 10 * 0.25 * 1.0 * 1.0 = 2.5
      expect(effective).toBeCloseTo(2.5, 1)
    })

    test("usage factor boosts score", () => {
      const memory = makeMemory({
        score: 10.0,
        lastUsedAt: Date.now(), // just now
        useCount: 10,
        hitCount: 0,
      })
      const effective = MemoryDecay.calculateDecay(memory, 30)
      // usageFactor = min(2.0, 1.0 + 10 * 0.1) = 2.0, hitFactor = 1.0
      expect(effective).toBeCloseTo(20.0, 1)
    })

    test("usage factor caps at 2.0", () => {
      const memory = makeMemory({
        score: 10.0,
        lastUsedAt: Date.now(),
        useCount: 100, // Very high
        hitCount: 0,
      })
      const effective = MemoryDecay.calculateDecay(memory, 30)
      // usageFactor = min(2.0, 1.0 + 100 * 0.1) = min(2.0, 11.0) = 2.0
      expect(effective).toBeCloseTo(20.0, 1)
    })

    test("hit rate boosts score", () => {
      const memory = makeMemory({
        score: 10.0,
        lastUsedAt: Date.now(),
        useCount: 10,
        hitCount: 10, // 100% hit rate
      })
      const effective = MemoryDecay.calculateDecay(memory, 30)
      // usageFactor = 2.0, hitFactor = 1.0 + 1.0 * 0.5 = 1.5
      expect(effective).toBeCloseTo(30.0, 1)
    })

    test("uses createdAt when lastUsedAt is undefined", () => {
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
      const memory = makeMemory({
        score: 10.0,
        createdAt: thirtyDaysAgo,
        lastUsedAt: undefined,
        useCount: 0,
        hitCount: 0,
      })
      const effective = MemoryDecay.calculateDecay(memory, 30)
      expect(effective).toBeCloseTo(5.0, 1)
    })

    test("shorter half-life causes faster decay", () => {
      const memory = makeMemory({
        score: 10.0,
        lastUsedAt: Date.now() - 15 * 24 * 60 * 60 * 1000, // 15 days ago
        useCount: 0,
        hitCount: 0,
      })
      const withDefault = MemoryDecay.calculateDecay(memory, 30) // half-life 30
      const withShort = MemoryDecay.calculateDecay(memory, 15) // half-life 15
      // 15 days is half of 30 but full of 15, so shorter half-life decays more
      expect(withShort).toBeLessThan(withDefault)
      expect(withShort).toBeCloseTo(5.0, 1) // exactly one half-life for 15-day
    })

    test("zero useCount gives hitFactor of 1.0 (no division by zero)", () => {
      const memory = makeMemory({
        score: 10.0,
        lastUsedAt: Date.now(),
        useCount: 0,
        hitCount: 0,
      })
      const effective = MemoryDecay.calculateDecay(memory, 30)
      // decayFactor ≈ 1.0, usageFactor = 1.0, hitFactor = 1.0
      expect(effective).toBeCloseTo(10.0, 1)
    })

    test("maintain keeps local decay behavior when hindsight is enabled", async () => {
      await withInstance(
        async () => {
          const mem = await Memory.create({
            content: "Decay should stay local",
            categories: ["pattern"],
            scope: "personal",
            score: 10,
            baseScore: 10,
            useCount: 4,
            hitCount: 2,
            lastUsedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
            source: { sessionID: "ses_decay", method: "manual" },
          })

          const expected = MemoryDecay.calculateDecay(mem, 30)
          const result = await MemoryDecay.maintain()
          const next = await Memory.get(mem.id)

          expect(result.totalMemories).toBe(1)
          expect(next?.score).toBeCloseTo(expected, 2)
        },
        {
          memory: {
            hindsight,
          },
        },
      )
    })
  })
})
