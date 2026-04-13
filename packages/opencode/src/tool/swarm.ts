import { Tool } from "./tool"
import z from "zod"
import { Swarm } from "../session/swarm"

type SwarmMeta = Record<string, unknown>

const defaults = [
  { name: "PM", perspective: "Focus on user value, scope control, and product-market fit" },
  { name: "RD", perspective: "Focus on implementation feasibility, performance, and technical debt" },
  { name: "QA", perspective: "Focus on edge cases, error handling, testing strategy, and security" },
]

function flat(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function cut(value: string, size: number) {
  const text = flat(value)
  if (text.length <= size) return text
  if (size <= 3) return text.slice(0, size)
  return `${text.slice(0, size - 3).trimEnd()}...`
}

function pad(value: string, size: number) {
  return value.length >= size ? value : value + " ".repeat(size - value.length)
}

function table(head: string[], body: string[][]) {
  const rows = [head, ...body]
  const width = head.map((_, i) => Math.max(...rows.map((row) => row[i]?.length ?? 0)))
  const draw = (row: string[]) => row.map((item, i) => pad(item, width[i] ?? 0)).join("  ")
  return [draw(head), draw(width.map((size) => "-".repeat(size))), ...body.map(draw)].join("\n")
}

function state(info: Swarm.Info) {
  if (["active", "blocked", "paused"].includes(info.status)) return `${info.status}/${info.stage}`
  return info.status
}

function crew(info: Swarm.Info) {
  if (info.workers.length === 0) return "none"
  return info.workers
    .map((item) => {
      const role = item.role ?? item.agent
      const task = item.task_id || "-"
      const line = `- ${role} [${item.status}] task ${task}`
      return item.reason ? `${line} - ${item.reason}` : line
    })
    .join("\n")
}

function view(info: Swarm.Info) {
  const lines = [
    `ID: ${info.id}`,
    `Goal: ${flat(info.goal)}`,
    `State: ${state(info)}`,
    `Conductor: ${info.conductor}`,
    `Workers: ${info.workers.length}/${info.config.max_workers}`,
    `Updated: ${new Date(info.time.updated).toISOString()}`,
  ]
  if (info.reason) lines.push(`Reason: ${info.reason}`)
  lines.push("Worker Detail:", crew(info))
  return lines.join("\n")
}

function list(swarms: Swarm.Info[]) {
  if (swarms.length === 0) return "No swarms in the current workspace."
  const rows = swarms
    .toSorted((a, b) => b.time.updated - a.time.updated)
    .map((item) => [item.id, state(item), String(item.workers.length), cut(item.goal, 68)])
  const notes = swarms.filter((item) => item.reason).map((item) => `- ${item.id}: ${item.reason}`)
  if (notes.length === 0) return table(["ID", "Status", "Workers", "Goal"], rows)
  return `${table(["ID", "Status", "Workers", "Goal"], rows)}\n\nNotes:\n${notes.join("\n")}`
}

export const SwarmLaunchTool = Tool.define("swarm_launch", {
  description: "Launch a new multi-agent Swarm to accomplish a complex goal collaboratively.",
  parameters: z.object({
    goal: z.string().describe("The goal for the Swarm to accomplish"),
    max_workers: z.number().optional().describe("Maximum concurrent workers (default: 4)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: SwarmMeta; output: string }> {
    const info = await Swarm.launch({
      goal: params.goal,
      config: params.max_workers ? { max_workers: params.max_workers } : undefined,
      dedupe_key: `tool:${ctx.sessionID}:${ctx.messageID}:${JSON.stringify({ goal: params.goal, max_workers: params.max_workers ?? null })}`,
    })
    return {
      title: `Swarm launched: ${info.id}`,
      metadata: { swarmId: info.id, conductorSession: info.conductor, workerCount: info.workers.length },
      output: [
        `Swarm ${info.id} launched.`,
        `Goal: ${cut(info.goal, 120)}`,
        `Conductor: ${info.conductor}`,
        `Capacity: ${info.config.max_workers} workers`,
      ].join("\n"),
    }
  },
})

export const SwarmStatusTool = Tool.define("swarm_status", {
  description: "Get the current status of a Swarm.",
  parameters: z.object({
    id: z.string().describe("The Swarm ID"),
  }),
  async execute(params): Promise<{ title: string; metadata: SwarmMeta; output: string }> {
    const info = await Swarm.status(params.id)
    return {
      title: `Swarm ${info.status}: ${info.id}`,
      metadata: { swarmId: info.id, status: info.status, stage: info.stage, workerCount: info.workers.length },
      output: view(info),
    }
  },
})

export const SwarmInterveneTool = Tool.define("swarm_intervene", {
  description: "Send a message to the Conductor of a running Swarm.",
  parameters: z.object({
    id: z.string().describe("The Swarm ID"),
    message: z.string().describe("Message to send to the Conductor"),
  }),
  async execute(params): Promise<{ title: string; metadata: SwarmMeta; output: string }> {
    await Swarm.intervene(params.id, params.message)
    return {
      title: "Message sent",
      metadata: { swarmId: params.id },
      output: `Message sent to Swarm ${params.id} conductor.`,
    }
  },
})

export const SwarmStopTool = Tool.define("swarm_stop", {
  description: "Stop a running Swarm and cancel all workers.",
  parameters: z.object({
    id: z.string().describe("The Swarm ID"),
  }),
  async execute(params): Promise<{ title: string; metadata: SwarmMeta; output: string }> {
    const info = await Swarm.stop(params.id)
    return {
      title: "Swarm stopped",
      metadata: { swarmId: info.id, status: info.status },
      output: `Swarm ${info.id} stopped.\nState: ${state(info)}`,
    }
  },
})

export const SwarmDiscussTool = Tool.define("swarm_discuss", {
  description: "Launch a discussion-focused Swarm where role-specific agents debate a topic.",
  parameters: z.object({
    topic: z.string().describe("The topic to discuss"),
    roles: z
      .array(
        z.object({
          name: z.string().describe("The role name (e.g. PM, RD, QA)"),
          perspective: z.string().describe("The role perspective (e.g. 'Focus on user value, scope control')"),
        }),
      )
      .optional()
      .describe("Roles to assign in the discussion"),
    max_rounds: z.number().optional().describe("Maximum discussion rounds (default: 3)"),
  }),
  async execute(params): Promise<{ title: string; metadata: SwarmMeta; output: string }> {
    const roles = params.roles && params.roles.length > 0 ? params.roles : defaults
    const info = await Swarm.discuss({
      topic: params.topic,
      roles,
      max_rounds: params.max_rounds,
    })
    return {
      title: `Discussion launched: ${info.id}`,
      metadata: { swarmId: info.id, conductorSession: info.conductor, roles: roles.map((item) => item.name) },
      output: [
        `Discussion Swarm ${info.id} launched.`,
        `Topic: ${cut(params.topic, 120)}`,
        `Roles: ${roles.map((item) => item.name).join(", ")}`,
        `Rounds: ${params.max_rounds ?? 3}`,
        `Conductor: ${info.conductor}`,
      ].join("\n"),
    }
  },
})

export const SwarmListTool = Tool.define("swarm_list", {
  description: "List all Swarms.",
  parameters: z.object({}),
  async execute(): Promise<{ title: string; metadata: SwarmMeta; output: string }> {
    const swarms = await Swarm.list()
    return {
      title: swarms.length === 0 ? "No swarms" : `${swarms.length} swarms`,
      metadata: { count: swarms.length },
      output: list(swarms),
    }
  },
})
