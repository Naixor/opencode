import { SecuritySchema } from "./schema"
import { LLMScanner } from "./llm-scanner"
import { SecurityRedact } from "./redact"

export namespace SecurityUtil {
  export function getDefaultRole(config: SecuritySchema.SecurityConfig): string {
    const roles = config.roles ?? []
    if (roles.length === 0) return "viewer"
    const lowest = roles.reduce((prev, curr) => (curr.level < prev.level ? curr : prev), roles[0])
    return lowest.name
  }

  export function scanAndRedact(content: string, config: SecuritySchema.SecurityConfig): string {
    if (!hasSecurityRules(config)) return content
    const matches = LLMScanner.scanForProtectedContent(content, config)
    if (matches.length === 0) return content
    return SecurityRedact.redactContent(content, matches)
  }

  export function hasSecurityRules(config: SecuritySchema.SecurityConfig): boolean {
    return (config.rules?.length ?? 0) > 0 || config.segments !== undefined
  }
}
