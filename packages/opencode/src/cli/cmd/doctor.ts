import { bootstrap } from "../bootstrap"
import { cmd } from "./cmd"
import { doctorCount, runDoctor } from "../../doctor"
import { Instance } from "../../project/instance"

const icon = {
  error: "✗",
  warn: "⚠",
  info: "ℹ",
} as const

const color = {
  error: "\x1b[31m",
  warn: "\x1b[33m",
  info: "\x1b[36m",
} as const

export const DoctorCommand = cmd({
  command: "doctor",
  describe: "run combined sandbox and security diagnostics",
  handler: async () => {
    await bootstrap(process.cwd(), async () => {
      const list = await runDoctor(Instance.directory)
      const count = doctorCount(list)
      const reset = "\x1b[0m"

      console.log("Doctor\n")

      for (const item of list) {
        console.log(`  [${item.source}] ${color[item.level]}${icon[item.level]}${reset} ${item.message}`)
        if (item.fix) {
          console.log(`    Fix: ${item.fix}`)
        }
      }

      console.log(`\n${count.error} error(s), ${count.warn} warning(s), ${count.info} info`)
      if (count.error > 0) {
        process.exitCode = 1
      }
    })
  },
})
