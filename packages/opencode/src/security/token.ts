import crypto from "crypto"
import fs from "fs"
import z from "zod"
import { Log } from "../util/log"

export namespace SecurityToken {
  const log = Log.create({ service: "security-token" })

  export interface VerifyResult {
    valid: boolean
    role?: string
    error?: string
  }

  const JWTHeader = z.object({
    alg: z.string(),
    typ: z.string().optional(),
  })

  const JWTPayload = z
    .object({
      role: z.string().optional(),
      exp: z.number().optional(),
      iat: z.number().optional(),
      jti: z.string().optional(),
    })
    .passthrough()

  function base64UrlDecode(str: string): Buffer {
    return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64")
  }

  const safeJson = z.string().transform((s) => JSON.parse(s))

  function parseJWTParts(
    token: string,
  ):
    | {
        header: z.infer<typeof JWTHeader>
        payload: z.infer<typeof JWTPayload>
        signatureInput: string
        signature: Buffer
      }
    | { error: string } {
    const parts = token.trim().split(".")
    if (parts.length !== 3) {
      return { error: "Invalid JWT format: expected 3 parts separated by dots" }
    }

    const headerResult = safeJson.pipe(JWTHeader).safeParse(base64UrlDecode(parts[0]).toString("utf8"))
    if (!headerResult.success) {
      return { error: `Invalid JWT header: ${headerResult.error.message}` }
    }

    const payloadResult = safeJson.pipe(JWTPayload).safeParse(base64UrlDecode(parts[1]).toString("utf8"))
    if (!payloadResult.success) {
      return { error: `Invalid JWT payload: ${payloadResult.error.message}` }
    }

    return {
      header: headerResult.data,
      payload: payloadResult.data,
      signatureInput: `${parts[0]}.${parts[1]}`,
      signature: base64UrlDecode(parts[2]),
    }
  }

  function verifySignature(signatureInput: string, signature: Buffer, publicKey: string): boolean {
    const verifier = crypto.createVerify("RSA-SHA256")
    verifier.update(signatureInput)
    return verifier.verify(publicKey, signature)
  }

  /**
   * Verify a JWT role token using RS256 signature verification.
   * Checks signature, expiration, and revocation status.
   */
  export function verifyRoleToken(tokenPath: string, publicKey: string, revokedTokens: string[] = []): VerifyResult {
    const stat = fs.statSync(tokenPath, { throwIfNoEntry: false })
    if (!stat) {
      log.debug("token file not found", { path: tokenPath })
      return { valid: false, error: `Token file not found: ${tokenPath}` }
    }

    const tokenContent = fs.readFileSync(tokenPath, "utf8").trim()
    if (!tokenContent) {
      log.debug("token file is empty", { path: tokenPath })
      return { valid: false, error: "Token file is empty" }
    }

    const parsed = parseJWTParts(tokenContent)
    if ("error" in parsed) {
      log.debug("failed to parse JWT", { path: tokenPath, error: parsed.error })
      return { valid: false, error: parsed.error }
    }

    // Verify algorithm is RS256
    if (parsed.header.alg !== "RS256") {
      return { valid: false, error: `Unsupported algorithm: ${parsed.header.alg}. Only RS256 is supported` }
    }

    // Verify signature using public key
    const signatureValid = verifySignature(parsed.signatureInput, parsed.signature, publicKey)
    if (!signatureValid) {
      log.debug("token signature verification failed", { path: tokenPath })
      return { valid: false, error: "Token signature verification failed" }
    }

    // Check expiration
    if (parsed.payload.exp !== undefined) {
      const now = Math.floor(Date.now() / 1000)
      if (now >= parsed.payload.exp) {
        log.debug("token expired", { path: tokenPath, exp: parsed.payload.exp, now })
        return { valid: false, error: "Token has expired" }
      }
    }

    // Check revocation by jti claim
    if (parsed.payload.jti && revokedTokens.includes(parsed.payload.jti)) {
      log.debug("token is revoked", { path: tokenPath, jti: parsed.payload.jti })
      return { valid: false, error: "Token has been revoked" }
    }

    // Extract role from claims
    if (!parsed.payload.role) {
      return { valid: false, error: "Token does not contain a valid 'role' claim" }
    }

    log.debug("token verified successfully", { path: tokenPath, role: parsed.payload.role })
    return { valid: true, role: parsed.payload.role }
  }
}
