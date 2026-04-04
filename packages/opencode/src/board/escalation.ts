import z from "zod"
import { Config } from "../config/config"
import { Log } from "../util/log"

export namespace Escalation {
  const log = Log.create({ service: "board.escalation" })

  export const Action = z.enum(["retry", "arbitrate", "reassign", "ask_human"])
  export type Action = z.infer<typeof Action>

  export const Rule = z.object({
    condition: z.string(),
    action: Action,
    max_retries: z.number().int().positive().default(3),
  })
  export type Rule = z.infer<typeof Rule>

  const DEFAULTS: Rule[] = [
    { condition: "task_failed", action: "retry", max_retries: 3 },
    { condition: "conflict_same_file", action: "arbitrate", max_retries: 3 },
    { condition: "architecture_decision", action: "ask_human", max_retries: 3 },
    { condition: "all_retries_exhausted", action: "ask_human", max_retries: 3 },
    { condition: "security_sensitive", action: "ask_human", max_retries: 3 },
  ]

  export async function rules(): Promise<Rule[]> {
    const cfg = await Config.get()
    const custom = cfg.swarm?.escalation ?? []
    return [...custom, ...DEFAULTS]
  }

  export async function evaluate(event: {
    type: string
    retries: number
    context?: Record<string, unknown>
  }): Promise<{ action: Action; rule: Rule } | undefined> {
    const all = await rules()
    for (const rule of all) {
      if (event.type === rule.condition) {
        if (event.type === "task_failed" && event.retries >= rule.max_retries) continue
        return { action: rule.action, rule }
      }
    }
    if (event.retries >= 3) {
      const fallback = all.find((r) => r.condition === "all_retries_exhausted")
      if (fallback) return { action: fallback.action, rule: fallback }
    }
    return undefined
  }
}
