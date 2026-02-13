import { SecuritySchema } from "./schema"
import { Log } from "../util/log"
import path from "path"
import fs from "fs"

export namespace SecurityConfig {
  const log = Log.create({ service: "security-config" })

  const SECURITY_CONFIG_FILE = ".opencode-security.json"

  const emptyConfig: SecuritySchema.SecurityConfig = {
    version: "1.0",
    roles: [],
    rules: [],
  }

  let currentConfig: SecuritySchema.SecurityConfig = emptyConfig
  let configLoaded = false

  export async function loadSecurityConfig(projectRoot: string): Promise<SecuritySchema.SecurityConfig> {
    const configPath = path.join(projectRoot, SECURITY_CONFIG_FILE)

    const file = Bun.file(configPath)
    const exists = await file.exists()

    if (!exists) {
      log.debug("security config not found, using empty config", { path: configPath })
      currentConfig = emptyConfig
      configLoaded = true
      return currentConfig
    }

    const text = await file.text().catch((err) => {
      log.warn("failed to read security config file", { path: configPath, error: err })
      return undefined
    })

    if (!text) {
      currentConfig = emptyConfig
      configLoaded = true
      return currentConfig
    }

    const parsed = await Promise.resolve()
      .then(() => JSON.parse(text))
      .catch((err) => {
        log.warn("security config is not valid JSON", { path: configPath, error: err })
        return undefined
      })

    if (!parsed) {
      currentConfig = emptyConfig
      configLoaded = true
      return currentConfig
    }

    const validated = SecuritySchema.securityConfigSchema.safeParse(parsed)

    if (!validated.success) {
      log.warn("malformed security config, using empty config", {
        path: configPath,
        issues: validated.error.issues,
      })
      currentConfig = emptyConfig
      configLoaded = true
      return currentConfig
    }

    log.info("security config loaded", { path: configPath })
    currentConfig = validated.data
    appendImplicitRules(currentConfig)
    configLoaded = true
    return currentConfig
  }

  /**
   * Load a single config file from a given path.
   * Returns undefined if file doesn't exist or is invalid.
   */
  async function loadConfigFile(configPath: string): Promise<SecuritySchema.SecurityConfig | undefined> {
    const file = Bun.file(configPath)
    const exists = await file.exists()
    if (!exists) return undefined

    const text = await file.text().catch((err) => {
      log.warn("failed to read security config file", { path: configPath, error: err })
      return undefined
    })
    if (!text) return undefined

    const parsed = await Promise.resolve()
      .then(() => JSON.parse(text))
      .catch((err) => {
        log.warn("security config is not valid JSON", { path: configPath, error: err })
        return undefined
      })
    if (!parsed) return undefined

    const validated = SecuritySchema.securityConfigSchema.safeParse(parsed)
    if (!validated.success) {
      log.warn("malformed security config, skipping", { path: configPath, issues: validated.error.issues })
      return undefined
    }

    return validated.data
  }

  /**
   * Find the git root directory by walking up from startPath looking for .git.
   */
  function findGitRoot(startPath: string): string | undefined {
    let current = path.resolve(startPath)
    const root = path.parse(current).root

    while (current !== root) {
      const gitPath = path.join(current, ".git")
      const stat = fs.statSync(gitPath, { throwIfNoEntry: false })
      if (stat) return current
      current = path.dirname(current)
    }

    return undefined
  }

  /**
   * Walk up from startPath to the git root, collecting all `.opencode-security.json` files.
   * Returns configs ordered from most specific (startPath) to least specific (git root).
   */
  export async function findSecurityConfigs(
    startPath: string,
  ): Promise<{ config: SecuritySchema.SecurityConfig; path: string }[]> {
    const resolved = path.resolve(startPath)
    const gitRoot = findGitRoot(resolved)

    if (!gitRoot) {
      log.debug("no git root found, checking startPath only", { startPath: resolved })
      const configPath = path.join(resolved, SECURITY_CONFIG_FILE)
      const config = await loadConfigFile(configPath)
      if (!config) return []
      return [{ config, path: configPath }]
    }

    const configs: { config: SecuritySchema.SecurityConfig; path: string }[] = []
    let current = resolved

    while (true) {
      const configPath = path.join(current, SECURITY_CONFIG_FILE)
      const config = await loadConfigFile(configPath)
      if (config) {
        configs.push({ config, path: configPath })
      }

      if (current === gitRoot) break
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }

    return configs
  }

  const MCP_POLICY_PRIORITY: Record<SecuritySchema.McpPolicy, number> = {
    blocked: 3,
    enforced: 2,
    trusted: 1,
  }

  /**
   * Get the most restrictive MCP policy between two policies.
   * Priority: blocked > enforced > trusted
   */
  function mostRestrictiveMcpPolicy(
    a: SecuritySchema.McpPolicy,
    b: SecuritySchema.McpPolicy,
  ): SecuritySchema.McpPolicy {
    return MCP_POLICY_PRIORITY[a] >= MCP_POLICY_PRIORITY[b] ? a : b
  }

  /**
   * Merge multiple security configs into a single config.
   * - Rules are unioned (more configs = more restrictions)
   * - Role definitions must be identical across configs (throws error if conflict)
   * - MCP policies use most restrictive (blocked > enforced > trusted)
   * - Segments (markers and AST) are unioned
   * - Logging uses the first defined config's logging settings
   * - Authentication uses the first defined config's authentication settings
   */
  export function mergeSecurityConfigs(configs: SecuritySchema.SecurityConfig[]): SecuritySchema.SecurityConfig {
    if (configs.length === 0) return emptyConfig
    if (configs.length === 1) return configs[0]

    // Validate role definitions are identical across configs
    const roleMap = new Map<string, number>()
    for (const config of configs) {
      for (const role of config.roles ?? []) {
        const existing = roleMap.get(role.name)
        if (existing !== undefined && existing !== role.level) {
          throw new Error(
            `Role conflict: role '${role.name}' has level ${existing} in one config but level ${role.level} in another`,
          )
        }
        roleMap.set(role.name, role.level)
      }
    }

    // Union all roles (deduplicated by name since we verified no conflicts)
    const mergedRoles: SecuritySchema.Role[] = [...roleMap.entries()].map(([name, level]) => ({ name, level }))

    // Union all rules
    const mergedRules: SecuritySchema.Rule[] = configs.flatMap((c) => c.rules ?? [])

    // Union segment markers
    const mergedMarkers: SecuritySchema.MarkerConfig[] = configs.flatMap((c) => c.segments?.markers ?? [])

    // Union AST configs
    const mergedAST: SecuritySchema.ASTConfig[] = configs.flatMap((c) => c.segments?.ast ?? [])

    const mergedSegments =
      mergedMarkers.length > 0 || mergedAST.length > 0
        ? {
            ...(mergedMarkers.length > 0 ? { markers: mergedMarkers } : {}),
            ...(mergedAST.length > 0 ? { ast: mergedAST } : {}),
          }
        : undefined

    // First defined logging wins
    const mergedLogging = configs.find((c) => c.logging)?.logging

    // First defined authentication wins
    const mergedAuthentication = configs.find((c) => c.authentication)?.authentication

    // Merge MCP policies: most restrictive wins
    const mcpConfigs = configs.filter((c) => c.mcp)
    const mergedMcp =
      mcpConfigs.length > 0
        ? (() => {
            let defaultPolicy: SecuritySchema.McpPolicy = "trusted"
            const servers: Record<string, SecuritySchema.McpPolicy> = {}

            for (const config of mcpConfigs) {
              if (!config.mcp) continue
              defaultPolicy = mostRestrictiveMcpPolicy(defaultPolicy, config.mcp.defaultPolicy)
              for (const [serverName, policy] of Object.entries(config.mcp.servers)) {
                const existing = servers[serverName]
                servers[serverName] = existing ? mostRestrictiveMcpPolicy(existing, policy) : policy
              }
            }

            return { defaultPolicy, servers }
          })()
        : undefined

    const result: SecuritySchema.SecurityConfig = {
      version: configs[0].version,
      roles: mergedRoles.length > 0 ? mergedRoles : undefined,
      rules: mergedRules.length > 0 ? mergedRules : undefined,
      segments: mergedSegments,
      logging: mergedLogging,
      authentication: mergedAuthentication,
      mcp: mergedMcp,
    }
    appendImplicitRules(result)
    return result
  }

  export function getSecurityConfig(): SecuritySchema.SecurityConfig {
    if (!configLoaded) {
      log.warn("getSecurityConfig called before config was loaded, returning empty config")
      return emptyConfig
    }
    return currentConfig
  }

  export function resetConfig(): void {
    currentConfig = emptyConfig
    configLoaded = false
  }

  function appendImplicitRules(config: SecuritySchema.SecurityConfig): void {
    const protectedFiles = [".opencode-security.json", ".opencode-security-audit.log"]
    if (!config.rules) config.rules = []
    for (const file of protectedFiles) {
      const exists = config.rules.some((r) => r.pattern === file)
      if (exists) continue
      config.rules.push({
        pattern: file,
        type: "file",
        deniedOperations: ["write"],
        allowedRoles: [],
      })
    }
  }

  export function getMcpPolicy(serverName: string): "enforced" | "trusted" | "blocked" {
    const config = getSecurityConfig()
    if (config.mcp) {
      const serverPolicy = config.mcp.servers?.[serverName]
      if (serverPolicy) return serverPolicy
      return config.mcp.defaultPolicy ?? "trusted"
    }
    const hasRules = (config.rules?.length ?? 0) > 0 || config.segments !== undefined
    if (hasRules) return "enforced"
    return "trusted"
  }
}
