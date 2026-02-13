import { Tool } from "./tool"
import DESCRIPTION from "./skill-mcp.txt"
import z from "zod"
import { MCP } from "../mcp"
import { BuiltinMcp } from "../mcp/builtin"
import { SecurityConfig } from "../security/config"
import { SecurityAudit } from "../security/audit"
import { Log } from "../util/log"

const log = Log.create({ service: "skill-mcp" })

type SkillMcpMetadata = {
  [key: string]: unknown
}

export const SkillMcpTool = Tool.define("skill_mcp", async () => {
  // Build MCP info for description
  const mcpInfo = await buildMcpInfo()

  const description = DESCRIPTION.replace("{mcp_info}", mcpInfo)

  const parameters = z.object({
    mcp_name: z.string().describe("The MCP server name"),
    tool_name: z.string().optional().describe("Name of the MCP tool to invoke"),
    resource_name: z.string().optional().describe("URI of the MCP resource to read"),
    prompt_name: z.string().optional().describe("Name of the MCP prompt to execute"),
    arguments: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe("Arguments as JSON string or object"),
  })

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx): Promise<{ title: string; metadata: SkillMcpMetadata; output: string }> {
      // Validate exactly ONE operation specified
      const ops = [params.tool_name, params.resource_name, params.prompt_name].filter(Boolean)
      if (ops.length === 0) {
        return {
          title: "Validation Error",
          metadata: { error: true },
          output: "You must specify exactly one of: tool_name, resource_name, or prompt_name.",
        }
      }
      if (ops.length > 1) {
        return {
          title: "Validation Error",
          metadata: { error: true },
          output: "You must specify exactly one of: tool_name, resource_name, or prompt_name. Multiple operations were specified.",
        }
      }

      // Parse arguments
      const args = parseArguments(params.arguments)

      // Check MCP security policy
      const policy = SecurityConfig.getMcpPolicy(params.mcp_name)
      if (policy === "blocked") {
        SecurityAudit.logSecurityEvent({
          role: "agent",
          operation: "read",
          path: `mcp://${params.mcp_name}`,
          allowed: false,
          reason: `MCP server '${params.mcp_name}' is blocked by security policy`,
        })
        return {
          title: "Access Denied",
          metadata: { denied: true, server: params.mcp_name },
          output: `MCP server '${params.mcp_name}' is blocked by security policy. Check .opencode-security.json for MCP server policies.`,
        }
      }

      // Verify the MCP server exists and is connected
      const statuses = await MCP.status()
      const serverStatus = statuses[params.mcp_name]

      if (!serverStatus) {
        const builtinMsg = BuiltinMcp.getDisabledMessage(params.mcp_name)
        const msg = builtinMsg
          ? builtinMsg
          : `Unknown MCP server: '${params.mcp_name}'. Available servers: ${Object.keys(statuses).join(", ") || "none"}`
        return {
          title: "Error",
          metadata: { error: true, server: params.mcp_name },
          output: msg,
        }
      }

      if (serverStatus.status !== "connected") {
        const statusMsg = serverStatus.status === "failed"
          ? `failed: ${(serverStatus as { error: string }).error}`
          : serverStatus.status
        return {
          title: "Error",
          metadata: { error: true, server: params.mcp_name, status: serverStatus.status },
          output: `MCP server '${params.mcp_name}' is not connected (status: ${statusMsg}). Ensure the server is configured and running.`,
        }
      }

      // Route to the appropriate operation
      if (params.tool_name) {
        return callTool(params.mcp_name, params.tool_name, args)
      }

      if (params.resource_name) {
        return readResource(params.mcp_name, params.resource_name)
      }

      if (params.prompt_name) {
        return getPrompt(params.mcp_name, params.prompt_name, args as Record<string, string>)
      }

      return {
        title: "Error",
        metadata: { error: true },
        output: "Unexpected error: no operation matched.",
      }
    },
  }
})

function parseArguments(input: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {}
  if (typeof input === "object") return input
  return JSON.parse(input) as Record<string, unknown>
}

async function callTool(
  mcpName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ title: string; metadata: SkillMcpMetadata; output: string }> {
  const mcpTools = await MCP.tools()

  // Build the sanitized key
  const sanitizedServer = mcpName.replace(/[^a-zA-Z0-9_-]/g, "_")
  const sanitizedTool = toolName.replace(/[^a-zA-Z0-9_-]/g, "_")
  const toolKey = `${sanitizedServer}_${sanitizedTool}`

  const tool = mcpTools[toolKey]
  if (!tool) {
    // List available tools for this server
    const serverPrefix = sanitizedServer + "_"
    const available = Object.keys(mcpTools)
      .filter((k) => k.startsWith(serverPrefix))
      .map((k) => k.slice(serverPrefix.length))
    return {
      title: "Tool Not Found",
      metadata: { error: true, server: mcpName, tool: toolName },
      output: `MCP tool '${toolName}' not found on server '${mcpName}'. Available tools: ${available.join(", ") || "none"}`,
    }
  }

  if (!tool.execute) {
    return {
      title: "Error",
      metadata: { error: true, server: mcpName, tool: toolName },
      output: `MCP tool '${toolName}' on server '${mcpName}' has no execute function.`,
    }
  }

  const executeFn = tool.execute as unknown as (args: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown>
  const result = await executeFn(args, {
    toolCallId: "skill_mcp",
    messages: [],
  })
  const formatted = formatCallToolResult(result)

  return {
    title: `MCP Tool: ${mcpName}/${toolName}`,
    metadata: { server: mcpName, tool: toolName, operation: "tool" },
    output: formatted,
  }
}

async function readResource(
  mcpName: string,
  resourceUri: string,
): Promise<{ title: string; metadata: SkillMcpMetadata; output: string }> {
  const result = await MCP.readResource(mcpName, resourceUri)
  if (!result) {
    return {
      title: "Resource Not Found",
      metadata: { error: true, server: mcpName, resource: resourceUri },
      output: `Failed to read resource '${resourceUri}' from MCP server '${mcpName}'. The resource may not exist or the server returned an error.`,
    }
  }

  const parts = (result.contents ?? []).map((c: { text?: string; uri?: string; mimeType?: string; blob?: string }) => {
    if (c.text) return c.text
    if (c.blob) return `[Binary content: ${c.mimeType ?? "unknown type"}]`
    return `[Resource: ${c.uri ?? resourceUri}]`
  })

  return {
    title: `MCP Resource: ${mcpName}/${resourceUri}`,
    metadata: { server: mcpName, resource: resourceUri, operation: "resource" },
    output: parts.join("\n") || "Resource returned empty content.",
  }
}

async function getPrompt(
  mcpName: string,
  promptName: string,
  args: Record<string, string>,
): Promise<{ title: string; metadata: SkillMcpMetadata; output: string }> {
  const result = await MCP.getPrompt(mcpName, promptName, Object.keys(args).length > 0 ? args : undefined)
  if (!result) {
    // List available prompts for this server
    const allPrompts = await MCP.prompts()
    const serverPrefix = mcpName.replace(/[^a-zA-Z0-9_-]/g, "_") + ":"
    const available = Object.keys(allPrompts)
      .filter((k) => k.startsWith(serverPrefix))
      .map((k) => k.slice(serverPrefix.length))
    return {
      title: "Prompt Not Found",
      metadata: { error: true, server: mcpName, prompt: promptName },
      output: `Failed to execute prompt '${promptName}' on MCP server '${mcpName}'. Available prompts: ${available.join(", ") || "none"}`,
    }
  }

  const messages = (result.messages ?? []).map((m: { role: string; content: { type: string; text?: string } }) => {
    const text = m.content?.text ?? ""
    return `[${m.role}]: ${text}`
  })

  return {
    title: `MCP Prompt: ${mcpName}/${promptName}`,
    metadata: { server: mcpName, prompt: promptName, operation: "prompt" },
    output: messages.join("\n\n") || "Prompt returned empty content.",
  }
}

function formatCallToolResult(result: unknown): string {
  if (!result) return "Tool returned no result."

  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean }

  if (r.isError) {
    const errorText = r.content?.map((c) => c.text ?? "").join("\n") ?? "Unknown error"
    return `Error from MCP tool:\n${errorText}`
  }

  if (!r.content?.length) return "Tool returned empty result."

  return r.content
    .map((c) => {
      if (c.type === "text") return c.text ?? ""
      return `[${c.type} content]`
    })
    .join("\n")
}

async function buildMcpInfo(): Promise<string> {
  const statuses = await MCP.status().catch(() => ({}) as Record<string, MCP.Status>)
  const serverNames = Object.keys(statuses)

  if (serverNames.length === 0) {
    return "No MCP servers are currently configured."
  }

  const sections: string[] = []

  for (const name of serverNames) {
    const status = statuses[name]
    if (status.status !== "connected") continue

    // Check security policy
    const policy = SecurityConfig.getMcpPolicy(name)
    if (policy === "blocked") continue

    const lines: string[] = [`<mcp_server name="${name}">`]

    // List tools
    const mcpTools = await MCP.tools().catch(() => ({}) as Record<string, unknown>)
    const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, "_")
    const prefix = sanitizedName + "_"
    const toolNames = Object.keys(mcpTools)
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
    if (toolNames.length > 0) {
      lines.push(`  <tools>${toolNames.join(", ")}</tools>`)
    }

    // List resources
    const resources = await MCP.resources().catch(() => ({}) as Record<string, unknown>)
    const resPrefix = sanitizedName + ":"
    const resourceNames = Object.keys(resources)
      .filter((k) => k.startsWith(resPrefix))
      .map((k) => k.slice(resPrefix.length))
    if (resourceNames.length > 0) {
      lines.push(`  <resources>${resourceNames.join(", ")}</resources>`)
    }

    // List prompts
    const prompts = await MCP.prompts().catch(() => ({}) as Record<string, unknown>)
    const promptNames = Object.keys(prompts)
      .filter((k) => k.startsWith(resPrefix))
      .map((k) => k.slice(resPrefix.length))
    if (promptNames.length > 0) {
      lines.push(`  <prompts>${promptNames.join(", ")}</prompts>`)
    }

    lines.push(`</mcp_server>`)
    sections.push(lines.join("\n"))
  }

  if (sections.length === 0) {
    return "No MCP servers are currently connected and accessible."
  }

  return sections.join("\n\n")
}
