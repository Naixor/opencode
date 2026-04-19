import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "fs/promises"
import { request } from "node:http"
import path from "path"
import { Auth } from "../../src/auth"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

await Log.init({ print: false })

type ServerOpts = {
  profile?: string
  port?: number
  host?: string
  env?: Record<string, string | undefined>
  extraDaemonStartArgs?: string[]
  readyTimeoutMs?: number
}

const calls = {
  server: [] as ServerOpts[],
  client: [] as { baseUrl: string }[],
  start: 0,
  stop: 0,
  health: 0,
}

const flags = {
  start_ms: 0,
  health_ms: 0,
  start_fail: false,
  start_err: "",
  start_hook: undefined as undefined | (() => void | Promise<void>),
  health_ok: true,
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function post(url: string, body: unknown, auth?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: auth } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          })
        })
        res.on("error", reject)
      },
    )
    req.on("error", reject)
    req.write(JSON.stringify(body))
    req.end()
  })
}

async function logs(at = 0) {
  await wait(10)
  return (
    await Bun.file(Log.file())
      .text()
      .catch(() => "")
  ).slice(at)
}

async function mark() {
  return (
    await Bun.file(Log.file())
      .text()
      .catch(() => "")
  ).length
}

mock.module("@vectorize-io/hindsight-all", () => ({
  HindsightServer: class HindsightServer {
    opts: ServerOpts

    constructor(opts: ServerOpts = {}) {
      this.opts = opts
      calls.server.push({ ...opts })
    }

    getBaseUrl() {
      return `http://${this.opts.host ?? "127.0.0.1"}:${this.opts.port ?? 8888}`
    }

    getProfile() {
      return this.opts.profile ?? "default"
    }

    async start() {
      calls.start++
      await flags.start_hook?.()
      await wait(flags.start_ms)
      if (flags.start_err && this.opts.env?.HINDSIGHT_API_LLM_PROVIDER !== "none") throw new Error(flags.start_err)
      if (flags.start_fail) throw new Error("start failed")
    }

    async stop() {
      calls.stop++
    }

    async checkHealth() {
      calls.health++
      await wait(flags.health_ms)
      return flags.health_ok
    }
  },
  consoleLogger: console,
  getEmbedCommand: () => ["uvx", "hindsight-embed"],
  silentLogger: {
    debug() {},
    info() {},
    warn() {},
    error() {},
  },
}))

mock.module("@vectorize-io/hindsight-client", () => ({
  HindsightClient: class HindsightClient {
    opts: { baseUrl: string }

    constructor(opts: { baseUrl: string }) {
      this.opts = opts
      calls.client.push(opts)
    }
  },
  createConfig(input: { baseUrl: string }) {
    return input
  },
  createClient(input: { baseUrl: string }) {
    return { baseUrl: input.baseUrl }
  },
  sdk: {
    async getDocument() {
      return { data: {} }
    },
    async getDocuments() {
      return { data: [] }
    },
    async getOperation() {
      return { data: {} }
    },
    async getOperations() {
      return { data: [] }
    },
  },
}))

const { MemoryHindsightService } = await import("../../src/memory/hindsight/service")

function cfg(input: { startup_timeout_ms: number; query_timeout_ms: number }) {
  return {
    enabled: true,
    mode: "embedded" as const,
    extract: true,
    recall: true,
    backfill: true,
    workspace_scope: "worktree" as const,
    context_max_items: 6,
    context_max_tokens: 1200,
    ...input,
  }
}

function reset() {
  calls.server.length = 0
  calls.client.length = 0
  calls.start = 0
  calls.stop = 0
  calls.health = 0
  flags.start_ms = 0
  flags.health_ms = 0
  flags.start_fail = false
  flags.start_err = ""
  flags.start_hook = undefined
  flags.health_ok = true
}

beforeEach(() => {
  reset()
})

afterEach(async () => {
  await Auth.remove("openai")
  await Instance.disposeAll()
})

describe("MemoryHindsightService", () => {
  test("starts lazily on loopback and reuses one handle per worktree", async () => {
    const at = await mark()
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 50 }),
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await MemoryHindsightService.get()).status).toBe("stopped")
        const one = await MemoryHindsightService.ready()
        const two = await MemoryHindsightService.ready()
        expect(one?.status).toBe("ready")
        expect(two?.client).toBe(one?.client)
        expect(two?.base_url).toBe(one?.base_url)
        expect(await MemoryHindsightService.health()).toBe(true)
        expect((await MemoryHindsightService.get()).status).toBe("ready")
      },
    })

    expect(calls.server).toHaveLength(1)
    expect(calls.client).toHaveLength(1)
    expect(calls.start).toBe(1)
    expect(calls.server[0]).toMatchObject({
      host: "127.0.0.1",
      readyTimeoutMs: 50,
    })
    expect(calls.client[0]?.baseUrl).toBe(`http://127.0.0.1:${calls.server[0]?.port}`)
    const text = await logs(at)
    expect(text).toContain("starting hindsight")
    expect(text).toContain("hindsight health check started")
    expect(text).toContain("hindsight health check completed")
    expect(text).toContain("hindsight ready")
    expect(text).toContain("duration=")
  })

  test("forwards configured hindsight llm settings to the daemon", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        provider: {
          openai: {
            options: {
              baseURL: "https://api.openai.test/v1",
            },
          },
        },
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 50 }),
            llm_model: "openai/gpt-5.4-responses",
          },
        },
      },
    })

    await Auth.set("openai", { type: "api", key: "secret" })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await MemoryHindsightService.ready())?.status).toBe("ready")
      },
    })

    expect(calls.server[0]?.env).toMatchObject({
      HINDSIGHT_API_LLM_PROVIDER: "openai",
      HINDSIGHT_API_LLM_MODEL: "gpt-5.4-responses",
      HINDSIGHT_API_LLM_BASE_URL: "https://api.openai.test/v1",
      HINDSIGHT_API_LLM_API_KEY: "secret",
    })
  })

  test("uses the primary opencode model when hindsight llm is not configured", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "openai/gpt-5.4-responses",
        provider: {
          openai: {
            options: {
              baseURL: "https://api.openai.test/v1",
            },
          },
        },
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 50 }),
          },
        },
      },
    })

    await Auth.set("openai", { type: "api", key: "secret" })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await MemoryHindsightService.ready())?.status).toBe("ready")
      },
    })

    expect(calls.server[0]?.env).toMatchObject({
      HINDSIGHT_API_LLM_PROVIDER: "openai",
      HINDSIGHT_API_LLM_MODEL: "gpt-5.4-responses",
      HINDSIGHT_API_LLM_BASE_URL: "https://api.openai.test/v1",
      HINDSIGHT_API_LLM_API_KEY: "secret",
    })
  })

  test("accepts provider slash model in llm_provider for backwards compatibility", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        provider: {
          openai: {
            options: {
              baseURL: "https://api.openai.test/v1",
            },
          },
        },
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 50 }),
            llm_provider: "openai/gpt-5.4-responses",
          },
        },
      },
    })

    await Auth.set("openai", { type: "api", key: "secret" })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await MemoryHindsightService.ready())?.status).toBe("ready")
      },
    })

    expect(calls.server[0]?.env).toMatchObject({
      HINDSIGHT_API_LLM_PROVIDER: "openai",
      HINDSIGHT_API_LLM_MODEL: "gpt-5.4-responses",
      HINDSIGHT_API_LLM_BASE_URL: "https://api.openai.test/v1",
      HINDSIGHT_API_LLM_API_KEY: "secret",
    })
  })

  test("proxies oauth-backed openai auth for hindsight llm startup", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        provider: {
          openai: {
            options: {
              baseURL: "https://api.openai.test/v1",
            },
          },
        },
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 50 }),
            llm_model: "openai/gpt-5.4-responses",
          },
        },
      },
    })

    await Auth.set("openai", {
      type: "oauth",
      access: "oauth-access",
      refresh: "oauth-refresh",
      expires: Date.now() + 60_000,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await MemoryHindsightService.ready())?.status).toBe("ready")
      },
    })

    expect(calls.server[0]?.env).toMatchObject({
      HINDSIGHT_API_LLM_PROVIDER: "openai",
      HINDSIGHT_API_LLM_MODEL: "gpt-5.4-responses",
    })
    expect(calls.server[0]?.env?.HINDSIGHT_API_LLM_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    expect(calls.server[0]?.env?.HINDSIGHT_API_LLM_API_KEY).toBeTruthy()
    expect(calls.server[0]?.env?.HINDSIGHT_API_LLM_API_KEY).not.toBe("oauth-access")
  })

  test("translates hindsight chat completions through the oauth proxy", async () => {
    const hit: Array<{
      url: string
      auth: string | null
      originator: string | null
      account: string | null
      body: any
    }> = []
    const fn = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      hit.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
        originator: new Headers(init?.headers).get("originator"),
        account: new Headers(init?.headers).get("ChatGPT-Account-Id"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return new Response(
        [
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}`,
          `event: response.completed\ndata: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_1",
              created_at: 123,
              model: "gpt-5.4-responses",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  id: "msg_1",
                  content: [{ type: "output_text", text: "ok", annotations: [] }],
                },
              ],
              usage: {
                input_tokens: 7,
                output_tokens: 3,
                total_tokens: 10,
              },
            },
          })}`,
        ].join("\n\n") + "\n\n",
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      )
    }, globalThis.fetch)
    spyOn(globalThis, "fetch").mockImplementation(fn)

    await using tmp = await tmpdir({
      git: true,
      config: {
        provider: {
          openai: {
            options: {
              baseURL: "https://api.openai.test/v1",
            },
          },
        },
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 50 }),
            llm_model: "openai/gpt-5.4-responses",
          },
        },
      },
    })

    await Auth.set("openai", {
      type: "oauth",
      access: "oauth-access",
      refresh: "oauth-refresh",
      expires: Date.now() + 60_000,
      accountId: "acct_123",
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await MemoryHindsightService.ready())?.status).toBe("ready")
        const base = calls.server[0]?.env?.HINDSIGHT_API_LLM_BASE_URL
        const key = calls.server[0]?.env?.HINDSIGHT_API_LLM_API_KEY
        expect(base).toBeTruthy()
        expect(key).toBeTruthy()

        const res = await post(
          `${base}/chat/completions`,
          {
            model: "gpt-5.4-responses",
            messages: [
              { role: "system", content: "You are helpful." },
              { role: "user", content: "Hello" },
            ],
            max_tokens: 123,
            temperature: 0.2,
          },
          `Bearer ${key}`,
        )

        expect(res.status).toBe(200)
        expect(JSON.parse(res.body)).toMatchObject({
          object: "chat.completion",
          model: "gpt-5.4-responses",
          choices: [
            {
              message: {
                role: "assistant",
                content: "ok",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 3,
            total_tokens: 10,
          },
        })
      },
    })

    expect(hit).toHaveLength(1)
    expect(hit[0]).toMatchObject({
      url: "https://chatgpt.com/backend-api/codex/responses",
      auth: "Bearer oauth-access",
      originator: "opencode",
      account: "acct_123",
      body: {
        model: "gpt-5.4-responses",
        instructions: expect.any(String),
        input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
        temperature: 0.2,
        store: false,
        stream: true,
      },
    })
  })

  test("disables hindsight llm when provider is none", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 50 }),
            llm_provider: "none",
            llm_model: "openai/gpt-5.4-responses",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await MemoryHindsightService.ready())?.status).toBe("ready")
      },
    })

    expect(calls.server[0]?.env).toEqual({
      HINDSIGHT_API_LLM_PROVIDER: "none",
      HINDSIGHT_API_LLM_MODEL: "",
      HINDSIGHT_API_LLM_API_KEY: "",
      HINDSIGHT_API_LLM_BASE_URL: "",
    })
  })

  test("degrades on startup timeout without throwing", async () => {
    const at = await mark()
    flags.start_ms = 25

    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 5, query_timeout_ms: 50 }),
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await MemoryHindsightService.ready()).toBeUndefined()
        expect(await MemoryHindsightService.ready()).toBeUndefined()
        const info = await MemoryHindsightService.get()
        expect(info.status).toBe("degraded")
        expect(info.error).toContain("Operation timed out after 5ms")
      },
    })

    expect(calls.server[0]?.readyTimeoutMs).toBe(5)
    expect(calls.stop).toBe(1)
    expect(calls.start).toBe(1)
    const text = await logs(at)
    expect(text).toContain("hindsight degraded")
    expect(text).toContain("fallback=local")
  })

  test("degrades on slow health checks using query timeout", async () => {
    flags.health_ms = 25

    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 5 }),
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await MemoryHindsightService.ready()).toBeUndefined()
        const info = await MemoryHindsightService.get()
        expect(info.status).toBe("degraded")
        expect(info.error).toContain("Operation timed out after 5ms")
      },
    })

    expect(calls.start).toBe(1)
    expect(calls.health).toBe(1)
    expect(calls.stop).toBe(1)
  })

  test("shuts down on instance dispose and isolates worktrees", async () => {
    await using one = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 50 }),
          },
        },
      },
    })
    await using two = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 50 }),
          },
        },
      },
    })

    await Instance.provide({
      directory: one.path,
      fn: async () => {
        expect((await MemoryHindsightService.ready())?.status).toBe("ready")
      },
    })
    await Instance.provide({
      directory: two.path,
      fn: async () => {
        expect((await MemoryHindsightService.ready())?.status).toBe("ready")
      },
    })

    expect(calls.server).toHaveLength(2)
    expect(calls.server[0]?.profile).not.toBe(calls.server[1]?.profile)

    await Instance.disposeAll()

    expect(calls.stop).toBe(2)
  })

  test("restarts with a longer idle timeout when requested", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 50 }),
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await MemoryHindsightService.ready())?.status).toBe("ready")
        expect((await MemoryHindsightService.readyUi())?.status).toBe("ready")
      },
    })

    expect(calls.start).toBe(2)
    expect(calls.stop).toBe(2)
    expect(calls.server[0]?.env?.HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT).toBeUndefined()
    expect(calls.server[1]?.env?.HINDSIGHT_API_ENABLE_OBSERVATIONS).toBe("true")
    expect(calls.server[1]?.env?.HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT).toBe("86400")
  })

  test("starts ui with llm muted when requested", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 50 }),
            llm_model: "openai/gpt-5.4",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await MemoryHindsightService.readyUi({ mute_llm: true }))?.status).toBe("ready")
      },
    })

    expect(calls.start).toBe(1)
    expect(calls.server[0]?.env).toMatchObject({
      HINDSIGHT_API_LLM_PROVIDER: "none",
      HINDSIGHT_API_LLM_MODEL: "",
      HINDSIGHT_API_LLM_API_KEY: "",
      HINDSIGHT_API_LLM_BASE_URL: "",
      HINDSIGHT_API_ENABLE_OBSERVATIONS: "true",
      HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT: "86400",
    })
  })

  test("retries ui startup without llm when daemon verification fails", async () => {
    const at = await mark()
    flags.start_err = "Connection verification failed for openai/gpt-5.4: Error code: 401"

    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 50 }),
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await MemoryHindsightService.readyUi())?.status).toBe("ready")
      },
    })

    expect(calls.start).toBe(2)
    expect(calls.stop).toBe(3)
    expect(calls.server[0]?.env?.HINDSIGHT_API_LLM_PROVIDER).not.toBe("none")
    expect(calls.server[0]?.env?.HINDSIGHT_API_LLM_MODEL).toBeTruthy()
    expect(calls.server[1]?.env).toMatchObject({
      HINDSIGHT_API_LLM_PROVIDER: "none",
      HINDSIGHT_API_LLM_MODEL: "",
      HINDSIGHT_API_LLM_API_KEY: "",
      HINDSIGHT_API_LLM_BASE_URL: "",
      HINDSIGHT_API_ENABLE_OBSERVATIONS: "true",
      HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT: "86400",
    })
    const text = await logs(at)
    expect(text).toContain("hindsight ui llm unavailable, retrying without llm")
    expect(text).toContain("fallback=llm_disabled")
    expect(text).toContain("reason=connection_verification_failed")
  })

  test("retries ui startup without llm when startup log reports provider failure", async () => {
    const home = process.env.OPENCODE_TEST_HOME
    const at = await mark()
    let hit = 0
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 200, query_timeout_ms: 50 }),
          },
        },
      },
    })

    process.env.OPENCODE_TEST_HOME = tmp.path
    flags.start_ms = 1_000
    flags.start_hook = async () => {
      hit++
      if (hit > 1) {
        flags.start_ms = 0
        return
      }
      const file = path.join(tmp.path, ".hindsight", "profiles", `${calls.server.at(-1)?.profile}.log`)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await Bun.sleep(25)
      await Bun.write(file, "RuntimeError: Connection verification failed for openai/gpt-5.4: Error code: 500")
    }

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await MemoryHindsightService.readyUi())?.status).toBe("ready")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }

    expect(calls.start).toBe(2)
    expect(calls.stop).toBe(3)
    expect(calls.server[1]?.env).toMatchObject({
      HINDSIGHT_API_LLM_PROVIDER: "none",
      HINDSIGHT_API_LLM_MODEL: "",
      HINDSIGHT_API_LLM_API_KEY: "",
      HINDSIGHT_API_LLM_BASE_URL: "",
      HINDSIGHT_API_ENABLE_OBSERVATIONS: "true",
      HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT: "86400",
    })
    const text = await logs(at)
    expect(text).toContain("hindsight ui llm unavailable, retrying without llm")
    expect(text).toContain("fallback=llm_disabled")
  })

  test("restarts after an in-flight boot when a longer idle timeout is requested", async () => {
    flags.start_ms = 25

    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 50 }),
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const one = MemoryHindsightService.ready()
        const two = MemoryHindsightService.readyUi()
        expect((await one)?.status).toBe("ready")
        expect((await two)?.status).toBe("ready")
      },
    })

    expect(calls.start).toBe(2)
    expect(calls.stop).toBe(2)
    expect(calls.server[0]?.env?.HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT).toBeUndefined()
    expect(calls.server[1]?.env?.HINDSIGHT_API_ENABLE_OBSERVATIONS).toBe("true")
    expect(calls.server[1]?.env?.HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT).toBe("86400")
  })

  test("stops any stale ui daemon before restarting on the same profile", async () => {
    const at = await mark()
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 50 }),
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await MemoryHindsightService.readyUi())?.status).toBe("ready")
      },
    })

    expect(calls.start).toBe(1)
    expect(calls.stop).toBe(1)
    const text = await logs(at)
    expect(text).toContain("hindsight stale daemon cleanup")
  })
})
