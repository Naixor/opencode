import { Agent } from "./agent"
import { Skill } from "../skill"
import { Config } from "../config/config"
import PROMPT_SISYPHUS from "./prompt/sisyphus.txt"

export namespace Sisyphus {
  export async function buildDynamicPrompt(): Promise<string> {
    const sections = [PROMPT_SISYPHUS]

    const agentsSection = await buildAgentsTable()
    if (agentsSection) sections.push(agentsSection)

    const skillsSection = await buildSkillsList()
    if (skillsSection) sections.push(skillsSection)

    const categoriesSection = await buildCategoriesSection()
    if (categoriesSection) sections.push(categoriesSection)

    return sections.join("\n\n")
  }

  async function buildAgentsTable(): Promise<string | undefined> {
    const agents = await Agent.list()
    const delegatable = agents.filter(
      (a) => a.mode === "subagent" || a.mode === "all",
    )
    if (delegatable.length === 0) return undefined

    const rows = delegatable.map(
      (a) => `| ${a.name} | ${a.description ?? "No description"} | ${a.mode} |`,
    )

    return [
      "## Available Agents",
      "",
      "| Agent | Description | Mode |",
      "|-------|-------------|------|",
      ...rows,
    ].join("\n")
  }

  async function buildSkillsList(): Promise<string | undefined> {
    const skills = await Skill.all()
    if (skills.length === 0) return undefined

    const items = skills.map((s) => `- **${s.name}**: ${s.description}`)

    return ["## Available Skills", "", ...items].join("\n")
  }

  async function buildCategoriesSection(): Promise<string | undefined> {
    const cfg = await Config.get()
    // categories field will be added in US-030; access safely via record lookup
    const categories = (cfg as Record<string, unknown>).categories as
      | Record<string, { description: string; model?: string }>
      | undefined
    if (!categories || Object.keys(categories).length === 0) return undefined

    const items = Object.entries(categories).map(
      ([name, cat]) =>
        `- **${name}**: ${cat.description}${cat.model ? ` (model: ${cat.model})` : ""}`,
    )

    return ["## Task Categories", "", ...items].join("\n")
  }
}
