import crypto from "node:crypto"
import open from "open"
import { cmd } from "./cmd"
import { FeishuAuth } from "../../auth/feishu"

const PORT_START = 19876
const PORT_END = 19885
const TIMEOUT = 5 * 60 * 1000
const FEISHU_BASE = process.env.FEISHU_BASE_URL || "https://open.feishu.cn"

const SUCCESS_HTML = `<!DOCTYPE html><html><body><h1>Authorization Successful</h1><p>You can close this window.</p></body></html>`
const FAILURE_HTML = `<!DOCTYPE html><html><body><h1>Authorization Failed</h1><p>Please try again.</p></body></html>`

export const FeishuAuthCommand = cmd({
  command: "feishu-auth",
  describe: false as any,
  builder: (yargs) =>
    yargs
      .option("issuer", {
        describe: "issuer URL",
        type: "string",
        demandOption: true,
      })
      .option("app-id", {
        describe: "Feishu app id",
        type: "string",
        demandOption: true,
      }),
  async handler(args) {
    const issuer = args.issuer.replace(/\/+$/, "")
    const appId = args["app-id"]
    const state = crypto.randomUUID()

    // Try ports 19876-19885
    let server: ReturnType<typeof Bun.serve> | undefined
    let port = 0

    for (let p = PORT_START; p <= PORT_END; p++) {
      try {
        const result = await tryPort(p, state, issuer)
        server = result.server
        port = p
        break
      } catch {
        continue
      }
    }

    if (!server) {
      process.stderr.write("Error: All ports 19876-19885 are occupied\n")
      process.exit(1)
    }

    const redirect = `http://localhost:${port}/oauth/callback`
    const authUrl =
      `${FEISHU_BASE}/open-apis/authen/v1/authorize?` +
      `app_id=${encodeURIComponent(appId)}` +
      `&redirect_uri=${encodeURIComponent(redirect)}` +
      `&state=${encodeURIComponent(state)}` +
      `&scope=contact:user.email:readonly`

    await open(authUrl)
  },
})

function tryPort(port: number, state: string, issuer: string): Promise<{ server: ReturnType<typeof Bun.serve> }> {
  return new Promise((resolve, reject) => {
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      server.stop()
      process.stderr.write("Error: Authorization timed out (5 minutes)\n")
      process.exit(1)
    }, TIMEOUT)

    const server = Bun.serve({
      port,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname !== "/oauth/callback") {
          return new Response("not found", { status: 404 })
        }

        const code = url.searchParams.get("code")
        const incoming = url.searchParams.get("state")

        if (incoming !== state) {
          return new Response(FAILURE_HTML, {
            status: 403,
            headers: { "content-type": "text/html" },
          })
        }

        if (!code) {
          return new Response(FAILURE_HTML, {
            status: 400,
            headers: { "content-type": "text/html" },
          })
        }

        // Exchange code for JWT via issuer
        try {
          const res = await fetch(`${issuer}/auth/token`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              code,
              redirect_uri: `http://localhost:${port}/oauth/callback`,
            }),
          })

          if (!res.ok) {
            const body = await res.text()
            process.stderr.write(`Error: Issuer returned ${res.status}: ${body}\n`)
            clearTimeout(timer)
            settled = true
            server.stop()
            process.exit(1)
            return new Response(FAILURE_HTML, {
              status: 502,
              headers: { "content-type": "text/html" },
            })
          }

          const data = (await res.json()) as {
            jwt: string
            refresh_token: string
            expires_at: number
            name: string
            email: string
          }

          // Write JWT to stdout (for wellknown mechanism)
          process.stdout.write(data.jwt)

          // Save metadata to feishu-auth.json
          await FeishuAuth.write({
            refresh_token: data.refresh_token,
            expires_at: data.expires_at,
            name: data.name,
            email: data.email,
            wellknown_url: issuer,
          })

          clearTimeout(timer)
          settled = true

          // Use setTimeout to stop server after response is sent
          setTimeout(() => {
            server.stop()
            process.exit(0)
          }, 100)

          return new Response(SUCCESS_HTML, {
            headers: { "content-type": "text/html" },
          })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          process.stderr.write(`Error: Failed to exchange code: ${msg}\n`)
          clearTimeout(timer)
          settled = true
          server.stop()
          process.exit(1)
          return new Response(FAILURE_HTML, {
            status: 502,
            headers: { "content-type": "text/html" },
          })
        }
      },
    })

    // Port bound successfully
    settled = false
    resolve({ server })
  })
}
