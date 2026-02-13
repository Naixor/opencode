/**
 * US-031: delegate_task SecurityConfig sharing integration tests.
 */
import { describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"
import { BackgroundManager } from "../../../src/agent/background/manager"

describe("delegate_task security config sharing", () => {
  async function withInstance(fn: () => Promise<void>) {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        BackgroundManager.reset()
        await fn()
      },
    })
  }

  test("Object.is(parent.config, child.config) === true", async () => {
    await withInstance(async () => {
      const config = {
        version: "1.0",
        rules: [{ pattern: "secret.txt", type: "file", deniedOperations: ["read"], allowedRoles: [] }],
      }
      BackgroundManager.setSecurityConfig(config as any)

      const parentRef = BackgroundManager.getSecurityConfig()
      const childRef = BackgroundManager.getSecurityConfig()
      expect(Object.is(parentRef, childRef)).toBe(true)
    })
  })

  test("Object.isFrozen(config) === true", async () => {
    await withInstance(async () => {
      const config = { version: "1.0", rules: [{ pattern: "secret.txt", deniedOperations: ["read"] }] }
      BackgroundManager.setSecurityConfig(config as any)

      const shared = BackgroundManager.getSecurityConfig()
      expect(shared).toBeDefined()
      expect(Object.isFrozen(shared)).toBe(true)
    })
  })

  test("mutation throws TypeError", async () => {
    await withInstance(async () => {
      const config = { version: "1.0", rules: [{ pattern: "secret.txt" }] }
      BackgroundManager.setSecurityConfig(config as any)

      const shared = BackgroundManager.getSecurityConfig()
      expect(() => {
        ;(shared as any).newProp = "value"
      }).toThrow(TypeError)
    })
  })

  test("SecurityConfig shared by reference (frozen reference)", async () => {
    await withInstance(async () => {
      const securityConfig = {
        version: "1.0",
        rules: [
          {
            pattern: "/secrets/**",
            type: "file",
            deniedOperations: ["read", "write"],
            allowedRoles: [],
          },
        ],
      }
      BackgroundManager.setSecurityConfig(securityConfig as any)

      const shared = BackgroundManager.getSecurityConfig()
      expect(shared).toBeDefined()

      // Verify rules preserved
      expect((shared as any).rules).toBeDefined()
      expect((shared as any).rules.length).toBe(1)
      expect((shared as any).rules[0].pattern).toBe("/secrets/**")
      expect((shared as any).rules[0].deniedOperations).toEqual(["read", "write"])

      // Verify frozen (immutable)
      expect(Object.isFrozen(shared)).toBe(true)
    })
  })
})
