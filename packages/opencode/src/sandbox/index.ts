import type { Config } from "../config/config"
import { Log } from "../util/log"

const log = Log.create({ service: "sandbox" })

export interface Sandbox {
  wrap(command: string[]): string[]
  isAvailable(): Promise<boolean>
  generatePolicy(config: SandboxConfig): Promise<string>
}

export interface SandboxConfig {
  projectRoot: string
  allowlist: string[]
  deny: string[]
  extraPaths: string[]
}

export type SandboxStatus = "off" | "active" | "failed"

let currentSandbox: Sandbox | null = null
let sandboxStatus: SandboxStatus = "off"
let sandboxError: string | null = null

export async function getSandbox(): Promise<Sandbox | null> {
  if (process.platform === "darwin") {
    const { SeatbeltSandbox } = await import("./seatbelt")
    return new SeatbeltSandbox()
  }
  return null
}

export function isSandboxEnabled(config: Config.Info): boolean {
  return config.sandbox?.enabled === true
}

export function setActiveSandbox(sandbox: Sandbox | null, status: SandboxStatus, error?: string): void {
  currentSandbox = sandbox
  sandboxStatus = status
  sandboxError = error ?? null
  log.info("sandbox state updated", { status, error: error ?? "none" })
}

export function getActiveSandbox(): Sandbox | null {
  return currentSandbox
}

export function getSandboxStatus(): { status: SandboxStatus; error: string | null } {
  return { status: sandboxStatus, error: sandboxError }
}

export function resetSandbox(): void {
  currentSandbox = null
  sandboxStatus = "off"
  sandboxError = null
}
