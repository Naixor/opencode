import { cmd } from "../cmd"
import { SecurityStatusCommand } from "./status"
import { SecurityCheckCommand } from "./check"
import { SecurityInitCommand } from "./init"
import { SecurityLogsCommand } from "./logs"
import { SecurityInitKeysCommand } from "./init-keys"
import { SecurityIssueTokenCommand } from "./issue-token"

export const SecurityCommand = cmd({
  command: "security",
  describe: "security access control management",
  builder: (yargs) =>
    yargs
      .command(SecurityStatusCommand)
      .command(SecurityCheckCommand)
      .command(SecurityInitCommand)
      .command(SecurityLogsCommand)
      .command(SecurityInitKeysCommand)
      .command(SecurityIssueTokenCommand)
      .demandCommand(),
  async handler() {},
})
