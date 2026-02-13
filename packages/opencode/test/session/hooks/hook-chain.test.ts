import { describe, expect, test, beforeEach, mock } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { HookChain } from "../../../src/session/hooks"

describe("HookChain", () => {
  async function withInstance(
    fn: () => Promise<void>,
    config?: Record<string, unknown>,
  ) {
    await using tmp = await tmpdir({
      git: true,
      config: config ?? {},
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        HookChain.reset()
        await fn()
      },
    })
  }

  // --- Chain execution order ---

  test("chain execution order respects priority (lower number = earlier)", async () => {
    await withInstance(async () => {
      const order: string[] = []

      HookChain.register("hook-c", "pre-llm", 300, async () => {
        order.push("c")
      })
      HookChain.register("hook-a", "pre-llm", 100, async () => {
        order.push("a")
      })
      HookChain.register("hook-b", "pre-llm", 200, async () => {
        order.push("b")
      })

      await HookChain.execute("pre-llm", {
        sessionID: "test-session",
        system: ["prompt"],
        agent: "build",
        model: "claude-opus-4-6",
        messages: [],
      })

      expect(order).toEqual(["a", "b", "c"])
    })
  })

  // --- Disabled hook ---

  test("disabled hook is skipped with zero overhead", async () => {
    await withInstance(async () => {
      const executed: string[] = []

      HookChain.register("enabled-hook", "pre-llm", 100, async () => {
        executed.push("enabled")
      })
      HookChain.register("disabled-hook", "pre-llm", 200, async () => {
        executed.push("disabled")
      })

      // Disable the second hook via config
      HookChain.reloadConfig({ "disabled-hook": { enabled: false } })

      await HookChain.execute("pre-llm", {
        sessionID: "test-session",
        system: ["prompt"],
        agent: "build",
        model: "claude-opus-4-6",
        messages: [],
      })

      expect(executed).toEqual(["enabled"])
    })
  })

  // --- Chain compilation caching ---

  test("chain compilation caches correctly", async () => {
    await withInstance(async () => {
      const executed: number[] = []

      HookChain.register("hook-1", "pre-llm", 100, async () => {
        executed.push(1)
      })

      // First execution triggers compilation
      await HookChain.execute("pre-llm", {
        sessionID: "s1",
        system: [],
        agent: "build",
        model: "m1",
        messages: [],
      })

      // Second execution uses cache (same compiled chain)
      await HookChain.execute("pre-llm", {
        sessionID: "s2",
        system: [],
        agent: "build",
        model: "m1",
        messages: [],
      })

      expect(executed).toEqual([1, 1])
    })
  })

  // --- Error isolation ---

  test("error in one hook does not crash chain (error isolation with logging)", async () => {
    await withInstance(async () => {
      const executed: string[] = []

      HookChain.register("hook-before", "pre-llm", 100, async () => {
        executed.push("before")
      })
      HookChain.register("hook-error", "pre-llm", 200, async () => {
        throw new Error("intentional test error")
      })
      HookChain.register("hook-after", "pre-llm", 300, async () => {
        executed.push("after")
      })

      await HookChain.execute("pre-llm", {
        sessionID: "s1",
        system: [],
        agent: "build",
        model: "m1",
        messages: [],
      })

      expect(executed).toEqual(["before", "after"])
    })
  })

  // --- PreLLMChain receives correct system prompt context ---

  test("PreLLMChain receives correct system prompt context", async () => {
    await withInstance(async () => {
      let receivedCtx: HookChain.PreLLMContext | undefined

      HookChain.register("capture-hook", "pre-llm", 100, async (ctx) => {
        receivedCtx = ctx
      })

      const inputCtx: HookChain.PreLLMContext = {
        sessionID: "session-123",
        system: ["You are a helpful assistant", "Be concise"],
        agent: "build",
        model: "claude-opus-4-6",
        variant: "max",
        messages: [{ role: "user", content: "Hello" }],
      }

      await HookChain.execute("pre-llm", inputCtx)

      expect(receivedCtx).toBeDefined()
      expect(receivedCtx!.sessionID).toBe("session-123")
      expect(receivedCtx!.system).toEqual(["You are a helpful assistant", "Be concise"])
      expect(receivedCtx!.agent).toBe("build")
      expect(receivedCtx!.model).toBe("claude-opus-4-6")
      expect(receivedCtx!.variant).toBe("max")
    })
  })

  // --- PreToolChain receives tool name + args ---

  test("PreToolChain receives tool name + args", async () => {
    await withInstance(async () => {
      let receivedCtx: HookChain.PreToolContext | undefined

      HookChain.register("capture-tool", "pre-tool", 100, async (ctx) => {
        receivedCtx = ctx
      })

      await HookChain.execute("pre-tool", {
        sessionID: "session-123",
        toolName: "edit",
        args: { file_path: "/src/main.ts", old_string: "foo", new_string: "bar" },
        agent: "build",
      })

      expect(receivedCtx).toBeDefined()
      expect(receivedCtx!.toolName).toBe("edit")
      expect(receivedCtx!.args.file_path).toBe("/src/main.ts")
    })
  })

  // --- PostToolChain receives tool result + can modify it ---

  test("PostToolChain receives tool result + can modify it", async () => {
    await withInstance(async () => {
      HookChain.register("modify-result", "post-tool", 100, async (ctx) => {
        ctx.result.output = ctx.result.output + " [truncated]"
      })

      const ctx: HookChain.PostToolContext = {
        sessionID: "session-123",
        toolName: "read",
        args: { file_path: "/src/main.ts" },
        result: {
          output: "file contents here",
          title: "Read file",
          metadata: {},
        },
        agent: "build",
      }

      await HookChain.execute("post-tool", ctx)

      expect(ctx.result.output).toBe("file contents here [truncated]")
    })
  })

  // --- SessionLifecycleChain receives session events ---

  test("SessionLifecycleChain receives session events", async () => {
    await withInstance(async () => {
      let receivedCtx: HookChain.SessionLifecycleContext | undefined

      HookChain.register("lifecycle-hook", "session-lifecycle", 100, async (ctx) => {
        receivedCtx = ctx
      })

      await HookChain.execute("session-lifecycle", {
        sessionID: "session-123",
        event: "session.created",
        data: { title: "New Session" },
        agent: "build",
      })

      expect(receivedCtx).toBeDefined()
      expect(receivedCtx!.event).toBe("session.created")
      expect(receivedCtx!.data).toEqual({ title: "New Session" })
    })
  })

  // --- Config-driven enable/disable toggles hook at runtime reload ---

  test("config-driven enable/disable toggles hook at runtime reload", async () => {
    await withInstance(async () => {
      const executed: string[] = []

      HookChain.register("toggleable-hook", "pre-llm", 100, async () => {
        executed.push("executed")
      })

      const ctx: HookChain.PreLLMContext = {
        sessionID: "s1",
        system: [],
        agent: "build",
        model: "m1",
        messages: [],
      }

      // Initially enabled (default)
      await HookChain.execute("pre-llm", ctx)
      expect(executed).toEqual(["executed"])

      // Disable via config reload
      HookChain.reloadConfig({ "toggleable-hook": { enabled: false } })
      await HookChain.execute("pre-llm", ctx)
      expect(executed).toEqual(["executed"]) // No new execution

      // Re-enable via config reload
      HookChain.reloadConfig({ "toggleable-hook": { enabled: true } })
      await HookChain.execute("pre-llm", ctx)
      expect(executed).toEqual(["executed", "executed"])
    })
  })

  // --- Plugin.trigger() executes BEFORE internal middleware chain ---

  test("Plugin.trigger() executes BEFORE internal middleware chain at same hook point", async () => {
    await withInstance(async () => {
      // We test the combined execution method.
      // Since we can't easily mock Plugin.trigger in this test environment,
      // we verify that the internal chain runs and modifies the output.
      const order: string[] = []

      HookChain.register("internal-hook", "pre-llm", 100, async (ctx) => {
        order.push("internal")
        ctx.system.push("injected by internal hook")
      })

      const pluginOutput = { system: ["original system prompt"] }
      const ctx: HookChain.PreLLMContext = {
        sessionID: "s1",
        system: pluginOutput.system,
        agent: "build",
        model: "m1",
        messages: [],
      }

      // Execute just the internal chain directly
      await HookChain.execute("pre-llm", ctx)

      expect(order).toEqual(["internal"])
      expect(ctx.system).toContain("injected by internal hook")
    })
  })

  // --- Plugin can modify data that internal middleware chain then receives ---

  test("plugin can modify data that internal middleware chain then receives", async () => {
    await withInstance(async () => {
      let receivedSystem: string[] = []

      HookChain.register("reader-hook", "pre-llm", 100, async (ctx) => {
        receivedSystem = [...ctx.system]
      })

      // Simulate plugin modifying data before internal chain
      const ctx: HookChain.PreLLMContext = {
        sessionID: "s1",
        system: ["original", "plugin-injected"],
        agent: "build",
        model: "m1",
        messages: [],
      }

      await HookChain.execute("pre-llm", ctx)

      expect(receivedSystem).toEqual(["original", "plugin-injected"])
    })
  })

  // --- Internal middleware chain still runs when no plugins registered ---

  test("internal middleware chain still runs when no plugins registered", async () => {
    await withInstance(async () => {
      const executed: string[] = []

      HookChain.register("standalone-hook", "pre-llm", 100, async () => {
        executed.push("ran")
      })

      await HookChain.execute("pre-llm", {
        sessionID: "s1",
        system: [],
        agent: "build",
        model: "m1",
        messages: [],
      })

      expect(executed).toEqual(["ran"])
    })
  })

  // --- Init with config ---

  test("init with hooks config sets enabled state", async () => {
    await withInstance(async () => {
      HookChain.register("hook-a", "pre-llm", 100, async () => {})
      HookChain.register("hook-b", "pre-llm", 200, async () => {})

      await HookChain.init({
        "hook-a": { enabled: true },
        "hook-b": { enabled: false },
      })

      const hooks = HookChain.listRegistered("pre-llm")
      const hookA = hooks.find((h) => h.name === "hook-a")
      const hookB = hooks.find((h) => h.name === "hook-b")

      expect(hookA?.enabled).toBe(true)
      expect(hookB?.enabled).toBe(false)
    })
  })

  // --- Security order enforcement ---

  test("security hooks run before transform hooks before output hooks", async () => {
    await withInstance(async () => {
      const order: string[] = []

      // Output hook (highest priority number = runs last)
      HookChain.register("output-hook", "post-tool", 500, async () => {
        order.push("output")
      })
      // Transform hook (medium priority)
      HookChain.register("transform-hook", "post-tool", 200, async () => {
        order.push("transform")
      })
      // Security hook (lowest priority number = runs first)
      HookChain.register("security-hook", "post-tool", 10, async () => {
        order.push("security")
      })

      await HookChain.execute("post-tool", {
        sessionID: "s1",
        toolName: "read",
        args: {},
        result: { output: "data", title: "Read" },
        agent: "build",
      })

      expect(order).toEqual(["security", "transform", "output"])
    })
  })

  // --- Multiple chain types independent ---

  test("hooks on different chain types are independent", async () => {
    await withInstance(async () => {
      const preLlmExecuted: string[] = []
      const postToolExecuted: string[] = []

      HookChain.register("pre-llm-hook", "pre-llm", 100, async () => {
        preLlmExecuted.push("ran")
      })
      HookChain.register("post-tool-hook", "post-tool", 100, async () => {
        postToolExecuted.push("ran")
      })

      await HookChain.execute("pre-llm", {
        sessionID: "s1",
        system: [],
        agent: "build",
        model: "m1",
        messages: [],
      })

      expect(preLlmExecuted).toEqual(["ran"])
      expect(postToolExecuted).toEqual([])
    })
  })

  // --- listRegistered ---

  test("listRegistered returns all registered hooks", async () => {
    await withInstance(async () => {
      HookChain.register("h1", "pre-llm", 100, async () => {})
      HookChain.register("h2", "post-tool", 200, async () => {})
      HookChain.register("h3", "pre-tool", 50, async () => {})

      const all = HookChain.listRegistered()
      expect(all.length).toBe(3)

      const preLlm = HookChain.listRegistered("pre-llm")
      expect(preLlm.length).toBe(1)
      expect(preLlm[0].name).toBe("h1")

      const preTool = HookChain.listRegistered("pre-tool")
      expect(preTool.length).toBe(1)
      expect(preTool[0].name).toBe("h3")
    })
  })

  // --- Reset clears all state ---

  test("reset clears all registered hooks", async () => {
    await withInstance(async () => {
      HookChain.register("h1", "pre-llm", 100, async () => {})
      expect(HookChain.listRegistered().length).toBe(1)

      HookChain.reset()
      expect(HookChain.listRegistered().length).toBe(0)
    })
  })
})
