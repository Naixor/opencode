import os from "os"
import path from "path"
import { SecuritySchema } from "./schema"
import { SecurityToken } from "./token"
import { Log } from "../util/log"

export namespace SecurityRole {
  const log = Log.create({ service: "security-role" })

  const TOKEN_FILE_NAME = ".opencode-role.token"
  const GLOBAL_TOKEN_PATH = path.join(".config", "opencode", "role.token")

  let cachedRole: string | undefined
  let cacheInitialized = false

  /**
   * Get the current user's security role for the given project.
   *
   * Token lookup order:
   * 1. `.opencode-role.token` in projectRoot
   * 2. `~/.config/opencode/role.token` in user home
   *
   * Falls back to the lowest-level role defined in config if no valid token is found.
   * Result is cached for the session lifetime.
   */
  export function getCurrentRole(projectRoot: string, config: SecuritySchema.SecurityConfig): string {
    if (cacheInitialized) {
      return cachedRole!
    }

    const role = detectRole(projectRoot, config)
    cachedRole = role
    cacheInitialized = true
    return role
  }

  /**
   * Reset the cached role. Useful for testing or when config changes.
   */
  export function resetCache(): void {
    cachedRole = undefined
    cacheInitialized = false
  }

  function detectRole(projectRoot: string, config: SecuritySchema.SecurityConfig): string {
    const publicKey = config.authentication?.publicKey
    if (!publicKey) {
      log.debug("no public key configured, using default role")
      return getLowestRole(config)
    }

    const revokedTokens = config.authentication?.revokedTokens ?? []

    // Try project-local token first
    const localTokenPath = path.join(projectRoot, TOKEN_FILE_NAME)
    const localResult = SecurityToken.verifyRoleToken(localTokenPath, publicKey, revokedTokens)
    if (localResult.valid && localResult.role) {
      const roleName = localResult.role
      if (isKnownRole(roleName, config)) {
        log.info("role detected from local token", { role: roleName, path: localTokenPath })
        return roleName
      }
      log.warn("token contains unknown role, falling back to default", { role: roleName })
    }

    // Try global token
    const globalTokenPath = path.join(os.homedir(), GLOBAL_TOKEN_PATH)
    const globalResult = SecurityToken.verifyRoleToken(globalTokenPath, publicKey, revokedTokens)
    if (globalResult.valid && globalResult.role) {
      const roleName = globalResult.role
      if (isKnownRole(roleName, config)) {
        log.info("role detected from global token", { role: roleName, path: globalTokenPath })
        return roleName
      }
      log.warn("global token contains unknown role, falling back to default", { role: roleName })
    }

    log.debug("no valid token found, using lowest role", {
      localError: localResult.error,
      globalError: globalResult.error,
    })
    return getLowestRole(config)
  }

  function isKnownRole(roleName: string, config: SecuritySchema.SecurityConfig): boolean {
    const roles = config.roles ?? []
    return roles.some((r) => r.name === roleName)
  }

  function getLowestRole(config: SecuritySchema.SecurityConfig): string {
    const roles = config.roles ?? []
    if (roles.length === 0) {
      return "viewer"
    }
    const lowestRole = roles.reduce((prev, curr) => (curr.level < prev.level ? curr : prev), roles[0])
    return lowestRole.name
  }
}
