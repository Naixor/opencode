import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { SecurityConfig } from "@/security/config"
import { SecurityAccess } from "@/security/access"

afterEach(() => {
  SecurityConfig.resetConfig()
})

describe("trusted_commands", () => {
  test("matches command name and absolute executable path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-trusted-"))
    fs.mkdirSync(path.join(dir, ".git"))
    fs.writeFileSync(
      path.join(dir, ".opencode-security.json"),
      JSON.stringify({ version: "1.0", trusted_commands: ["bitsky"] }, null, 2),
    )

    SecurityAccess.setProjectRoot(dir)
    await SecurityConfig.loadSecurityConfig(dir, { forceWalk: true })

    expect(SecurityConfig.isTrustedCommand("bitsky", dir)).toBe(true)
    expect(SecurityConfig.isTrustedCommand("/usr/local/bin/bitsky", dir)).toBe(true)
    expect(SecurityConfig.isTrustedCommand("other", dir)).toBe(false)

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("child scope overrides parent trusted commands", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-trusted-"))
    const child = path.join(dir, "child")
    fs.mkdirSync(path.join(dir, ".git"))
    fs.mkdirSync(child, { recursive: true })
    fs.writeFileSync(
      path.join(dir, ".opencode-security.json"),
      JSON.stringify({ version: "1.0", trusted_commands: ["bitsky"] }, null, 2),
    )
    fs.writeFileSync(
      path.join(child, ".opencode-security.json"),
      JSON.stringify({ version: "1.0", trusted_commands: ["childsky"] }, null, 2),
    )

    SecurityAccess.setProjectRoot(dir)
    await SecurityConfig.loadSecurityConfig(dir, { forceWalk: true })

    expect(SecurityConfig.isTrustedCommand("bitsky", dir)).toBe(true)
    expect(SecurityConfig.isTrustedCommand("bitsky", child)).toBe(false)
    expect(SecurityConfig.isTrustedCommand("childsky", child)).toBe(true)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})
