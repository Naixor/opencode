import { cmd } from "./cmd"
import { runDoctorChecks } from "../../sandbox/doctor"
import { getActiveSandbox, getSandboxStatus } from "../../sandbox"
import { Instance } from "../../project/instance"
import { initSandbox, refreshSandboxPolicy } from "../../sandbox/init"
import { SecurityConfig } from "../../security/config"
import { SecurityAccess } from "../../security/access"

const DoctorCommand = cmd({
  command: "doctor",
  describe: "diagnose sandbox environment only",
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

export async function loadSandboxStatus(dir: string, force: boolean) {
  SecurityAccess.setProjectRoot(dir)
  await SecurityConfig.loadSecurityConfig(dir, force ? { forceWalk: true } : undefined)
  const init = await initSandbox()
  if (force && init.status === "active") {
    await refreshSandboxPolicy()
  }

  const { status, error } = getSandboxStatus()
  if (status !== "active") {
    return { status, error, policyPath: undefined, profile: undefined }
  }

  const sandbox = getActiveSandbox() as { getPolicyPath?: () => string | null } | null
  const policyPath = sandbox?.getPolicyPath?.()
  if (!policyPath) {
    return { status, error, policyPath: undefined, profile: undefined }
  }

  return {
    status,
    error,
    policyPath,
    profile: await Bun.file(policyPath).text(),
  }
}

export const StatusCommand = cmd({
  command: "status",
  describe: "show current sandbox status",
  builder: (yargs) => yargs,
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const result = await loadSandboxStatus(Instance.directory, false)
        console.log("Sandbox Status\n")
        console.log(`  Platform:  ${process.platform}`)
        console.log(`  Status:    ${result.status}`)
        if (result.error) {
          console.log(`  Error:     ${result.error}`)
        }

        // Show generated profile if sandbox is active
        if (result.status === "active") {
          if (result.policyPath && result.profile !== undefined) {
            console.log(`  Policy:    ${result.policyPath}`)
            console.log(`\nSBPL Profile:\n`)
            console.log(result.profile)
          }
        }
      },
    })
  },
})

export const RefreshCommand = cmd({
  command: "refresh",
  describe: "force refresh sandbox policy and security config cache",
  builder: (yargs) => yargs,
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const result = await loadSandboxStatus(Instance.directory, true)
        console.log("Sandbox Refresh\n")
        console.log(`  Platform:  ${process.platform}`)
        console.log(`  Status:    ${result.status}`)
        if (result.error) {
          console.log(`  Error:     ${result.error}`)
        }

        if (result.status === "active") {
          if (result.policyPath && result.profile !== undefined) {
            console.log(`  Policy:    ${result.policyPath}`)
            console.log(`\nSBPL Profile:\n`)
            console.log(result.profile)
          }
        }
      },
    })
  },
})

export const SandboxCommand = cmd({
  command: "sandbox",
  describe: "manage OS-native sandbox",
  builder: (yargs) => yargs.command(DoctorCommand).command(StatusCommand).command(RefreshCommand).demandCommand(),
  handler() {},
})
