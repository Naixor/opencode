import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { HookChain } from "../../../src/session/hooks"

describe("HookChain", () => {
  async function withInstance(fn: () => Promise<void>) {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        HookChain.reset()
        await fn()
      },
    })
  }

  test("non-fatal hook errors are still swallowed", async () => {
    await withInstance(async () => {
      HookChain.register("soft", "pre-llm", 1, async () => {
        throw new Error("soft fail")
      })

      const ctx: HookChain.PreLLMContext = {
        sessionID: "s1",
        system: ["base"],
        agent: "build",
        model: "claude-sonnet-4-5-20250929",
        messages: [],
      }

      await expect(HookChain.execute("pre-llm", ctx)).resolves.toBeUndefined()
    })
  })

  test("fatal hook errors are rethrown", async () => {
    await withInstance(async () => {
      HookChain.register(
        "hard",
        "pre-llm",
        1,
        async () => {
          throw new Error("hard fail")
        },
        { fatal: true },
      )

      const ctx: HookChain.PreLLMContext = {
        sessionID: "s1",
        system: ["base"],
        agent: "build",
        model: "claude-sonnet-4-5-20250929",
        messages: [],
      }

      await expect(HookChain.execute("pre-llm", ctx)).rejects.toThrow("hard fail")
    })
  })
})
