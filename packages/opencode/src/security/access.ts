import { minimatch } from "minimatch"
import { SecuritySchema } from "./schema"
import { SecurityConfig } from "./config"
import { Log } from "../util/log"
import path from "path"

export namespace SecurityAccess {
  const log = Log.create({ service: "security-access" })

  export interface AccessResult {
    allowed: boolean
    reason?: string
  }

  export interface InheritedRule {
    rule: SecuritySchema.Rule
    matchType: "direct" | "inherited"
    inheritedFrom?: string
  }

  /**
   * Get the inheritance chain of applicable rules for a path.
   * Returns rules that apply directly or are inherited from parent directories.
   */
  export function getInheritanceChain(filePath: string): InheritedRule[] {
    const config = SecurityConfig.getSecurityConfig()

    if (!config.rules || config.rules.length === 0) {
      return []
    }

    const inheritedRules: InheritedRule[] = []
    const normalizedPath = filePath.replace(/\\/g, "/")

    // Get all parent paths from root to the file
    const parentPaths = getParentPaths(normalizedPath)

    // Check each rule against all parent paths and the file itself
    for (const rule of config.rules) {
      const normalizedPattern = rule.pattern.replace(/\\/g, "/")

      // Check for direct match on the file path
      if (matchPath(normalizedPath, normalizedPattern, rule.type)) {
        inheritedRules.push({
          rule,
          matchType: "direct",
        })
        continue
      }

      // Check for inherited match from parent directories (directory rules only)
      if (rule.type === "directory") {
        for (const parentPath of parentPaths) {
          if (matchDirectoryPattern(parentPath, normalizedPattern)) {
            inheritedRules.push({
              rule,
              matchType: "inherited",
              inheritedFrom: parentPath,
            })
            break // Only add once per rule
          }
        }
      }
    }

    return inheritedRules
  }

  /**
   * Check if access is allowed for a given path, operation, and role.
   * Uses glob pattern matching, respects role hierarchy, and applies rule inheritance.
   *
   * Inheritance rules:
   * - Child paths inherit parent directory protection rules
   * - More restrictive child rules take precedence over inherited rules
   * - Less restrictive child rules do NOT override parent restrictions
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

    // Get all applicable rules including inherited ones
    const inheritedRules = getInheritanceChain(filePath)

    if (inheritedRules.length === 0) {
      return { allowed: true }
    }

    // Check each applicable rule (both direct and inherited)
    // Parent restrictions cannot be overridden by child rules, so we check all
    for (const { rule, matchType, inheritedFrom } of inheritedRules) {
      // Check if this operation is denied by this rule
      if (!rule.deniedOperations.includes(operation)) {
        continue
      }

      // Check if the user's role is allowed
      if (isRoleAllowed(role, roleLevel, rule.allowedRoles, roles)) {
        continue
      }

      const inheritanceInfo = matchType === "inherited" ? ` (inherited from '${inheritedFrom}')` : ""
      log.debug("access denied", { path: filePath, operation, role, rule: rule.pattern, matchType, inheritedFrom })
      return {
        allowed: false,
        reason: `Access denied: operation '${operation}' on '${filePath}' is restricted by rule '${rule.pattern}'${inheritanceInfo}. Allowed roles: ${rule.allowedRoles.join(", ")}`,
      }
    }

    return { allowed: true }
  }

  /**
   * Get all parent directory paths from root to the given path
   */
  function getParentPaths(filePath: string): string[] {
    const parts = filePath.split("/").filter(Boolean)
    const parents: string[] = []

    let current = ""
    for (let i = 0; i < parts.length - 1; i++) {
      current = current + "/" + parts[i]
      parents.push(current)
    }

    return parents
  }

  /**
   * Check if a path matches a directory pattern (for inheritance checking)
   */
  function matchDirectoryPattern(dirPath: string, pattern: string): boolean {
    // Normalize both paths
    const normalizedDir = dirPath.endsWith("/") ? dirPath.slice(0, -1) : dirPath
    const normalizedPattern = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern

    // Direct match
    if (normalizedDir === normalizedPattern) {
      return true
    }

    // Glob match
    return minimatch(normalizedDir, normalizedPattern, { matchBase: true })
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
