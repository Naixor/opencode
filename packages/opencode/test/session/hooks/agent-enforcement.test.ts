import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { HookChain } from "../../../src/session/hooks"
import { AgentEnforcementHooks } from "../../../src/session/hooks/agent-enforcement"
import { Todo } from "../../../src/session/todo"

describe("AgentEnforcementHooks", () => {
  async function withInstance(fn: () => Promise<void>, config?: Record<string, unknown>) {
    await using tmp = await tmpdir({
      git: true,
      config: config ?? {},
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        HookChain.reset()
        AgentEnforcementHooks.resetStopSignals()
        AgentEnforcementHooks.register()
        await fn()
      },
    })
  }

  // --- todo-continuation-enforcer ---

  describe("todo-continuation-enforcer", () => {
    test("agent stops with 3 incomplete todos -> continuation prompt", async () => {
      await withInstance(async () => {
        const sessionID = "s-todo-1"

        await Todo.update({
          sessionID,
          todos: [
            { id: "t1", content: "Fix auth bug", status: "in_progress", priority: "high" },
            { id: "t2", content: "Write tests", status: "pending", priority: "medium" },
            { id: "t3", content: "Update docs", status: "pending", priority: "low" },
            { id: "t4", content: "Deploy", status: "completed", priority: "high" },
          ],
        })

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID,
          event: "agent.stopped",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { continuation?: boolean; message?: string }
        expect(data.continuation).toBe(true)
        expect(data.message).toContain("3 incomplete tasks remaining")
        expect(data.message).toContain("Fix auth bug")
        expect(data.message).toContain("Write tests")
        expect(data.message).toContain("Update docs")
      })
    })

    test("agent stops with all todos complete -> no prompt", async () => {
      await withInstance(async () => {
        const sessionID = "s-todo-2"

        await Todo.update({
          sessionID,
          todos: [
            { id: "t1", content: "Fix auth bug", status: "completed", priority: "high" },
            { id: "t2", content: "Write tests", status: "completed", priority: "medium" },
            { id: "t3", content: "Deploy", status: "cancelled", priority: "low" },
          ],
        })

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID,
          event: "agent.stopped",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { continuation?: boolean }
        expect(data.continuation).toBeUndefined()
      })
    })

    test("agent stops with no todos -> no prompt", async () => {
      await withInstance(async () => {
        const sessionID = "s-todo-3"

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID,
          event: "agent.stopped",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { continuation?: boolean }
        expect(data.continuation).toBeUndefined()
      })
    })

    test("non-stopped event -> no continuation check", async () => {
      await withInstance(async () => {
        const sessionID = "s-todo-4"

        await Todo.update({
          sessionID,
          todos: [
            { id: "t1", content: "Fix bug", status: "pending", priority: "high" },
          ],
        })

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID,
          event: "session.updated",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { continuation?: boolean }
        expect(data.continuation).toBeUndefined()
      })
    })

    test("single incomplete todo -> correct singular message", async () => {
      await withInstance(async () => {
        const sessionID = "s-todo-5"

        await Todo.update({
          sessionID,
          todos: [
            { id: "t1", content: "Fix auth bug", status: "in_progress", priority: "high" },
          ],
        })

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID,
          event: "agent.stopped",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { continuation?: boolean; message?: string }
        expect(data.continuation).toBe(true)
        expect(data.message).toContain("1 incomplete task remaining")
        // Should use singular "task" not "tasks"
        expect(data.message).not.toContain("tasks")
      })
    })
  })

  // --- stop-continuation-guard ---

  describe("stop-continuation-guard", () => {
    test("user sends stop -> continuation blocked", async () => {
      await withInstance(async () => {
        const sessionID = "s-stop-1"

        await Todo.update({
          sessionID,
          todos: [
            { id: "t1", content: "Fix bug", status: "pending", priority: "high" },
            { id: "t2", content: "Write tests", status: "pending", priority: "medium" },
          ],
        })

        // First, fire agent.stopped with userStop=true (stop-continuation-guard runs at priority 190)
        const ctx: HookChain.SessionLifecycleContext = {
          sessionID,
          event: "agent.stopped",
          data: { userStop: true },
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        // stop-continuation-guard (priority 190) runs before todo-continuation-enforcer (priority 200)
        // so the enforcer should see the stop signal and skip
        const data = ctx.data as { continuation?: boolean }
        expect(data.continuation).toBeUndefined()
      })
    })

    test("no user stop -> continuation allowed", async () => {
      await withInstance(async () => {
        const sessionID = "s-stop-2"

        await Todo.update({
          sessionID,
          todos: [
            { id: "t1", content: "Fix bug", status: "pending", priority: "high" },
          ],
        })

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID,
          event: "agent.stopped",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { continuation?: boolean; message?: string }
        expect(data.continuation).toBe(true)
        expect(data.message).toContain("1 incomplete task remaining")
      })
    })
  })

  // --- subagent-question-blocker ---

  describe("subagent-question-blocker", () => {
    test("subagent calls question tool -> blocked with message", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreToolContext = {
          sessionID: "s-sub-1",
          toolName: "question",
          args: {
            questions: [{ question: "What approach?", options: ["A", "B"] }],
            _isSubagent: true,
          },
          agent: "explore",
        }

        await HookChain.execute("pre-tool", ctx)

        expect(ctx.args._blocked).toBe(true)
        expect(ctx.args._blockedMessage).toContain("Proceed autonomously")
        expect(ctx.args._blockedMessage).toContain("sub-agent")
      })
    })

    test("primary agent calls question tool -> allowed", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreToolContext = {
          sessionID: "s-sub-2",
          toolName: "question",
          args: {
            questions: [{ question: "What approach?", options: ["A", "B"] }],
          },
          agent: "build",
        }

        await HookChain.execute("pre-tool", ctx)

        expect(ctx.args._blocked).toBeUndefined()
        expect(ctx.args._blockedMessage).toBeUndefined()
      })
    })

    test("subagent calls non-question tool -> not blocked", async () => {
      await withInstance(async () => {
        const ctx: HookChain.PreToolContext = {
          sessionID: "s-sub-3",
          toolName: "read",
          args: {
            file_path: "/src/main.ts",
            _isSubagent: true,
          },
          agent: "explore",
        }

        await HookChain.execute("pre-tool", ctx)

        expect(ctx.args._blocked).toBeUndefined()
      })
    })
  })

  // --- Config-driven disable ---

  describe("config-driven disable", () => {
    test("disabled todo-continuation-enforcer -> no prompt on incomplete todos", async () => {
      await withInstance(async () => {
        HookChain.reloadConfig({ "todo-continuation-enforcer": { enabled: false } })

        const sessionID = "s-cfg-1"

        await Todo.update({
          sessionID,
          todos: [
            { id: "t1", content: "Fix bug", status: "pending", priority: "high" },
          ],
        })

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID,
          event: "agent.stopped",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { continuation?: boolean }
        expect(data.continuation).toBeUndefined()
      })
    })

    test("disabled subagent-question-blocker -> subagent question allowed", async () => {
      await withInstance(async () => {
        HookChain.reloadConfig({ "subagent-question-blocker": { enabled: false } })

        const ctx: HookChain.PreToolContext = {
          sessionID: "s-cfg-2",
          toolName: "question",
          args: {
            questions: [{ question: "What?", options: ["A"] }],
            _isSubagent: true,
          },
          agent: "explore",
        }

        await HookChain.execute("pre-tool", ctx)

        expect(ctx.args._blocked).toBeUndefined()
      })
    })

    test("disabled stop-continuation-guard -> stop signal ignored, continuation fires", async () => {
      await withInstance(async () => {
        HookChain.reloadConfig({ "stop-continuation-guard": { enabled: false } })

        const sessionID = "s-cfg-3"

        await Todo.update({
          sessionID,
          todos: [
            { id: "t1", content: "Fix bug", status: "pending", priority: "high" },
          ],
        })

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID,
          event: "agent.stopped",
          data: { userStop: true },
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        // Without the guard, the stop signal isn't recorded, so continuation fires
        const data = ctx.data as { continuation?: boolean; message?: string }
        expect(data.continuation).toBe(true)
        expect(data.message).toContain("1 incomplete task remaining")
      })
    })
  })
})
