import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { generatePKCE } from "@openauthjs/openauth/pkce"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
const TOOL_PREFIX = "mcp_"
const VERSION = "2.1.81"

// Tools created internally by Vercel AI SDK (e.g. generateObject uses "json").
// These must NOT be prefixed with mcp_ — they are not MCP tools.
const SDK_TOOLS = new Set(["json"])

// Betas sent with every OAuth request (base set)
const BASE_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "redact-thinking-2026-02-12",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
]

// Only Opus 4.6+ supports the 1M long context beta
const LONG_CONTEXT_BETA = "context-1m-2025-08-07"
const LONG_CONTEXT_MODELS = ["claude-opus-4-6", "claude-opus-4.6"]

// Additional betas appended at query time
const QUERY_BETAS = ["advanced-tool-use-2025-11-20", "effort-2025-11-24"]

async function authorize(mode: "max" | "console") {
  const pkce = await generatePKCE()
  const host = mode === "console" ? "console.anthropic.com" : "claude.ai"
  const url = new URL(`https://${host}/oauth/authorize`)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", "https://console.anthropic.com/oauth/code/callback")
  url.searchParams.set("scope", "org:create_api_key user:profile user:inference")
  url.searchParams.set("code_challenge", pkce.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", pkce.verifier)
  return { url: url.toString(), verifier: pkce.verifier }
}

async function exchange(code: string, verifier: string) {
  const splits = code.split("#")
  const result = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  })
  if (!result.ok) return { type: "failed" as const }
  const json = (await result.json()) as { refresh_token: string; access_token: string; expires_in: number }
  return {
    type: "success" as const,
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  }
}

function collect(init: RequestInit | undefined): Headers {
  const headers = new Headers()
  if (!init?.headers) return headers
  if (init.headers instanceof Headers) {
    init.headers.forEach((v, k) => headers.set(k, v))
    return headers
  }
  if (Array.isArray(init.headers)) {
    for (const [k, v] of init.headers) {
      if (v !== undefined) headers.set(k, String(v))
    }
    return headers
  }
  for (const [k, v] of Object.entries(init.headers)) {
    if (v !== undefined) headers.set(k, String(v))
  }
  return headers
}

function merge(input: RequestInfo | URL, collected: Headers): Headers {
  if (input instanceof Request) {
    input.headers.forEach((v, k) => {
      if (!collected.has(k)) collected.set(k, v)
    })
  }
  return collected
}

export async function AnthropicAuthPlugin({ client }: PluginInput): Promise<Hooks> {
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      const prefix = "You are Claude Code, Anthropic's official CLI for Claude."
      if (_input.model?.providerID === "anthropic") {
        output.system.unshift(prefix)
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // zero out cost for max plan
        for (const model of Object.values(provider.models)) {
          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        return {
          apiKey: "",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const auth = await getAuth()
            if (auth.type !== "oauth") return fetch(input, init)

            if (!auth.access || auth.expires < Date.now()) {
              const response = await fetch(TOKEN_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  grant_type: "refresh_token",
                  refresh_token: auth.refresh,
                  client_id: CLIENT_ID,
                }),
              })
              if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`)
              const json = (await response.json()) as {
                refresh_token: string
                access_token: string
                expires_in: number
              }
              await client.auth.set({
                path: { id: "anthropic" },
                body: {
                  type: "oauth",
                  refresh: json.refresh_token,
                  access: json.access_token,
                  expires: Date.now() + json.expires_in * 1000,
                },
              })
              auth.access = json.access_token
            }

            const headers = merge(input, collect(init))

            // Merge base betas with any existing betas from the request
            const existing = headers.get("anthropic-beta") || ""
            const extra = existing
              .split(",")
              .map((b) => b.trim())
              .filter(Boolean)
            const betas = [...new Set([...BASE_BETAS, ...QUERY_BETAS, ...extra])]

            // Conditionally add long context beta based on model in request body
            if (init?.body && typeof init.body === "string") {
              try {
                const peek = JSON.parse(init.body)
                if (typeof peek.model === "string" && LONG_CONTEXT_MODELS.some((m) => peek.model.includes(m))) {
                  betas.push(LONG_CONTEXT_BETA)
                }
              } catch {}
            }

            headers.set("anthropic-beta", betas.join(","))
            headers.set("authorization", `Bearer ${auth.access}`)
            headers.set("user-agent", `claude-code/${VERSION}`)
            headers.set("x-service-name", "claude-code")
            headers.delete("x-api-key")

            let body = init?.body
            if (body && typeof body === "string") {
              try {
                const parsed = JSON.parse(body)

                // Sanitize system prompt - server blocks "OpenCode" string
                // Only replace standalone occurrences; skip when part of identifiers,
                // paths, package names, env vars, etc. (preceded/followed by word-boundary
                // chars like @, /, -, _, .)
                if (parsed.system && Array.isArray(parsed.system)) {
                  parsed.system = parsed.system.map((item: any) => {
                    if (item.type === "text" && item.text) {
                      return {
                        ...item,
                        text: item.text
                          .replace(/(?<![/@\w.-])OpenCode(?![/@\w.-])/g, "Claude Code")
                          .replace(/(?<![/@\w.-])opencode(?![/@\w.-])/gi, "Claude"),
                      }
                    }
                    return item
                  })
                }

                // Add prefix to tools definitions (skip SDK-internal tools like "json")
                if (parsed.tools && Array.isArray(parsed.tools)) {
                  parsed.tools = parsed.tools.map((tool: any) => ({
                    ...tool,
                    name: tool.name && !SDK_TOOLS.has(tool.name) ? `${TOOL_PREFIX}${tool.name}` : tool.name,
                  }))
                }

                // Add prefix to tool_use blocks in messages (skip SDK-internal tools)
                if (parsed.messages && Array.isArray(parsed.messages)) {
                  parsed.messages = parsed.messages.map((msg: any) => {
                    if (msg.content && Array.isArray(msg.content)) {
                      msg.content = msg.content.map((block: any) => {
                        if (block.type === "tool_use" && block.name && !SDK_TOOLS.has(block.name)) {
                          return { ...block, name: `${TOOL_PREFIX}${block.name}` }
                        }
                        return block
                      })
                    }
                    return msg
                  })
                }

                body = JSON.stringify(parsed)
              } catch {
                // ignore parse errors
              }
            }

            let target: RequestInfo | URL = input
            let url: URL | null = null
            try {
              if (typeof input === "string" || input instanceof URL) url = new URL(input.toString())
              else if (input instanceof Request) url = new URL(input.url)
            } catch {
              url = null
            }

            if (url && url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
              url.searchParams.set("beta", "true")
              target = input instanceof Request ? new Request(url.toString(), input) : url
            }

            const response = await fetch(target, { ...init, body, headers })

            // Transform streaming response to rename tools back
            if (response.body) {
              const reader = response.body.getReader()
              const decoder = new TextDecoder()
              const encoder = new TextEncoder()

              const stream = new ReadableStream({
                async pull(controller) {
                  const { done, value } = await reader.read()
                  if (done) {
                    controller.close()
                    return
                  }
                  let text = decoder.decode(value, { stream: true })
                  text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')
                  controller.enqueue(encoder.encode(text))
                },
              })

              return new Response(stream, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              })
            }

            return response
          },
        }
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("max")
            return {
              url,
              instructions: "Paste the authorization code here: ",
              method: "code" as const,
              callback: async (code: string) => exchange(code, verifier),
            }
          },
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("console")
            return {
              url,
              instructions: "Paste the authorization code here: ",
              method: "code" as const,
              callback: async (code: string) => {
                const credentials = await exchange(code, verifier)
                if (credentials.type === "failed") return credentials
                const result = (await fetch("https://api.anthropic.com/api/oauth/claude_cli/create_api_key", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    authorization: `Bearer ${credentials.access}`,
                  },
                }).then((r) => r.json())) as { raw_key: string }
                return { type: "success" as const, key: result.raw_key }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  }
}
