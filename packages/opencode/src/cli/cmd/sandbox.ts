import { cmd } from "./cmd"
import { runDoctorChecks } from "../../sandbox/doctor"
import { getActiveSandbox, getSandboxStatus } from "../../sandbox"
import { Instance } from "../../project/instance"
import { initSandbox } from "../../sandbox/init"
import { SecurityConfig } from "../../security/config"
import { SecurityAccess } from "../../security/access"

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
        // Load security config and initialize sandbox (same as InstanceBootstrap)
        SecurityAccess.setProjectRoot(Instance.directory)
        await SecurityConfig.loadSecurityConfig(Instance.directory)
        await initSandbox()

        const { status, error } = getSandboxStatus()
        console.log("Sandbox Status\n")
        console.log(`  Platform:  ${process.platform}`)
        console.log(`  Status:    ${status}`)
        if (error) {
          console.log(`  Error:     ${error}`)
        }

        // Show generated profile if sandbox is active
        if (status === "active") {
          const sandbox = getActiveSandbox() as { getPolicyPath?: () => string | null } | null
          const policyPath = sandbox?.getPolicyPath?.()
          if (policyPath) {
            const profile = await Bun.file(policyPath).text()
            console.log(`  Policy:    ${policyPath}`)
            console.log(`\nSBPL Profile:\n`)
            console.log(profile)
          }
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
