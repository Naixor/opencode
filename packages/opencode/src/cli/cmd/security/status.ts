import { cmd } from "../cmd"
import { bootstrap } from "../../bootstrap"
import { SecurityConfig } from "../../../security/config"
import { SecuritySchema } from "../../../security/schema"

export const SecurityStatusCommand = cmd({
  command: "status",
  describe: "show current security status",
  handler: async () => {
    await bootstrap(process.cwd(), async () => {
      const config = SecurityConfig.getSecurityConfig()
      const hasRules = (config.rules?.length ?? 0) > 0
      const hasSegments = (config.segments?.markers?.length ?? 0) > 0 || (config.segments?.ast?.length ?? 0) > 0

      if (!hasRules && !hasSegments) {
        console.log("Security: inactive (no rules configured)")
        return
      }

      console.log("=== Security Status ===\n")

      // Role info
      const roles = config.roles ?? []
      const defaultRole =
        roles.length > 0 ? roles.reduce((min, r) => (r.level < min.level ? r : min), roles[0]) : undefined
      console.log("Role:")
      if (roles.length === 0) {
        console.log("  No roles defined")
      }
      for (const role of roles) {
        console.log(`  ${role.name} (level ${role.level})`)
      }
      if (defaultRole) {
        console.log(`  Current: ${defaultRole.name} (default - lowest level)`)
      }
      console.log()

      // Rules count by type
      const rules = config.rules ?? []
      const directoryRules = rules.filter((r) => r.type === "directory")
      const fileRules = rules.filter((r) => r.type === "file")

      console.log("Rules:")
      console.log(`  Total:     ${rules.length}`)
      console.log(`  Directory: ${directoryRules.length}`)
      console.log(`  File:      ${fileRules.length}`)
      console.log()

      // Segments
      const markerCount = config.segments?.markers?.length ?? 0
      const astCount = config.segments?.ast?.length ?? 0
      if (markerCount > 0 || astCount > 0) {
        console.log("Segments:")
        if (markerCount > 0) console.log(`  Marker rules: ${markerCount}`)
        if (astCount > 0) console.log(`  AST rules:    ${astCount}`)
        console.log()
      }

      // MCP policies
      if (config.mcp) {
        console.log("MCP:")
        console.log(`  Default policy: ${config.mcp.defaultPolicy}`)
        const serverEntries = Object.entries(config.mcp.servers)
        if (serverEntries.length > 0) {
          for (const [name, policy] of serverEntries) {
            console.log(`  ${name}: ${policy}`)
          }
        }
        console.log()
      }

      // Config files
      const configs = await SecurityConfig.findSecurityConfigs(process.cwd())
      console.log("Config files:")
      if (configs.length === 0) {
        console.log("  None found")
      }
      for (const entry of configs) {
        const ruleCount = entry.config.rules?.length ?? 0
        console.log(`  ${entry.path} (${ruleCount} rules)`)
      }
    })
  },
})
