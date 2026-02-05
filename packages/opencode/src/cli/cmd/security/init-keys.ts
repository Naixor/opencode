import { cmd } from "../cmd"
import crypto from "crypto"
import path from "path"
import fs from "fs"

const PRIVATE_KEY_FILE = ".opencode-security-key.pem"

export const SecurityInitKeysCommand = cmd({
  command: "init-keys",
  describe: "generate an RSA key pair for signing role tokens",
  builder: (yargs) =>
    yargs.option("passphrase", {
      type: "string",
      describe: "passphrase to encrypt the private key",
    }),
  handler: async (args) => {
    const privateKeyPath = path.resolve(process.cwd(), PRIVATE_KEY_FILE)

    if (fs.existsSync(privateKeyPath)) {
      console.error(`Error: ${privateKeyPath} already exists. Remove it first if you want to regenerate.`)
      process.exitCode = 1
      return
    }

    const passphrase = args.passphrase as string | undefined

    const keyPairOptions: crypto.RSAKeyPairOptions<"pem", "pem"> = {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: "spki",
        format: "pem",
      },
      privateKeyEncoding: passphrase
        ? {
            type: "pkcs8",
            format: "pem",
            cipher: "aes-256-cbc",
            passphrase,
          }
        : {
            type: "pkcs8",
            format: "pem",
          },
    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", keyPairOptions)

    fs.writeFileSync(privateKeyPath, privateKey, "utf-8")
    console.log(`Private key saved to: ${privateKeyPath}`)
    console.log()
    console.log("WARNING: Add this file to .gitignore to prevent committing the private key:")
    console.log(`  echo '${PRIVATE_KEY_FILE}' >> .gitignore`)
    console.log()
    if (passphrase) {
      console.log("Private key is encrypted with the provided passphrase.")
      console.log()
    }
    console.log("Add the following public key to your .opencode-security.json under authentication.publicKey:")
    console.log()
    console.log(publicKey)
  },
})
