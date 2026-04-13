import { cmd } from "../cmd"
import { bootstrap } from "../../bootstrap"
import { runSecurityDoctor } from "../../../security/doctor"
import { Instance } from "../../../project/instance"

export const SecurityDoctorCommand = cmd({
  command: "doctor",
  describe: "diagnose security configuration only",
  handler: async () => {
    await bootstrap(process.cwd(), async () => {
      const diagnostics = await runSecurityDoctor(Instance.directory)

      console.log("Security Doctor\n")

      if (diagnostics.length === 0) {
        console.log("  No issues found.")
        return
      }

      const errors = diagnostics.filter((d) => d.level === "error")
      const warnings = diagnostics.filter((d) => d.level === "warn")
      const infos = diagnostics.filter((d) => d.level === "info")

      const levelIcon = { error: "✗", warn: "⚠", info: "ℹ" } as const
      const levelColor = { error: "\x1b[31m", warn: "\x1b[33m", info: "\x1b[36m" } as const
      const reset = "\x1b[0m"

      // Group by category
      const categories = new Map<string, typeof diagnostics>()
      for (const d of diagnostics) {
        const list = categories.get(d.category) ?? []
        list.push(d)
        categories.set(d.category, list)
      }

      for (const [category, items] of categories) {
        console.log(`  [${category}]`)
        for (const d of items) {
          const icon = levelIcon[d.level]
          const color = levelColor[d.level]
          console.log(`    ${color}${icon}${reset} ${d.message}`)
          if (d.fix) {
            console.log(`      Fix: ${d.fix}`)
          }
        }
        console.log()
      }

      console.log(`${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} info`)
    })
  },
})
