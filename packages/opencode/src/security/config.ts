import { SecuritySchema } from "./schema"
import { Log } from "../util/log"
import path from "path"
import fs from "fs"

export namespace SecurityConfig {
  const log = Log.create({ service: "security-config" })

  const SECURITY_CONFIG_FILE = ".opencode-security.json"

  const emptyConfig: SecuritySchema.ResolvedSecurityConfig = {
    version: "1.0",
    roles: [],
    rules: [],
    resolvedAllowlist: [],
  }

  let currentConfig: SecuritySchema.ResolvedSecurityConfig = emptyConfig
  let configLoaded = false

  export async function loadSecurityConfig(projectRoot: string): Promise<SecuritySchema.ResolvedSecurityConfig> {
    const configs = await findSecurityConfigs(projectRoot)

    if (configs.length === 0) {
      log.debug("no security configs found, using empty config", { projectRoot })
      currentConfig = emptyConfig
      configLoaded = true
      return currentConfig
    }

    log.info("security configs loaded", {
      count: configs.length,
      paths: configs.map((c) => c.path),
    })

    currentConfig = mergeSecurityConfigs(configs)
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
  export function mergeSecurityConfigs(
    configs: { config: SecuritySchema.SecurityConfig; path: string }[],
  ): SecuritySchema.ResolvedSecurityConfig {
    if (configs.length === 0) return emptyConfig
    if (configs.length === 1) {
      const entry = configs[0]
      const resolvedAllowlist: SecuritySchema.AllowlistLayer[] = entry.config.allowlist
        ? [{ source: entry.path, entries: entry.config.allowlist }]
        : []
      if (entry.config.allowlist && entry.config.allowlist.length === 0) {
        log.warn(
          "Empty allowlist configured — all LLM operations will be denied. No files are accessible to the LLM.",
        )
      }
      return { ...entry.config, resolvedAllowlist }
    }

    // Validate role definitions are identical across configs
    const roleMap = new Map<string, number>()
    for (const { config } of configs) {
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
    const mergedRules: SecuritySchema.Rule[] = configs.flatMap((c) => c.config.rules ?? [])

    // Union segment markers
    const mergedMarkers: SecuritySchema.MarkerConfig[] = configs.flatMap((c) => c.config.segments?.markers ?? [])

    // Union AST configs
    const mergedAST: SecuritySchema.ASTConfig[] = configs.flatMap((c) => c.config.segments?.ast ?? [])

    const mergedSegments =
      mergedMarkers.length > 0 || mergedAST.length > 0
        ? {
            ...(mergedMarkers.length > 0 ? { markers: mergedMarkers } : {}),
            ...(mergedAST.length > 0 ? { ast: mergedAST } : {}),
          }
        : undefined

    // First defined logging wins
    const mergedLogging = configs.find((c) => c.config.logging)?.config.logging

    // First defined authentication wins
    const mergedAuthentication = configs.find((c) => c.config.authentication)?.config.authentication

    // Merge MCP policies: most restrictive wins
    const mcpConfigs = configs.filter((c) => c.config.mcp)
    const mergedMcp =
      mcpConfigs.length > 0
        ? (() => {
            let defaultPolicy: SecuritySchema.McpPolicy = "trusted"
            const servers: Record<string, SecuritySchema.McpPolicy> = {}

            for (const entry of mcpConfigs) {
              if (!entry.config.mcp) continue
              defaultPolicy = mostRestrictiveMcpPolicy(defaultPolicy, entry.config.mcp.defaultPolicy)
              for (const [serverName, policy] of Object.entries(entry.config.mcp.servers)) {
                const existing = servers[serverName]
                servers[serverName] = existing ? mostRestrictiveMcpPolicy(existing, policy) : policy
              }
            }

            return { defaultPolicy, servers }
          })()
        : undefined

    // Build allowlist layers — one per config that defines an allowlist
    const resolvedAllowlist: SecuritySchema.AllowlistLayer[] = configs
      .filter((c) => c.config.allowlist !== undefined)
      .map((c) => ({ source: c.path, entries: c.config.allowlist! }))

    const hasEmptyAllowlist = configs.some((c) => c.config.allowlist && c.config.allowlist.length === 0)
    if (hasEmptyAllowlist) {
      log.warn("Empty allowlist configured — all LLM operations will be denied. No files are accessible to the LLM.")
    }

    return {
      version: configs[0].config.version,
      roles: mergedRoles.length > 0 ? mergedRoles : undefined,
      rules: mergedRules.length > 0 ? mergedRules : undefined,
      segments: mergedSegments,
      logging: mergedLogging,
      authentication: mergedAuthentication,
      mcp: mergedMcp,
      resolvedAllowlist,
    }
  }

  export function getSecurityConfig(): SecuritySchema.ResolvedSecurityConfig {
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

  /**
   * Get the MCP security policy for a given server name.
   * Returns the server-specific policy if configured, otherwise the default policy.
   * If no MCP config exists, returns "trusted" (no restrictions).
   */
  export function getMcpPolicy(serverName: string): "enforced" | "trusted" | "blocked" {
    const config = getSecurityConfig()
    if (!config.mcp) {
      return "trusted"
    }

    const serverPolicy = config.mcp.servers?.[serverName]
    if (serverPolicy) {
      return serverPolicy
    }

    return config.mcp.defaultPolicy ?? "trusted"
  }
}
