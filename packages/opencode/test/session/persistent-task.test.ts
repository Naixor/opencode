import { describe, test, expect, beforeEach } from "bun:test"
import { PersistentTask } from "../../src/session/persistent-task"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

async function withInstance(fn: (tmpPath: string) => Promise<void>) {
  await using tmp = await tmpdir({ git: true, config: {} })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fn(tmp.path)
    },
  })
}

describe("PersistentTask", () => {
  describe("create", () => {
    test("creates a JSON file in .opencode/tasks/ with T-{uuid} format", async () => {
      await withInstance(async (tmpPath) => {
        const task = await PersistentTask.create({ subject: "Test task" })
        expect(task.id).toMatch(/^T-[0-9a-f-]+$/)
        const filePath = path.join(tmpPath, ".opencode", "tasks", `${task.id}.json`)
        const exists = await Bun.file(filePath).exists()
        expect(exists).toBe(true)
        const stored = await Bun.file(filePath).json()
        expect(stored.id).toBe(task.id)
        expect(stored.subject).toBe("Test task")
      })
    })

    test("all fields populated with defaults", async () => {
      await withInstance(async () => {
        const task = await PersistentTask.create({
          subject: "Full task",
          description: "A detailed description",
          owner: "agent-1",
          blockedBy: [],
          blocks: [],
          metadata: { priority: "high" },
          activeForm: "Working on full task",
        })
        expect(task.id).toMatch(/^T-/)
        expect(task.subject).toBe("Full task")
        expect(task.description).toBe("A detailed description")
        expect(task.status).toBe("pending")
        expect(task.blockedBy).toEqual([])
        expect(task.blocks).toEqual([])
        expect(task.owner).toBe("agent-1")
        expect(task.metadata).toEqual({ priority: "high" })
        expect(task.activeForm).toBe("Working on full task")
        expect(task.createdAt).toBeGreaterThan(0)
        expect(task.updatedAt).toBeGreaterThan(0)
      })
    })
  })

  describe("list", () => {
    test("returns all tasks", async () => {
      await withInstance(async () => {
        await PersistentTask.create({ subject: "Task A" })
        await PersistentTask.create({ subject: "Task B" })
        await PersistentTask.create({ subject: "Task C" })
        const tasks = await PersistentTask.list()
        expect(tasks.length).toBe(3)
        const subjects = tasks.map((t) => t.subject).sort()
        expect(subjects).toEqual(["Task A", "Task B", "Task C"])
      })
    })
  })

  describe("ready filter", () => {
    test("excludes tasks with incomplete blockedBy", async () => {
      await withInstance(async () => {
        const dep = await PersistentTask.create({ subject: "Dependency" })
        await PersistentTask.create({ subject: "Blocked task", blockedBy: [dep.id] })
        const ready = await PersistentTask.ready()
        const blockedReady = ready.find((t) => t.subject === "Blocked task")
        expect(blockedReady).toBeUndefined()
      })
    })

    test("includes tasks with completed blockedBy", async () => {
      await withInstance(async () => {
        const dep = await PersistentTask.create({ subject: "Dependency" })
        await PersistentTask.update(dep.id, { status: "in_progress" })
        await PersistentTask.update(dep.id, { status: "completed" })
        await PersistentTask.create({ subject: "Unblocked task", blockedBy: [dep.id] })
        const ready = await PersistentTask.ready()
        const unblocked = ready.find((t) => t.subject === "Unblocked task")
        expect(unblocked).toBeDefined()
      })
    })
  })

  describe("get", () => {
    test("returns full details", async () => {
      await withInstance(async () => {
        const created = await PersistentTask.create({
          subject: "Detailed task",
          description: "Get test",
          owner: "me",
          metadata: { key: "val" },
        })
        const task = await PersistentTask.get(created.id)
        expect(task.id).toBe(created.id)
        expect(task.subject).toBe("Detailed task")
        expect(task.description).toBe("Get test")
        expect(task.owner).toBe("me")
        expect(task.metadata).toEqual({ key: "val" })
      })
    })

    test("nonexistent ID throws clear error", async () => {
      await withInstance(async () => {
        const result = PersistentTask.get("T-nonexistent-id")
        await expect(result).rejects.toThrow("Task not found: T-nonexistent-id")
      })
    })
  })

  describe("status transitions", () => {
    test("pending -> in_progress -> completed", async () => {
      await withInstance(async () => {
        const task = await PersistentTask.create({ subject: "Status test" })
        expect(task.status).toBe("pending")

        const inProgress = await PersistentTask.update(task.id, { status: "in_progress" })
        expect(inProgress.status).toBe("in_progress")

        const completed = await PersistentTask.update(task.id, { status: "completed" })
        expect(completed.status).toBe("completed")
      })
    })

    test("invalid transition throws error", async () => {
      await withInstance(async () => {
        const task = await PersistentTask.create({ subject: "Invalid transition" })
        const result = PersistentTask.update(task.id, { status: "completed" })
        await expect(result).rejects.toThrow("Invalid status transition: pending -> completed")
      })
    })

    test("pending -> cancelled", async () => {
      await withInstance(async () => {
        const task = await PersistentTask.create({ subject: "Cancel test" })
        const cancelled = await PersistentTask.update(task.id, { status: "cancelled" })
        expect(cancelled.status).toBe("cancelled")
      })
    })

    test("in_progress -> failed", async () => {
      await withInstance(async () => {
        const task = await PersistentTask.create({ subject: "Fail test" })
        await PersistentTask.update(task.id, { status: "in_progress" })
        const failed = await PersistentTask.update(task.id, { status: "failed" })
        expect(failed.status).toBe("failed")
      })
    })
  })

  describe("delete", () => {
    test("removes file", async () => {
      await withInstance(async (tmpPath) => {
        const task = await PersistentTask.create({ subject: "Delete me" })
        const filePath = path.join(tmpPath, ".opencode", "tasks", `${task.id}.json`)
        expect(await Bun.file(filePath).exists()).toBe(true)

        await PersistentTask.remove(task.id)
        expect(await Bun.file(filePath).exists()).toBe(false)
      })
    })

    test("nonexistent task throws error", async () => {
      await withInstance(async () => {
        const result = PersistentTask.remove("T-nonexistent")
        await expect(result).rejects.toThrow("Task not found: T-nonexistent")
      })
    })
  })

  describe("blockedBy", () => {
    test("stored and enforced", async () => {
      await withInstance(async () => {
        const dep1 = await PersistentTask.create({ subject: "Dep 1" })
        const dep2 = await PersistentTask.create({ subject: "Dep 2" })
        const task = await PersistentTask.create({
          subject: "Blocked",
          blockedBy: [dep1.id, dep2.id],
        })
        const fetched = await PersistentTask.get(task.id)
        expect(fetched.blockedBy).toEqual([dep1.id, dep2.id])

        // Not ready since deps are pending
        const ready = await PersistentTask.ready()
        expect(ready.find((t) => t.id === task.id)).toBeUndefined()

        // Complete one dep — still not ready
        await PersistentTask.update(dep1.id, { status: "in_progress" })
        await PersistentTask.update(dep1.id, { status: "completed" })
        const ready2 = await PersistentTask.ready()
        expect(ready2.find((t) => t.id === task.id)).toBeUndefined()

        // Complete second dep — now ready
        await PersistentTask.update(dep2.id, { status: "in_progress" })
        await PersistentTask.update(dep2.id, { status: "completed" })
        const ready3 = await PersistentTask.ready()
        expect(ready3.find((t) => t.id === task.id)).toBeDefined()
      })
    })
  })

  describe("concurrent writes", () => {
    test("no corruption under concurrent writes", async () => {
      await withInstance(async () => {
        const task = await PersistentTask.create({ subject: "Concurrent" })
        await PersistentTask.update(task.id, { status: "in_progress" })

        // Run multiple updates concurrently
        const updates = Array.from({ length: 5 }, (_, i) =>
          PersistentTask.update(task.id, { metadata: { iteration: i } }),
        )
        const results = await Promise.all(updates)

        // All should succeed — last writer wins but all are valid
        const final = await PersistentTask.get(task.id)
        expect(final.status).toBe("in_progress")
        expect(final.metadata).toHaveProperty("iteration")
        expect(typeof (final.metadata as Record<string, unknown>).iteration).toBe("number")
      })
    })
  })

  describe("existing task tool (agent spawning) still works", () => {
    test("TaskTool is still registered and accessible", async () => {
      // The existing TaskTool in task.ts should remain unmodified
      const { TaskTool } = await import("../../src/tool/task")
      expect(TaskTool.id).toBe("task")
    })
  })

  describe("PersistentTaskTool", () => {
    test("tool is registered with correct id", async () => {
      const { PersistentTaskTool } = await import("../../src/tool/persistent-task-tool")
      expect(PersistentTaskTool.id).toBe("persistent_task")
    })

    test("tool create operation works", async () => {
      await withInstance(async () => {
        const { PersistentTaskTool } = await import("../../src/tool/persistent-task-tool")
        const tool = await PersistentTaskTool.init()
        const ctx = {
          sessionID: "test-session",
          messageID: "test-msg",
          callID: "test-call",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } as any
        const result = await tool.execute(
          { operation: "create", subject: "Tool test" },
          ctx,
        )
        expect(result.title).toContain("Created task")
        const parsed = JSON.parse(result.output)
        expect(parsed.subject).toBe("Tool test")
        expect(parsed.id).toMatch(/^T-/)
      })
    })

    test("tool list operation works", async () => {
      await withInstance(async () => {
        const { PersistentTaskTool } = await import("../../src/tool/persistent-task-tool")
        const tool = await PersistentTaskTool.init()
        const ctx = {
          sessionID: "test-session",
          messageID: "test-msg",
          callID: "test-call",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } as any

        await PersistentTask.create({ subject: "Listed task" })
        const result = await tool.execute({ operation: "list" }, ctx)
        expect(result.title).toContain("1 tasks")
        const parsed = JSON.parse(result.output)
        expect(parsed.length).toBe(1)
        expect(parsed[0].subject).toBe("Listed task")
      })
    })

    test("tool get operation works", async () => {
      await withInstance(async () => {
        const { PersistentTaskTool } = await import("../../src/tool/persistent-task-tool")
        const tool = await PersistentTaskTool.init()
        const ctx = {
          sessionID: "test-session",
          messageID: "test-msg",
          callID: "test-call",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } as any

        const task = await PersistentTask.create({ subject: "Get task" })
        const result = await tool.execute({ operation: "get", id: task.id }, ctx)
        expect(result.title).toContain(task.id)
        const parsed = JSON.parse(result.output)
        expect(parsed.subject).toBe("Get task")
      })
    })

    test("tool update operation works", async () => {
      await withInstance(async () => {
        const { PersistentTaskTool } = await import("../../src/tool/persistent-task-tool")
        const tool = await PersistentTaskTool.init()
        const ctx = {
          sessionID: "test-session",
          messageID: "test-msg",
          callID: "test-call",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } as any

        const task = await PersistentTask.create({ subject: "Update task" })
        const result = await tool.execute(
          { operation: "update", id: task.id, status: "in_progress" },
          ctx,
        )
        expect(result.title).toContain("Updated task")
        const parsed = JSON.parse(result.output)
        expect(parsed.status).toBe("in_progress")
      })
    })

    test("tool delete operation works", async () => {
      await withInstance(async () => {
        const { PersistentTaskTool } = await import("../../src/tool/persistent-task-tool")
        const tool = await PersistentTaskTool.init()
        const ctx = {
          sessionID: "test-session",
          messageID: "test-msg",
          callID: "test-call",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } as any

        const task = await PersistentTask.create({ subject: "Delete task" })
        const result = await tool.execute(
          { operation: "delete", id: task.id },
          ctx,
        )
        expect(result.title).toContain("Deleted task")
        expect(result.output).toContain("deleted successfully")
      })
    })

    test("tool list with ready filter", async () => {
      await withInstance(async () => {
        const { PersistentTaskTool } = await import("../../src/tool/persistent-task-tool")
        const tool = await PersistentTaskTool.init()
        const ctx = {
          sessionID: "test-session",
          messageID: "test-msg",
          callID: "test-call",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } as any

        const dep = await PersistentTask.create({ subject: "Dep" })
        await PersistentTask.update(dep.id, { status: "in_progress" })
        await PersistentTask.create({ subject: "Ready task" })
        await PersistentTask.create({ subject: "Blocked", blockedBy: [dep.id] })

        const result = await tool.execute(
          { operation: "list", filter: "ready" },
          ctx,
        )
        const parsed = JSON.parse(result.output)
        // "Ready task" is pending with no deps (ready), "Dep" is in_progress (not pending, excluded), "Blocked" is pending but dep not completed
        expect(parsed.length).toBe(1)
        expect(parsed[0].subject).toBe("Ready task")
      })
    })
  })
})
