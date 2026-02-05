import { cmd } from "../cmd"
import crypto from "crypto"
import path from "path"
import fs from "fs"

const PRIVATE_KEY_FILE = ".opencode-security-key.pem"

function base64UrlEncode(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function getGitRemote(): string | undefined {
  const result = Bun.spawnSync(["git", "remote", "get-url", "origin"], { stderr: "pipe" })
  if (result.exitCode !== 0) return undefined
  return result.stdout.toString().trim() || undefined
}

function createJWT(payload: Record<string, unknown>, privateKey: string, passphrase?: string): string {
  const header = { alg: "RS256", typ: "JWT" }
  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)))
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)))
  const signatureInput = `${headerB64}.${payloadB64}`

  const sign = crypto.createSign("RSA-SHA256")
  sign.update(signatureInput)
  const signature = passphrase
    ? sign.sign({ key: privateKey, passphrase })
    : sign.sign(privateKey)
  const signatureB64 = base64UrlEncode(signature)

  return `${signatureInput}.${signatureB64}`
}

export const SecurityIssueTokenCommand = cmd({
  command: "issue-token",
  describe: "generate a signed JWT role token for team members",
  builder: (yargs) =>
    yargs
      .option("role", {
        type: "string",
        describe: "role name to assign to the token",
        demandOption: true,
      })
      .option("expires", {
        type: "number",
        describe: "number of days until token expires",
        default: 30,
      })
      .option("passphrase", {
        type: "string",
        describe: "passphrase for encrypted private key",
      })
      .option("output", {
        type: "string",
        alias: "o",
        describe: "output file path (defaults to stdout)",
      }),
  handler: async (args) => {
    const role = args.role as string
    const expires = args.expires as number
    const passphrase = args.passphrase as string | undefined
    const output = args.output as string | undefined

    const privateKeyPath = path.resolve(process.cwd(), PRIVATE_KEY_FILE)

    if (!fs.existsSync(privateKeyPath)) {
      console.error(`Error: Private key not found at ${privateKeyPath}`)
      console.error("Run 'opencode security init-keys' first to generate a key pair.")
      process.exitCode = 1
      return
    }

    const privateKey = fs.readFileSync(privateKeyPath, "utf8")

    const now = Math.floor(Date.now() / 1000)
    const exp = now + expires * 24 * 60 * 60
    const jti = crypto.randomUUID()

    const project = getGitRemote()

    const payload: Record<string, unknown> = {
      role,
      iat: now,
      exp,
      jti,
    }
    if (project) {
      payload.project = project
    }

    const token = createJWT(payload, privateKey, passphrase)

    if (output) {
      const outputPath = path.resolve(process.cwd(), output)
      fs.writeFileSync(outputPath, token, "utf-8")
      console.log(`Token saved to: ${outputPath}`)
    } else {
      console.log(token)
    }

    console.error()
    console.error(`Role: ${role}`)
    console.error(`Expires: ${new Date(exp * 1000).toISOString()} (${expires} days)`)
    console.error(`Token ID: ${jti}`)
    if (project) {
      console.error(`Project: ${project}`)
    }
  },
})
