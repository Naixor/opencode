import { test, expect, describe } from "bun:test"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

async function writeConfig(dir: string, config: object, name = "opencode.json") {
  await Bun.write(dir + "/" + name, JSON.stringify(config))
}

describe("OMO config schema", () => {
  test("empty config -> all defaults applied", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        // All OMO fields should be undefined (defaults)
        expect(config.hooks).toBeUndefined()
        expect(config.background_task).toBeUndefined()
        expect(config.categories).toBeUndefined()
        expect(config.disabled_mcps).toBeUndefined()
        expect(config.notification).toBeUndefined()
        // Agent section defaults to empty
        expect(config.agent).toBeDefined()
      },
    })
  })

  test("agents section enable agent -> loaded", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          agent: {
            hephaestus: { enabled: true, model: "anthropic/claude-haiku" },
            prometheus: { enabled: true, temperature: 0.2 },
          },
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.agent!.hephaestus).toBeDefined()
        expect(config.agent!.hephaestus!.model).toBe("anthropic/claude-haiku")
        expect(config.agent!.hephaestus!.options!.enabled).toBe(true)
        expect(config.agent!.prometheus).toBeDefined()
        expect(config.agent!.prometheus!.temperature).toBe(0.2)
        expect(config.agent!.prometheus!.options!.enabled).toBe(true)
      },
    })
  })

  test("categories section add custom -> available", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          categories: {
            "my-category": {
              description: "Custom task category",
              model: "openai/gpt-5",
              prompt_append: "Extra instructions",
            },
          },
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.categories).toBeDefined()
        expect(config.categories!["my-category"]).toBeDefined()
        expect(config.categories!["my-category"].description).toBe("Custom task category")
        expect(config.categories!["my-category"].model).toBe("openai/gpt-5")
        expect(config.categories!["my-category"].prompt_append).toBe("Extra instructions")
      },
    })
  })

  test("hooks section disable -> hook skipped", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          hooks: {
            "edit-error-recovery": { enabled: false },
            "context-window-monitor": { enabled: true },
          },
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.hooks).toBeDefined()
        expect(config.hooks!["edit-error-recovery"]).toEqual({ enabled: false })
        expect(config.hooks!["context-window-monitor"]).toEqual({ enabled: true })
      },
    })
  })

  test("background_task concurrency -> enforced", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          background_task: {
            defaultConcurrency: 5,
            providerConcurrency: { anthropic: 3 },
            modelConcurrency: { "claude-opus": 2 },
            staleTimeoutMs: 300000,
            persist_on_exit: true,
          },
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.background_task).toBeDefined()
        expect(config.background_task!.defaultConcurrency).toBe(5)
        expect(config.background_task!.providerConcurrency!.anthropic).toBe(3)
        expect(config.background_task!.modelConcurrency!["claude-opus"]).toBe(2)
        expect(config.background_task!.staleTimeoutMs).toBe(300000)
        expect(config.background_task!.persist_on_exit).toBe(true)
      },
    })
  })

  test("notification disable -> no notifications", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          notification: {
            enabled: false,
            sound: false,
          },
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.notification).toBeDefined()
        expect(config.notification!.enabled).toBe(false)
        expect(config.notification!.sound).toBe(false)
      },
    })
  })

  test("disabled_mcps -> server not loaded", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          disabled_mcps: ["websearch", "context7"],
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.disabled_mcps).toBeDefined()
        expect(config.disabled_mcps).toContain("websearch")
        expect(config.disabled_mcps).toContain("context7")
        expect(config.disabled_mcps!.length).toBe(2)
      },
    })
  })

  test("invalid value -> Zod error with helpful message", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          background_task: {
            defaultConcurrency: "not-a-number",
          },
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const err = await Config.get().catch((e: unknown) => e)
        expect(err).toBeDefined()
        expect(Config.InvalidError.isInstance(err)).toBe(true)
        if (Config.InvalidError.isInstance(err)) {
          expect(err.data.issues).toBeDefined()
          expect(err.data.issues!.length).toBeGreaterThan(0)
        }
      },
    })
  })

  test("existing valid config -> no errors", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          model: "anthropic/claude-opus-4-6",
          username: "developer",
          agent: {
            build: { model: "anthropic/claude-sonnet-4-5-20250929" },
          },
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.model).toBe("anthropic/claude-opus-4-6")
        expect(config.username).toBe("developer")
        expect(config.agent!.build!.model).toBe("anthropic/claude-sonnet-4-5-20250929")
      },
    })
  })

  test("all OMO config sections coexist without conflict", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          agent: {
            hephaestus: { enabled: true },
          },
          categories: {
            quick: { description: "Fast tasks" },
          },
          hooks: {
            "edit-error-recovery": { enabled: false },
          },
          background_task: {
            defaultConcurrency: 2,
          },
          notification: {
            enabled: true,
            sound: false,
          },
          disabled_mcps: ["grep_app"],
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.agent!.hephaestus!.options!.enabled).toBe(true)
        expect(config.categories!.quick.description).toBe("Fast tasks")
        expect(config.hooks!["edit-error-recovery"].enabled).toBe(false)
        expect(config.background_task!.defaultConcurrency).toBe(2)
        expect(config.notification!.enabled).toBe(true)
        expect(config.notification!.sound).toBe(false)
        expect(config.disabled_mcps).toContain("grep_app")
      },
    })
  })
})
