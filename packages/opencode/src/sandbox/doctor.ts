import os from "os"

export interface DoctorCheck {
  name: string
  status: "pass" | "fail" | "skip"
  message: string
  fix?: string
}

export async function runDoctorChecks(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []

  // Check 1: Platform
  const platform = process.platform
  if (platform === "darwin") {
    checks.push({ name: "Platform", status: "pass", message: `macOS (${os.release()})` })
  } else if (platform === "linux") {
    checks.push({
      name: "Platform",
      status: "skip",
      message: `Linux — Landlock sandbox not yet implemented`,
      fix: "Linux sandbox support is planned for a future release",
    })
    return checks
  } else {
    checks.push({
      name: "Platform",
      status: "fail",
      message: `${platform} is not supported`,
      fix: "Sandbox is only available on macOS (Seatbelt) and Linux (Landlock, planned)",
    })
    return checks
  }

  // Check 2: sandbox-exec available
  const sandboxExec = Bun.spawn(["which", "sandbox-exec"], { stdout: "pipe", stderr: "pipe" })
  const sandboxExecCode = await sandboxExec.exited
  if (sandboxExecCode === 0) {
    const sandboxPath = (await new Response(sandboxExec.stdout).text()).trim()
    checks.push({ name: "sandbox-exec", status: "pass", message: `Found at ${sandboxPath}` })
  } else {
    checks.push({
      name: "sandbox-exec",
      status: "fail",
      message: "sandbox-exec not found in PATH",
      fix: "Ensure SIP (System Integrity Protection) is enabled. sandbox-exec is a macOS system binary.",
    })
    return checks
  }

  // Check 3: macOS version
  const release = os.release()
  const majorVersion = parseInt(release.split(".")[0], 10)
  // Darwin 20 = macOS 11 (Big Sur)
  if (majorVersion >= 20) {
    const macosVersion = majorVersion - 9
    checks.push({ name: "macOS version", status: "pass", message: `macOS ${macosVersion}+ (Darwin ${majorVersion})` })
  } else {
    checks.push({
      name: "macOS version",
      status: "fail",
      message: `Darwin ${majorVersion} — macOS 11+ required`,
      fix: "Upgrade to macOS 11 (Big Sur) or later",
    })
  }

  // Check 4: SIP status (try csrutil)
  const sip = Bun.spawn(["csrutil", "status"], { stdout: "pipe", stderr: "pipe" })
  const sipOutput = await new Response(sip.stdout).text()
  await sip.exited
  if (sipOutput.includes("enabled")) {
    checks.push({ name: "SIP status", status: "pass", message: "System Integrity Protection enabled" })
  } else if (sipOutput.includes("disabled")) {
    checks.push({
      name: "SIP status",
      status: "fail",
      message: "System Integrity Protection is disabled",
      fix: "Re-enable SIP: boot into Recovery Mode (Cmd+R) → Terminal → 'csrutil enable'",
    })
  } else {
    checks.push({ name: "SIP status", status: "skip", message: "Could not determine SIP status" })
  }

  // Check 5: Basic sandbox validation
  const validation = Bun.spawn(["sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const validationCode = await validation.exited
  if (validationCode === 0) {
    checks.push({ name: "Sandbox validation", status: "pass", message: "sandbox-exec can execute commands" })
  } else {
    const stderr = await new Response(validation.stderr).text()
    checks.push({
      name: "Sandbox validation",
      status: "fail",
      message: `sandbox-exec test failed: ${stderr.trim()}`,
      fix: "Check system permissions and SIP status",
    })
  }

  return checks
}
