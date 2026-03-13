import { sign, verify } from "./jwt"

const PORT = parseInt(process.env.PORT || "3456")
const ISSUER_URL = process.env.ISSUER_URL || ""
const APP_ID = process.env.APP_ID || ""
const APP_SECRET = process.env.APP_SECRET || ""
const RSA_PRIVATE_KEY = process.env.RSA_PRIVATE_KEY || ""
const RSA_PUBLIC_KEY = process.env.RSA_PUBLIC_KEY || ""
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com"
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ""
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""
const FEISHU_BASE_URL = process.env.FEISHU_BASE_URL || "https://open.feishu.cn"
const JWT_TTL = parseInt(process.env.JWT_TTL || String(48 * 3600))

const REDIRECT_WHITELIST = Array.from({ length: 10 }, (_, i) => `http://localhost:${19876 + i}/oauth/callback`)

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function error(msg: string, status = 400) {
  return json({ error: msg }, status)
}

// US-001: GET /.well-known/opencode
function wellknown() {
  return json({
    auth: {
      command: ["opencode", "feishu-auth", "--issuer", ISSUER_URL, "--app-id", APP_ID],
      env: "OPENCODE_FEISHU_TOKEN",
    },
    config: {
      provider: {
        anthropic: {
          options: { baseURL: ANTHROPIC_BASE_URL },
        },
        openai: {
          options: { baseURL: OPENAI_BASE_URL },
        },
      },
    },
  })
}

// US-002: POST /auth/token
async function token(req: Request) {
  const body = (await req.json().catch(() => null)) as { code?: string; redirect_uri?: string } | null
  if (!body?.code || !body?.redirect_uri) return error("missing code or redirect_uri")
  if (!REDIRECT_WHITELIST.includes(body.redirect_uri)) return error("invalid redirect_uri", 403)

  // Step 1: Get app_access_token
  const appTokenRes = await fetch(`${FEISHU_BASE_URL}/open-apis/auth/v3/app_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  })
  const appTokenData = (await appTokenRes.json()) as { app_access_token?: string; code?: number; msg?: string }
  if (!appTokenData.app_access_token) return error(appTokenData.msg || "failed to get app_access_token", 502)

  // Step 2: Exchange auth code for user_access_token
  const userTokenRes = await fetch(`${FEISHU_BASE_URL}/open-apis/authen/v1/oidc/access_token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${appTokenData.app_access_token}`,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: body.code,
      redirect_uri: body.redirect_uri,
    }),
  })
  const userTokenData = (await userTokenRes.json()) as {
    data?: { access_token?: string; refresh_token?: string; refresh_expires_in?: number }
    code?: number
    msg?: string
  }
  if (!userTokenData.data?.access_token) return error(userTokenData.msg || "failed to exchange code", 502)

  // Step 3: Fetch user info
  const userInfoRes = await fetch(`${FEISHU_BASE_URL}/open-apis/authen/v1/user_info`, {
    headers: { authorization: `Bearer ${userTokenData.data.access_token}` },
  })
  const userInfoData = (await userInfoRes.json()) as {
    data?: { open_id?: string; name?: string; email?: string }
    code?: number
    msg?: string
  }
  if (!userInfoData.data?.open_id) return error(userInfoData.msg || "failed to get user info", 502)

  // Step 4: Sign JWT
  const jwt = sign(
    {
      sub: userInfoData.data.open_id,
      email: userInfoData.data.email,
      name: userInfoData.data.name,
    },
    RSA_PRIVATE_KEY,
    JWT_TTL,
  )

  return json({
    jwt,
    refresh_token: userTokenData.data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + JWT_TTL,
    name: userInfoData.data.name,
    email: userInfoData.data.email,
  })
}

// US-003: POST /auth/refresh
async function refresh(req: Request) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
  if (!bearer) return error("missing authorization header", 401)

  const body = (await req.json().catch(() => null)) as { refresh_token?: string } | null
  if (!body?.refresh_token) return error("missing refresh_token")

  // Verify JWT signature but allow expired
  let payload: Record<string, unknown>
  try {
    payload = verify(bearer, RSA_PUBLIC_KEY, { ignoreExpiration: true })
  } catch {
    return error("invalid jwt", 401)
  }

  // Get app_access_token for refresh
  const appTokenRes = await fetch(`${FEISHU_BASE_URL}/open-apis/auth/v3/app_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  })
  const appTokenData = (await appTokenRes.json()) as { app_access_token?: string; msg?: string }
  if (!appTokenData.app_access_token) return error("failed to get app_access_token", 502)

  // Refresh Feishu token
  const refreshRes = await fetch(`${FEISHU_BASE_URL}/open-apis/authen/v1/oidc/refresh_access_token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${appTokenData.app_access_token}`,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: body.refresh_token,
    }),
  })
  const refreshData = (await refreshRes.json()) as {
    data?: { refresh_token?: string }
    code?: number
    msg?: string
  }

  if (!refreshData.data?.refresh_token) {
    const expired = refreshData.code === 20004 || refreshData.msg?.includes("expired")
    return error(expired ? "refresh_token_expired" : refreshData.msg || "refresh failed", expired ? 401 : 502)
  }

  const jwt = sign({ sub: payload.sub, email: payload.email, name: payload.name }, RSA_PRIVATE_KEY, JWT_TTL)

  return json({
    jwt,
    refresh_token: refreshData.data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + JWT_TTL,
  })
}

// US-004: Reverse proxy
const ROUTES: Record<string, { upstream: string; key: string }> = {
  "/v1/anthropic": { upstream: ANTHROPIC_BASE_URL, key: ANTHROPIC_API_KEY },
  "/v1/openai": { upstream: OPENAI_BASE_URL, key: OPENAI_API_KEY },
}

async function proxy(req: Request, url: URL) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
  if (!bearer) return error("missing authorization", 401)

  try {
    verify(bearer, RSA_PUBLIC_KEY)
  } catch (e) {
    return error(e instanceof Error ? e.message : "invalid token", 401)
  }

  for (const [prefix, route] of Object.entries(ROUTES)) {
    if (!url.pathname.startsWith(prefix)) continue
    const target = url.pathname.slice(prefix.length)
    const upstream = `${route.upstream}${target}${url.search}`
    const headers = new Headers(req.headers)
    headers.set("authorization", `Bearer ${route.key}`)
    headers.delete("host")

    const res = await fetch(upstream, {
      method: req.method,
      headers,
      body: req.body,
      duplex: "half" as const,
    })

    // Pass through SSE/streaming responses, stripping encoding to avoid
    // double-decompression issues when intermediary and client both decode
    const fwd = new Headers(res.headers)
    fwd.delete("content-encoding")
    fwd.delete("content-length")
    return new Response(res.body, {
      status: res.status,
      headers: fwd,
    })
  }

  return error("not found", 404)
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/.well-known/opencode" && req.method === "GET") return wellknown()
    if (url.pathname === "/auth/token" && req.method === "POST") return token(req)
    if (url.pathname === "/auth/refresh" && req.method === "POST") return refresh(req)
    if (url.pathname.startsWith("/v1/")) return proxy(req, url)

    return error("not found", 404)
  },
})

console.log(`Feishu auth server running on http://localhost:${server.port}`)
