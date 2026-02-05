import crypto from "crypto"

// Public helper function - should NOT be protected
export function hashData(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex")
}

// AST-protected functions matching pattern: encrypt|decrypt|sign|verify
export function encryptData(plaintext: string, key: string): string {
  const cipher = crypto.createCipheriv("aes-256-gcm", key, crypto.randomBytes(12))
  return cipher.update(plaintext, "utf8", "hex") + cipher.final("hex")
}

export function decryptPayload(ciphertext: string, key: string): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.alloc(12))
  return decipher.update(ciphertext, "hex", "utf8") + decipher.final("utf8")
}

export const signToken = (payload: object, secret: string): string => {
  return crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex")
}

export const verifySignature = (data: string, signature: string, secret: string): boolean => {
  const expected = crypto.createHmac("sha256", secret).update(data).digest("hex")
  return expected === signature
}

// Public utility - should NOT be protected
export function generateNonce(): string {
  return crypto.randomBytes(16).toString("hex")
}
