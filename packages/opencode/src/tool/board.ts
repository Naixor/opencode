import { Tool } from "./tool"
import z from "zod"
import { SharedBoard, BoardTask, BoardArtifact, BoardSignal } from "../board"
import { Discussion } from "../board/discussion"

type BoardMeta = Record<string, unknown>

// --- board_read ---
export const BoardReadTool = Tool.define("board_read", {
  description:
    "Read data from the SharedBoard. Query tasks, artifacts, signals, or get a full snapshot of the Swarm board state.",
  parameters: z.object({
    operation: z
      .enum(["tasks", "artifacts", "signals", "snapshot", "discussion"])
      .describe("What to read from the board"),
    swarm_id: z.string().describe("The Swarm ID"),
    filter: z
      .object({
        task_id: z.string().optional(),
        type: z.string().optional(),
        author: z.string().optional(),
        channel: z.string().optional(),
        limit: z.number().optional(),
      })
      .optional()
      .describe("Optional filter criteria"),
  }),
  async execute(params): Promise<{ title: string; metadata: BoardMeta; output: string }> {
    if (params.operation === "tasks") {
      const tasks = await BoardTask.list(params.swarm_id)
      return {
        title: `${tasks.length} tasks`,
        metadata: { count: tasks.length },
        output: JSON.stringify(tasks, null, 2),
      }
    }
    if (params.operation === "artifacts") {
      const artifacts = await BoardArtifact.list({
        swarm_id: params.swarm_id,
        task_id: params.filter?.task_id,
        type: params.filter?.type as BoardArtifact.Type | undefined,
        author: params.filter?.author,
      })
      return {
        title: `${artifacts.length} artifacts`,
        metadata: { count: artifacts.length },
        output: JSON.stringify(artifacts, null, 2),
      }
    }
    if (params.operation === "signals") {
      const signals = await BoardSignal.recent(params.swarm_id, params.filter?.channel, params.filter?.limit ?? 50)
      return {
        title: `${signals.length} signals`,
        metadata: { count: signals.length },
        output: JSON.stringify(signals, null, 2),
      }
    }
    if (params.operation === "discussion") {
      const channel = params.filter?.channel
      if (!channel) return { title: "Error", metadata: {}, output: "Missing filter.channel for discussion operation" }
      const [round, thread] = await Promise.all([
        Discussion.status(params.swarm_id, channel),
        BoardSignal.thread(params.swarm_id, channel),
      ])
      return {
        title: `Discussion ${channel}`,
        metadata: { round: round?.round, signals: thread.length },
        output: JSON.stringify({ round, thread }, null, 2),
      }
    }
    const snap = await SharedBoard.snapshot(params.swarm_id)
    return { title: "Board snapshot", metadata: { stats: snap.stats }, output: JSON.stringify(snap, null, 2) }
  },
})

// --- board_write ---
export const BoardWriteTool = Tool.define("board_write", {
  description: "Write data to the SharedBoard. Create or update tasks, publish artifacts, or send signals.",
  parameters: z.object({
    operation: z
      .enum(["create_task", "update_task", "post_artifact", "signal", "advance_round"])
      .describe("What to write"),
    swarm_id: z.string().describe("The Swarm ID"),
    data: z.record(z.string(), z.unknown()).describe("Data for the operation"),
  }),
  async execute(params): Promise<{ title: string; metadata: BoardMeta; output: string }> {
    if (params.operation === "create_task") {
      const task = await BoardTask.create({
        subject: (params.data.subject as string) ?? "",
        description: params.data.description as string | undefined,
        type: (params.data.type as BoardTask.Type) ?? "implement",
        scope: (params.data.scope as string[]) ?? [],
        swarm_id: params.swarm_id,
        blockedBy: (params.data.blockedBy as string[]) ?? [],
        blocks: (params.data.blocks as string[]) ?? [],
        assignee: params.data.assignee as string | undefined,
      })
      return { title: `Created task ${task.id}`, metadata: { taskId: task.id }, output: JSON.stringify(task, null, 2) }
    }
    if (params.operation === "update_task") {
      const id = params.data.id as string
      if (!id) return { title: "Error", metadata: {}, output: "Missing task id in data" }
      const changes: Record<string, unknown> = { ...params.data }
      delete changes.id
      const task = await BoardTask.update(params.swarm_id, id, changes as any)
      return { title: `Updated task ${task.id}`, metadata: { taskId: task.id }, output: JSON.stringify(task, null, 2) }
    }
    if (params.operation === "post_artifact") {
      const artifact = await BoardArtifact.post({
        type: (params.data.type as BoardArtifact.Type) ?? "finding",
        task_id: (params.data.task_id as string) ?? "",
        swarm_id: params.swarm_id,
        author: (params.data.author as string) ?? "",
        content: (params.data.content as string) ?? "",
        files: (params.data.files as string[]) ?? [],
        supersedes: params.data.supersedes as string | undefined,
      })
      return {
        title: `Posted artifact ${artifact.id}`,
        metadata: { artifactId: artifact.id },
        output: JSON.stringify(artifact, null, 2),
      }
    }
    if (params.operation === "advance_round") {
      const channel = params.data.channel as string
      if (!channel) return { title: "Error", metadata: {}, output: "Missing data.channel for advance_round" }
      const round = await Discussion.advance(params.swarm_id, channel)
      return {
        title: `Round advanced to ${round.round}`,
        metadata: { round: round.round, channel },
        output: JSON.stringify(round, null, 2),
      }
    }
    const signal = await BoardSignal.send({
      channel: (params.data.channel as string) ?? "general",
      type: (params.data.type as BoardSignal.Type) ?? "progress",
      from: (params.data.from as string) ?? "",
      payload: (params.data.payload as Record<string, unknown>) ?? {},
      swarm_id: params.swarm_id,
    })
    return { title: "Signal sent", metadata: { signalId: signal.id }, output: JSON.stringify(signal, null, 2) }
  },
})

// --- board_status ---
export const BoardStatusTool = Tool.define("board_status", {
  description: "Get a concise summary of the Swarm board state including task counts and active workers.",
  parameters: z.object({
    swarm_id: z.string().describe("The Swarm ID"),
  }),
  async execute(params): Promise<{ title: string; metadata: BoardMeta; output: string }> {
    const snap = await SharedBoard.snapshot(params.swarm_id)
    const lines = [
      `Tasks: ${snap.stats.total} total`,
      `  Pending: ${snap.stats.pending}`,
      `  Running: ${snap.stats.running}`,
      `  Completed: ${snap.stats.completed}`,
      `  Failed: ${snap.stats.failed}`,
      `Active Workers: ${snap.stats.workers}`,
      `Last Updated: ${new Date(snap.stats.last_updated).toISOString()}`,
    ]
    return { title: "Board status", metadata: { stats: snap.stats }, output: lines.join("\n") }
  },
})
