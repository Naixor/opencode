import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { HookChain } from "../../../src/session/hooks"
import { DetectionCheckingHooks } from "../../../src/session/hooks/detection-checking"
import * as path from "path"
import * as fs from "fs"

describe("DetectionCheckingHooks", () => {
  async function withInstance(fn: (tmpPath: string) => Promise<void>, config?: Record<string, unknown>) {
    await using tmp = await tmpdir({
      git: true,
      config: config ?? {},
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        HookChain.reset()
        DetectionCheckingHooks.resetCommentThreshold()
        DetectionCheckingHooks.register()
        await fn(tmp.path)
      },
    })
  }

  // --- keyword-detector ---

  describe("keyword-detector", () => {
    test("message with '[ultrawork]' -> variant set to 'max'", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-opus-4-20250514",
          messages: [{ role: "user", content: "Please work in [ultrawork] mode" }],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.variant).toBe("max")
      })
    })

    test("message with 'ulw' -> variant set to 'max'", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-opus-4-20250514",
          messages: [{ role: "user", content: "ulw fix the bug in auth.ts" }],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.variant).toBe("max")
      })
    })

    test("message with '[analyze-mode]' -> variant set to 'analyze'", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-opus-4-20250514",
          messages: [{ role: "user", content: "[analyze-mode] review this code" }],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.variant).toBe("analyze")
      })
    })

    test("normal message -> no variant change", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-opus-4-20250514",
          messages: [{ role: "user", content: "fix the bug in auth.ts" }],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.variant).toBeUndefined()
      })
    })

    test("keyword in older message, not latest -> no variant change", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-opus-4-20250514",
          messages: [
            { role: "user", content: "[ultrawork] do something" },
            { role: "assistant", content: "Done" },
            { role: "user", content: "now fix the other thing" },
          ],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.variant).toBeUndefined()
      })
    })

    test("multipart content with keyword -> variant set", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-opus-4-20250514",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "[review-mode] check this code" },
              ],
            },
          ],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.variant).toBe("review")
      })
    })
  })

  // --- comment-checker ---

  describe("comment-checker", () => {
    test("edit result with 50% comments -> warning injected", async () => {
      await withInstance(async () => {
        const codeWith50PctComments = [
          "// This is a comment",
          "// Another comment",
          "// Third comment",
          "// Fourth comment",
          "// Fifth comment",
          "const a = 1",
          "const b = 2",
          "const c = 3",
          "const d = 4",
          "const e = 5",
        ].join("\n")

        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "edit",
          args: { file_path: "/src/main.ts", old_string: "old", new_string: codeWith50PctComments },
          result: {
            output: "Successfully edited /src/main.ts",
            title: "Edit",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).toContain("WARNING:")
        expect(ctx.result.output).toContain("50%")
        expect(ctx.result.output).toContain("comment lines")
      })
    })

    test("edit result with 10% comments -> no warning", async () => {
      await withInstance(async () => {
        const codeWith10PctComments = [
          "// A comment",
          "const a = 1",
          "const b = 2",
          "const c = 3",
          "const d = 4",
          "const e = 5",
          "const f = 6",
          "const g = 7",
          "const h = 8",
          "const i = 9",
        ].join("\n")

        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "edit",
          args: { file_path: "/src/main.ts", old_string: "old", new_string: codeWith10PctComments },
          result: {
            output: "Successfully edited /src/main.ts",
            title: "Edit",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).not.toContain("WARNING:")
        expect(ctx.result.output).toBe("Successfully edited /src/main.ts")
      })
    })

    test("configurable threshold at 30% -> triggers at 30%", async () => {
      await withInstance(async () => {
        DetectionCheckingHooks.configureCommentThreshold(0.3)

        const codeWith35PctComments = [
          "// Comment 1",
          "// Comment 2",
          "// Comment 3",
          "// Comment 4",
          "const a = 1",
          "const b = 2",
          "const c = 3",
          "const d = 4",
          "const e = 5",
          "const f = 6",
          "function foo() {}",
        ].join("\n")

        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "edit",
          args: { file_path: "/src/main.ts", old_string: "old", new_string: codeWith35PctComments },
          result: {
            output: "Successfully edited /src/main.ts",
            title: "Edit",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).toContain("WARNING:")
        expect(ctx.result.output).toContain("30%")
      })
    })

    test("write tool with comments -> also checked", async () => {
      await withInstance(async () => {
        const highCommentCode = [
          "// Comment 1",
          "// Comment 2",
          "// Comment 3",
          "// Comment 4",
          "// Comment 5",
          "const a = 1",
          "const b = 2",
        ].join("\n")

        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "write",
          args: { file_path: "/src/new.ts", content: highCommentCode },
          result: {
            output: "Successfully wrote /src/new.ts",
            title: "Write",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).toContain("WARNING:")
        expect(ctx.result.output).toContain("comment lines")
      })
    })

    test("edit error -> no comment check", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "edit",
          args: { file_path: "/src/main.ts", old_string: "old", new_string: "// all comments\n// more comments" },
          result: {
            output: "Error: oldString not found in content",
            title: "Edit",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        // Should not have comment warning (only error recovery may fire)
        expect(ctx.result.output).not.toContain("comment lines")
      })
    })

    test("non-edit/write tool -> no comment check", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "read",
          args: {},
          result: {
            output: "// all comments\n// more comments\n// third",
            title: "Read",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).not.toContain("WARNING:")
      })
    })
  })

  // --- empty-task-response-detector ---

  describe("empty-task-response-detector", () => {
    test("delegate_task returns '' -> warning injected", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "delegate_task",
          args: { prompt: "do something" },
          result: {
            output: "",
            title: "Delegate Task",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).toContain("WARNING:")
        expect(ctx.result.output).toContain("empty or minimal result")
      })
    })

    test("delegate_task returns short content -> warning injected", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "delegate_task",
          args: { prompt: "do something" },
          result: {
            output: "ok",
            title: "Delegate Task",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).toContain("WARNING:")
        expect(ctx.result.output).toContain("empty or minimal result")
      })
    })

    test("delegate_task returns meaningful content -> no warning", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "delegate_task",
          args: { prompt: "do something" },
          result: {
            output: "Task completed successfully. The function was refactored to use the new API pattern.",
            title: "Delegate Task",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).not.toContain("WARNING:")
        expect(ctx.result.output).not.toContain("empty or minimal result")
      })
    })

    test("task tool returns empty -> also detected", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "task",
          args: { prompt: "do something" },
          result: {
            output: "   ",
            title: "Task",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).toContain("WARNING:")
        expect(ctx.result.output).toContain("empty or minimal result")
      })
    })

    test("non-task tool returns empty -> no detection", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "read",
          args: {},
          result: {
            output: "",
            title: "Read",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).not.toContain("WARNING:")
      })
    })
  })

  // --- write-existing-file-guard ---

  describe("write-existing-file-guard", () => {
    test("write to existing file -> warning injected", async () => {
      await withInstance(async (tmpPath) => {
        const filePath = path.join(tmpPath, "existing.ts")
        fs.writeFileSync(filePath, "const x = 1")

        const ctx: HookChain.PreToolContext = {
          sessionID: "s1",
          toolName: "write",
          args: { file_path: filePath, content: "const x = 2" },
          agent: "build",
        }

        await HookChain.execute("pre-tool", ctx)

        expect(ctx.args._warning).toContain("WARNING:")
        expect(ctx.args._warning).toContain("File already exists")
        expect(ctx.args._warning).toContain("edit tool")
      })
    })

    test("write to new file -> no warning", async () => {
      await withInstance(async (tmpPath) => {
        const filePath = path.join(tmpPath, "nonexistent-file-12345.ts")

        const ctx: HookChain.PreToolContext = {
          sessionID: "s1",
          toolName: "write",
          args: { file_path: filePath, content: "const x = 1" },
          agent: "build",
        }

        await HookChain.execute("pre-tool", ctx)

        expect(ctx.args._warning).toBeUndefined()
      })
    })

    test("non-write tool -> no warning", async () => {
      await withInstance(async (tmpPath) => {
        const filePath = path.join(tmpPath, "existing.ts")
        fs.writeFileSync(filePath, "const x = 1")

        const ctx: HookChain.PreToolContext = {
          sessionID: "s1",
          toolName: "edit",
          args: { file_path: filePath },
          agent: "build",
        }

        await HookChain.execute("pre-tool", ctx)

        expect(ctx.args._warning).toBeUndefined()
      })
    })
  })

  // --- Config-driven disable ---

  describe("config-driven disable", () => {
    test("disabled keyword-detector -> no variant set", async () => {
      await withInstance(async () => {
        HookChain.reloadConfig({ "keyword-detector": { enabled: false } })

        const ctx: HookChain.PreLLMContext = {
          sessionID: "s1",
          system: ["You are an assistant."],
          agent: "build",
          model: "claude-opus-4-20250514",
          messages: [{ role: "user", content: "[ultrawork] do the thing" }],
        }

        await HookChain.execute("pre-llm", ctx)

        expect(ctx.variant).toBeUndefined()
      })
    })

    test("disabled comment-checker -> no warning on high comments", async () => {
      await withInstance(async () => {
        HookChain.reloadConfig({ "comment-checker": { enabled: false } })

        const highCommentCode = [
          "// Comment 1",
          "// Comment 2",
          "// Comment 3",
          "// Comment 4",
          "// Comment 5",
          "const a = 1",
          "const b = 2",
        ].join("\n")

        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "edit",
          args: { file_path: "/src/main.ts", old_string: "old", new_string: highCommentCode },
          result: {
            output: "Successfully edited /src/main.ts",
            title: "Edit",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).not.toContain("comment lines")
        expect(ctx.result.output).toBe("Successfully edited /src/main.ts")
      })
    })

    test("disabled write-existing-file-guard -> no warning on existing file", async () => {
      await withInstance(async (tmpPath) => {
        HookChain.reloadConfig({ "write-existing-file-guard": { enabled: false } })

        const filePath = path.join(tmpPath, "existing.ts")
        fs.writeFileSync(filePath, "const x = 1")

        const ctx: HookChain.PreToolContext = {
          sessionID: "s1",
          toolName: "write",
          args: { file_path: filePath, content: "const x = 2" },
          agent: "build",
        }

        await HookChain.execute("pre-tool", ctx)

        expect(ctx.args._warning).toBeUndefined()
      })
    })
  })
})
