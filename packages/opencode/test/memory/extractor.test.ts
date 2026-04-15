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
import { MemoryHindsightRetain } from "../../src/memory/hindsight/retain"
import { MemoryHindsightRecall } from "../../src/memory/hindsight/recall"
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
        spyOn(MemoryHindsightRetain, "session").mockResolvedValue({
          status: "retained",
          document_id: "sess:test:sess_9:0:2",
          result: { success: true, bank_id: "bank_1", items_count: 1, async: false },
        }),
        spyOn(MemoryHindsightRecall, "context").mockResolvedValue({
          raw: { results: [] } as never,
          hits: 0,
          items: [],
        }),
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
        spyOn(MemoryHindsightRetain, "session").mockResolvedValue({
          status: "retained",
          document_id: "sess:test:sess_10:0:2",
          result: { success: true, bank_id: "bank_1", items_count: 1, async: false },
        }),
        spyOn(MemoryHindsightRecall, "context").mockResolvedValue({
          raw: { results: [] } as never,
          hits: 0,
          items: [],
        }),
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

    test("queries hindsight context for extract and injects returned snippets", async () => {
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
              context_max_items: 3,
              context_max_tokens: 1200,
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
        spyOn(MemoryHindsightRetain, "session").mockResolvedValue({
          status: "retained",
          document_id: "sess:test:sess_10b:0:2",
          result: { success: true, bank_id: "bank_1", items_count: 1, async: false },
        }),
        spyOn(MemoryHindsightRecall, "context").mockResolvedValue({
          raw: { results: [] } as never,
          hits: 2,
          items: [
            { text: "Related observation from session history", kind: "obs", id: "obs_1", score: 0.91 },
            { text: "Related retained document chunk", kind: "doc", id: "doc_1", score: 0.82 },
          ],
        }),
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
          MemoryExtractor.extractFromSession("sess_10b", [
            { role: "user", content: "What should we remember about extractor prompts?" },
            { role: "assistant", content: "We should keep them bounded." },
          ]),
      })

      expect(sys).toContain("## Hindsight context")
      expect(sys).toContain("Related observation from session history")
      expect(sys).toContain("Related retained document chunk")
    })

    test("continues without a hindsight section when context query returns no usable items", async () => {
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
              context_max_items: 3,
              context_max_tokens: 1200,
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
        spyOn(MemoryHindsightRetain, "session").mockResolvedValue({
          status: "retained",
          document_id: "sess:test:sess_10c:0:2",
          result: { success: true, bank_id: "bank_1", items_count: 1, async: false },
        }),
        spyOn(MemoryHindsightRecall, "context").mockResolvedValue({
          raw: { results: [] } as never,
          hits: 0,
          items: [],
        }),
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
          MemoryExtractor.extractFromSession("sess_10c", [
            { role: "user", content: "Keep prompts small" },
            { role: "assistant", content: "Okay." },
          ]),
      })

      expect(sys).not.toContain("## Hindsight context")
    })

    test("retains the current session slice before hindsight-assisted extraction", async () => {
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
      })

      const calls: Array<Parameters<typeof MemoryHindsightRetain.session>[0]> = []
      spies.push(
        spyOn(Provider, "defaultModel").mockResolvedValue({
          providerID: "test",
          modelID: "primary",
        }),
        spyOn(Provider, "getSmallModel").mockResolvedValue(undefined),
        spyOn(MemoryHindsightRecall, "context").mockResolvedValue({
          raw: { results: [] } as never,
          hits: 0,
          items: [],
        }),
        spyOn(MemoryHindsightRetain, "session").mockImplementation(async (input) => {
          calls.push(input)
          return {
            status: "retained",
            document_id: "sess:test:sess_11:0:2",
            result: {
              success: true,
              bank_id: "bank_1",
              items_count: 1,
              async: false,
            },
          }
        }),
        spyOn(SessionPrompt, "prompt").mockResolvedValue({
          info: {} as never,
          parts: [{ type: "text", text: JSON.stringify({ items: [] }) }],
        } as Awaited<ReturnType<typeof SessionPrompt.prompt>>),
      )

      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          MemoryExtractor.extractFromSession("sess_11", [
            { role: "user", content: "Keep Hono for API routes" },
            { role: "assistant", content: "Okay." },
          ]),
      })

      expect(calls).toHaveLength(1)
      expect(calls[0].session_id).toBe("sess_11")
      expect(calls[0].start).toBe(0)
      expect(calls[0].end).toBe(2)
      expect(calls[0].content).toContain("[user]: Keep Hono for API routes")
      expect(calls[0].content).toContain("[assistant]: Okay.")
    })

    test("keeps extraction non-fatal when session-slice retain fails", async () => {
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
      })

      let called = false
      spies.push(
        spyOn(Provider, "defaultModel").mockResolvedValue({
          providerID: "test",
          modelID: "primary",
        }),
        spyOn(Provider, "getSmallModel").mockResolvedValue(undefined),
        spyOn(MemoryHindsightRecall, "context").mockResolvedValue({
          raw: { results: [] } as never,
          hits: 0,
          items: [],
        }),
        spyOn(MemoryHindsightRetain, "session").mockResolvedValue({
          status: "failed",
          document_id: "sess:test:sess_12:0:2",
          error: "boom",
        }),
        spyOn(SessionPrompt, "prompt").mockImplementation(
          Object.assign(
            async () => {
              called = true
              return {
                info: {} as never,
                parts: [{ type: "text", text: JSON.stringify({ items: [] }) }],
              } as Awaited<ReturnType<typeof SessionPrompt.prompt>>
            },
            {
              force: SessionPrompt.prompt.force,
              schema: SessionPrompt.prompt.schema,
            },
          ),
        ),
      )

      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          MemoryExtractor.extractFromSession("sess_12", [
            { role: "user", content: "Keep Hono for API routes" },
            { role: "assistant", content: "Okay." },
          ]),
      })

      expect(called).toBe(true)
    })

    test("updates one authoritative memory in place with bounded hindsight context", async () => {
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
              context_max_tokens: 1200,
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
        spyOn(MemoryHindsightRetain, "session").mockResolvedValue({
          status: "retained",
          document_id: "sess:test:sess_13:0:2",
          result: { success: true, bank_id: "bank_1", items_count: 1, async: false },
        }),
        spyOn(MemoryHindsightRetain, "memory").mockResolvedValue({
          status: "retained",
          document_id: "mem:test:mem_1",
          result: { success: true, bank_id: "bank_1", items_count: 1, async: false },
        }),
        spyOn(MemoryHindsightRecall, "context").mockResolvedValue({
          raw: { results: [] } as never,
          hits: 2,
          items: [
            { text: "Keep memory wording self-contained", kind: "obs", id: "obs_1", score: 0.91 },
            {
              text: "Merge lookup terms into tags instead of duplicating memories",
              kind: "doc",
              id: "doc_1",
              score: 0.82,
            },
            { text: "This third hint should be trimmed", kind: "doc", id: "doc_2", score: 0.71 },
          ],
        }),
        spyOn(SessionPrompt, "prompt").mockImplementation((async (opts) => {
          sys = opts.system ?? ""
          return {
            info: {} as never,
            parts: [
              {
                type: "text",
                text: JSON.stringify({
                  items: [
                    {
                      action: "update",
                      targetID: "memory_existing",
                      content: "Use Hono for APIs and Bun.file for file reads",
                      categories: ["tool"],
                      tags: ["bun", "hono"],
                      citations: ["doc-2"],
                    },
                  ],
                }),
              },
            ],
          }
        }) as typeof SessionPrompt.prompt),
      )

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await MemoryStorage.clear()
          await MemoryStorage.save(
            Memory.Info.parse({
              id: "memory_existing",
              content: "Use Hono for APIs",
              categories: ["tool"],
              scope: "personal",
              status: "confirmed",
              tags: ["api"],
              source: { sessionID: "sess_seed", method: "manual" },
              citations: ["doc-1"],
              score: 1,
              baseScore: 1,
              useCount: 0,
              hitCount: 0,
              inject: false,
              createdAt: 1,
              updatedAt: 1,
            }),
          )

          const result = await MemoryExtractor.extractFromSession("sess_13", [
            { role: "user", content: "Remember that we use Hono and Bun.file" },
            { role: "assistant", content: "Okay, I will update the memory." },
          ])
          const list = await Memory.list()

          expect(result).toHaveLength(1)
          expect(result[0]?.id).toBe("memory_existing")
          expect(list).toHaveLength(1)
          expect(list[0]?.content).toBe("Use Hono for APIs and Bun.file for file reads")
          expect(list[0]?.tags).toEqual(["api", "bun", "hono"])
          expect(list[0]?.citations).toEqual(["doc-1", "doc-2"])
        },
      })

      expect(sys).toContain("## Hindsight context")
      expect(sys).toContain("Keep memory wording self-contained")
      expect(sys).toContain("Merge lookup terms into tags instead of duplicating memories")
      expect(sys).not.toContain("This third hint should be trimmed")
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
