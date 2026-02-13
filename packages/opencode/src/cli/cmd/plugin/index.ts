import { cmd } from "../cmd"
import { PluginAuditCommand } from "./audit"

export const PluginCommand = cmd({
  command: "plugin",
  describe: "plugin management commands",
  builder: (yargs) => yargs.command(PluginAuditCommand).demandCommand(),
  async handler() {},
})
