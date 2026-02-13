import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./persistent-task.txt"
import { PersistentTask } from "../session/persistent-task"

const parameters = z.object({
  operation: z.enum(["create", "get", "list", "update", "delete"]).describe("The operation to perform"),
  id: z.string().describe("Task ID (required for get, update, delete)").optional(),
  subject: z.string().describe("Task subject/title (required for create)").optional(),
  description: z.string().describe("Task description").optional(),
  status: PersistentTask.Status.describe("New status for update").optional(),
  blockedBy: z.array(z.string()).describe("Task IDs this task depends on").optional(),
  blocks: z.array(z.string()).describe("Task IDs blocked by this task").optional(),
  owner: z.string().describe("Task owner/assignee").optional(),
  metadata: z.record(z.string(), z.unknown()).describe("Arbitrary metadata").optional(),
  activeForm: z.string().describe("Active form description").optional(),
  filter: z.enum(["all", "ready", "pending", "in_progress", "completed", "failed", "cancelled"]).describe("Filter for list operation").optional(),
})

export const PersistentTaskTool = Tool.define("persistent_task", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx): Promise<{ title: string; metadata: { [key: string]: unknown }; output: string }> {
    if (params.operation === "create") {
      if (!params.subject) throw new Error("subject is required for create operation")
      const task = await PersistentTask.create({
        subject: params.subject,
        description: params.description,
        owner: params.owner,
        blockedBy: params.blockedBy,
        blocks: params.blocks,
        metadata: params.metadata,
        activeForm: params.activeForm,
      })
      return {
        title: `Created task ${task.id}`,
        metadata: { operation: "create", taskId: task.id },
        output: JSON.stringify(task, null, 2),
      }
    }

    if (params.operation === "get") {
      if (!params.id) throw new Error("id is required for get operation")
      const task = await PersistentTask.get(params.id)
      return {
        title: `Task ${task.id}: ${task.subject}`,
        metadata: { operation: "get", taskId: task.id },
        output: JSON.stringify(task, null, 2),
      }
    }

    if (params.operation === "list") {
      const filter = params.filter ?? "all"
      if (filter === "ready") {
        const tasks = await PersistentTask.ready()
        return {
          title: `${tasks.length} ready tasks`,
          metadata: { operation: "list", filter: "ready", count: tasks.length },
          output: JSON.stringify(tasks, null, 2),
        }
      }
      const tasks = await PersistentTask.list()
      const filtered = filter === "all" ? tasks : tasks.filter((t) => t.status === filter)
      return {
        title: `${filtered.length} tasks`,
        metadata: { operation: "list", filter, count: filtered.length },
        output: JSON.stringify(filtered, null, 2),
      }
    }

    if (params.operation === "update") {
      if (!params.id) throw new Error("id is required for update operation")
      const changes: Record<string, unknown> = {}
      if (params.subject !== undefined) changes.subject = params.subject
      if (params.description !== undefined) changes.description = params.description
      if (params.status !== undefined) changes.status = params.status
      if (params.blockedBy !== undefined) changes.blockedBy = params.blockedBy
      if (params.blocks !== undefined) changes.blocks = params.blocks
      if (params.owner !== undefined) changes.owner = params.owner
      if (params.metadata !== undefined) changes.metadata = params.metadata
      if (params.activeForm !== undefined) changes.activeForm = params.activeForm
      const task = await PersistentTask.update(params.id, changes as any)
      return {
        title: `Updated task ${task.id}`,
        metadata: { operation: "update", taskId: task.id },
        output: JSON.stringify(task, null, 2),
      }
    }

    if (params.operation === "delete") {
      if (!params.id) throw new Error("id is required for delete operation")
      await PersistentTask.remove(params.id)
      return {
        title: `Deleted task ${params.id}`,
        metadata: { operation: "delete", taskId: params.id },
        output: `Task ${params.id} deleted successfully`,
      }
    }

    throw new Error(`Unknown operation: ${params.operation}`)
  },
})
