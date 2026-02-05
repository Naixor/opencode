import { describe, test, expect, afterEach } from "bun:test"
import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { SecurityToken } from "@/security/token"
import { SecurityRole } from "@/security/role"
import { SecurityConfig } from "@/security/config"
import { SecurityAccess } from "@/security/access"
import {
  loadBaseConfig,
  setupSecurityConfig,
  teardownSecurityConfig,
  generateExpiredToken,
  generateForgedToken,
  generateValidToken,
  writeTokenFile,
  keyPath,
} from "../helpers"

function base64UrlEncode(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function signJWT(header: object, payload: object, privateKeyPem: string): string {
  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)))
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)))
  const signatureInput = `${headerB64}.${payloadB64}`
  const signer = crypto.createSign("RSA-SHA256")
  signer.update(signatureInput)
  const signature = signer.sign(privateKeyPem)
  return `${signatureInput}.${base64UrlEncode(signature)}`
}

function readPublicKey(): string {
  return fs.readFileSync(keyPath("test-public"), "utf8")
}

function readPrivateKey(): string {
  return fs.readFileSync(keyPath("test-private"), "utf8")
}

afterEach(() => {
  teardownSecurityConfig()
  SecurityRole.resetCache()
})

describe("CASE-AUTH-001: All tools use getDefaultRole() instead of SecurityRole.getCurrentRole()", () => {
  // CRITICAL finding: Tools use getDefaultRole (returns lowest-level role from config),
  // NOT SecurityRole.getCurrentRole() (which reads JWT tokens from disk).
  // This means role-based access escalation via tokens has NO EFFECT on tool checks —
  // all users are treated as the lowest role.

  const toolFiles = ["read.ts", "write.ts", "edit.ts", "grep.ts", "glob.ts", "bash.ts"]
  const toolDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../../../src/tool",
  )

  for (const file of toolFiles) {
    test(`${file} uses getDefaultRole (not getCurrentRole)`, () => {
      const content = fs.readFileSync(path.join(toolDir, file), "utf8")

      // Should use getDefaultRole
      expect(content).toContain("getDefaultRole")

      // Should NOT use SecurityRole.getCurrentRole
      expect(content).not.toContain("SecurityRole.getCurrentRole")
      expect(content).not.toContain("getCurrentRole(")
    })
  }

  test("getDefaultRole always returns the lowest-level role from config", () => {
    const baseConfig = loadBaseConfig()
    const roles = baseConfig.roles ?? []
    const lowestRole = roles.reduce(
      (prev, curr) => (curr.level < prev.level ? curr : prev),
      roles[0],
    )

    // The lowest role should be "viewer" (level 10)
    expect(lowestRole.name).toBe("viewer")
    expect(lowestRole.level).toBe(10)
  })

  test("[CRITICAL] valid admin token has NO EFFECT on tool-level access checks", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)

    // Generate a valid admin token
    const adminToken = generateValidToken("admin")
    const tokenPath = path.join(dir, ".opencode-role.token")
    fs.writeFileSync(tokenPath, adminToken)

    // SecurityRole.getCurrentRole() would return "admin" with a valid token
    const currentRole = SecurityRole.getCurrentRole(dir, baseConfig)
    expect(currentRole).toBe("admin")

    // But tools use getDefaultRole which always returns the lowest role
    const roles = baseConfig.roles ?? []
    const lowestRole = roles.reduce(
      (prev, curr) => (curr.level < prev.level ? curr : prev),
      roles[0],
    )
    expect(lowestRole.name).toBe("viewer")

    // So even with an admin token present, tool checks use "viewer"
    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", lowestRole.name)
    expect(result.allowed).toBe(false)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("CASE-AUTH-002: Token signed with wrong key is rejected", () => {
  test("forged token (wrong private key) fails signature verification", () => {
    const publicKey = readPublicKey()
    const forgedToken = generateForgedToken("admin")
    const tokenPath = writeTokenFile(forgedToken)

    const result = SecurityToken.verifyRoleToken(tokenPath, publicKey, [])

    expect(result.valid).toBe(false)
    expect(result.error).toContain("signature")

    fs.rmSync(path.dirname(tokenPath), { recursive: true, force: true })
  })
})

describe("CASE-AUTH-003: Expired token is rejected", () => {
  test("token with exp in the past is rejected", () => {
    const publicKey = readPublicKey()
    const expiredToken = generateExpiredToken("admin")
    const tokenPath = writeTokenFile(expiredToken)

    const result = SecurityToken.verifyRoleToken(tokenPath, publicKey, [])

    expect(result.valid).toBe(false)
    expect(result.error).toContain("expired")

    fs.rmSync(path.dirname(tokenPath), { recursive: true, force: true })
  })
})

describe("CASE-AUTH-004: Revoked token is rejected", () => {
  test("token with jti in revoked list is rejected", () => {
    const publicKey = readPublicKey()
    const privateKey = readPrivateKey()

    const jti = crypto.randomUUID()
    const header = { alg: "RS256", typ: "JWT" }
    const payload = {
      role: "admin",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
      jti,
    }
    const token = signJWT(header, payload, privateKey)
    const tokenPath = writeTokenFile(token)

    const result = SecurityToken.verifyRoleToken(tokenPath, publicKey, [jti])

    expect(result.valid).toBe(false)
    expect(result.error).toContain("revoked")

    fs.rmSync(path.dirname(tokenPath), { recursive: true, force: true })
  })

  test("token with different jti is NOT rejected", () => {
    const publicKey = readPublicKey()
    const privateKey = readPrivateKey()

    const jti = crypto.randomUUID()
    const header = { alg: "RS256", typ: "JWT" }
    const payload = {
      role: "admin",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
      jti,
    }
    const token = signJWT(header, payload, privateKey)
    const tokenPath = writeTokenFile(token)

    const result = SecurityToken.verifyRoleToken(tokenPath, publicKey, ["some-other-jti"])

    expect(result.valid).toBe(true)
    expect(result.role).toBe("admin")

    fs.rmSync(path.dirname(tokenPath), { recursive: true, force: true })
  })
})

describe("CASE-AUTH-005: Token with non-existent role falls back to lowest role", () => {
  test("getCurrentRole falls back to lowest role for unknown role in token", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)

    // Create a valid token with a non-existent role
    const privateKey = readPrivateKey()
    const header = { alg: "RS256", typ: "JWT" }
    const payload = {
      role: "superadmin",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
      jti: crypto.randomUUID(),
    }
    const token = signJWT(header, payload, privateKey)
    fs.writeFileSync(path.join(dir, ".opencode-role.token"), token)

    // getCurrentRole should fall back to lowest role since "superadmin" is not in config
    const role = SecurityRole.getCurrentRole(dir, baseConfig)
    expect(role).toBe("viewer") // lowest role

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("CASE-AUTH-006: Token without exp claim is accepted (not rejected)", () => {
  // The token.ts code only checks exp if it's defined:
  //   if (parsed.payload.exp !== undefined) { ... check ... }
  // A token without exp is treated as non-expiring — document as behavior.
  test("token without exp claim is treated as non-expiring", () => {
    const publicKey = readPublicKey()
    const privateKey = readPrivateKey()

    const header = { alg: "RS256", typ: "JWT" }
    const payload = {
      role: "admin",
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
      // No exp field
    }
    const token = signJWT(header, payload, privateKey)
    const tokenPath = writeTokenFile(token)

    const result = SecurityToken.verifyRoleToken(tokenPath, publicKey, [])

    // Token without exp is accepted — this is the actual behavior
    // [KNOWN_LIMITATION] severity MEDIUM: tokens without exp never expire
    expect(result.valid).toBe(true)
    expect(result.role).toBe("admin")

    fs.rmSync(path.dirname(tokenPath), { recursive: true, force: true })
  })
})

describe("CASE-AUTH-007: Role with Number.MAX_SAFE_INTEGER level does not overflow", () => {
  test("role hierarchy comparison handles MAX_SAFE_INTEGER without overflow", async () => {
    const config = {
      version: "1.0" as const,
      roles: [
        { name: "superadmin", level: Number.MAX_SAFE_INTEGER },
        { name: "viewer", level: 10 },
      ],
      rules: [
        {
          pattern: "secrets/**",
          type: "directory" as const,
          deniedOperations: ["read" as const, "write" as const],
          allowedRoles: ["viewer"],
        },
      ],
    }

    const dir = await setupSecurityConfig(config)

    // superadmin (MAX_SAFE_INTEGER) should be able to access content allowed for viewer (10)
    // because higher level roles can access lower level content
    const resultSuperadmin = SecurityAccess.checkAccess("secrets/key.pem", "read", "superadmin")
    expect(resultSuperadmin.allowed).toBe(true)

    // viewer should be allowed (directly listed in allowedRoles)
    const resultViewer = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(resultViewer.allowed).toBe(true)

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("comparison does not produce incorrect results at boundary values", async () => {
    const config = {
      version: "1.0" as const,
      roles: [
        { name: "max", level: Number.MAX_SAFE_INTEGER },
        { name: "max-minus-one", level: Number.MAX_SAFE_INTEGER - 1 },
        { name: "viewer", level: 10 },
      ],
      rules: [
        {
          pattern: "secrets/**",
          type: "directory" as const,
          deniedOperations: ["read" as const],
          allowedRoles: ["max"],
        },
      ],
    }

    const dir = await setupSecurityConfig(config)

    // "max" (MAX_SAFE_INTEGER) is directly allowed
    const resultMax = SecurityAccess.checkAccess("secrets/key.pem", "read", "max")
    expect(resultMax.allowed).toBe(true)

    // "max-minus-one" (MAX_SAFE_INTEGER - 1) should NOT be allowed
    // because its level < "max" level, and only "max" is in allowedRoles
    const resultMaxMinusOne = SecurityAccess.checkAccess("secrets/key.pem", "read", "max-minus-one")
    expect(resultMaxMinusOne.allowed).toBe(false)

    // "viewer" (10) should NOT be allowed
    const resultViewer = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer")
    expect(resultViewer.allowed).toBe(false)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("CASE-AUTH-008: Empty role name does not accidentally match defaults", () => {
  test("empty string role name does not match any config roles", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)

    // Empty role name should not match any role and get level 0
    const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "")
    expect(result.allowed).toBe(false)

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("empty role name is not a known role", () => {
    const baseConfig = loadBaseConfig()
    const roles = baseConfig.roles ?? []
    const hasEmptyRole = roles.some((r) => r.name === "")
    expect(hasEmptyRole).toBe(false)
  })

  test("getCurrentRole with empty-name token falls back to lowest role", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)

    // Create a valid token with empty role
    const privateKey = readPrivateKey()
    const header = { alg: "RS256", typ: "JWT" }
    const payload = {
      role: "",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
      jti: crypto.randomUUID(),
    }
    const token = signJWT(header, payload, privateKey)
    fs.writeFileSync(path.join(dir, ".opencode-role.token"), token)

    // Token with empty role: verifyRoleToken returns valid:false because role claim is falsy
    const publicKey = readPublicKey()
    const verifyResult = SecurityToken.verifyRoleToken(
      path.join(dir, ".opencode-role.token"),
      publicKey,
      [],
    )
    // Empty string is falsy in JS, so `!parsed.payload.role` is true => invalid
    expect(verifyResult.valid).toBe(false)
    expect(verifyResult.error).toContain("role")

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("CASE-AUTH-009: Role name matching is case-sensitive", () => {
  test("'Admin' does not match config role 'admin'", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)

    // "Admin" (capital A) should NOT match "admin" (lowercase) in allowedRoles
    // secrets/** is allowed only for "admin"
    const resultUppercase = SecurityAccess.checkAccess("secrets/key.pem", "read", "Admin")
    expect(resultUppercase.allowed).toBe(false)

    // "admin" (lowercase) should match
    const resultLowercase = SecurityAccess.checkAccess("secrets/key.pem", "read", "admin")
    expect(resultLowercase.allowed).toBe(true)

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("getCurrentRole with case-mismatched role falls back to lowest", async () => {
    const baseConfig = loadBaseConfig()
    const dir = await setupSecurityConfig(baseConfig)

    // Create a valid token with "Admin" (capital A) — not in config roles
    const privateKey = readPrivateKey()
    const header = { alg: "RS256", typ: "JWT" }
    const payload = {
      role: "Admin",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
      jti: crypto.randomUUID(),
    }
    const token = signJWT(header, payload, privateKey)
    fs.writeFileSync(path.join(dir, ".opencode-role.token"), token)

    // "Admin" is not a known role in config (only "admin" exists), so falls back to lowest
    const role = SecurityRole.getCurrentRole(dir, baseConfig)
    expect(role).toBe("viewer")

    fs.rmSync(dir, { recursive: true, force: true })
  })
})
