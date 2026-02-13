import { cmd } from "../cmd"
import { PluginAudit } from "../../../plugin/audit"
import path from "path"

export const PluginAuditCommand = cmd({
  command: "audit <target>",
  describe: "scan a plugin for dangerous API usage patterns",
  builder: (yargs) =>
    yargs.positional("target", {
      type: "string",
      describe: "plugin package name or installed plugin directory path",
      demandOption: true,
    }),
  handler: async (args) => {
    const target = path.resolve(process.cwd(), args.target as string)
    const result = await PluginAudit.audit(target)
    console.log(PluginAudit.format(result))
    process.exit(result.hasCritical ? 1 : 0)
  },
})
