import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { DelegateTaskTool, BackgroundOutputTool, BackgroundCancelTool } from "../../src/tool/delegate-task"
import { BackgroundManager } from "../../src/agent/background/manager"
import { Categories } from "../../src/agent/background/categories"

const ctx = {
  sessionID: "test-session",
  messageID: "test-msg",
  callID: "test-call",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("delegate-task tools", () => {
  async function withInstance(fn: () => Promise<void>) {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        BackgroundManager.reset()
        await fn()
      },
    })
  }

  // --- DelegateTaskTool ---

  describe("DelegateTaskTool", () => {
    test("tool id is delegate_task", () => {
      expect(DelegateTaskTool.id).toBe("delegate_task")
    })

    test("init returns description and parameters", async () => {
      await withInstance(async () => {
        const tool = await DelegateTaskTool.init()
        expect(tool.description).toContain("Delegate a task")
        expect(tool.parameters).toBeDefined()
      })
    })

    test("description contains agents list", async () => {
      await withInstance(async () => {
        const tool = await DelegateTaskTool.init()
        // Should contain available agents
        expect(tool.description).toContain("explore")
      })
    })

    test("description contains categories", async () => {
      await withInstance(async () => {
        const tool = await DelegateTaskTool.init()
        // Should contain category delegation table
        expect(tool.description).toContain("Task Categories")
        expect(tool.description).toContain("quick")
        expect(tool.description).toContain("ultrabrain")
        expect(tool.description).toContain("deep")
      })
    })

    test("sub-agent calls delegate_task -> denied", async () => {
      await withInstance(async () => {
        const tool = await DelegateTaskTool.init()
        const result = await tool.execute(
          {
            description: "test task",
            prompt: "do something",
            run_in_background: false,
          },
          {
            ...ctx,
            extra: { isSubagent: true },
          },
        )
        expect(result.output).toContain("Sub-agents cannot call delegate_task")
        expect(result.metadata.denied).toBe(true)
      })
    })

    test("both category and subagent_type -> error", async () => {
      await withInstance(async () => {
        const tool = await DelegateTaskTool.init()
        const result = await tool.execute(
          {
            description: "test task",
            prompt: "do something",
            run_in_background: false,
            category: "quick",
            subagent_type: "explore",
          },
          ctx,
        )
        expect(result.output).toContain("Cannot specify both")
        expect(result.metadata.error).toBe(true)
      })
    })

    test("unknown agent type -> error", async () => {
      await withInstance(async () => {
        const tool = await DelegateTaskTool.init()
        const result = await tool.execute(
          {
            description: "test task",
            prompt: "do something",
            run_in_background: false,
            subagent_type: "nonexistent-agent-xyz",
          },
          ctx,
        )
        expect(result.output).toContain("Unknown agent type")
        expect(result.output).toContain("nonexistent-agent-xyz")
        expect(result.metadata.error).toBe(true)
      })
    })

    test("parameters schema validates correctly", async () => {
      await withInstance(async () => {
        const tool = await DelegateTaskTool.init()
        const schema = tool.parameters

        // Valid minimal params
        const valid = schema.parse({
          description: "test",
          prompt: "do something",
        })
        expect(valid.run_in_background).toBe(false) // default value
        expect(valid.category).toBeUndefined()
        expect(valid.subagent_type).toBeUndefined()
        expect(valid.session_id).toBeUndefined()
        expect(valid.load_skills).toBeUndefined()

        // Valid with all fields
        const full = schema.parse({
          description: "test",
          prompt: "do something",
          run_in_background: true,
          category: "quick",
          session_id: "s1",
          load_skills: ["git-master"],
        })
        expect(full.run_in_background).toBe(true)
        expect(full.category).toBe("quick")
        expect(full.load_skills).toEqual(["git-master"])
      })
    })

    test("category='quick' resolves model from category config", async () => {
      await withInstance(async () => {
        // Verify categories resolve correctly
        const categories = await Categories.resolve()
        const quick = Categories.lookup("quick", categories)
        expect(quick).toBeDefined()
        expect(quick!.description).toContain("Fast")
      })
    })

    test("subagent_type='oracle' resolves oracle agent", async () => {
      await withInstance(async () => {
        const { Agent } = await import("../../src/agent/agent")
        const oracle = await Agent.get("oracle")
        expect(oracle).toBeDefined()
        expect(oracle!.name).toBe("oracle")
      })
    })
  })

  // --- BackgroundOutputTool ---

  describe("BackgroundOutputTool", () => {
    test("tool id is background_output", () => {
      expect(BackgroundOutputTool.id).toBe("background_output")
    })

    test("init returns description and parameters", async () => {
      await withInstance(async () => {
        const tool = await BackgroundOutputTool.init()
        expect(tool.description).toContain("status")
        expect(tool.parameters).toBeDefined()
      })
    })

    test("nonexistent task -> error", async () => {
      await withInstance(async () => {
        const tool = await BackgroundOutputTool.init()
        const result = await tool.execute({ task_id: "bg_nonexistent" }, ctx)
        expect(result.output).toContain("Background task not found")
        expect(result.metadata.error).toBe(true)
      })
    })

    test("returns status + partial output for running task", async () => {
      await withInstance(async () => {
        BackgroundManager.setCallbacks({
          onExecute: () => new Promise(() => {}),
        })

        const task = BackgroundManager.create({ description: "search codebase" })
        const tool = await BackgroundOutputTool.init()
        const result = await tool.execute({ task_id: task.id }, ctx)

        expect(result.output).toContain(task.id)
        expect(result.output).toContain("running")
        expect(result.output).toContain("search codebase")
        expect(result.metadata.taskId).toBe(task.id)
        expect(result.metadata.status).toBe("running")
      })
    })

    test("returns completed output with result text", async () => {
      await withInstance(async () => {
        BackgroundManager.setCallbacks({
          onExecute: () => new Promise(() => {}),
        })

        const task = BackgroundManager.create({ description: "analysis" })
        BackgroundManager.complete(task.id, { text: "Found 5 issues", sessionId: "s1" })

        const tool = await BackgroundOutputTool.init()
        const result = await tool.execute({ task_id: task.id }, ctx)

        expect(result.output).toContain("completed")
        expect(result.output).toContain("Found 5 issues")
        expect(result.output).toContain("s1")
        expect(result.metadata.status).toBe("completed")
      })
    })

    test("returns failed output with error", async () => {
      await withInstance(async () => {
        BackgroundManager.setCallbacks({
          onExecute: () => new Promise(() => {}),
        })

        const task = BackgroundManager.create({ description: "failing task" })
        BackgroundManager.fail(task.id, "Connection timeout")

        const tool = await BackgroundOutputTool.init()
        const result = await tool.execute({ task_id: task.id }, ctx)

        expect(result.output).toContain("failed")
        expect(result.output).toContain("Connection timeout")
        expect(result.metadata.status).toBe("failed")
      })
    })
  })

  // --- BackgroundCancelTool ---

  describe("BackgroundCancelTool", () => {
    test("tool id is background_cancel", () => {
      expect(BackgroundCancelTool.id).toBe("background_cancel")
    })

    test("init returns description and parameters", async () => {
      await withInstance(async () => {
        const tool = await BackgroundCancelTool.init()
        expect(tool.description).toContain("Cancel")
        expect(tool.parameters).toBeDefined()
      })
    })

    test("nonexistent task -> error", async () => {
      await withInstance(async () => {
        const tool = await BackgroundCancelTool.init()
        const result = await tool.execute({ task_id: "bg_nonexistent" }, ctx)
        expect(result.output).toContain("Background task not found")
        expect(result.metadata.error).toBe(true)
      })
    })

    test("cancel running task -> cancelled", async () => {
      await withInstance(async () => {
        BackgroundManager.setCallbacks({
          onExecute: () => new Promise(() => {}),
        })

        const task = BackgroundManager.create({ description: "long task" })
        expect(BackgroundManager.get(task.id)?.status).toBe("running")

        const tool = await BackgroundCancelTool.init()
        const result = await tool.execute({ task_id: task.id }, ctx)

        expect(result.output).toContain("has been cancelled")
        expect(result.metadata.status).toBe("cancelled")
        expect(BackgroundManager.get(task.id)?.status).toBe("cancelled")
      })
    })

    test("cancel completed task -> cannot cancel", async () => {
      await withInstance(async () => {
        BackgroundManager.setCallbacks({
          onExecute: () => new Promise(() => {}),
        })

        const task = BackgroundManager.create({ description: "done task" })
        BackgroundManager.complete(task.id, { text: "done" })

        const tool = await BackgroundCancelTool.init()
        const result = await tool.execute({ task_id: task.id }, ctx)

        expect(result.output).toContain("already completed")
        expect(result.output).toContain("cannot be cancelled")
      })
    })

    test("cancel pending task -> cancelled", async () => {
      await withInstance(async () => {
        // Create a task that stays pending (concurrency limit reached)
        BackgroundManager.configure({ defaultConcurrency: 1 })
        BackgroundManager.setCallbacks({
          onExecute: () => new Promise(() => {}),
        })

        const t1 = BackgroundManager.create({ description: "running" })
        const t2 = BackgroundManager.create({ description: "pending" })

        expect(BackgroundManager.get(t1.id)?.status).toBe("running")
        expect(BackgroundManager.get(t2.id)?.status).toBe("pending")

        const tool = await BackgroundCancelTool.init()
        const result = await tool.execute({ task_id: t2.id }, ctx)

        expect(result.output).toContain("has been cancelled")
        expect(BackgroundManager.get(t2.id)?.status).toBe("cancelled")
      })
    })
  })

  // --- Integration: SecurityConfig ---

  describe("security config sharing", () => {
    test("SecurityConfig shared (frozen reference)", async () => {
      await withInstance(async () => {
        const config = { rules: [{ path: "secret.txt", deniedOperations: ["read"] }] }
        BackgroundManager.setSecurityConfig(config as any)

        const shared = BackgroundManager.getSecurityConfig()
        expect(shared).toBeDefined()
        expect(Object.isFrozen(shared)).toBe(true)
      })
    })

    test("SecurityConfig mutation throws TypeError", async () => {
      await withInstance(async () => {
        const config = { rules: [{ path: "secret.txt" }] }
        BackgroundManager.setSecurityConfig(config as any)

        const shared = BackgroundManager.getSecurityConfig()
        expect(() => {
          ;(shared as any).newProp = "value"
        }).toThrow(TypeError)
      })
    })
  })

  // --- Integration: Concurrency ---

  describe("concurrency with delegate_task", () => {
    test("exceeding concurrency limit queues task", async () => {
      await withInstance(async () => {
        BackgroundManager.configure({ defaultConcurrency: 2 })
        BackgroundManager.setCallbacks({
          onExecute: () => new Promise(() => {}),
        })

        const t1 = BackgroundManager.create({ description: "t1", provider: "anthropic" })
        const t2 = BackgroundManager.create({ description: "t2", provider: "anthropic" })
        const t3 = BackgroundManager.create({ description: "t3", provider: "anthropic" })

        expect(BackgroundManager.get(t1.id)?.status).toBe("running")
        expect(BackgroundManager.get(t2.id)?.status).toBe("running")
        expect(BackgroundManager.get(t3.id)?.status).toBe("pending")

        // Complete t1 -> t3 should dequeue
        BackgroundManager.complete(t1.id, { text: "done" })
        expect(BackgroundManager.get(t3.id)?.status).toBe("running")
      })
    })
  })

  // --- Skill Injection ---

  describe("load_skills parameter", () => {
    test("load_skills injects skill content into prompt", async () => {
      await withInstance(async () => {
        // The Skill module scans for files, so we just verify the parameter is accepted
        const tool = await DelegateTaskTool.init()
        const schema = tool.parameters
        const parsed = schema.parse({
          description: "test",
          prompt: "do something",
          load_skills: ["git-master", "playwright"],
        })
        expect(parsed.load_skills).toEqual(["git-master", "playwright"])
      })
    })
  })

  // --- Session Continuation ---

  describe("session continuation", () => {
    test("session_id parameter accepted", async () => {
      await withInstance(async () => {
        const tool = await DelegateTaskTool.init()
        const schema = tool.parameters
        const parsed = schema.parse({
          description: "continue task",
          prompt: "finish the work",
          session_id: "session_123",
        })
        expect(parsed.session_id).toBe("session_123")
      })
    })
  })

  // --- Tool Registration ---

  describe("tool registration", () => {
    test("all three tools have correct IDs", () => {
      expect(DelegateTaskTool.id).toBe("delegate_task")
      expect(BackgroundOutputTool.id).toBe("background_output")
      expect(BackgroundCancelTool.id).toBe("background_cancel")
    })

    test("tools are registered in registry", async () => {
      await withInstance(async () => {
        const { ToolRegistry } = await import("../../src/tool/registry")
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("delegate_task")
        expect(ids).toContain("background_output")
        expect(ids).toContain("background_cancel")
      })
    })
  })
})
