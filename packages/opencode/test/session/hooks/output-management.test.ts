import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { HookChain } from "../../../src/session/hooks"
import { OutputManagementHooks } from "../../../src/session/hooks/output-management"

describe("OutputManagementHooks", () => {
  async function withInstance(fn: () => Promise<void>) {
    await using tmp = await tmpdir({
      git: true,
      config: {},
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        HookChain.reset()
        OutputManagementHooks.resetThresholds()
        OutputManagementHooks.register()
        await fn()
      },
    })
  }

  // --- tool-output-truncator ---

  describe("tool-output-truncator", () => {
    test("1MB output -> truncated to budget with [truncated] suffix", async () => {
      await withInstance(async () => {
        const largeOutput = "x".repeat(1024 * 1024) // 1MB
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "bash",
          args: { command: "cat bigfile" },
          result: {
            output: largeOutput,
            title: "Bash",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output.length).toBeLessThan(largeOutput.length)
        expect(ctx.result.output).toContain("[truncated")
      })
    })

    test("100 byte output -> no truncation", async () => {
      await withInstance(async () => {
        const smallOutput = "hello world - this is a small output"
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "read",
          args: { file_path: "/src/main.ts" },
          result: {
            output: smallOutput,
            title: "Read",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).toBe(smallOutput)
      })
    })

    test("output with [REDACTED: Security Protected] -> markers preserved after truncation", async () => {
      await withInstance(async () => {
        // Create output where the marker is beyond the truncation point
        const prefix = "x".repeat(50 * 1024 + 100) // Over 50KB
        const marker = "[REDACTED: Security Protected]"
        const output = prefix + "\n" + marker + "\nmore data after marker"

        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "bash",
          args: {},
          result: {
            output,
            title: "Bash",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).toContain(marker)
        expect(ctx.result.output).toContain("[truncated")
      })
    })

    test("15MB stream -> only first N bytes read + tail message", async () => {
      await withInstance(async () => {
        const streamOutput = "data-line\n".repeat(1500000) // ~15MB
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "bash",
          args: {},
          result: {
            output: streamOutput,
            title: "Bash",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output.length).toBeLessThan(streamOutput.length)
        expect(ctx.result.output).toContain("[truncated")
        expect(ctx.result.output).toContain("bytes")
      })
    })
  })

  // --- grep-output-truncator ---

  describe("grep-output-truncator", () => {
    test("grep 500 matches -> truncated with count message", async () => {
      await withInstance(async () => {
        const lines = Array.from({ length: 500 }, (_, i) => `src/file${i}.ts:${i}: match ${i}`).join("\n")
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "grep",
          args: { pattern: "foo" },
          result: {
            output: lines,
            title: "Grep",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).toContain("showing 50 of 500 matches")
      })
    })

    test("grep 10 matches -> no truncation", async () => {
      await withInstance(async () => {
        const lines = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts:${i}: match ${i}`).join("\n")
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "grep",
          args: { pattern: "foo" },
          result: {
            output: lines,
            title: "Grep",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).not.toContain("showing")
        expect(ctx.result.output).toBe(lines)
      })
    })

    test("non-grep tool -> not affected by grep truncator", async () => {
      await withInstance(async () => {
        const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n")
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "read",
          args: {},
          result: {
            output: lines,
            title: "Read",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        // read tool should not be affected by grep truncator (though tool-output-truncator may truncate if over 50KB)
        expect(ctx.result.output).not.toContain("showing")
      })
    })
  })

  // --- question-label-truncator ---

  describe("question-label-truncator", () => {
    test("300 char question label -> truncated to 200 with '...'", async () => {
      await withInstance(async () => {
        const longTitle = "A".repeat(300)
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "ask",
          args: {},
          result: {
            output: "some output",
            title: longTitle,
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.title!.length).toBe(203) // 200 + "..."
        expect(ctx.result.title!).toEndWith("...")
      })
    })

    test("short title -> no truncation", async () => {
      await withInstance(async () => {
        const title = "Short Title"
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "ask",
          args: {},
          result: {
            output: "some output",
            title,
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.title).toBe(title)
      })
    })

    test("no title -> no error", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "ask",
          args: {},
          result: {
            output: "some output",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.title).toBeUndefined()
      })
    })
  })

  // --- context-window-monitor ---

  describe("context-window-monitor", () => {
    test("85% context usage -> warning injected", async () => {
      await withInstance(async () => {
        // For a 200k token model, we need ~680k chars (4 chars per token * 170k tokens = 680k chars)
        // system + messages must total ~85% of context
        const bigMessages = Array.from({ length: 100 }, (_, i) => ({
          role: "user",
          content: "x".repeat(6800), // 100 messages * 6800 chars = 680k chars = ~170k tokens
        }))

        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are a helpful assistant."],
          agent: "build",
          model: "claude-sonnet-4-5-20250929",
          messages: bigMessages,
        }

        await HookChain.execute("pre-llm", ctx)

        const lastSystem = ctx.system[ctx.system.length - 1]
        expect(lastSystem).toContain("WARNING")
        expect(lastSystem).toContain("Context window")
      })
    })

    test("50% context usage -> no warning", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are a helpful assistant."],
          agent: "build",
          model: "claude-sonnet-4-5-20250929",
          messages: [{ role: "user", content: "hello" }],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.system.length).toBe(1)
        expect(ctx.system[0]).toBe("You are a helpful assistant.")
      })
    })

    test("custom threshold 70% -> warning triggers at 70%", async () => {
      await withInstance(async () => {
        OutputManagementHooks.configureThresholds({ warningThreshold: 0.7 })

        // ~75% usage: 150k tokens out of 200k = 600k chars
        const bigMessages = Array.from({ length: 100 }, (_, i) => ({
          role: "user",
          content: "x".repeat(6000),
        }))

        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are a helpful assistant."],
          agent: "build",
          model: "claude-sonnet-4-5-20250929",
          messages: bigMessages,
        }

        await HookChain.execute("pre-llm", ctx)

        const lastSystem = ctx.system[ctx.system.length - 1]
        expect(lastSystem).toContain("WARNING")
      })
    })
  })

  // --- preemptive-compaction ---

  describe("preemptive-compaction", () => {
    test("92% context usage -> compaction triggered", async () => {
      await withInstance(async () => {
        // ~92% usage: 184k tokens = 736k chars
        const bigMessages = Array.from({ length: 100 }, (_, i) => ({
          role: "user",
          content: "x".repeat(7360),
        }))

        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are a helpful assistant."],
          agent: "build",
          model: "claude-sonnet-4-5-20250929",
          messages: bigMessages,
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.variant).toBe("compact")
        const lastSystem = ctx.system[ctx.system.length - 1]
        expect(lastSystem).toContain("CRITICAL")
        expect(lastSystem).toContain("Compaction triggered")
      })
    })

    test("85% context usage -> no compaction (only warning)", async () => {
      await withInstance(async () => {
        // ~85% usage: 170k tokens = 680k chars
        const bigMessages = Array.from({ length: 100 }, (_, i) => ({
          role: "user",
          content: "x".repeat(6800),
        }))

        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are a helpful assistant."],
          agent: "build",
          model: "claude-sonnet-4-5-20250929",
          messages: bigMessages,
        }

        await HookChain.execute("pre-llm", ctx)

        // Should have warning but NOT compaction
        expect(ctx.variant).toBeUndefined()
        const systemTexts = ctx.system.join(" ")
        expect(systemTexts).toContain("WARNING")
        expect(systemTexts).not.toContain("CRITICAL")
      })
    })
  })

  // --- Config-driven disable ---

  describe("config-driven disable", () => {
    test("disabled tool-output-truncator -> no truncation on large output", async () => {
      await withInstance(async () => {
        HookChain.reloadConfig({ "tool-output-truncator": { enabled: false } })

        const largeOutput = "x".repeat(100 * 1024) // 100KB
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "bash",
          args: {},
          result: {
            output: largeOutput,
            title: "Bash",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        // tool-output-truncator is disabled, so output should remain large
        // (grep-output-truncator won't touch non-grep tools)
        expect(ctx.result.output).toBe(largeOutput)
      })
    })

    test("disabled context-window-monitor -> no warning", async () => {
      await withInstance(async () => {
        HookChain.reloadConfig({ "context-window-monitor": { enabled: false } })

        const bigMessages = Array.from({ length: 100 }, (_, i) => ({
          role: "user",
          content: "x".repeat(6800),
        }))

        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are a helpful assistant."],
          agent: "build",
          model: "claude-sonnet-4-5-20250929",
          messages: bigMessages,
        }

        await HookChain.execute("pre-llm", ctx)

        // preemptive-compaction may still fire (it's not disabled), but context-window-monitor should not
        const systemTexts = ctx.system.filter((s) => s.includes("WARNING"))
        expect(systemTexts.length).toBe(0)
      })
    })

    test("disabled preemptive-compaction -> no compaction", async () => {
      await withInstance(async () => {
        HookChain.reloadConfig({ "preemptive-compaction": { enabled: false } })

        const bigMessages = Array.from({ length: 100 }, (_, i) => ({
          role: "user",
          content: "x".repeat(7360),
        }))

        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are a helpful assistant."],
          agent: "build",
          model: "claude-sonnet-4-5-20250929",
          messages: bigMessages,
        }

        await HookChain.execute("pre-llm", ctx)

        // Should not set compact variant since preemptive-compaction is disabled
        expect(ctx.variant).toBeUndefined()
      })
    })
  })

  // --- Internal function tests ---

  describe("internal helpers", () => {
    test("truncateOutput preserves markers across truncation boundary", () => {
      const marker = "[REDACTED: Security Protected]"
      const before = "a".repeat(100)
      const after = marker
      const output = before + after
      const result = OutputManagementHooks.truncateOutput(output, 80)
      expect(result.wasTruncated).toBe(true)
      expect(result.text).toContain(marker)
    })

    test("truncateOutput no truncation for small output", () => {
      const result = OutputManagementHooks.truncateOutput("small", 1000)
      expect(result.wasTruncated).toBe(false)
      expect(result.text).toBe("small")
    })

    test("countGrepMatches counts non-empty lines", () => {
      const output = "file1.ts:1: match\n\nfile2.ts:2: match\nfile3.ts:3: match"
      expect(OutputManagementHooks.countGrepMatches(output)).toBe(3)
    })

    test("estimateTokens rough estimate", () => {
      const tokens = OutputManagementHooks.estimateTokens("hello world") // 11 chars
      expect(tokens).toBe(3) // ceil(11/4)
    })

    test("getModelContextWindow returns correct sizes", () => {
      expect(OutputManagementHooks.getModelContextWindow("claude-opus-4-6")).toBe(200000)
      expect(OutputManagementHooks.getModelContextWindow("gpt-4-turbo")).toBe(128000)
      expect(OutputManagementHooks.getModelContextWindow("gemini-pro")).toBe(1000000)
      expect(OutputManagementHooks.getModelContextWindow("unknown-model")).toBe(128000)
    })
  })
})
