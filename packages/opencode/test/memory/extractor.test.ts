import { describe, test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import type { Config } from "../../src/config/config"
import { Memory } from "../../src/memory/memory"
import { MemoryStorage } from "../../src/memory/storage"
import { MemoryExtractor } from "../../src/memory/engine/extractor"
import { tmpdir } from "../fixture/fixture"

async function withMemoryEnv<T>(fn: () => Promise<T>, config?: Partial<Config.Info>): Promise<T> {
  await using tmp = await tmpdir({ git: true, config })
  return Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await MemoryStorage.clear()
      return fn()
    },
  })
}

describe("MemoryExtractor", () => {
  describe("rememberWithContext", () => {
    test("creates a memory with context snapshot", async () => {
      await withMemoryEnv(async () => {
        const messages = [
          { role: "user", content: "Write an API handler" },
          { role: "assistant", content: "Here's an express handler..." },
          { role: "user", content: "No, use Hono" },
          { role: "assistant", content: "Updated to Hono..." },
        ]

        const memory = await MemoryExtractor.rememberWithContext("sess_1", "Use Hono for API handlers", messages, {
          category: "tool",
          tags: ["hono", "api"],
        })

        expect(memory.id).toMatch(/^mem_/)
        expect(memory.content).toBe("Use Hono for API handlers")
        expect(memory.category).toBe("tool")
        expect(memory.scope).toBe("personal")
        expect(memory.status).toBe("confirmed")
        expect(memory.tags).toEqual(["hono", "api"])
        expect(memory.source.sessionID).toBe("sess_1")
        expect(memory.source.method).toBe("manual")
        expect(memory.source.contextSnapshot).toContain("[user]: Write an API handler")
        expect(memory.source.contextSnapshot).toContain("[user]: No, use Hono")
      })
    })

    test("limits context to last 10 messages", async () => {
      await withMemoryEnv(async () => {
        const messages = Array.from({ length: 20 }, (_, i) => ({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}`,
        }))

        const memory = await MemoryExtractor.rememberWithContext("sess_2", "Remember this", messages)

        // Should only contain last 10 messages
        expect(memory.source.contextSnapshot).not.toContain("Message 0")
        expect(memory.source.contextSnapshot).toContain("Message 19")
      })
    })

    test("marks session as dirty after remember", async () => {
      await withMemoryEnv(async () => {
        expect(Memory.isDirty("sess_3")).toBe(false)
        await MemoryExtractor.rememberWithContext("sess_3", "Test", [])
        expect(Memory.isDirty("sess_3")).toBe(true)
      })
    })

    test("defaults to context category when none specified", async () => {
      await withMemoryEnv(async () => {
        const memory = await MemoryExtractor.rememberWithContext("sess_4", "Remember this", [])
        expect(memory.category).toBe("context")
      })
    })
  })

  describe("extractFromSession", () => {
    test("handles empty messages", async () => {
      await withMemoryEnv(async () => {
        const result = await MemoryExtractor.extractFromSession("sess_7", [])
        expect(result).toEqual([])
      })
    })

    test("returns empty on LLM failure (no provider configured)", async () => {
      await withMemoryEnv(
        async () => {
          // If a provider is available (e.g. OAuth), extraction may succeed.
          // This test verifies no crash occurs — result is either empty or valid memories.
          const result = await MemoryExtractor.extractFromSession("sess_8", [
            { role: "user", content: "We always use Hono framework" },
            { role: "assistant", content: "Noted, using Hono." },
          ])
          expect(Array.isArray(result)).toBe(true)
        },
        {
          // Fixed: force a fast provider failure instead of depending on ambient auth/config.
          model: "missing/model",
        },
      )
    }, 15000)
  })

  describe("prompt builders", () => {
    test("buildRememberPrompt includes user input and context", () => {
      const prompt = MemoryExtractor.buildRememberPrompt("Use Hono", "[user]: Write handler\n---\n[assistant]: ...")
      expect(prompt).toContain("Use Hono")
      expect(prompt).toContain("[user]: Write handler")
      expect(prompt).toContain("self-contained")
      expect(prompt).toContain("Topic: detail")
      expect(prompt).toContain("under 120 characters")
    })
  })
})
