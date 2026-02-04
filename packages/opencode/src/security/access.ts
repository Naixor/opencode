import { minimatch } from "minimatch"
import { SecuritySchema } from "./schema"
import { SecurityConfig } from "./config"
import { Log } from "../util/log"

export namespace SecurityAccess {
  const log = Log.create({ service: "security-access" })

  export interface AccessResult {
    allowed: boolean
    reason?: string
  }

  /**
   * Check if access is allowed for a given path, operation, and role.
   * Uses glob pattern matching and respects role hierarchy.
   */
  export function checkAccess(
    filePath: string,
    operation: SecuritySchema.Operation,
    role: string,
  ): AccessResult {
    const config = SecurityConfig.getSecurityConfig()

    if (!config.rules || config.rules.length === 0) {
      return { allowed: true }
    }

    const roles = config.roles || []
    const roleLevel = getRoleLevel(role, roles)

    // Find all matching rules for this path
    const matchingRules = config.rules.filter((rule) => matchPath(filePath, rule.pattern, rule.type))

    if (matchingRules.length === 0) {
      return { allowed: true }
    }

    // Check each matching rule
    for (const rule of matchingRules) {
      // Check if this operation is denied by this rule
      if (!rule.deniedOperations.includes(operation)) {
        continue
      }

      // Check if the user's role is allowed
      if (isRoleAllowed(role, roleLevel, rule.allowedRoles, roles)) {
        continue
      }

      log.debug("access denied", { path: filePath, operation, role, rule: rule.pattern })
      return {
        allowed: false,
        reason: `Access denied: operation '${operation}' on '${filePath}' is restricted by rule '${rule.pattern}'. Allowed roles: ${rule.allowedRoles.join(", ")}`,
      }
    }

    return { allowed: true }
  }

  /**
   * Match a file path against a glob pattern
   */
  function matchPath(filePath: string, pattern: string, type: SecuritySchema.RuleType): boolean {
    // Normalize path separators
    const normalizedPath = filePath.replace(/\\/g, "/")
    const normalizedPattern = pattern.replace(/\\/g, "/")

    // For directory rules, ensure the pattern matches directory paths
    if (type === "directory") {
      // Match the directory itself or any file within it
      const dirPattern = normalizedPattern.endsWith("/") ? normalizedPattern : `${normalizedPattern}/`

      // Check if path starts with the directory pattern (for files inside directory)
      if (normalizedPath.startsWith(dirPattern.replace(/\*+/g, ""))) {
        return true
      }

      // Also check glob match
      return minimatch(normalizedPath, normalizedPattern, { matchBase: true }) ||
        minimatch(normalizedPath, `${normalizedPattern}/**`, { matchBase: true })
    }

    // For file rules, match directly
    return minimatch(normalizedPath, normalizedPattern, { matchBase: true })
  }

  /**
   * Get the level for a given role name
   */
  function getRoleLevel(roleName: string, roles: SecuritySchema.Role[]): number {
    const role = roles.find((r) => r.name === roleName)
    return role?.level ?? 0
  }

  /**
   * Check if a role is allowed based on role hierarchy.
   * Higher level roles can access content allowed for lower levels.
   */
  function isRoleAllowed(
    roleName: string,
    roleLevel: number,
    allowedRoles: string[],
    allRoles: SecuritySchema.Role[],
  ): boolean {
    // Direct match
    if (allowedRoles.includes(roleName)) {
      return true
    }

    // Check role hierarchy - higher level roles can access lower level content
    for (const allowedRoleName of allowedRoles) {
      const allowedRoleLevel = getRoleLevel(allowedRoleName, allRoles)
      if (roleLevel > allowedRoleLevel) {
        return true
      }
    }

    return false
  }
}
