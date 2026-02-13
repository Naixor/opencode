import { SecuritySchema } from "./schema"
import { LLMScanner } from "./llm-scanner"
import { SecurityRedact } from "./redact"
import { SecuritySegments } from "./segments"

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

  export function getRoleLevel(roleName: string, config: SecuritySchema.SecurityConfig): number {
    const role = (config.roles ?? []).find((r) => r.name === roleName)
    return role?.level ?? 0
  }

  export function isRoleAllowed(
    roleName: string,
    allowedRoles: string[],
    config: SecuritySchema.SecurityConfig,
  ): boolean {
    if (allowedRoles.includes(roleName)) return true
    const roleLevel = getRoleLevel(roleName, config)
    const allRoles = config.roles ?? []
    for (const allowedRoleName of allowedRoles) {
      const allowedRole = allRoles.find((r) => r.name === allowedRoleName)
      if (allowedRole && roleLevel > allowedRole.level) return true
    }
    return false
  }

  export function findProtectedSegments(
    filepath: string,
    content: string,
    config: SecuritySchema.SecurityConfig,
    currentRole: string,
  ): SecurityRedact.Segment[] {
    const segments: SecurityRedact.Segment[] = []
    const segmentsConfig = config.segments

    if (!segmentsConfig) return segments

    if (segmentsConfig.markers && segmentsConfig.markers.length > 0) {
      const markerSegments = SecuritySegments.findMarkerSegments(content, segmentsConfig.markers)
      for (const segment of markerSegments) {
        if (
          segment.rule.deniedOperations.includes("read") &&
          !isRoleAllowed(currentRole, segment.rule.allowedRoles, config)
        ) {
          segments.push({ start: segment.start, end: segment.end })
        }
      }
    }

    if (segmentsConfig.ast && segmentsConfig.ast.length > 0) {
      const astSegments = SecuritySegments.findASTSegments(filepath, content, segmentsConfig.ast)
      for (const segment of astSegments) {
        if (
          segment.rule.deniedOperations.includes("read") &&
          !isRoleAllowed(currentRole, segment.rule.allowedRoles, config)
        ) {
          segments.push({ start: segment.start, end: segment.end })
        }
      }
    }

    return segments
  }
}
