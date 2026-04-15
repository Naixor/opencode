import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

await Log.init({ print: false })

type ServerOpts = {
  profile?: string
  port?: number
  host?: string
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
  health_ok: true,
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
      await wait(flags.start_ms)
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
  flags.health_ok = true
}

beforeEach(() => {
  reset()
})

afterEach(async () => {
  await Instance.disposeAll()
})

describe("MemoryHindsightService", () => {
  test("starts lazily on loopback and reuses one handle per worktree", async () => {
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
  })

  test("degrades on startup timeout without throwing", async () => {
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
        const info = await MemoryHindsightService.get()
        expect(info.status).toBe("degraded")
        expect(info.error).toContain("Operation timed out after 5ms")
      },
    })

    expect(calls.server[0]?.readyTimeoutMs).toBe(5)
    expect(calls.stop).toBe(1)
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
})
