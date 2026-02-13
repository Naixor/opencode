import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { HookChain } from "../../../src/session/hooks"
import { LLMParameterHooks } from "../../../src/session/hooks/llm-parameters"

describe("LLMParameterHooks", () => {
  async function withInstance(fn: () => Promise<void>) {
    await using tmp = await tmpdir({
      git: true,
      config: {},
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        HookChain.reset()
        LLMParameterHooks.register()
        await fn()
      },
    })
  }

  // --- think-mode ---

  describe("think-mode", () => {
    test("variant 'max' -> thinkingBudget=32000", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-opus-4-20250514",
          variant: "max",
          messages: [{ role: "user", content: "do something" }],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.providerOptions).toBeDefined()
        expect(ctx.providerOptions!.thinking).toEqual({
          type: "enabled",
          budgetTokens: 32000,
        })
      })
    })

    test("variant 'quick' -> thinking disabled", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-sonnet-4-20250514",
          variant: "quick",
          messages: [{ role: "user", content: "quick fix" }],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.providerOptions).toBeDefined()
        expect(ctx.providerOptions!.thinking).toEqual({
          type: "disabled",
        })
      })
    })

    test("no variant -> default behavior unchanged", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-opus-4-20250514",
          messages: [{ role: "user", content: "do something" }],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.providerOptions).toBeUndefined()
      })
    })

    test("non-Claude model -> no thinking set", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "gpt-4o",
          variant: "max",
          messages: [{ role: "user", content: "do something" }],
        }

        await HookChain.execute("pre-llm", ctx)

        // think-mode should not set providerOptions for non-Claude
        // anthropic-effort also skips non-Claude
        expect(ctx.providerOptions).toBeUndefined()
      })
    })

    test("other variant -> default thinking budget", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-opus-4-20250514",
          variant: "analyze",
          messages: [{ role: "user", content: "analyze this" }],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.providerOptions).toBeDefined()
        expect(ctx.providerOptions!.thinking).toEqual({
          type: "enabled",
          budgetTokens: 16000,
        })
      })
    })
  })

  // --- anthropic-effort ---

  describe("anthropic-effort", () => {
    test("variant 'max' -> effort='high'", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-opus-4-20250514",
          variant: "max",
          messages: [{ role: "user", content: "do something complex" }],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.providerOptions).toBeDefined()
        expect(ctx.providerOptions!.effort).toBe("high")
      })
    })

    test("variant 'quick' -> effort='low'", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-sonnet-4-20250514",
          variant: "quick",
          messages: [{ role: "user", content: "quick question" }],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.providerOptions).toBeDefined()
        expect(ctx.providerOptions!.effort).toBe("low")
      })
    })

    test("no variant -> no effort set", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-opus-4-20250514",
          messages: [{ role: "user", content: "do something" }],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.providerOptions).toBeUndefined()
      })
    })

    test("other variant -> effort='medium'", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-opus-4-20250514",
          variant: "analyze",
          messages: [{ role: "user", content: "analyze this" }],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.providerOptions).toBeDefined()
        expect(ctx.providerOptions!.effort).toBe("medium")
      })
    })

    test("non-Claude model -> no effort set", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "gpt-4o",
          variant: "max",
          messages: [{ role: "user", content: "do something" }],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.providerOptions).toBeUndefined()
      })
    })
  })

  // --- Config-driven disable ---

  describe("config-driven disable", () => {
    test("disabled think-mode -> no thinking set on variant 'max'", async () => {
      await withInstance(async () => {
        HookChain.reloadConfig({ "think-mode": { enabled: false } })

        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-opus-4-20250514",
          variant: "max",
          messages: [{ role: "user", content: "do something" }],
        }

        await HookChain.execute("pre-llm", ctx)

        // anthropic-effort still runs, but think-mode is disabled
        expect(ctx.providerOptions?.thinking).toBeUndefined()
        // effort should still be set
        expect(ctx.providerOptions?.effort).toBe("high")
      })
    })

    test("disabled anthropic-effort -> no effort set on variant 'max'", async () => {
      await withInstance(async () => {
        HookChain.reloadConfig({ "anthropic-effort": { enabled: false } })

        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-opus-4-20250514",
          variant: "max",
          messages: [{ role: "user", content: "do something" }],
        }

        await HookChain.execute("pre-llm", ctx)

        // think-mode still runs, but anthropic-effort is disabled
        expect(ctx.providerOptions?.thinking).toEqual({
          type: "enabled",
          budgetTokens: 32000,
        })
        expect(ctx.providerOptions?.effort).toBeUndefined()
      })
    })
  })

  // --- Priority ordering ---

  describe("priority ordering", () => {
    test("think-mode (50) runs before anthropic-effort (60)", async () => {
      await withInstance(async () => {
        const hooks = HookChain.listRegistered("pre-llm")
        const thinkMode = hooks.find((h) => h.name === "think-mode")
        const anthropicEffort = hooks.find((h) => h.name === "anthropic-effort")

        expect(thinkMode).toBeDefined()
        expect(anthropicEffort).toBeDefined()
        expect(thinkMode!.priority).toBeLessThan(anthropicEffort!.priority)
      })
    })
  })
})
