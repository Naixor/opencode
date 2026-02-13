import { Config } from "../config/config"
import { Log } from "../util/log"
import { SecurityConfig } from "../security/config"

export namespace BuiltinMcp {
  const log = Log.create({ service: "mcp.builtin" })

  export interface BuiltinServerDef {
    readonly name: string
    readonly description: string
    readonly envVar: string
    readonly config: (apiKey: string) => Config.Mcp
  }

  const BUILTIN_SERVERS: readonly BuiltinServerDef[] = [
    {
      name: "websearch",
      description: "Web search via Exa API",
      envVar: "EXA_API_KEY",
      config: (apiKey) => ({
        type: "remote" as const,
        url: "https://mcp.exa.ai/mcp",
        headers: {
          "x-api-key": apiKey,
        },
        oauth: false as const,
      }),
    },
    {
      name: "context7",
      description: "Documentation search via Context7",
      envVar: "CONTEXT7_API_KEY",
      config: (apiKey) => ({
        type: "remote" as const,
        url: "https://mcp.context7.com/mcp",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        oauth: false as const,
      }),
    },
    {
      name: "grep_app",
      description: "GitHub code search via grep.app",
      envVar: "GREP_APP_API_KEY",
      config: (apiKey) => ({
        type: "remote" as const,
        url: "https://mcp.grep.app/mcp",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        oauth: false as const,
      }),
    },
  ] as const

  /**
   * Resolve built-in MCP server configurations.
   *
   * Returns MCP configs for servers where:
   * 1. The API key is available (env var or opencode.jsonc)
   * 2. The server is not in `disabled_mcps`
   * 3. The server is not blocked by MCP security policy
   * 4. The server is not already configured by the user
   */
  export function resolve(
    existingMcp: Record<string, Config.Mcp | { enabled: boolean }> | undefined,
    disabledMcps: string[],
    apiKeys?: Record<string, string>,
  ): Record<string, Config.Mcp> {
    const result: Record<string, Config.Mcp> = {}
    const disabledSet = new Set(disabledMcps)

    for (const server of BUILTIN_SERVERS) {
      // Skip if already configured by user
      if (existingMcp?.[server.name]) {
        log.debug("built-in MCP server already configured by user", { name: server.name })
        continue
      }

      // Skip if in disabled_mcps list
      if (disabledSet.has(server.name)) {
        log.debug("built-in MCP server disabled via disabled_mcps", { name: server.name })
        continue
      }

      // Skip if blocked by MCP security policy
      const policy = SecurityConfig.getMcpPolicy(server.name)
      if (policy === "blocked") {
        log.debug("built-in MCP server blocked by security policy", { name: server.name })
        continue
      }

      // Check for API key: explicit apiKeys param > env var
      const apiKey = apiKeys?.[server.envVar] ?? process.env[server.envVar]
      if (!apiKey) {
        log.debug("built-in MCP server skipped: no API key", { name: server.name, envVar: server.envVar })
        continue
      }

      result[server.name] = server.config(apiKey)
      log.info("built-in MCP server auto-enabled", { name: server.name })
    }

    return result
  }

  /**
   * Get the env var name required for a built-in MCP server.
   * Returns undefined if the server is not a built-in.
   */
  export function getRequiredEnvVar(name: string): string | undefined {
    const server = BUILTIN_SERVERS.find((s) => s.name === name)
    return server?.envVar
  }

  /**
   * Check if a server name is a built-in MCP server.
   */
  export function isBuiltin(name: string): boolean {
    return BUILTIN_SERVERS.some((s) => s.name === name)
  }

  /**
   * Get all built-in server definitions (for testing/introspection).
   */
  export function definitions(): readonly BuiltinServerDef[] {
    return BUILTIN_SERVERS
  }

  /**
   * Get a message for when an agent tries to use a disabled/unconfigured built-in MCP.
   */
  export function getDisabledMessage(name: string): string | undefined {
    const server = BUILTIN_SERVERS.find((s) => s.name === name)
    if (!server) return undefined

    return `Built-in MCP server '${name}' (${server.description}) is not enabled. Set the ${server.envVar} environment variable to enable it.`
  }
}
