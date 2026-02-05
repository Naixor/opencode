import { SecuritySchema } from "./schema"
import { Log } from "../util/log"
import path from "path"

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
    configLoaded = true
    return currentConfig
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
