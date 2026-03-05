import type { Sandbox, SandboxConfig } from "./index"
import { generateFullProfile } from "./profile"
import { Log } from "../util/log"
import fs from "fs/promises"
import path from "path"
import os from "os"

const log = Log.create({ service: "sandbox-seatbelt" })

export class SeatbeltSandbox implements Sandbox {
  private policyPath: string | null = null

  wrap(command: string[]): string[] {
    if (!this.policyPath) throw new Error("Sandbox policy not generated. Call generatePolicy() first.")
    return ["sandbox-exec", "-f", this.policyPath, ...command]
  }

  async isAvailable(): Promise<boolean> {
    const proc = Bun.spawn(["which", "sandbox-exec"], { stdout: "pipe", stderr: "pipe" })
    const code = await proc.exited
    return code === 0
  }

  async generatePolicy(config: SandboxConfig): Promise<string> {
    if (this.policyPath) return this.policyPath

    const profile = await generateFullProfile({
      projectRoot: config.projectRoot,
      allowlist: config.allowlist.map((pattern) => {
        const isDir = pattern.endsWith("/**") || pattern.endsWith("/") || !pattern.includes(".")
        return { pattern, type: isDir ? ("directory" as const) : ("file" as const) }
      }),
      deny: config.deny.map((entry) => {
        const isGlob = /[*?[{]/.test(entry.pattern)
        const isDir = !isGlob && (entry.pattern.endsWith("/**") || entry.pattern.endsWith("/") || !entry.pattern.includes("."))
        return {
          pattern: entry.pattern,
          type: isDir ? ("directory" as const) : ("file" as const),
          deniedOperations: entry.deniedOperations as ("read" | "write")[],
          allowedRoles: [],
        }
      }),
      extraPaths: config.extraPaths,
    })

    const tmpDir = path.join(os.tmpdir(), "opencode-sandbox")
    await fs.mkdir(tmpDir, { recursive: true })
    const policyFile = path.join(tmpDir, `sandbox-${process.pid}.sb`)
    await fs.writeFile(policyFile, profile, "utf-8")

    log.info("generated seatbelt policy", { path: policyFile })
    this.policyPath = policyFile
    return policyFile
  }

  getPolicyPath(): string | null {
    return this.policyPath
  }
}
