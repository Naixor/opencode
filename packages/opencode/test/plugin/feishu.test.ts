import { describe, test, expect } from "bun:test"
import { decode } from "../../src/plugin/feishu"

function createJwt(payload: object, ttl = 3600): string {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + ttl })).toString("base64url")
  return `${header}.${body}.fakesig`
}

describe("plugin.feishu", () => {
  describe("decode", () => {
    test("decodes a valid JWT payload", () => {
      const token = createJwt({ sub: "ou_123", email: "a@b.com", name: "Alice" })
      const payload = decode(token)
      expect(payload).not.toBeNull()
      expect(payload!.sub).toBe("ou_123")
      expect(payload!.email).toBe("a@b.com")
      expect(payload!.name).toBe("Alice")
    })

    test("returns exp and iat fields", () => {
      const token = createJwt({ sub: "u1" }, 7200)
      const payload = decode(token)!
      expect(payload.exp).toBeTypeOf("number")
      expect(payload.iat).toBeTypeOf("number")
      expect((payload.exp as number) - (payload.iat as number)).toBe(7200)
    })

    test("returns null for too few segments", () => {
      expect(decode("only.two")).toBeNull()
      expect(decode("single")).toBeNull()
    })

    test("returns null for invalid base64", () => {
      expect(decode("a.!!!.c")).toBeNull()
    })

    test("returns null for invalid JSON in payload", () => {
      const header = Buffer.from("{}").toString("base64url")
      const bad = Buffer.from("not-json").toString("base64url")
      expect(decode(`${header}.${bad}.sig`)).toBeNull()
    })

    test("does not require valid signature", () => {
      const token = createJwt({ sub: "u1" })
      // Replace signature with garbage
      const parts = token.split(".")
      const result = decode(`${parts[0]}.${parts[1]}.totallyfake`)
      expect(result).not.toBeNull()
      expect(result!.sub).toBe("u1")
    })

    test("detects token about to expire", () => {
      // Token that expires in 2 minutes
      const token = createJwt({ sub: "u1" }, 120)
      const payload = decode(token)!
      const remaining = (payload.exp as number) - Date.now() / 1000
      expect(remaining).toBeLessThan(300) // less than 5 min threshold
    })

    test("detects token not expiring soon", () => {
      // Token that expires in 24 hours
      const token = createJwt({ sub: "u1" }, 86400)
      const payload = decode(token)!
      const remaining = (payload.exp as number) - Date.now() / 1000
      expect(remaining).toBeGreaterThan(300) // more than 5 min threshold
    })
  })
})
