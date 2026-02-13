import { describe, test, expect } from "bun:test"
import { SecurityUtil } from "@/security/util"
import type { SecuritySchema } from "@/security/schema"

describe("SecurityUtil", () => {
  describe("getDefaultRole", () => {
    test("returns 'viewer' when no roles defined", () => {
      const config: SecuritySchema.SecurityConfig = { version: "1.0" }
      expect(SecurityUtil.getDefaultRole(config)).toBe("viewer")
    })

    test("returns 'viewer' when roles is empty array", () => {
      const config: SecuritySchema.SecurityConfig = { version: "1.0", roles: [] }
      expect(SecurityUtil.getDefaultRole(config)).toBe("viewer")
    })

    test("returns the lowest level role", () => {
      const config: SecuritySchema.SecurityConfig = {
        version: "1.0",
        roles: [
          { name: "admin", level: 100 },
          { name: "developer", level: 50 },
          { name: "viewer", level: 10 },
        ],
      }
      expect(SecurityUtil.getDefaultRole(config)).toBe("viewer")
    })

    test("returns single role when only one defined", () => {
      const config: SecuritySchema.SecurityConfig = {
        version: "1.0",
        roles: [{ name: "admin", level: 100 }],
      }
      expect(SecurityUtil.getDefaultRole(config)).toBe("admin")
    })
  })

  describe("hasSecurityRules", () => {
    test("returns false for empty config", () => {
      const config: SecuritySchema.SecurityConfig = { version: "1.0" }
      expect(SecurityUtil.hasSecurityRules(config)).toBe(false)
    })

    test("returns false when rules is empty array", () => {
      const config: SecuritySchema.SecurityConfig = { version: "1.0", rules: [] }
      expect(SecurityUtil.hasSecurityRules(config)).toBe(false)
    })

    test("returns true when rules exist", () => {
      const config: SecuritySchema.SecurityConfig = {
        version: "1.0",
        rules: [{ pattern: "*.env", type: "file", deniedOperations: ["read"], allowedRoles: ["admin"] }],
      }
      expect(SecurityUtil.hasSecurityRules(config)).toBe(true)
    })

    test("returns true when segments exist", () => {
      const config: SecuritySchema.SecurityConfig = {
        version: "1.0",
        segments: {
          markers: [{ start: "SECRET_START", end: "SECRET_END", deniedOperations: ["read"], allowedRoles: ["admin"] }],
        },
      }
      expect(SecurityUtil.hasSecurityRules(config)).toBe(true)
    })
  })

  describe("scanAndRedact", () => {
    test("returns content unchanged when no rules", () => {
      const config: SecuritySchema.SecurityConfig = { version: "1.0" }
      const content = "some sensitive data here"
      expect(SecurityUtil.scanAndRedact(content, config)).toBe(content)
    })
  })
})
