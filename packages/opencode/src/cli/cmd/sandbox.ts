import { cmd } from "./cmd"
import { runDoctorChecks } from "../../sandbox/doctor"
import { getSandboxStatus } from "../../sandbox"
import { Instance } from "../../project/instance"

const DoctorCommand = cmd({
  command: "doctor",
  describe: "diagnose sandbox environment",
  builder: (yargs) => yargs,
  async handler() {
    const checks = await runDoctorChecks()
    console.log("Sandbox Doctor\n")
    for (const check of checks) {
      const icon = check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "–"
      const color = check.status === "pass" ? "\x1b[32m" : check.status === "fail" ? "\x1b[31m" : "\x1b[33m"
      console.log(`  ${color}${icon}\x1b[0m ${check.name}: ${check.message}`)
      if (check.fix) {
        console.log(`    Fix: ${check.fix}`)
      }
    }
    const passed = checks.filter((c) => c.status === "pass").length
    const failed = checks.filter((c) => c.status === "fail").length
    console.log(`\n${passed} passed, ${failed} failed, ${checks.length} total`)
  },
})

const StatusCommand = cmd({
  command: "status",
  describe: "show current sandbox status",
  builder: (yargs) => yargs,
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const { status, error } = getSandboxStatus()
        console.log("Sandbox Status\n")
        console.log(`  Platform:  ${process.platform}`)
        console.log(`  Status:    ${status}`)
        if (error) {
          console.log(`  Error:     ${error}`)
        }
      },
    })
  },
})

export const SandboxCommand = cmd({
  command: "sandbox",
  describe: "manage OS-native sandbox",
  builder: (yargs) => yargs.command(DoctorCommand).command(StatusCommand).demandCommand(),
  handler() {},
})
