import { cmd } from "../cmd"
import { SecurityStatusCommand } from "./status"

export const SecurityCommand = cmd({
  command: "security",
  describe: "security access control management",
  builder: (yargs) => yargs.command(SecurityStatusCommand).demandCommand(),
  async handler() {},
})
