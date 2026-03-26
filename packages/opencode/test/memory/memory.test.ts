import { describe, test, expect, beforeEach } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Memory } from "../../src/memory/memory"
import { MemoryStorage } from "../../src/memory/storage"
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

describe("Memory", () => {
  describe("data model", () => {
    test("Info schema validates correct data", () => {
      const now = Date.now()
      const result = Memory.Info.safeParse({
        id: "mem_test123",
        content: "Use Hono for HTTP routing",
        category: "tool",
        scope: "personal",
        status: "confirmed",
        tags: ["framework"],
        source: {
          sessionID: "ses_abc",
          method: "manual",
        },
        citations: [],
        score: 5.0,
        useCount: 3,
        hitCount: 1,
        createdAt: now,
        updatedAt: now,
      })
      expect(result.success).toBe(true)
    })

    test("Info schema applies defaults", () => {
      const now = Date.now()
      const result = Memory.Info.parse({
        id: "mem_test123",
        content: "No semicolons",
        category: "style",
        scope: "personal",
        source: {
          sessionID: "ses_abc",
          method: "manual",
        },
        createdAt: now,
        updatedAt: now,
      })
      expect(result.status).toBe("confirmed")
      expect(result.tags).toEqual([])
      expect(result.citations).toEqual([])
      expect(result.score).toBe(1.0)
      expect(result.useCount).toBe(0)
      expect(result.hitCount).toBe(0)
    })

    test("Info schema rejects invalid category", () => {
      const now = Date.now()
      const result = Memory.Info.safeParse({
        id: "mem_test",
        content: "test",
        category: "invalid_category",
        scope: "personal",
        source: { sessionID: "ses_1", method: "manual" },
        createdAt: now,
        updatedAt: now,
      })
      expect(result.success).toBe(false)
    })

    test("Category enum has all expected values", () => {
      const values = Memory.Category.options
      expect(values).toContain("style")
      expect(values).toContain("pattern")
      expect(values).toContain("tool")
      expect(values).toContain("domain")
      expect(values).toContain("workflow")
      expect(values).toContain("correction")
      expect(values).toContain("context")
    })

    test("Scope enum has personal and team", () => {
      expect(Memory.Scope.options).toEqual(["personal", "team"])
    })

    test("Status enum has pending and confirmed", () => {
      expect(Memory.Status.options).toEqual(["pending", "confirmed"])
    })
  })

  describe("TeamScope", () => {
    test("validates global scope", () => {
      const result = Memory.TeamScope.parse({ global: true })
      expect(result.global).toBe(true)
      expect(result.projectIds).toEqual([])
      expect(result.languages).toEqual([])
      expect(result.techStack).toEqual([])
      expect(result.modules).toEqual([])
    })

    test("validates multi-dimension scope", () => {
      const result = Memory.TeamScope.parse({
        languages: ["typescript"],
        techStack: ["hono", "drizzle"],
      })
      expect(result.global).toBe(false)
      expect(result.languages).toEqual(["typescript"])
      expect(result.techStack).toEqual(["hono", "drizzle"])
    })

    test("applies defaults for empty input", () => {
      const result = Memory.TeamScope.parse({})
      expect(result.global).toBe(false)
      expect(result.projectIds).toEqual([])
    })
  })

  describe("CRUD operations", () => {
    test("create returns a memory with generated id", async () => {
      await withInstance(async () => {
        const mem = await Memory.create({
          content: "Always use vitest for testing",
          category: "tool",
          scope: "personal",
          source: { sessionID: "ses_1", method: "manual" },
        })
        expect(mem.id).toMatch(/^mem_/)
        expect(mem.content).toBe("Always use vitest for testing")
        expect(mem.category).toBe("tool")
        expect(mem.scope).toBe("personal")
        expect(mem.status).toBe("confirmed")
        expect(mem.score).toBe(1.0)
        expect(mem.createdAt).toBeGreaterThan(0)
        expect(mem.updatedAt).toBeGreaterThan(0)
      })
    })

    test("create with pending status", async () => {
      await withInstance(async () => {
        const mem = await Memory.create({
          content: "Auto-extracted preference",
          category: "style",
          scope: "personal",
          status: "pending",
          source: { sessionID: "ses_1", method: "auto" },
        })
        expect(mem.status).toBe("pending")
      })
    })

    test("get returns created memory", async () => {
      await withInstance(async () => {
        const created = await Memory.create({
          content: "Use namespace pattern",
          category: "pattern",
          scope: "personal",
          source: { sessionID: "ses_1", method: "manual" },
        })
        const fetched = await Memory.get(created.id)
        expect(fetched).toBeDefined()
        expect(fetched!.content).toBe("Use namespace pattern")
        expect(fetched!.id).toBe(created.id)
      })
    })

    test("get returns undefined for non-existent id", async () => {
      await withInstance(async () => {
        const result = await Memory.get("mem_nonexistent")
        expect(result).toBeUndefined()
      })
    })

    test("update modifies fields and bumps updatedAt", async () => {
      await withInstance(async () => {
        const created = await Memory.create({
          content: "Original content",
          category: "style",
          scope: "personal",
          source: { sessionID: "ses_1", method: "manual" },
        })
        await Bun.sleep(10) // ensure time difference
        const updated = await Memory.update(created.id, {
          content: "Updated content",
          score: 5.0,
        })
        expect(updated).toBeDefined()
        expect(updated!.content).toBe("Updated content")
        expect(updated!.score).toBe(5.0)
        expect(updated!.updatedAt).toBeGreaterThan(created.updatedAt)
        expect(updated!.createdAt).toBe(created.createdAt) // unchanged
      })
    })

    test("update returns undefined for non-existent id", async () => {
      await withInstance(async () => {
        const result = await Memory.update("mem_nonexistent", { content: "new" })
        expect(result).toBeUndefined()
      })
    })

    test("remove deletes a memory", async () => {
      await withInstance(async () => {
        const created = await Memory.create({
          content: "To be removed",
          category: "context",
          scope: "personal",
          source: { sessionID: "ses_1", method: "manual" },
        })
        const removed = await Memory.remove(created.id)
        expect(removed).toBe(true)
        const fetched = await Memory.get(created.id)
        expect(fetched).toBeUndefined()
      })
    })

    test("remove returns false for non-existent id", async () => {
      await withInstance(async () => {
        const result = await Memory.remove("mem_nonexistent")
        expect(result).toBe(false)
      })
    })

    test("list returns all memories", async () => {
      await withInstance(async () => {
        await Memory.create({
          content: "Memory 1",
          category: "style",
          scope: "personal",
          source: { sessionID: "ses_1", method: "manual" },
        })
        await Memory.create({
          content: "Memory 2",
          category: "tool",
          scope: "personal",
          source: { sessionID: "ses_1", method: "auto" },
        })
        const all = await Memory.list()
        expect(all.length).toBe(2)
      })
    })

    test("list filters by scope", async () => {
      await withInstance(async () => {
        await Memory.create({
          content: "Personal memory",
          category: "style",
          scope: "personal",
          source: { sessionID: "ses_1", method: "manual" },
        })
        await Memory.create({
          content: "Team memory",
          category: "style",
          scope: "team",
          source: { sessionID: "ses_1", method: "pulled" },
        })
        const personal = await Memory.list({ scope: "personal" })
        expect(personal.length).toBe(1)
        expect(personal[0].content).toBe("Personal memory")

        const team = await Memory.list({ scope: "team" })
        expect(team.length).toBe(1)
        expect(team[0].content).toBe("Team memory")
      })
    })

    test("list filters by status", async () => {
      await withInstance(async () => {
        await Memory.create({
          content: "Confirmed",
          category: "style",
          scope: "personal",
          status: "confirmed",
          source: { sessionID: "ses_1", method: "manual" },
        })
        await Memory.create({
          content: "Pending",
          category: "style",
          scope: "personal",
          status: "pending",
          source: { sessionID: "ses_1", method: "auto" },
        })
        const pending = await Memory.list({ status: "pending" })
        expect(pending.length).toBe(1)
        expect(pending[0].content).toBe("Pending")
      })
    })

    test("list filters by category", async () => {
      await withInstance(async () => {
        await Memory.create({
          content: "Style pref",
          category: "style",
          scope: "personal",
          source: { sessionID: "ses_1", method: "manual" },
        })
        await Memory.create({
          content: "Tool pref",
          category: "tool",
          scope: "personal",
          source: { sessionID: "ses_1", method: "manual" },
        })
        const tools = await Memory.list({ category: "tool" })
        expect(tools.length).toBe(1)
        expect(tools[0].category).toBe("tool")
      })
    })

    test("list filters by method", async () => {
      await withInstance(async () => {
        await Memory.create({
          content: "Manual",
          category: "style",
          scope: "personal",
          source: { sessionID: "ses_1", method: "manual" },
        })
        await Memory.create({
          content: "Auto",
          category: "style",
          scope: "personal",
          source: { sessionID: "ses_1", method: "auto" },
        })
        const auto = await Memory.list({ method: "auto" })
        expect(auto.length).toBe(1)
        expect(auto[0].content).toBe("Auto")
      })
    })

    test("upsert creates or updates", async () => {
      await withInstance(async () => {
        const now = Date.now()
        const mem: Memory.Info = {
          id: "team_remote_1",
          content: "Team convention",
          category: "workflow",
          scope: "team",
          status: "confirmed",
          tags: [],
          source: { sessionID: "", method: "pulled" },
          citations: [],
          score: 10.0,
          baseScore: 10.0,
          useCount: 0,
          hitCount: 0,
          inject: false,
          createdAt: now,
          updatedAt: now,
        }
        const result = await Memory.upsert(mem)
        expect(result.id).toBe("team_remote_1")

        const fetched = await Memory.get("team_remote_1")
        expect(fetched).toBeDefined()
        expect(fetched!.content).toBe("Team convention")
      })
    })

    test("findSimilar finds exact match (case-insensitive)", async () => {
      await withInstance(async () => {
        await Memory.create({
          content: "Use Hono for routing",
          category: "tool",
          scope: "personal",
          source: { sessionID: "ses_1", method: "manual" },
        })
        const found = await Memory.findSimilar("use hono for routing")
        expect(found).toBeDefined()
        expect(found!.content).toBe("Use Hono for routing")

        const notFound = await Memory.findSimilar("use express for routing")
        expect(notFound).toBeUndefined()
      })
    })
  })

  describe("meta key-value store", () => {
    test("getMeta returns undefined for non-existent key", async () => {
      await withInstance(async () => {
        const result = await Memory.getMeta("nonexistent")
        expect(result).toBeUndefined()
      })
    })

    test("setMeta and getMeta roundtrip", async () => {
      await withInstance(async () => {
        await Memory.setMeta("extracted:ses_1", 1234567890)
        const result = await Memory.getMeta("extracted:ses_1")
        expect(result).toBe(1234567890)
      })
    })

    test("setMeta overwrites existing value", async () => {
      await withInstance(async () => {
        await Memory.setMeta("lastMaintainAt", 100)
        await Memory.setMeta("lastMaintainAt", 200)
        const result = await Memory.getMeta("lastMaintainAt")
        expect(result).toBe(200)
      })
    })
  })
})
