import { minimatch } from "minimatch"
import { SecuritySchema } from "./schema"
import { SecurityConfig } from "./config"
import { SecurityAudit } from "./audit"
import { Log } from "../util/log"
import path from "path"
import fs from "fs"

export namespace SecurityAccess {
  const log = Log.create({ service: "security-access" })

  let projectRoot: string | undefined

  /**
   * Set the project root directory used to normalize absolute paths
   * to relative paths before matching against security rules/allowlist patterns.
   * Must be called during bootstrap (after Instance.directory is available).
   */
  export function setProjectRoot(root: string) {
    projectRoot = path.resolve(root)
  }

  /**
   * Normalize a file path to be relative to the project root.
   * If the path is absolute and starts with projectRoot, strips the prefix.
   * Otherwise returns the path as-is.
   */
  function normalizePath(filePath: string): string {
    if (!projectRoot) return filePath
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath)
    if (resolved.startsWith(projectRoot + "/")) {
      return resolved.slice(projectRoot.length + 1)
    }
    if (resolved === projectRoot) return ""
    return filePath
  }

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
      const normalizedPattern = normalizePath(rule.pattern).replace(/\\/g, "/")

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
   * Resolve a path, following symbolic links to get the real path.
   * Handles chains of symlinks by fully resolving to the final target.
   * Returns null if the path doesn't exist or can't be resolved.
   */
  export function resolveSymlink(filePath: string): { realPath: string; isSymlink: boolean } | null {
    const normalizedPath = filePath.replace(/\\/g, "/")

    // Check if file exists using lstat (doesn't follow symlinks)
    const lstatResult = fs.lstatSync(normalizedPath, { throwIfNoEntry: false })
    if (!lstatResult) {
      return null
    }

    const isSymlink = lstatResult.isSymbolicLink()

    if (!isSymlink) {
      return { realPath: normalizedPath, isSymlink: false }
    }

    // Resolve symlink to its real path (follows all chains)
    const realPathResult = fs.realpathSync(normalizedPath, { encoding: "utf8" })
    return { realPath: realPathResult.replace(/\\/g, "/"), isSymlink: true }
  }

  /**
   * Check if access is allowed for a given path, operation, and role.
   * Uses glob pattern matching, respects role hierarchy, and applies rule inheritance.
   *
   * Symbolic link handling:
   * - Resolves symbolic links to their targets before checking access rules
   * - If symlink target is protected, denies access to the symlink
   * - Handles chains of symlinks (resolves fully before checking)
   *
   * Inheritance rules:
   * - Child paths inherit parent directory protection rules
   * - More restrictive child rules take precedence over inherited rules
   * - Less restrictive child rules do NOT override parent restrictions
   */
  export function checkAccess(filePath: string, operation: SecuritySchema.Operation, role: string): AccessResult {
    const config = SecurityConfig.getSecurityConfig()

    // Resolve symbolic links before checking access
    const resolved = resolveSymlink(filePath)
    const pathToCheck = resolved?.realPath ?? filePath
    const isSymlink = resolved?.isSymlink ?? false

    // Normalize to relative paths for pattern matching against rules/allowlist
    const relativePathToCheck = normalizePath(pathToCheck)
    const relativeFilePath = normalizePath(filePath)

    // 1. Check deny rules first — deny always wins
    if (config.rules && config.rules.length > 0) {
      const roles = config.roles || []
      const roleLevel = getRoleLevel(role, roles)

      // If path is a symlink, check both the symlink path and the target path
      // Access is denied if either the symlink itself or its target is protected
      const pathsToCheck = isSymlink ? [relativeFilePath, relativePathToCheck] : [relativePathToCheck]

      for (const checkPath of pathsToCheck) {
        const isTargetPath = isSymlink && checkPath === relativePathToCheck && checkPath !== relativeFilePath

        // Get all applicable rules including inherited ones
        const inheritedRules = getInheritanceChain(checkPath)

        if (inheritedRules.length === 0) {
          continue
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
          const symlinkInfo = isTargetPath ? " (symlink target is protected)" : ""

          log.debug("access denied", {
            path: filePath,
            relativePath: relativeFilePath,
            operation,
            role,
            rule: rule.pattern,
            matchType,
            inheritedFrom,
            isSymlink,
            targetPath: isTargetPath ? pathToCheck : undefined,
          })

          return {
            allowed: false,
            reason: `Access denied: operation '${operation}' on '${filePath}' is restricted by rule '${rule.pattern}'${inheritanceInfo}${symlinkInfo}. Allowed roles: ${rule.allowedRoles.join(", ")}`,
          }
        }
      }
    }

    // 2. Allowlist applies to 'llm' AND 'read' operations
    // This ensures LLM tools (Read, Glob, Grep) cannot access files outside the allowlist
    if (operation !== "llm" && operation !== "read") {
      return { allowed: true }
    }

    // 3. If no allowlist configured, all files are accessible
    if (config.resolvedAllowlist.length === 0) {
      return { allowed: true }
    }

    // 4. Check file against every allowlist layer (AND across layers, OR within entries)
    // Use normalized relative path for allowlist matching
    const normalizedPath = relativePathToCheck.replace(/\\/g, "/")

    for (const layer of config.resolvedAllowlist) {
      const matched = layer.entries.some((entry) => {
        const normalizedPattern = normalizePath(entry.pattern).replace(/\\/g, "/")
        return matchPath(normalizedPath, normalizedPattern, entry.type)
      })

      if (!matched) {
        const displayPath = relativeFilePath || filePath
        const reason =
          `Access denied: file '${displayPath}' is not in the allowlist defined in '${layer.source}'. ` +
          `Add a matching entry to the allowlist, e.g.: { "pattern": "${path.dirname(displayPath).replace(/\\/g, "/")}/**", "type": "directory" }`

        log.debug("access denied by allowlist", {
          path: filePath,
          relativePath: relativeFilePath,
          operation,
          role,
          layer: layer.source,
        })

        SecurityAudit.logSecurityEvent({
          path: filePath,
          operation,
          role,
          allowed: false,
          reason: `Allowlist denial: file not matched by layer '${layer.source}'`,
        })

        return {
          allowed: false,
          reason,
        }
      }
    }

    return { allowed: true }
  }

  export interface AllowlistMatchResult {
    layer: SecuritySchema.AllowlistLayer
    matched: boolean
    matchedPattern?: string
  }

  /**
   * Check a file path against each allowlist layer and return per-layer match details.
   */
  export function checkAllowlistLayers(filePath: string): AllowlistMatchResult[] {
    const config = SecurityConfig.getSecurityConfig()
    if (config.resolvedAllowlist.length === 0) return []

    const normalizedPath = normalizePath(filePath).replace(/\\/g, "/")

    return config.resolvedAllowlist.map((layer) => {
      for (const entry of layer.entries) {
        const normalizedPattern = normalizePath(entry.pattern).replace(/\\/g, "/")
        if (matchPath(normalizedPath, normalizedPattern, entry.type)) {
          return { layer, matched: true, matchedPattern: entry.pattern }
        }
      }
      return { layer, matched: false }
    })
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
      return (
        minimatch(normalizedPath, normalizedPattern, { matchBase: true }) ||
        minimatch(normalizedPath, `${normalizedPattern}/**`, { matchBase: true })
      )
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
