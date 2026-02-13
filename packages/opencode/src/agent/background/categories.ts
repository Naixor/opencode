import z from "zod"
import { Config } from "../../config/config"
import { Log } from "../../util/log"

export namespace Categories {
  const log = Log.create({ service: "categories" })

  export const CategoryConfig = z.object({
    description: z.string().describe("Description of when to use this category"),
    model: z.string().optional().describe("Model to use for tasks in this category (provider/model format)"),
    prompt_append: z.string().optional().describe("Additional prompt text appended for tasks in this category"),
  })
  export type CategoryConfig = z.infer<typeof CategoryConfig>

  export const DEFAULTS: Record<string, CategoryConfig> = {
    "visual-engineering": {
      description: "UI/UX implementation, frontend components, styling, layout work",
    },
    ultrabrain: {
      description: "Complex reasoning, architecture decisions, hard debugging requiring deep analysis",
    },
    deep: {
      description: "Deep codebase exploration, thorough analysis, comprehensive refactoring",
    },
    artistry: {
      description: "Creative writing, documentation, naming, prompt engineering",
    },
    quick: {
      description: "Fast, simple tasks: small edits, lookups, formatting, trivial fixes",
    },
    writing: {
      description: "Documentation, README, comments, technical writing, changelogs",
    },
    "unspecified-low": {
      description: "General tasks with low complexity — no specific category, use cheap/fast model",
    },
    "unspecified-high": {
      description: "General tasks with high complexity — no specific category, use capable model",
    },
  }

  export async function resolve(): Promise<Record<string, CategoryConfig>> {
    const cfg = await Config.get()
    const userCategories = (cfg as Record<string, unknown>).categories as
      | Record<string, CategoryConfig>
      | undefined
    if (!userCategories) return { ...DEFAULTS }
    return { ...DEFAULTS, ...userCategories }
  }

  export function lookup(
    name: string,
    categories: Record<string, CategoryConfig>,
  ): CategoryConfig | undefined {
    return categories[name]
  }

  export function buildDelegationTable(
    categories: Record<string, CategoryConfig>,
  ): string {
    const rows = Object.entries(categories).map(
      ([name, cat]) =>
        `| ${name} | ${cat.description}${cat.model ? ` (model: ${cat.model})` : ""} |`,
    )

    return [
      "## Task Categories",
      "",
      "Use these categories when delegating tasks to select the appropriate model and configuration.",
      "",
      "| Category | Description |",
      "|----------|-------------|",
      ...rows,
    ].join("\n")
  }
}
