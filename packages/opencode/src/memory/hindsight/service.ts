import { HindsightServer } from "@vectorize-io/hindsight-all"
import { HindsightClient } from "@vectorize-io/hindsight-client"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { withTimeout } from "@/util/timeout"
import { MemoryHindsightBank } from "./bank"

export namespace MemoryHindsightService {
  const log = Log.create({ service: "memory.hindsight.service" })
  const host = "127.0.0.1"

  type Cfg = NonNullable<NonNullable<Awaited<ReturnType<typeof Config.get>>["memory"]>["hindsight"]>

  export type Status = "disabled" | "stopped" | "starting" | "ready" | "degraded"

  export interface Info {
    status: Status
    root: string
    bank_id: string
    profile: string
    base_url: string
    port: number
    error?: string
  }

  export interface Ready extends Info {
    status: "ready"
    client: HindsightClient
  }

  interface State {
    info: Info
    boot?: Promise<Ready | undefined>
    server?: HindsightServer
    client?: HindsightClient
  }

  function meta(root = Instance.worktree) {
    const hash = MemoryHindsightBank.worktreeHash(root)
    const port = 40000 + (Number.parseInt(hash.slice(0, 4), 16) % 20000)
    return {
      root,
      bank_id: MemoryHindsightBank.bankId(root),
      profile: `opencode-${hash}`,
      base_url: `http://${host}:${port}`,
      port,
    }
  }

  function info(status: Status, error?: string): Info {
    return {
      status,
      ...meta(),
      ...(error ? { error } : {}),
    }
  }

  function text(err: unknown) {
    return err instanceof Error ? err.message : String(err)
  }

  function timer(cfg: Cfg, key: "startup_timeout_ms" | "query_timeout_ms") {
    if (key === "startup_timeout_ms") return cfg.startup_timeout_ms ?? 30_000
    return cfg.query_timeout_ms ?? 5_000
  }

  function logger(next: Info) {
    const tag = {
      profile: next.profile,
      root: next.root,
      port: next.port,
    }
    return {
      debug(msg: string) {
        log.debug(msg, tag)
      },
      info(msg: string) {
        log.info(msg, tag)
      },
      warn(msg: string) {
        log.warn(msg, tag)
      },
      error(msg: string) {
        log.error(msg, tag)
      },
    }
  }

  async function stop(s: State) {
    const server = s.server
    s.boot = undefined
    s.server = undefined
    s.client = undefined
    if (!server) {
      s.info = info("stopped")
      return
    }
    await server.stop().catch((err) => {
      log.warn("hindsight shutdown failed", {
        error: text(err),
        profile: s.info.profile,
        root: s.info.root,
      })
    })
    s.info = info("stopped")
  }

  async function degrade(s: State, err: unknown) {
    const error = text(err)
    await stop(s)
    s.info = info("degraded", error)
    log.warn("hindsight degraded", {
      error,
      profile: s.info.profile,
      root: s.info.root,
    })
  }

  async function boot(s: State, cfg: Cfg) {
    const next = info("starting")
    const server = new HindsightServer({
      profile: next.profile,
      host,
      port: next.port,
      readyTimeoutMs: cfg.startup_timeout_ms,
      logger: logger(next),
    })
    const client = new HindsightClient({
      baseUrl: next.base_url,
    })

    s.info = next
    s.server = server
    s.client = client
    log.info("starting hindsight", {
      profile: next.profile,
      root: next.root,
      port: next.port,
    })

    return withTimeout(server.start(), timer(cfg, "startup_timeout_ms"))
      .then(() => withTimeout(server.checkHealth(), timer(cfg, "query_timeout_ms")))
      .then(async (ok) => {
        if (!ok) {
          await degrade(s, new Error("Hindsight health check failed"))
          return
        }
        s.info = info("ready")
        log.info("hindsight ready", {
          profile: s.info.profile,
          root: s.info.root,
          port: s.info.port,
        })
        return {
          ...s.info,
          status: "ready",
          client,
        } satisfies Ready
      })
      .catch(async (err) => {
        await degrade(s, err)
        return undefined
      })
  }

  const state = Instance.state<State>(
    () => ({
      info: info("stopped"),
    }),
    async (s) => {
      await stop(s)
    },
  )

  export async function get(): Promise<Info> {
    const cfg = await Config.get()
    if (!cfg.memory?.hindsight.enabled) return info("disabled")
    return state().info
  }

  export async function ready(): Promise<Ready | undefined> {
    const cfg = await Config.get()
    const opts = cfg.memory?.hindsight
    if (!opts?.enabled) return
    const s = state()
    if (s.info.status === "degraded") return
    if (s.info.status === "ready" && s.client) {
      return {
        ...s.info,
        status: "ready",
        client: s.client,
      }
    }
    if (s.boot) return s.boot
    s.boot = boot(s, opts).finally(() => {
      s.boot = undefined
    })
    return s.boot
  }

  export async function health(): Promise<boolean> {
    const cfg = await Config.get()
    const opts = cfg.memory?.hindsight
    const s = state()
    if (!opts?.enabled || !s.server || s.info.status !== "ready") return false
    return withTimeout(s.server.checkHealth(), timer(opts, "query_timeout_ms"))
      .then(async (ok) => {
        if (ok) return true
        await degrade(s, new Error("Hindsight health check failed"))
        return false
      })
      .catch(async (err) => {
        await degrade(s, err)
        return false
      })
  }

  export async function dispose(): Promise<void> {
    await stop(state())
  }
}
