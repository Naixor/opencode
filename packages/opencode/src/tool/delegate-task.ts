import { Tool } from "./tool"
import DESCRIPTION from "./delegate-task.txt"
import BACKGROUND_OUTPUT_DESC from "./background-output.txt"
import BACKGROUND_CANCEL_DESC from "./background-cancel.txt"
import z from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { Categories } from "../agent/background/categories"
import { BackgroundManager } from "../agent/background/manager"
import { Skill } from "../skill/skill"
import { Log } from "../util/log"

const log = Log.create({ service: "delegate-task" })

const delegateParameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The detailed task for the agent to perform"),
  run_in_background: z.boolean().default(false).describe("If true, returns task_id immediately without waiting for completion"),
  category: z.string().optional().describe("Task category for model routing (e.g., 'quick', 'deep', 'ultrabrain'). Cannot be used with subagent_type"),
  subagent_type: z.string().optional().describe("The type of specialized agent to use. Cannot be used with category"),
  session_id: z.string().optional().describe("Existing session ID to continue"),
  load_skills: z.array(z.string()).optional().describe("Skill names to inject into sub-agent context"),
})

type DelegateMetadata = {
  [key: string]: unknown
}

export const DelegateTaskTool = Tool.define("delegate_task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const categories = await Categories.resolve()
  const categoriesSection = Categories.buildDelegationTable(categories)

  const description = DESCRIPTION
    .replace(
      "{agents}",
      accessibleAgents
        .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
        .join("\n"),
    )
    .replace("{categories}", categoriesSection)

  return {
    description,
    parameters: delegateParameters,
    async execute(params: z.infer<typeof delegateParameters>, ctx): Promise<{ title: string; metadata: DelegateMetadata; output: string }> {
      // Block sub-agents from calling delegate_task (prevent recursion)
      if (ctx.extra?.isSubagent) {
        return {
          title: "Denied",
          metadata: { denied: true },
          output: "Sub-agents cannot call delegate_task. Proceed with the task directly using your available tools.",
        }
      }

      // Validate that category and subagent_type are not both specified
      if (params.category && params.subagent_type) {
        return {
          title: "Error",
          metadata: { error: true },
          output: "Cannot specify both 'category' and 'subagent_type'. Use one or the other:\n- 'category' for automatic model routing based on task type\n- 'subagent_type' for a specific agent",
        }
      }

      const config = await Config.get()

      // Resolve agent
      const agentName = params.subagent_type ?? "explore"
      const agent = await Agent.get(agentName)
      if (!agent) {
        return {
          title: "Error",
          metadata: { error: true },
          output: `Unknown agent type: ${agentName} is not a valid agent type. Available agents: ${accessibleAgents.map((a) => a.name).join(", ")}`,
        }
      }

      // Check permission (skip if user explicitly invoked)
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [agentName],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: agentName,
          },
        })
      }

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")

      // Resolve model from category or agent
      const categoryModel = await iife(async () => {
        if (!params.category) return undefined
        const cat = Categories.lookup(params.category, categories)
        if (!cat) {
          log.warn("unknown category", { category: params.category })
          return undefined
        }
        if (!cat.model) return undefined
        const [providerID, ...rest] = cat.model.split("/")
        const modelID = rest.join("/")
        if (!providerID || !modelID) return undefined
        return { providerID, modelID }
      })

      // Load skills if requested
      const skillContent = await iife(async () => {
        if (!params.load_skills?.length) return ""
        const parts: string[] = []
        for (const name of params.load_skills) {
          const skill = await Skill.get(name)
          if (skill) {
            parts.push(`<skill_content name="${skill.name}">\n${skill.content.trim()}\n</skill_content>`)
          }
        }
        return parts.length > 0 ? "\n\n" + parts.join("\n\n") : ""
      })

      const promptWithSkills = params.prompt + skillContent

      // Create or resume session
      const session = await iife(async () => {
        if (params.session_id) {
          const found = await Session.get(params.session_id).catch(() => {})
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} delegate)`,
          permission: [
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "todoread",
              pattern: "*",
              action: "deny",
            },
            // Deny delegate_task for sub-agents to prevent recursion
            {
              permission: "task" as const,
              pattern: "delegate_task" as const,
              action: "deny" as const,
            },
            ...(hasTaskPermission
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ],
        })
      })

      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = categoryModel ?? agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      // Background execution
      if (params.run_in_background) {
        const bgTask = BackgroundManager.create({
          description: params.description,
          provider: model.providerID,
          model: model.modelID,
          category: params.category,
        })

        // Set up the execution callback for this task
        const messageID = Identifier.ascending("message")
        const promptParts = await SessionPrompt.resolvePromptParts(promptWithSkills)

        // Execute asynchronously
        executeInBackground(bgTask.id, {
          messageID,
          session,
          model,
          agent,
          config,
          hasTaskPermission,
          promptParts,
          abort: ctx.abort,
          description: params.description,
        }).catch((err: unknown) => {
          BackgroundManager.fail(bgTask.id, err instanceof Error ? err.message : String(err))
        })

        return {
          title: params.description,
          metadata: {
            taskId: bgTask.id,
            sessionId: session.id,
            model,
            background: true,
          },
          output: [
            `Background task started: ${bgTask.id}`,
            `Session: ${session.id}`,
            `Agent: ${agent.name}`,
            `Status: running`,
            "",
            "Use background_output tool with this task_id to check progress.",
            "Use background_cancel tool to cancel the task.",
          ].join("\n"),
        }
      }

      // Synchronous execution (same pattern as existing task tool)
      const messageID = Identifier.ascending("message")
      const parts: Record<string, { id: string; tool: string; state: { status: string; title?: string } }> = {}
      const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
        if (evt.properties.part.sessionID !== session.id) return
        if (evt.properties.part.messageID === messageID) return
        if (evt.properties.part.type !== "tool") return
        const part = evt.properties.part
        parts[part.id] = {
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }
        ctx.metadata({
          title: params.description,
          metadata: {
            sessionId: session.id,
            model,
          },
        })
      })

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const promptParts = await SessionPrompt.resolvePromptParts(promptWithSkills)

      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,
        tools: {
          todowrite: false,
          todoread: false,
          delegate_task: false,
          ...(hasTaskPermission ? {} : { task: false }),
          ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
        },
        parts: promptParts,
      }).finally(() => {
        unsub()
      })

      const messages = await Session.messages({ sessionID: session.id })
      const summary = messages
        .filter((x) => x.info.role === "assistant")
        .flatMap((msg) => msg.parts.filter((x: any) => x.type === "tool") as MessageV2.ToolPart[])
        .map((part) => ({
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }))
      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

      const output = text + "\n\n" + ["<task_metadata>", `session_id: ${session.id}`, "</task_metadata>"].join("\n")

      return {
        title: params.description,
        metadata: {
          summary,
          sessionId: session.id,
          model,
          background: false,
        },
        output,
      }
    },
  }
})

async function executeInBackground(
  taskId: string,
  input: {
    messageID: string
    session: Session.Info
    model: { providerID: string; modelID: string }
    agent: Agent.Info
    config: Config.Info
    hasTaskPermission: boolean
    promptParts: SessionPrompt.PromptInput["parts"]
    abort: AbortSignal
    description: string
  },
): Promise<void> {
  const result = await SessionPrompt.prompt({
    messageID: input.messageID,
    sessionID: input.session.id,
    model: {
      modelID: input.model.modelID,
      providerID: input.model.providerID,
    },
    agent: input.agent.name,
    tools: {
      todowrite: false,
      todoread: false,
      delegate_task: false,
      ...(input.hasTaskPermission ? {} : { task: false }),
      ...Object.fromEntries((input.config.experimental?.primary_tools ?? []).map((t) => [t, false])),
    },
    parts: input.promptParts,
  })

  const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""
  BackgroundManager.complete(taskId, {
    text,
    sessionId: input.session.id,
  })
}

// --- Background Output Tool ---

const outputParameters = z.object({
  task_id: z.string().describe("The background task ID to check"),
})

type OutputMetadata = {
  [key: string]: unknown
}

export const BackgroundOutputTool = Tool.define("background_output", {
  description: BACKGROUND_OUTPUT_DESC,
  parameters: outputParameters,
  async execute(params: z.infer<typeof outputParameters>): Promise<{ title: string; metadata: OutputMetadata; output: string }> {
    const task = BackgroundManager.get(params.task_id)
    if (!task) {
      return {
        title: "Not Found",
        metadata: { error: true },
        output: `Background task not found: ${params.task_id}. The task may have been cleaned up or the ID is incorrect.`,
      }
    }

    const lines: string[] = [
      `Task: ${task.id}`,
      `Status: ${task.status}`,
      `Description: ${task.description ?? "N/A"}`,
    ]

    if (task.createdAt) lines.push(`Created: ${new Date(task.createdAt).toISOString()}`)
    if (task.startedAt) lines.push(`Started: ${new Date(task.startedAt).toISOString()}`)
    if (task.completedAt) lines.push(`Completed: ${new Date(task.completedAt).toISOString()}`)

    if (task.status === "completed" && task.result) {
      const result = task.result as { text?: string; sessionId?: string }
      if (result.sessionId) lines.push(`Session: ${result.sessionId}`)
      if (result.text) {
        lines.push("", "--- Output ---", result.text)
      }
    }

    if (task.status === "failed" && task.error) {
      lines.push("", `Error: ${task.error}`)
    }

    return {
      title: `Task ${task.status}`,
      metadata: {
        taskId: task.id,
        status: task.status,
        sessionId: task.sessionID,
      },
      output: lines.join("\n"),
    }
  },
})

// --- Background Cancel Tool ---

const cancelParameters = z.object({
  task_id: z.string().describe("The background task ID to cancel"),
})

type CancelMetadata = {
  [key: string]: unknown
}

export const BackgroundCancelTool = Tool.define("background_cancel", {
  description: BACKGROUND_CANCEL_DESC,
  parameters: cancelParameters,
  async execute(params: z.infer<typeof cancelParameters>): Promise<{ title: string; metadata: CancelMetadata; output: string }> {
    const task = BackgroundManager.get(params.task_id)
    if (!task) {
      return {
        title: "Not Found",
        metadata: { error: true },
        output: `Background task not found: ${params.task_id}. The task may have been cleaned up or the ID is incorrect.`,
      }
    }

    if (task.status !== "pending" && task.status !== "running") {
      return {
        title: "Cannot Cancel",
        metadata: { taskId: task.id, status: task.status },
        output: `Task ${task.id} is already ${task.status} and cannot be cancelled.`,
      }
    }

    // If task has a session, cancel the prompt
    if (task.sessionID) {
      SessionPrompt.cancel(task.sessionID)
    }

    BackgroundManager.cancel(params.task_id)

    return {
      title: "Cancelled",
      metadata: { taskId: task.id, status: "cancelled" },
      output: `Background task ${task.id} has been cancelled.`,
    }
  },
})
