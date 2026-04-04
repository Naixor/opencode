import { Tool } from "./tool"
import z from "zod"
import { Swarm } from "../session/swarm"

type SwarmMeta = Record<string, unknown>

export const SwarmLaunchTool = Tool.define("swarm_launch", {
  description: "Launch a new multi-agent Swarm to accomplish a complex goal collaboratively.",
  parameters: z.object({
    goal: z.string().describe("The goal for the Swarm to accomplish"),
    max_workers: z.number().optional().describe("Maximum concurrent workers (default: 4)"),
  }),
  async execute(params): Promise<{ title: string; metadata: SwarmMeta; output: string }> {
    const info = await Swarm.launch({
      goal: params.goal,
      config: params.max_workers ? { max_workers: params.max_workers } : undefined,
    })
    return {
      title: `Swarm launched: ${info.id}`,
      metadata: { swarmId: info.id, conductorSession: info.conductor },
      output: `Swarm ${info.id} launched.\nConductor session: ${info.conductor}\nGoal: ${info.goal.slice(0, 100)}`,
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
      title: `Swarm ${info.status}`,
      metadata: { swarmId: info.id, status: info.status },
      output: JSON.stringify(info, null, 2),
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
      output: `Message sent to Swarm ${params.id} Conductor.`,
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
      output: `Swarm ${info.id} stopped.`,
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
      .describe("Roles to assign in the discussion"),
    max_rounds: z.number().optional().describe("Maximum discussion rounds (default: 3)"),
  }),
  async execute(params): Promise<{ title: string; metadata: SwarmMeta; output: string }> {
    const info = await Swarm.discuss({
      topic: params.topic,
      roles: params.roles,
      max_rounds: params.max_rounds,
    })
    return {
      title: `Discussion launched: ${info.id}`,
      metadata: { swarmId: info.id, conductorSession: info.conductor },
      output: `Discussion Swarm ${info.id} launched.\nTopic: ${params.topic}\nRoles: ${params.roles.map((r) => r.name).join(", ")}\nConductor: ${info.conductor}`,
    }
  },
})

export const SwarmListTool = Tool.define("swarm_list", {
  description: "List all Swarms.",
  parameters: z.object({}),
  async execute(): Promise<{ title: string; metadata: SwarmMeta; output: string }> {
    const swarms = await Swarm.list()
    if (swarms.length === 0) return { title: "No swarms", metadata: {}, output: "No active Swarms." }
    const lines = swarms.map((s) => `${s.id} | ${s.status} | ${s.workers.length} workers | ${s.goal.slice(0, 60)}`)
    return {
      title: `${swarms.length} swarms`,
      metadata: { count: swarms.length },
      output: lines.join("\n"),
    }
  },
})
