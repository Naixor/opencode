import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import crypto from "node:crypto"
import { sign } from "../src/jwt"

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
})

// Mock Feishu API server
let feishuMock: ReturnType<typeof Bun.serve>

// Upstream API mock (simulates Anthropic/OpenAI)
let upstreamMock: ReturnType<typeof Bun.serve>

// The feishu-server under test (subprocess)
let proc: Bun.Subprocess
let serverPort = 0

beforeAll(async () => {
  // Start mock Feishu API
  feishuMock = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/open-apis/auth/v3/app_access_token/internal") {
        return Response.json({ app_access_token: "mock_app_token", code: 0 })
      }

      if (url.pathname === "/open-apis/authen/v1/oidc/access_token") {
        return Response.json({
          code: 0,
          data: {
            access_token: "mock_user_token",
            refresh_token: "mock_refresh_token",
            refresh_expires_in: 2592000,
          },
        })
      }

      if (url.pathname === "/open-apis/authen/v1/user_info") {
        return Response.json({
          code: 0,
          data: { open_id: "ou_test123", name: "Test User", email: "test@example.com" },
        })
      }

      if (url.pathname === "/open-apis/authen/v1/oidc/refresh_access_token") {
        return Response.json({
          code: 0,
          data: { refresh_token: "new_refresh_token" },
        })
      }

      return Response.json({ error: "not found" }, { status: 404 })
    },
  })

  // Start mock upstream (Anthropic/OpenAI)
  upstreamMock = Bun.serve({
    port: 0,
    fetch(req) {
      const auth = req.headers.get("authorization")
      return Response.json({ received: true, auth, path: new URL(req.url).pathname })
    },
  })

  // Start the server as a subprocess so it gets fresh env
  serverPort = 10000 + Math.floor(Math.random() * 50000)
  const root = new URL("..", import.meta.url).pathname
  proc = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PORT: String(serverPort),
      ISSUER_URL: `http://localhost:${serverPort}`,
      APP_ID: "cli_test",
      APP_SECRET: "test_secret",
      RSA_PRIVATE_KEY: privateKey,
      RSA_PUBLIC_KEY: publicKey,
      ANTHROPIC_BASE_URL: `http://localhost:${upstreamMock.port}`,
      OPENAI_BASE_URL: `http://localhost:${upstreamMock.port}`,
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENAI_API_KEY: "sk-oai-test",
      FEISHU_BASE_URL: `http://localhost:${feishuMock.port}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  // Wait for server to be ready (up to 8 seconds)
  let ready = false
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://localhost:${serverPort}/.well-known/opencode`)
      if (res.ok) {
        ready = true
        break
      }
    } catch {
      // not ready yet
    }
    await Bun.sleep(100)
  }

  if (!ready) {
    const err = await new Response(proc.stderr as ReadableStream).text()
    const out = await new Response(proc.stdout as ReadableStream).text()
    throw new Error(`Server failed to start on port ${serverPort}\nstdout: ${out}\nstderr: ${err}`)
  }
})

afterAll(() => {
  proc?.kill()
  feishuMock?.stop()
  upstreamMock?.stop()
})

describe("GET /.well-known/opencode", () => {
  test("returns auth command and provider config", async () => {
    const res = await fetch(`http://localhost:${serverPort}/.well-known/opencode`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.auth.command).toContain("feishu-auth")
    expect(body.auth.env).toBe("OPENCODE_FEISHU_TOKEN")
    expect(body.config.provider.anthropic).toBeDefined()
    expect(body.config.provider.openai).toBeDefined()
  })
})

describe("POST /auth/token", () => {
  test("rejects missing code", async () => {
    const res = await fetch(`http://localhost:${serverPort}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uri: "http://localhost:19876/oauth/callback" }),
    })
    expect(res.status).toBe(400)
  })

  test("rejects invalid redirect_uri", async () => {
    const res = await fetch(`http://localhost:${serverPort}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "test", redirect_uri: "http://evil.com/callback" }),
    })
    expect(res.status).toBe(403)
  })

  test("exchanges code for JWT via Feishu APIs", async () => {
    const res = await fetch(`http://localhost:${serverPort}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "test_code",
        redirect_uri: "http://localhost:19876/oauth/callback",
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.jwt).toBeTypeOf("string")
    expect(body.jwt.split(".")).toHaveLength(3)
    expect(body.refresh_token).toBe("mock_refresh_token")
    expect(body.name).toBe("Test User")
    expect(body.email).toBe("test@example.com")
    expect(body.expires_at).toBeTypeOf("number")
  })
})

describe("POST /auth/refresh", () => {
  test("rejects missing authorization header", async () => {
    const res = await fetch(`http://localhost:${serverPort}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: "rt" }),
    })
    expect(res.status).toBe(401)
  })

  test("rejects invalid JWT signature", async () => {
    const other = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    })
    const bad = sign({ sub: "u1" }, other.privateKey)
    const res = await fetch(`http://localhost:${serverPort}/auth/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bad}`,
      },
      body: JSON.stringify({ refresh_token: "rt" }),
    })
    expect(res.status).toBe(401)
  })

  test("refreshes expired JWT successfully", async () => {
    const expired = sign({ sub: "ou_test123", email: "test@example.com", name: "Test" }, privateKey, -10)
    const res = await fetch(`http://localhost:${serverPort}/auth/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${expired}`,
      },
      body: JSON.stringify({ refresh_token: "old_refresh" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.jwt).toBeTypeOf("string")
    expect(body.refresh_token).toBe("new_refresh_token")
    expect(body.expires_at).toBeTypeOf("number")
  })
})

describe("Reverse proxy /v1/*", () => {
  test("rejects request without JWT", async () => {
    const res = await fetch(`http://localhost:${serverPort}/v1/anthropic/v1/messages`, {
      method: "POST",
    })
    expect(res.status).toBe(401)
  })

  test("rejects expired JWT", async () => {
    const expired = sign({ sub: "u1" }, privateKey, -10)
    const res = await fetch(`http://localhost:${serverPort}/v1/anthropic/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${expired}` },
    })
    expect(res.status).toBe(401)
  })

  test("proxies to anthropic upstream with server-issued JWT", async () => {
    // Get a JWT from the server's own /auth/token endpoint
    const tokenRes = await fetch(`http://localhost:${serverPort}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "proxy_test_code",
        redirect_uri: "http://localhost:19876/oauth/callback",
      }),
    })
    const { jwt } = (await tokenRes.json()) as { jwt: string }

    const res = await fetch(`http://localhost:${serverPort}/v1/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ test: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.received).toBe(true)
    expect(body.auth).toBe("Bearer sk-ant-test")
    expect(body.path).toBe("/v1/messages")
  })

  test("proxies to openai upstream with server-issued JWT", async () => {
    const tokenRes = await fetch(`http://localhost:${serverPort}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "proxy_test_code2",
        redirect_uri: "http://localhost:19877/oauth/callback",
      }),
    })
    const { jwt } = (await tokenRes.json()) as { jwt: string }

    const res = await fetch(`http://localhost:${serverPort}/v1/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ test: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.auth).toBe("Bearer sk-oai-test")
    expect(body.path).toBe("/v1/chat/completions")
  })

  test("returns 404 for unknown proxy route", async () => {
    const token = sign({ sub: "u1" }, privateKey)
    const res = await fetch(`http://localhost:${serverPort}/v1/unknown/endpoint`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(404)
  })
})
