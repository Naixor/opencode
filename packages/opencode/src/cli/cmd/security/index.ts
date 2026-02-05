import { cmd } from "../cmd"
import { SecurityStatusCommand } from "./status"
import { SecurityCheckCommand } from "./check"

export const SecurityCommand = cmd({
  command: "security",
  describe: "security access control management",
  builder: (yargs) => yargs.command(SecurityStatusCommand).command(SecurityCheckCommand).demandCommand(),
  async handler() {},
})
