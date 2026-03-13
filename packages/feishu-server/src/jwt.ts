import crypto from "node:crypto"

function base64url(buf: Buffer | string) {
  const raw = typeof buf === "string" ? Buffer.from(buf) : buf
  return raw.toString("base64url")
}

function encodeJson(obj: unknown) {
  return base64url(JSON.stringify(obj))
}

export function sign(payload: Record<string, unknown>, key: string, ttl = 48 * 3600) {
  const now = Math.floor(Date.now() / 1000)
  const header = encodeJson({ alg: "RS256", typ: "JWT" })
  const body = encodeJson({ ...payload, iat: now, exp: now + ttl })
  const data = `${header}.${body}`
  const signer = crypto.createSign("RSA-SHA256")
  signer.update(data)
  const sig = signer.sign(key)
  return `${data}.${base64url(sig)}`
}

export function verify(token: string, key: string, opts?: { ignoreExpiration?: boolean }) {
  const parts = token.split(".")
  if (parts.length !== 3) throw new Error("invalid jwt")
  const data = `${parts[0]}.${parts[1]}`
  const verifier = crypto.createVerify("RSA-SHA256")
  verifier.update(data)
  const valid = verifier.verify(key, Buffer.from(parts[2]!, "base64url"))
  if (!valid) throw new Error("invalid signature")
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Record<string, unknown>
  if (!opts?.ignoreExpiration && typeof payload.exp === "number" && payload.exp < Date.now() / 1000) {
    throw new Error("token expired")
  }
  return payload
}

export function decode(token: string) {
  const parts = token.split(".")
  if (parts.length !== 3) throw new Error("invalid jwt")
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Record<string, unknown>
}
