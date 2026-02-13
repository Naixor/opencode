import { describe, expect, test } from "bun:test"
import path from "path"
import * as fs from "fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { HookChain } from "../../../src/session/hooks"
import { ContextInjectionHooks } from "../../../src/session/hooks/context-injection"
import { SecurityConfig } from "../../../src/security/config"

describe("ContextInjectionHooks", () => {
  async function withInstance(
    fn: () => Promise<void>,
    setup?: (dir: string) => Promise<void>,
  ) {
    await using tmp = await tmpdir({
      git: true,
      config: {},
      init: setup,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        HookChain.reset()
        ContextInjectionHooks.resetCaches()
        ContextInjectionHooks.register()
        await fn()
      },
    })
  }

  // --- directory-agents-injector ---

  describe("directory-agents-injector", () => {
    test("mock AGENTS.md -> content appears in system prompt", async () => {
      await withInstance(
        async () => {
          const ctx: HookChain.PreLLMContext = {
            sessionID: "s1",
            system: ["You are a helpful assistant."],
            agent: "build",
            model: "claude-sonnet-4-5-20250929",
            messages: [],
          }

          await HookChain.execute("pre-llm", ctx)

          const injected = ctx.system.find((s) => s.includes("AGENTS.md"))
          expect(injected).toBeDefined()
          expect(injected).toContain("Always use TypeScript")
        },
        async (dir) => {
          await Bun.write(path.join(dir, "AGENTS.md"), "# Agents\nAlways use TypeScript for new files.")
        },
      )
    })

    test("no AGENTS.md -> no injection, no error", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are a helpful assistant."],
          agent: "build",
          model: "claude-sonnet-4-5-20250929",
          messages: [],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.system.length).toBe(1)
        expect(ctx.system[0]).toBe("You are a helpful assistant.")
      })
    })

    test("AGENTS.md is security-protected -> access denied, no injection", async () => {
      await withInstance(
        async () => {
          // Load security config that denies read on AGENTS.md
          const dir = Instance.directory
          await SecurityConfig.loadSecurityConfig(dir)

          const ctx: HookChain.PreLLMContext = {
            sessionID: "s1",
            system: ["You are a helpful assistant."],
            agent: "build",
            model: "claude-sonnet-4-5-20250929",
            messages: [],
          }

          await HookChain.execute("pre-llm", ctx)

          const injected = ctx.system.find((s) => s.includes("AGENTS.md"))
          expect(injected).toBeUndefined()

          // Cleanup security config
          SecurityConfig.resetConfig()
        },
        async (dir) => {
          await Bun.write(path.join(dir, "AGENTS.md"), "# Secret Agents\nDo not share.")
          await Bun.write(
            path.join(dir, ".opencode-security.json"),
            JSON.stringify({
              version: "1.0",
              rules: [
                {
                  pattern: "**/AGENTS.md",
                  type: "file",
                  deniedOperations: ["read"],
                  allowedRoles: [],
                },
              ],
            }),
          )
        },
      )
    })

    test("AGENTS.md with protected segment -> segment redacted before injection", async () => {
      await withInstance(
        async () => {
          const dir = Instance.directory
          await SecurityConfig.loadSecurityConfig(dir)

          const ctx: HookChain.PreLLMContext = {
            sessionID: "s1",
            system: ["You are a helpful assistant."],
            agent: "build",
            model: "claude-sonnet-4-5-20250929",
            messages: [],
          }

          await HookChain.execute("pre-llm", ctx)

          const injected = ctx.system.find((s) => s.includes("AGENTS.md"))
          expect(injected).toBeDefined()
          expect(injected).toContain("Public content")
          // The secret should be redacted
          expect(injected).not.toContain("super-secret-api-key")

          SecurityConfig.resetConfig()
        },
        async (dir) => {
          const content = [
            "# Agents",
            "Public content here.",
            "// @security-start",
            "super-secret-api-key",
            "// @security-end",
            "More public content.",
          ].join("\n")
          await Bun.write(path.join(dir, "AGENTS.md"), content)
          await Bun.write(
            path.join(dir, ".opencode-security.json"),
            JSON.stringify({
              version: "1.0",
              segments: {
                markers: [
                  {
                    start: "@security-start",
                    end: "@security-end",
                    deniedOperations: ["llm"],
                    allowedRoles: [],
                  },
                ],
              },
              rules: [],
            }),
          )
        },
      )
    })

    test("inject AGENTS.md twice -> file read only once (cache)", async () => {
      await withInstance(
        async () => {
          const ctx1: HookChain.PreLLMContext = {
            sessionID: "s1",
            system: ["prompt1"],
            agent: "build",
            model: "claude-sonnet-4-5-20250929",
            messages: [],
          }
          await HookChain.execute("pre-llm", ctx1)

          const ctx2: HookChain.PreLLMContext = {
            sessionID: "s1",
            system: ["prompt2"],
            agent: "build",
            model: "claude-sonnet-4-5-20250929",
            messages: [],
          }
          await HookChain.execute("pre-llm", ctx2)

          // Both should have the injection
          const injected1 = ctx1.system.find((s) => s.includes("AGENTS.md"))
          const injected2 = ctx2.system.find((s) => s.includes("AGENTS.md"))
          expect(injected1).toBeDefined()
          expect(injected2).toBeDefined()

          // Verify cache was used (same content)
          expect(injected1).toBe(injected2)

          // Check cache has the session
          const cache = ContextInjectionHooks.getAgentsCache()
          expect(cache.has("s1")).toBe(true)
        },
        async (dir) => {
          await Bun.write(path.join(dir, "AGENTS.md"), "# Agents\nCached content.")
        },
      )
    })
  })

  // --- directory-readme-injector ---

  describe("directory-readme-injector", () => {
    test("first message -> README.md injected", async () => {
      await withInstance(
        async () => {
          const ctx: HookChain.PreLLMContext = {
            sessionID: "s1",
            system: ["You are a helpful assistant."],
            agent: "build",
            model: "claude-sonnet-4-5-20250929",
            messages: [],
          }

          await HookChain.execute("pre-llm", ctx)

          const injected = ctx.system.find((s) => s.includes("README.md"))
          expect(injected).toBeDefined()
          expect(injected).toContain("My Project")
        },
        async (dir) => {
          await Bun.write(path.join(dir, "README.md"), "# My Project\nThis is a test project.")
        },
      )
    })

    test("second message same dir -> no duplicate injection", async () => {
      await withInstance(
        async () => {
          const ctx1: HookChain.PreLLMContext = {
            sessionID: "s1",
            system: ["prompt1"],
            agent: "build",
            model: "claude-sonnet-4-5-20250929",
            messages: [],
          }
          await HookChain.execute("pre-llm", ctx1)

          const ctx2: HookChain.PreLLMContext = {
            sessionID: "s1",
            system: ["prompt2"],
            agent: "build",
            model: "claude-sonnet-4-5-20250929",
            messages: [{ role: "user", content: "hello" }],
          }
          await HookChain.execute("pre-llm", ctx2)

          // First should have README, second should not (same dir)
          const injected1 = ctx1.system.find((s) => s.includes("README.md"))
          const injected2 = ctx2.system.find((s) => s.includes("README.md"))
          expect(injected1).toBeDefined()
          expect(injected2).toBeUndefined()
        },
        async (dir) => {
          await Bun.write(path.join(dir, "README.md"), "# My Project\nTest.")
        },
      )
    })

    test("no README.md -> no injection, no error", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are a helpful assistant."],
          agent: "build",
          model: "claude-sonnet-4-5-20250929",
          messages: [],
        }

        await HookChain.execute("pre-llm", ctx)

        const injected = ctx.system.find((s) => s.includes("README.md"))
        expect(injected).toBeUndefined()
      })
    })

    test("directory change -> new README.md injected", async () => {
      await withInstance(
        async () => {
          // First message
          const ctx1: HookChain.PreLLMContext = {
            sessionID: "s1",
            system: ["prompt1"],
            agent: "build",
            model: "claude-sonnet-4-5-20250929",
            messages: [],
          }
          await HookChain.execute("pre-llm", ctx1)

          // Verify first injection
          const injected1 = ctx1.system.find((s) => s.includes("README.md"))
          expect(injected1).toBeDefined()
          expect(injected1).toContain("My Project")

          // Simulate directory change by clearing cache for this session with different dir
          const cache = ContextInjectionHooks.getReadmeCache()
          cache.set("s1", { dir: "/some/other/dir", content: null })

          // Second call - should re-inject since dir changed
          const ctx2: HookChain.PreLLMContext = {
            sessionID: "s1",
            system: ["prompt2"],
            agent: "build",
            model: "claude-sonnet-4-5-20250929",
            messages: [],
          }
          await HookChain.execute("pre-llm", ctx2)

          const injected2 = ctx2.system.find((s) => s.includes("README.md"))
          expect(injected2).toBeDefined()
        },
        async (dir) => {
          await Bun.write(path.join(dir, "README.md"), "# My Project\nHello world.")
        },
      )
    })
  })

  // --- rules-injector ---

  describe("rules-injector", () => {
    test("rules in .opencode/rules/ -> all rules injected", async () => {
      await withInstance(
        async () => {
          const ctx: HookChain.PreLLMContext = {
            sessionID: "s1",
            system: ["You are a helpful assistant."],
            agent: "build",
            model: "claude-sonnet-4-5-20250929",
            messages: [],
          }

          await HookChain.execute("pre-llm", ctx)

          const rules = ctx.system.filter((s) => s.includes("Custom rules from"))
          expect(rules.length).toBeGreaterThan(0)
          // At least one rule should contain content from our test rules
          const allRulesText = rules.join("\n")
          expect(allRulesText).toContain("Always write tests")
        },
        async (dir) => {
          const rulesDir = path.join(dir, ".opencode", "rules")
          await fs.mkdir(rulesDir, { recursive: true })
          await Bun.write(path.join(rulesDir, "testing.md"), "# Testing Rules\nAlways write tests for new features.")
        },
      )
    })

    test("no rules directory -> no injection, no error", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are a helpful assistant."],
          agent: "build",
          model: "claude-sonnet-4-5-20250929",
          messages: [],
        }

        await HookChain.execute("pre-llm", ctx)

        const rules = ctx.system.filter((s) => s.includes("Custom rules"))
        expect(rules.length).toBe(0)
      })
    })

    test("protected rule file -> skipped with security log", async () => {
      await withInstance(
        async () => {
          const dir = Instance.directory
          await SecurityConfig.loadSecurityConfig(dir)

          const ctx: HookChain.PreLLMContext = {
            sessionID: "s1",
            system: ["You are a helpful assistant."],
            agent: "build",
            model: "claude-sonnet-4-5-20250929",
            messages: [],
          }

          await HookChain.execute("pre-llm", ctx)

          // Protected rule should not appear
          const rules = ctx.system.filter((s) => s.includes("secret-rules"))
          expect(rules.length).toBe(0)

          SecurityConfig.resetConfig()
        },
        async (dir) => {
          const rulesDir = path.join(dir, ".opencode", "rules")
          await fs.mkdir(rulesDir, { recursive: true })
          await Bun.write(path.join(rulesDir, "secret-rules.md"), "# Secret Rules\nDo not share these.")
          await Bun.write(
            path.join(dir, ".opencode-security.json"),
            JSON.stringify({
              version: "1.0",
              rules: [
                {
                  pattern: "**/.opencode/rules/**",
                  type: "file",
                  deniedOperations: ["read"],
                  allowedRoles: [],
                },
              ],
            }),
          )
        },
      )
    })
  })

  // --- compaction-context-injector ---

  describe("compaction-context-injector", () => {
    test("mock compaction event -> context preserved", async () => {
      await withInstance(async () => {
        const messages = [
          { role: "assistant", content: "I'm working on editing src/main.ts" },
          { role: "assistant", content: "decision: Use functional patterns over class-based" },
          { role: "assistant", content: "I modified src/utils.ts" },
        ]

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s1",
          event: "session.compacting",
          data: { messages, context: [] },
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { context: string[] }
        expect(data.context.length).toBeGreaterThan(0)
        // Should have captured file references and decisions
        const contextText = data.context.join("\n")
        expect(contextText.includes("decision:") || contextText.includes("File reference")).toBe(true)
      })
    })

    test("no relevant context in messages -> no injection", async () => {
      await withInstance(async () => {
        const messages = [
          { role: "user", content: "hello" },
          { role: "assistant", content: "Hi there!" },
        ]

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s1",
          event: "session.compacting",
          data: { messages, context: [] },
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { context: string[] }
        expect(data.context.length).toBe(0)
      })
    })
  })

  // --- compaction-todo-preserver ---

  describe("compaction-todo-preserver", () => {
    test("messages with incomplete todos -> todos extracted and re-injected", async () => {
      await withInstance(async () => {
        const messages = [
          { role: "assistant", content: "Here are the tasks:\n- [ ] Fix the login bug\n- [x] Update README\n- [ ] Add tests for auth module" },
          { role: "assistant", content: "Also TODO: refactor the database layer" },
        ]

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s1",
          event: "session.compacting",
          data: { messages, context: [] },
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { context: string[] }
        const todoContext = data.context.find((c) => c.includes("Incomplete tasks"))
        expect(todoContext).toBeDefined()
        expect(todoContext).toContain("Fix the login bug")
        expect(todoContext).toContain("Add tests for auth module")
        expect(todoContext).toContain("refactor the database layer")
      })
    })

    test("no incomplete todos -> no injection", async () => {
      await withInstance(async () => {
        const messages = [
          { role: "assistant", content: "All tasks completed:\n- [x] Fix bug\n- [x] Update docs" },
        ]

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s1",
          event: "session.compacting",
          data: { messages, context: [] },
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { context: string[] }
        const todoContext = data.context.find((c) => c.includes("Incomplete tasks"))
        expect(todoContext).toBeUndefined()
      })
    })

    test("todos re-injected on session.created", async () => {
      await withInstance(async () => {
        // First, simulate compaction to store todos
        const messages = [
          { role: "assistant", content: "- [ ] Fix the login bug\n- [ ] Add tests" },
        ]

        const compactCtx: HookChain.SessionLifecycleContext = {
          sessionID: "s1",
          event: "session.compacting",
          data: { messages, context: [] },
          agent: "build",
        }
        await HookChain.execute("session-lifecycle", compactCtx)

        // Verify todos were stored
        const todos = ContextInjectionHooks.getCompactionTodos()
        expect(todos.has("s1")).toBe(true)
        expect(todos.get("s1")!.length).toBe(2)

        // Now simulate session.created
        const createdCtx: HookChain.SessionLifecycleContext = {
          sessionID: "s1",
          event: "session.created",
          data: {},
          agent: "build",
        }
        await HookChain.execute("session-lifecycle", createdCtx)

        const data = createdCtx.data as { preservedTodos?: string[] }
        expect(data.preservedTodos).toBeDefined()
        expect(data.preservedTodos!.length).toBe(2)
      })
    })
  })

  // --- Config-driven disable ---

  describe("config-driven disable", () => {
    test("disabled directory-agents-injector -> no injection", async () => {
      await withInstance(
        async () => {
          HookChain.reloadConfig({ "directory-agents-injector": { enabled: false } })

          const ctx: HookChain.PreLLMContext = {
            sessionID: "s1",
            system: ["You are a helpful assistant."],
            agent: "build",
            model: "claude-sonnet-4-5-20250929",
            messages: [],
          }

          await HookChain.execute("pre-llm", ctx)

          const injected = ctx.system.find((s) => s.includes("AGENTS.md"))
          expect(injected).toBeUndefined()
        },
        async (dir) => {
          await Bun.write(path.join(dir, "AGENTS.md"), "# Agents\nShould not appear.")
        },
      )
    })

    test("disabled directory-readme-injector -> no injection", async () => {
      await withInstance(
        async () => {
          HookChain.reloadConfig({ "directory-readme-injector": { enabled: false } })

          const ctx: HookChain.PreLLMContext = {
            sessionID: "s1",
            system: ["You are a helpful assistant."],
            agent: "build",
            model: "claude-sonnet-4-5-20250929",
            messages: [],
          }

          await HookChain.execute("pre-llm", ctx)

          const injected = ctx.system.find((s) => s.includes("README.md"))
          expect(injected).toBeUndefined()
        },
        async (dir) => {
          await Bun.write(path.join(dir, "README.md"), "# Readme\nShould not appear.")
        },
      )
    })
  })

  // --- Internal helpers ---

  describe("internal helpers", () => {
    test("extractCriticalContext extracts file references", () => {
      const messages = [
        { role: "assistant", content: "I'm working on src/app.ts now" },
        { role: "assistant", content: "Modified src/utils.ts to add helper" },
      ]
      const result = ContextInjectionHooks.extractCriticalContext(messages)
      expect(result.length).toBeGreaterThan(0)
    })

    test("extractCriticalContext extracts decisions", () => {
      const messages = [
        { role: "assistant", content: "decision: Use React hooks instead of class components" },
      ]
      const result = ContextInjectionHooks.extractCriticalContext(messages)
      expect(result.length).toBeGreaterThan(0)
      expect(result.some((r) => r.includes("decision:"))).toBe(true)
    })

    test("extractCriticalContext returns empty for generic messages", () => {
      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hi! How can I help?" },
      ]
      const result = ContextInjectionHooks.extractCriticalContext(messages)
      expect(result.length).toBe(0)
    })

    test("extractIncompleteTodos finds markdown checkboxes", () => {
      const messages = [
        { role: "assistant", content: "- [ ] Task 1\n- [x] Task 2\n- [ ] Task 3" },
      ]
      const result = ContextInjectionHooks.extractIncompleteTodos(messages)
      expect(result).toContain("Task 1")
      expect(result).toContain("Task 3")
      expect(result).not.toContain("Task 2") // Checked
    })

    test("extractIncompleteTodos finds TODO comments", () => {
      const messages = [
        { role: "assistant", content: "TODO: implement error handling\nFIXME: fix race condition" },
      ]
      const result = ContextInjectionHooks.extractIncompleteTodos(messages)
      expect(result).toContain("implement error handling")
      expect(result).toContain("fix race condition")
    })

    test("extractIncompleteTodos deduplicates", () => {
      const messages = [
        { role: "assistant", content: "TODO: fix bug\nTODO: fix bug" },
      ]
      const result = ContextInjectionHooks.extractIncompleteTodos(messages)
      expect(result.filter((t) => t === "fix bug").length).toBe(1)
    })

    test("extractIncompleteTodos returns empty for no todos", () => {
      const messages = [
        { role: "assistant", content: "Everything is done!" },
      ]
      const result = ContextInjectionHooks.extractIncompleteTodos(messages)
      expect(result.length).toBe(0)
    })
  })
})
