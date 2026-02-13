import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { PermissionNext } from "../permission/next"
import { Ripgrep } from "../file/ripgrep"
import { iife } from "@/util/iife"
import { MCP } from "../mcp"
import { SecurityConfig } from "../security/config"

export const SkillTool = Tool.define("skill", async (ctx) => {
  const skills = await Skill.all()

  // Filter skills by agent permissions and agent restrictions
  const agent = ctx?.agent
  const agentName = agent?.name
  const accessibleSkills = agent
    ? skills.filter((skill) => {
        // Check PermissionNext first
        const rule = PermissionNext.evaluate("skill", skill.name, agent.permission)
        if (rule.action === "deny") return false
        // Check skill.agent restriction
        if (skill.agent && skill.agent.length > 0 && !skill.agent.includes(agent.name)) return false
        return true
      })
    : skills

  // Build MCP info sections for skills with mcp metadata
  const mcpSections = await buildSkillMcpSections(accessibleSkills)

  const description =
    accessibleSkills.length === 0
      ? "Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available."
      : [
          "Load a specialized skill that provides domain-specific instructions and workflows.",
          "",
          "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
          "",
          "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
          "",
          'Tool output includes a `<skill_content name="...">` block with the loaded content.',
          "",
          "The following skills provide specialized sets of instructions for particular tasks",
          "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
          "",
          "<available_skills>",
          ...accessibleSkills.flatMap((skill) => {
            const lines = [
              `  <skill>`,
              `    <name>${skill.name}</name>`,
              `    <description>${skill.description}</description>`,
              `    <location>${pathToFileURL(skill.location).href}</location>`,
            ]
            const mcpInfo = mcpSections[skill.name]
            if (mcpInfo) {
              lines.push(`    <mcp_capabilities>`, mcpInfo, `    </mcp_capabilities>`)
            }
            if (skill.agent?.length) {
              lines.push(`    <restricted_to>${skill.agent.join(", ")}</restricted_to>`)
            }
            lines.push(`  </skill>`)
            return lines
          }),
          "</available_skills>",
        ].join("\n")

  const examples = accessibleSkills
    .map((skill) => `'${skill.name}'`)
    .slice(0, 3)
    .join(", ")
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ""

  const parameters = z.object({
    name: z.string().describe(`The name of the skill from available_skills${hint}`),
  })

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const skill = await Skill.get(params.name)

      if (!skill) {
        const available = await Skill.all().then((x) => x.map((s) => s.name).join(", "))
        throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
      }

      // Check agent restriction on execute as well
      if (skill.agent && skill.agent.length > 0 && agentName && !skill.agent.includes(agentName)) {
        return {
          title: "Access Denied",
          output: `Skill "${skill.name}" is restricted to agents: ${skill.agent.join(", ")}. Current agent "${agentName}" is not allowed.`,
          metadata: {
            name: skill.name,
            dir: "",
            hasInstruction: false,
            denied: true,
          },
        }
      }

      await ctx.ask({
        permission: "skill",
        patterns: [params.name],
        always: [params.name],
        metadata: {},
      })

      const dir = path.dirname(skill.location)
      const base = pathToFileURL(dir).href

      const limit = 10
      const files = await iife(async () => {
        const arr = []
        for await (const file of Ripgrep.files({
          cwd: dir,
          follow: false,
          hidden: true,
          signal: ctx.abort,
        })) {
          if (file.includes("SKILL.md")) {
            continue
          }
          arr.push(path.resolve(dir, file))
          if (arr.length >= limit) {
            break
          }
        }
        return arr
      }).then((f) => f.map((file) => `<file>${file}</file>`).join("\n"))

      // Extract <skill-instruction> block if present
      const { instruction, hasBlock } = Skill.extractInstruction(skill.content)
      const contentToReturn = hasBlock ? instruction : skill.content.trim()

      return {
        title: `Loaded skill: ${skill.name}`,
        output: [
          `<skill_content name="${skill.name}">`,
          `# Skill: ${skill.name}`,
          "",
          contentToReturn,
          "",
          `Base directory for this skill: ${base}`,
          "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
          "Note: file list is sampled.",
          "",
          "<skill_files>",
          files,
          "</skill_files>",
          "</skill_content>",
        ].join("\n"),
        metadata: {
          name: skill.name,
          dir,
          hasInstruction: hasBlock,
          denied: false,
        },
      }
    },
  }
})

async function buildSkillMcpSections(skills: Skill.Info[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {}

  const skillsWithMcp = skills.filter((s) => s.mcp?.length)
  if (skillsWithMcp.length === 0) return result

  const statuses = await MCP.status().catch(() => ({}) as Record<string, MCP.Status>)
  const mcpTools = await MCP.tools().catch(() => ({}) as Record<string, unknown>)
  const resources = await MCP.resources().catch(() => ({}) as Record<string, unknown>)
  const prompts = await MCP.prompts().catch(() => ({}) as Record<string, unknown>)

  for (const skill of skillsWithMcp) {
    const sections: string[] = []
    for (const serverName of skill.mcp!) {
      const status = statuses[serverName]
      if (!status || status.status !== "connected") continue

      const policy = SecurityConfig.getMcpPolicy(serverName)
      if (policy === "blocked") continue

      const sanitized = serverName.replace(/[^a-zA-Z0-9_-]/g, "_")
      const lines: string[] = [`      <mcp_server name="${serverName}">`]

      const toolPrefix = sanitized + "_"
      const toolNames = Object.keys(mcpTools)
        .filter((k) => k.startsWith(toolPrefix))
        .map((k) => k.slice(toolPrefix.length))
      if (toolNames.length > 0) {
        lines.push(`        <tools>${toolNames.join(", ")}</tools>`)
      }

      const resPrefix = sanitized + ":"
      const resourceNames = Object.keys(resources)
        .filter((k) => k.startsWith(resPrefix))
        .map((k) => k.slice(resPrefix.length))
      if (resourceNames.length > 0) {
        lines.push(`        <resources>${resourceNames.join(", ")}</resources>`)
      }

      const promptNames = Object.keys(prompts)
        .filter((k) => k.startsWith(resPrefix))
        .map((k) => k.slice(resPrefix.length))
      if (promptNames.length > 0) {
        lines.push(`        <prompts>${promptNames.join(", ")}</prompts>`)
      }

      lines.push(`      </mcp_server>`)
      sections.push(lines.join("\n"))
    }
    if (sections.length > 0) {
      result[skill.name] = sections.join("\n")
    }
  }

  return result
}
