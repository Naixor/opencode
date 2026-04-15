import { afterEach, describe, test, expect, spyOn } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import type { Config } from "../../src/config/config"
import { Memory } from "../../src/memory/memory"
import { MemoryStorage } from "../../src/memory/storage"
import { MemoryExtractor } from "../../src/memory/engine/extractor"
import { Provider } from "../../src/provider/provider"
import { SessionPrompt } from "../../src/session/prompt"
import { Token } from "../../src/util/token"
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
  const spies: Array<{ mockRestore(): void }> = []

  afterEach(() => {
    while (spies.length) spies.pop()?.mockRestore()
  })

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
          categories: ["tool"],
          tags: ["hono", "api"],
        })

        expect(memory.id).toMatch(/^mem_/)
        expect(memory.content).toBe("Use Hono for API handlers")
        expect(memory.categories).toEqual(["tool"])
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
        expect(memory.categories).toEqual(["context"])
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

    test("returns empty on LLM failure", async () => {
      await withMemoryEnv(
        async () => {
          spies.push(spyOn(SessionPrompt, "prompt").mockRejectedValue(new Error("llm failed")))
          const result = await MemoryExtractor.extractFromSession("sess_8", [
            { role: "user", content: "We always use Hono framework" },
            { role: "assistant", content: "Noted, using Hono." },
          ])
          expect(result).toEqual([])
        },
        {
          model: "missing/model",
        },
      )
    })

    test("routes enabled extract flows through the hindsight-aware prompt without changing authoritative writes", async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          memory: {
            hindsight: {
              enabled: true,
              mode: "embedded",
              extract: true,
              recall: true,
              backfill: true,
              workspace_scope: "worktree",
              context_max_items: 6,
              context_max_tokens: 1200,
            },
          },
        },
        init: async (dir) => {
          const mem = path.join(dir, ".opencode", "memory")
          await fs.mkdir(mem, { recursive: true })
          await Bun.write(
            path.join(mem, "extract-hindsight.md"),
            ["# System", "", "Custom hindsight system", "", "# Analysis", "", "Custom hindsight analysis"].join("\n"),
          )
        },
      })

      let sys = ""
      let task = ""
      let variant = ""
      spies.push(
        spyOn(Provider, "defaultModel").mockResolvedValue({
          providerID: "test",
          modelID: "primary",
        }),
        spyOn(Provider, "getSmallModel").mockResolvedValue(undefined),
        spyOn(SessionPrompt, "prompt").mockImplementation((async (opts) => {
          sys = opts.system ?? ""
          task = opts.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("")
          variant = opts.variant ?? ""
          return {
            info: {} as never,
            parts: [
              {
                type: "text",
                text: JSON.stringify({
                  items: [
                    {
                      action: "create",
                      content: "Use Hono for APIs",
                      categories: ["tool"],
                      tags: ["hono"],
                      citations: [],
                    },
                  ],
                }),
              },
            ],
          }
        }) as typeof SessionPrompt.prompt),
      )

      const result = await Instance.provide({
        directory: tmp.path,
        fn: () =>
          MemoryExtractor.extractFromSession("sess_9", [
            { role: "user", content: "Use Hono for API routes" },
            { role: "assistant", content: "Okay, I will keep using Hono." },
          ]),
      })

      const list = await Instance.provide({
        directory: tmp.path,
        fn: () => Memory.list(),
      })

      expect(variant).toBe("hindsight")
      expect(sys).toContain("Custom hindsight system")
      expect(task).toContain("Custom hindsight analysis")
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe("Use Hono for APIs")
      expect(list.map((item) => item.content)).toContain("Use Hono for APIs")
    })

    test("adds bounded hindsight context before prompt construction", async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          memory: {
            hindsight: {
              enabled: true,
              mode: "embedded",
              extract: true,
              recall: true,
              backfill: true,
              workspace_scope: "worktree",
              context_max_items: 2,
              context_max_tokens: 2000,
            },
          },
        },
      })

      let sys = ""
      spies.push(
        spyOn(Provider, "defaultModel").mockResolvedValue({
          providerID: "test",
          modelID: "primary",
        }),
        spyOn(Provider, "getSmallModel").mockResolvedValue(undefined),
        spyOn(SessionPrompt, "prompt").mockImplementation((async (opts) => {
          sys = opts.system ?? ""
          return {
            info: {} as never,
            parts: [{ type: "text", text: JSON.stringify({ items: [] }) }],
          }
        }) as typeof SessionPrompt.prompt),
      )

      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          MemoryExtractor.extractFromSession(
            "sess_10",
            [
              { role: "user", content: "Keep Hono for API routes" },
              { role: "assistant", content: "Okay." },
            ],
            {
              context: [
                { text: "Use Hono for API routes", kind: "mem", id: "mem_1", score: 0.91 },
                { text: "Prefer Bun APIs when possible", kind: "mem", id: "mem_2", score: 0.82 },
                { text: "This item should be trimmed by the item budget", kind: "sess", id: "sess_1", score: 0.77 },
              ],
            },
          ),
      })

      expect(sys).toContain("## Hindsight context")
      expect(sys).toContain("Use Hono for API routes")
      expect(sys).toContain("Prefer Bun APIs when possible")
      expect(sys).not.toContain("This item should be trimmed by the item budget")
    })
  })

  describe("formatHints", () => {
    test("uses the default item budget when no override is provided", () => {
      const text = MemoryExtractor.formatHints(
        Array.from({ length: 8 }, (_, i) => ({
          text: `Hint ${i + 1}`,
        })),
      )

      expect(text).toContain("Hint 1")
      expect(text).toContain("Hint 6")
      expect(text).not.toContain("Hint 7")
      expect(text).not.toContain("Hint 8")
    })

    test("uses the default token budget when no override is provided", () => {
      const text = MemoryExtractor.formatHints(
        Array.from({ length: 4 }, (_, i) => ({
          text: `${i + 1}`.repeat(1800),
        })),
      )

      expect(text).toContain("1111")
      expect(text).toContain("2222")
      expect(Token.estimate(text)).toBeLessThanOrEqual(1200)
      expect(text).not.toContain("4444")
    })

    test("trims the final hint instead of exceeding the token budget", () => {
      const text = MemoryExtractor.formatHints([{ text: "A".repeat(6000) }], {
        tokens: 100,
      })

      expect(text).toContain("...")
      expect(text.length).toBeLessThan(6000)
    })
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
