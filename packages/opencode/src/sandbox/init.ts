import { Log } from "../util/log"
import { Config } from "../config/config"
import { SecurityConfig } from "../security/config"
import { Instance } from "../project/instance"
import { getSandbox, setActiveSandbox, isSandboxEnabled, type Sandbox } from "./index"

const log = Log.create({ service: "sandbox-init" })

export interface SandboxInitResult {
  status: "active" | "disabled" | "failed" | "unsupported"
  error?: string
}

let initialized = false

export async function initSandbox(): Promise<SandboxInitResult> {
  if (initialized) return { status: "active" }

  const config = await Config.get()
  if (!isSandboxEnabled(config)) {
    log.debug("sandbox not enabled in config")
    return { status: "disabled" }
  }

  // Step 1: Platform detection
  const sandbox = await getSandbox()
  if (!sandbox) {
    log.warn("sandbox enabled but platform not supported", { platform: process.platform })
    setActiveSandbox(null, "off", `Platform ${process.platform} not supported`)
    return { status: "unsupported", error: `Platform ${process.platform} does not support sandboxing` }
  }

  // Step 2: Environment check (sandbox-exec available)
  const available = await sandbox.isAvailable()
  if (!available) {
    const error = "sandbox-exec not found. Is SIP (System Integrity Protection) enabled?"
    log.warn("sandbox-exec not available", { error })
    setActiveSandbox(null, "failed", error)
    return { status: "failed", error }
  }

  // Step 3: Policy generation
  const securityConfig = SecurityConfig.getSecurityConfig()
  const allowlistPatterns = securityConfig.resolvedAllowlist.flatMap((layer) =>
    layer.entries.map((e) => e.pattern),
  )
  // Only generate sandbox deny for rules that deny read or llm (llm = read+write).
  // Rules that only deny write are skipped since sandbox deny blocks both read+write.
  const denyEntries = (securityConfig.rules ?? [])
    .filter((r) => r.deniedOperations.includes("read") || r.deniedOperations.includes("llm"))
    .map((r) => ({ pattern: r.pattern, deniedOperations: r.deniedOperations }))
  const extraPaths = config.sandbox?.paths ?? []

  const policyPath = await sandbox
    .generatePolicy({
      projectRoot: Instance.directory,
      allowlist: allowlistPatterns,
      deny: denyEntries,
      extraPaths,
    })
    .catch((err: Error) => {
      log.error("failed to generate sandbox policy", { error: err.message })
      return null
    })

  if (!policyPath) {
    const error = "Failed to generate sandbox policy"
    setActiveSandbox(null, "failed", error)
    return { status: "failed", error }
  }

  // Step 4: Validation — run a harmless command inside the sandbox
  const validation = await validateSandbox(sandbox)
  if (!validation.ok) {
    const error = `Sandbox validation failed: ${validation.error}`
    log.error("sandbox validation failed", { error: validation.error })
    setActiveSandbox(null, "failed", error)
    return { status: "failed", error }
  }

  // Success
  setActiveSandbox(sandbox, "active")
  initialized = true
  log.info("sandbox initialized successfully", { policyPath })
  return { status: "active" }
}

async function validateSandbox(sandbox: Sandbox): Promise<{ ok: boolean; error?: string }> {
  const cmd = sandbox.wrap(["/usr/bin/true"])
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const [stderr] = await Promise.all([new Response(proc.stderr).text()])
  const code = await proc.exited
  if (code === 0) return { ok: true }
  return { ok: false, error: stderr.trim() || `sandbox-exec exited with code ${code}` }
}

export function resetSandboxInit(): void {
  initialized = false
}
