/**
 * US-031: context injection hooks security integration tests.
 */
import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"
import { HookChain } from "../../../src/session/hooks"
import { ContextInjectionHooks } from "../../../src/session/hooks/context-injection"
import { SecurityConfig } from "../../../src/security/config"

describe("context injection security integration", () => {
  test("context injection AGENTS.md protected segment -> redacted", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {},
      init: async (dir) => {
        const content = [
          "# Agents",
          "Public content here.",
          "// @security-start",
          "super-secret-api-key-12345",
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
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        HookChain.reset()
        ContextInjectionHooks.resetCaches()
        ContextInjectionHooks.register()

        await SecurityConfig.loadSecurityConfig(tmp.path)

        const hookCtx: HookChain.PreLLMContext = {
          sessionID: "s-security-integration",
          system: ["You are a helpful assistant."],
          agent: "build",
          model: "claude-sonnet-4-5-20250929",
          messages: [],
        }

        await HookChain.execute("pre-llm", hookCtx)

        const injected = hookCtx.system.find((s) => s.includes("AGENTS.md"))
        expect(injected).toBeDefined()
        expect(injected).toContain("Public content")
        // Secret should be redacted
        expect(injected).not.toContain("super-secret-api-key-12345")

        SecurityConfig.resetConfig()
      },
    })
  })

  test("context injection rules with protected rule file -> file skipped", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {},
      init: async (dir) => {
        const rulesDir = path.join(dir, ".opencode", "rules")
        fs.mkdirSync(rulesDir, { recursive: true })
        fs.writeFileSync(path.join(rulesDir, "secret-rules.md"), "# Secret Rules\nDo not share these.")
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
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        HookChain.reset()
        ContextInjectionHooks.resetCaches()
        ContextInjectionHooks.register()

        await SecurityConfig.loadSecurityConfig(tmp.path)

        const hookCtx: HookChain.PreLLMContext = {
          sessionID: "s-security-rules-integration",
          system: ["You are a helpful assistant."],
          agent: "build",
          model: "claude-sonnet-4-5-20250929",
          messages: [],
        }

        await HookChain.execute("pre-llm", hookCtx)

        // Protected rule should not appear
        const rules = hookCtx.system.filter((s) => s.includes("secret-rules"))
        expect(rules.length).toBe(0)

        SecurityConfig.resetConfig()
      },
    })
  })
})
