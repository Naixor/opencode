import { describe, test, expect } from "bun:test"
import crypto from "node:crypto"
import { sign, verify, decode } from "../src/jwt"

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
})

describe("jwt", () => {
  describe("sign + verify round-trip", () => {
    test("produces a valid 3-part token", () => {
      const token = sign({ sub: "u1", email: "a@b.com" }, privateKey)
      expect(token.split(".")).toHaveLength(3)
    })

    test("verify succeeds with correct public key", () => {
      const token = sign({ sub: "u1" }, privateKey)
      const payload = verify(token, publicKey)
      expect(payload.sub).toBe("u1")
      expect(payload.iat).toBeTypeOf("number")
      expect(payload.exp).toBeTypeOf("number")
    })

    test("payload preserves custom fields", () => {
      const token = sign({ sub: "u1", email: "a@b.com", name: "Alice" }, privateKey)
      const payload = verify(token, publicKey)
      expect(payload.email).toBe("a@b.com")
      expect(payload.name).toBe("Alice")
    })

    test("respects custom TTL", () => {
      const token = sign({ sub: "u1" }, privateKey, 60)
      const payload = verify(token, publicKey)
      expect((payload.exp as number) - (payload.iat as number)).toBe(60)
    })

    test("default TTL is 48 hours", () => {
      const token = sign({ sub: "u1" }, privateKey)
      const payload = verify(token, publicKey)
      expect((payload.exp as number) - (payload.iat as number)).toBe(48 * 3600)
    })
  })

  describe("verify rejects invalid tokens", () => {
    test("throws on wrong key", () => {
      const other = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      })
      const token = sign({ sub: "u1" }, privateKey)
      expect(() => verify(token, other.publicKey)).toThrow("invalid signature")
    })

    test("throws on malformed token", () => {
      expect(() => verify("not.a.jwt", publicKey)).toThrow()
    })

    test("throws on too few parts", () => {
      expect(() => verify("only.two", publicKey)).toThrow("invalid jwt")
    })

    test("throws on tampered payload", () => {
      const token = sign({ sub: "u1" }, privateKey)
      const parts = token.split(".")
      const tampered = Buffer.from(JSON.stringify({ sub: "hacker" })).toString("base64url")
      expect(() => verify(`${parts[0]}.${tampered}.${parts[2]}`, publicKey)).toThrow("invalid signature")
    })

    test("throws on expired token", () => {
      const token = sign({ sub: "u1" }, privateKey, -10)
      expect(() => verify(token, publicKey)).toThrow("token expired")
    })

    test("ignoreExpiration allows expired tokens", () => {
      const token = sign({ sub: "u1" }, privateKey, -10)
      const payload = verify(token, publicKey, { ignoreExpiration: true })
      expect(payload.sub).toBe("u1")
    })
  })

  describe("decode", () => {
    test("decodes payload without verification", () => {
      const token = sign({ sub: "u1", email: "a@b.com" }, privateKey)
      const payload = decode(token)
      expect(payload.sub).toBe("u1")
      expect(payload.email).toBe("a@b.com")
    })

    test("throws on malformed token", () => {
      expect(() => decode("two.parts")).toThrow("invalid jwt")
    })

    test("decodes even with wrong signature", () => {
      const token = sign({ sub: "u1" }, privateKey)
      const parts = token.split(".")
      const payload = decode(`${parts[0]}.${parts[1]}.badsig`)
      expect(payload.sub).toBe("u1")
    })
  })
})
