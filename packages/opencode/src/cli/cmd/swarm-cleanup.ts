import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { SwarmCleanup } from "../../session/swarm-cleanup"

export const SwarmCleanupCommand = cmd({
  command: "swarm-cleanup",
  describe: "remove legacy swarm data before enabling v2 rollout",
  builder: (yargs) =>
    yargs
      .option("dry-run", {
        describe: "show what would be removed without deleting anything",
        type: "boolean",
        default: false,
      })
      .option("confirm", {
        describe: "required confirmation token for destructive cleanup",
        type: "string",
      }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const report = await SwarmCleanup.run({ dry_run: args.dryRun, confirm: args.confirm })
      console.log(JSON.stringify(report, null, 2))
      if (!report.dry_run && !report.ready) process.exitCode = 1
    })
  },
})
