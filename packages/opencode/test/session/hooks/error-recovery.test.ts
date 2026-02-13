import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { HookChain } from "../../../src/session/hooks"
import { ErrorRecoveryHooks } from "../../../src/session/hooks/error-recovery"

describe("ErrorRecoveryHooks", () => {
  async function withInstance(fn: () => Promise<void>, config?: Record<string, unknown>) {
    await using tmp = await tmpdir({
      git: true,
      config: config ?? {},
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        HookChain.reset()
        ErrorRecoveryHooks.resetErrorHistory()
        ErrorRecoveryHooks.register()
        await fn()
      },
    })
  }

  // --- Edit error recovery ---

  describe("edit-error-recovery", () => {
    test("oldString not found -> recovery message injected", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "edit",
          args: { file_path: "/src/main.ts", old_string: "foo", new_string: "bar" },
          result: {
            output: "Error: oldString not found in content",
            title: "Edit",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).toContain("RECOVERY:")
        expect(ctx.result.output).toContain("Re-read the file")
      })
    })

    test("found multiple times -> recovery message injected", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "edit",
          args: { file_path: "/src/main.ts", old_string: "foo", new_string: "bar" },
          result: {
            output: "Error: Found multiple matches for oldString. Provide more surrounding lines.",
            title: "Edit",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).toContain("RECOVERY:")
        expect(ctx.result.output).toContain("more surrounding context")
      })
    })

    test("oldString and newString must be different -> recovery message injected", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "edit",
          args: { file_path: "/src/main.ts", old_string: "foo", new_string: "foo" },
          result: {
            output: "Error: oldString and newString must be different",
            title: "Edit",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).toContain("RECOVERY:")
        expect(ctx.result.output).toContain("actual changes")
      })
    })

    test("edit success -> no injection", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "edit",
          args: { file_path: "/src/main.ts", old_string: "foo", new_string: "bar" },
          result: {
            output: "Successfully edited /src/main.ts",
            title: "Edit",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).not.toContain("RECOVERY:")
        expect(ctx.result.output).toBe("Successfully edited /src/main.ts")
      })
    })

    test("non-edit tool -> no injection even with matching text", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "read",
          args: { file_path: "/src/main.ts" },
          result: {
            output: "oldString not found",
            title: "Read",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).not.toContain("RECOVERY:")
      })
    })
  })

  // --- Context window limit recovery ---

  describe("context-window-limit-recovery", () => {
    test("context_window_exceeded -> compaction triggered", async () => {
      await withInstance(async () => {
        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s1",
          event: "session.error",
          data: {
            error: {
              name: "APIError",
              data: { message: "context_window_exceeded: prompt is too long" },
            },
          },
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        expect(ctx.data.recovery).toBe("compact")
        expect(ctx.data.message).toContain("compaction")
      })
    })

    test("non-context error -> no compaction", async () => {
      await withInstance(async () => {
        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s1",
          event: "session.error",
          data: {
            error: {
              name: "APIError",
              data: { message: "rate_limit_exceeded" },
            },
          },
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        expect(ctx.data.recovery).toBeUndefined()
      })
    })

    test("non-error event -> no action", async () => {
      await withInstance(async () => {
        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s1",
          event: "session.created",
          data: { title: "Test Session" },
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        expect(ctx.data.recovery).toBeUndefined()
      })
    })
  })

  // --- Delegate task retry ---

  describe("delegate-task-retry", () => {
    test("delegate_task failure -> retry with backoff", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "delegate_task",
          args: { prompt: "do something" },
          result: {
            output: "Error: task failed to complete",
            title: "Delegate Task",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).toContain("RECOVERY:")
        expect(ctx.result.output).toContain("1000ms")
        expect(ctx.result.output).toContain("retry attempt 1 of 2")
        expect((ctx.result.metadata as Record<string, unknown>).retryCount).toBe(1)
      })
    })

    test("delegate_task success -> no retry", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "delegate_task",
          args: { prompt: "do something" },
          result: {
            output: "Task completed successfully. Result: the answer is 42.",
            title: "Delegate Task",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).not.toContain("RECOVERY:")
      })
    })

    test("delegate_task second failure -> exhaustion message", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "delegate_task",
          args: { prompt: "do something" },
          result: {
            output: "Error: task failed again",
            title: "Delegate Task",
            metadata: { retryCount: 1 },
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).toContain("RECOVERY:")
        expect(ctx.result.output).toContain("failed after retry")
        expect(ctx.result.output).toContain("alternative approach")
      })
    })

    test("task tool failure -> also handled", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "task",
          args: { prompt: "do something" },
          result: {
            output: "Error: timed out waiting for response",
            title: "Task",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).toContain("RECOVERY:")
      })
    })
  })

  // --- Iterative error recovery ---

  describe("iterative-error-recovery", () => {
    test("same error 3 times -> guidance injected", async () => {
      await withInstance(async () => {
        const makeCtx = (): HookChain.PostToolContext => ({
          sessionID: "s1",
          toolName: "edit",
          args: { file_path: "/src/main.ts" },
          result: {
            output: "Error: oldString not found in content",
            title: "Edit",
          },
          agent: "build",
        })

        // First occurrence - edit-error-recovery fires but not iterative
        const ctx1 = makeCtx()
        await HookChain.execute("post-tool", ctx1)
        expect(ctx1.result.output).toContain("RECOVERY: The oldString")
        expect(ctx1.result.output).not.toContain("same error has occurred")

        // Second occurrence - still no iterative recovery
        const ctx2 = makeCtx()
        await HookChain.execute("post-tool", ctx2)
        expect(ctx2.result.output).not.toContain("same error has occurred")

        // Third occurrence - iterative recovery kicks in
        const ctx3 = makeCtx()
        await HookChain.execute("post-tool", ctx3)
        expect(ctx3.result.output).toContain("same error has occurred 3 times")
        expect(ctx3.result.output).toContain("in a loop")
      })
    })

    test("same error 2 times -> no guidance", async () => {
      await withInstance(async () => {
        const makeCtx = (): HookChain.PostToolContext => ({
          sessionID: "s1",
          toolName: "grep",
          args: { pattern: "foo" },
          result: {
            output: "Error: pattern not found in any files",
            title: "Grep",
          },
          agent: "build",
        })

        const ctx1 = makeCtx()
        await HookChain.execute("post-tool", ctx1)

        const ctx2 = makeCtx()
        await HookChain.execute("post-tool", ctx2)

        expect(ctx2.result.output).not.toContain("same error has occurred")
      })
    })

    test("different errors -> no guidance", async () => {
      await withInstance(async () => {
        const ctx1: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "edit",
          args: {},
          result: { output: "Error: file alpha not found", title: "Edit" },
          agent: "build",
        }
        const ctx2: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "edit",
          args: {},
          result: { output: "Error: file beta not found", title: "Edit" },
          agent: "build",
        }
        const ctx3: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "edit",
          args: {},
          result: { output: "Error: file gamma not found", title: "Edit" },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx1)
        await HookChain.execute("post-tool", ctx2)
        await HookChain.execute("post-tool", ctx3)

        expect(ctx3.result.output).not.toContain("same error has occurred")
      })
    })

    test("successful tool output -> no tracking", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "read",
          args: {},
          result: { output: "File contents: hello world", title: "Read" },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)
        await HookChain.execute("post-tool", ctx)
        await HookChain.execute("post-tool", ctx)

        expect(ctx.result.output).not.toContain("RECOVERY:")
        expect(ctx.result.output).toBe("File contents: hello world")
      })
    })
  })

  // --- Config-driven disable ---

  describe("config-driven disable", () => {
    test("disabled hook -> no injection on edit failure", async () => {
      await withInstance(async () => {
        HookChain.reloadConfig({ "edit-error-recovery": { enabled: false } })

        const ctx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "edit",
          args: { file_path: "/src/main.ts" },
          result: {
            output: "Error: oldString not found in content",
            title: "Edit",
          },
          agent: "build",
        }

        await HookChain.execute("post-tool", ctx)

        // edit-error-recovery is disabled but iterative-error-recovery should still fire (after 3)
        // With just 1 occurrence, no iterative recovery either
        expect(ctx.result.output).toBe("Error: oldString not found in content")
      })
    })

    test("disabled context-window-limit-recovery -> no compaction on error", async () => {
      await withInstance(async () => {
        HookChain.reloadConfig({ "context-window-limit-recovery": { enabled: false } })

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s1",
          event: "session.error",
          data: {
            error: {
              name: "APIError",
              data: { message: "context_window_exceeded" },
            },
          },
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        expect(ctx.data.recovery).toBeUndefined()
      })
    })
  })
})
