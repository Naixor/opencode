import type { Hooks, Plugin as PluginInstance } from "@opencode-ai/plugin"
import { FeishuAuth } from "../auth/feishu"
import { Auth } from "../auth"
import { Log } from "../util/log"

const log = Log.create({ service: "plugin:feishu" })

export function decode(token: string): Record<string, unknown> | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString())
  } catch {
    return null
  }
}

let pending: Promise<void> | undefined

async function doRefresh(key: string, value: { key: string; token: string }) {
  const meta = await FeishuAuth.read()
  if (!meta) return

  try {
    const res = await fetch(`${meta.wellknown_url}/auth/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value.token}`,
      },
      body: JSON.stringify({ refresh_token: meta.refresh_token }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      if (body.includes("refresh_token_expired")) {
        log.warn("Feishu refresh token expired. Run 'opencode auth login' to re-authenticate.")
        return
      }
      log.error("failed to refresh feishu token", { status: res.status, body })
      return
    }

    const data = (await res.json()) as {
      jwt: string
      refresh_token: string
      expires_at: number
    }

    // Update 1: process.env
    process.env[value.key] = data.jwt

    // Update 2: auth.json
    await Auth.set(key, {
      type: "wellknown",
      key: value.key,
      token: data.jwt,
    })

    // Update 3: feishu-auth.json
    await FeishuAuth.write({
      ...meta,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
    })

    log.info("feishu token refreshed successfully")
  } catch (e) {
    log.error("failed to refresh feishu token", { error: e instanceof Error ? e.message : String(e) })
  }
}

export const FeishuPlugin: PluginInstance = async (_input) => {
  const hooks: Hooks = {
    "chat.headers": async () => {
      const auth = await Auth.all()
      for (const [key, value] of Object.entries(auth)) {
        if (value.type !== "wellknown") continue

        const payload = decode(value.token)
        if (!payload?.exp || typeof payload.exp !== "number") continue

        const remaining = payload.exp - Date.now() / 1000
        if (remaining > 300) continue

        // Token expires within 5 minutes — coalesce concurrent refresh calls
        if (pending) {
          await pending
          return
        }

        pending = doRefresh(key, value).finally(() => {
          pending = undefined
        })
        await pending
      }
    },
  }
  return hooks
}
