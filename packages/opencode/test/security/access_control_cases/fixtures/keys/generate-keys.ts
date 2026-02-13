import crypto from "crypto"
import fs from "fs"
import path from "path"

const keysDir = path.dirname(new URL(import.meta.url).pathname)

const generateKeyPair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  })
  return { publicKey, privateKey }
}

const testKeyPairPath = path.join(keysDir, "test-private.pem")
const testPublicPath = path.join(keysDir, "test-public.pem")
const wrongKeyPath = path.join(keysDir, "wrong-private.pem")

const needsGeneration =
  !fs.existsSync(testKeyPairPath) || !fs.existsSync(testPublicPath) || !fs.existsSync(wrongKeyPath)

if (needsGeneration) {
  console.log("Generating test RSA key pairs...")

  const testPair = generateKeyPair()
  fs.writeFileSync(testKeyPairPath, testPair.privateKey)
  fs.writeFileSync(testPublicPath, testPair.publicKey)
  console.log("  Created test-private.pem and test-public.pem")

  const wrongPair = generateKeyPair()
  fs.writeFileSync(wrongKeyPath, wrongPair.privateKey)
  console.log("  Created wrong-private.pem (different key for forgery tests)")

  console.log("Done.")
} else {
  console.log("All key files already exist, skipping generation.")
}
