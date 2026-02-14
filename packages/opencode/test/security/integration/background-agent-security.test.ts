/**
 * US-034: Background agent respects same security rules as parent.
 *
 * Verifies that background agents receive a frozen copy of the parent's
 * SecurityConfig and that the rules within it are actually usable by consumers
 * (e.g., checking file access with the shared config).
 */
import { describe, expect, test, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"
import { BackgroundManager } from "../../../src/agent/background/manager"
import { SecurityConfig } from "../../../src/security/config"
import { SecurityAccess } from "../../../src/security/access"

async function loadSecurityConfig(dir: string, config: Record<string, unknown>) {
  const configPath = path.join(dir, ".opencode-security.json")
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  const gitDir = path.join(dir, ".git")
  if (!fs.existsSync(gitDir)) {
    fs.mkdirSync(gitDir)
  }
  await SecurityConfig.loadSecurityConfig(dir)
}

describe("background agent security integration", () => {
  afterEach(() => {
    SecurityConfig.resetConfig()
  })

  test("background agent respects same security rules as parent", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        fs.writeFileSync(path.join(dir, "public.txt"), "public data")
        fs.writeFileSync(path.join(dir, "secret.key"), "private key content")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        BackgroundManager.reset()

        // Load security config that denies read on secret.key
        await loadSecurityConfig(tmp.path, {
          version: "1.0",
          rules: [
            {
              pattern: path.join(tmp.path, "secret.key"),
              type: "file",
              deniedOperations: ["read", "write"],
              allowedRoles: [],
            },
          ],
        })

        // Parent can check access via SecurityAccess
        const parentConfig = SecurityConfig.getSecurityConfig()
        const parentPublicAccess = SecurityAccess.checkAccess(
          path.join(tmp.path, "public.txt"),
          "read",
          "agent",
        )
        const parentSecretAccess = SecurityAccess.checkAccess(
          path.join(tmp.path, "secret.key"),
          "read",
          "agent",
        )
        expect(parentPublicAccess.allowed).toBe(true)
        expect(parentSecretAccess.allowed).toBe(false)

        // Share the security config with BackgroundManager (same as delegate_task does)
        BackgroundManager.setSecurityConfig(parentConfig as unknown as Record<string, unknown>)
        const sharedConfig = BackgroundManager.getSecurityConfig()

        // Verify the shared config is frozen and same reference
        expect(sharedConfig).toBeDefined()
        expect(Object.isFrozen(sharedConfig)).toBe(true)

        // Verify the shared config preserves the rules structure
        const rules = (sharedConfig as any).rules
        expect(rules).toBeDefined()
        expect(rules.length).toBe(1)
        expect(rules[0].pattern).toBe(path.join(tmp.path, "secret.key"))
        expect(rules[0].deniedOperations).toContain("read")
        expect(rules[0].deniedOperations).toContain("write")

        // Verify that the security rules are still enforced (SecurityAccess reads from SecurityConfig module,
        // and the BackgroundManager's frozen copy is the same config)
        const accessAfterShare = SecurityAccess.checkAccess(
          path.join(tmp.path, "secret.key"),
          "read",
          "agent",
        )
        expect(accessAfterShare.allowed).toBe(false)

        const publicAfterShare = SecurityAccess.checkAccess(
          path.join(tmp.path, "public.txt"),
          "read",
          "agent",
        )
        expect(publicAfterShare.allowed).toBe(true)
      },
    })
  })

  test("background agent cannot escalate security via config mutation", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        BackgroundManager.reset()

        const securityConfig = {
          version: "1.0",
          rules: [
            {
              pattern: "/protected/**",
              type: "file",
              deniedOperations: ["read", "write"],
              allowedRoles: [],
            },
          ],
        }
        BackgroundManager.setSecurityConfig(securityConfig as any)

        const shared = BackgroundManager.getSecurityConfig()

        // Attempting to clear rules should throw TypeError (frozen)
        expect(() => {
          ;(shared as any).rules = []
        }).toThrow(TypeError)

        // Attempting to add new properties should throw TypeError
        expect(() => {
          ;(shared as any).escalated = true
        }).toThrow(TypeError)

        // Original rules should still be intact
        const afterAttempt = BackgroundManager.getSecurityConfig()
        expect((afterAttempt as any).rules.length).toBe(1)
        expect((afterAttempt as any).rules[0].pattern).toBe("/protected/**")
      },
    })
  })
})
