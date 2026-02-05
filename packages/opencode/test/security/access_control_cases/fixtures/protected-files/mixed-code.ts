import crypto from "crypto"

// Public code
export const APP_VERSION = "2.0.0"

// @secure-start
// Marker-protected region with sensitive constants
const MASTER_KEY = "mixed-code-master-key-for-testing"
const ENCRYPTION_IV = Buffer.alloc(16)
// @secure-end

// AST-protected function (matches encrypt|decrypt|sign|verify pattern)
export function encryptData(data: string): string {
  const cipher = crypto.createCipheriv("aes-256-cbc", MASTER_KEY, ENCRYPTION_IV)
  return cipher.update(data, "utf8", "hex") + cipher.final("hex")
}

// Public function - not protected
export function formatOutput(data: string): string {
  return `[${APP_VERSION}] ${data}`
}

// @secure-start
// Another marker-protected region
const SIGNING_SECRET = "mixed-code-signing-secret-for-testing"
// @secure-end

// AST-protected function
export const verifyPayload = (payload: string, sig: string): boolean => {
  const expected = crypto.createHmac("sha256", SIGNING_SECRET).update(payload).digest("hex")
  return expected === sig
}
