import { cmd } from "../cmd"
import { bootstrap } from "../../bootstrap"
import { SecurityConfig } from "../../../security/config"
import { SecurityAccess } from "../../../security/access"
import path from "path"

export const SecurityCheckCommand = cmd({
  command: "check <path>",
  describe: "check if a specific path is accessible",
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      describe: "path to check accessibility for",
      demandOption: true,
    }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const config = SecurityConfig.getSecurityConfig()
      const hasRules = (config.rules?.length ?? 0) > 0

      if (!hasRules) {
        console.log("Security: inactive (no rules configured)")
        return
      }

      const targetPath = path.resolve(process.cwd(), args.path as string)

      console.log(`=== Security Check: ${targetPath} ===\n`)

      // Symlink resolution
      const resolved = SecurityAccess.resolveSymlink(targetPath)
      if (resolved?.isSymlink) {
        console.log("Symlink:")
        console.log(`  Link:   ${targetPath}`)
        console.log(`  Target: ${resolved.realPath}`)
        console.log()
      }

      // Determine current role (lowest level, same as status command)
      const roles = config.roles ?? []
      const currentRole =
        roles.length > 0 ? roles.reduce((min, r) => (r.level < min.level ? r : min), roles[0]).name : "default"

      console.log(`Current role: ${currentRole}\n`)

      // Check each operation type
      const operations: Array<"read" | "write" | "llm"> = ["read", "write", "llm"]

      console.log("Access results:")
      for (const op of operations) {
        const result = SecurityAccess.checkAccess(targetPath, op, currentRole)
        const status = result.allowed ? "ALLOWED" : "DENIED"
        const reason = result.reason ? ` - ${result.reason}` : ""
        console.log(`  ${op.padEnd(5)}: ${status}${reason}`)
      }
      console.log()

      // Inheritance chain
      const chain = SecurityAccess.getInheritanceChain(targetPath)

      // If path is a symlink, also get inheritance chain for the target
      const targetChain = resolved?.isSymlink ? SecurityAccess.getInheritanceChain(resolved.realPath) : []

      const allRules = [...chain, ...targetChain]

      if (allRules.length === 0) {
        console.log("Inheritance chain: no rules apply to this path")
        return
      }

      console.log("Inheritance chain:")
      for (const entry of allRules) {
        const source = entry.matchType === "inherited" ? `inherited from '${entry.inheritedFrom}'` : "direct match"
        const ops = entry.rule.deniedOperations.join(", ")
        const allowed = entry.rule.allowedRoles.join(", ")
        console.log(`  Pattern: ${entry.rule.pattern}`)
        console.log(`    Type:              ${entry.rule.type}`)
        console.log(`    Match:             ${source}`)
        console.log(`    Denied operations: ${ops}`)
        console.log(`    Allowed roles:     ${allowed}`)
      }
    })
  },
})
