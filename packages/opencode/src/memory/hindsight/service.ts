import { HindsightServer } from "@vectorize-io/hindsight-all"
import { HindsightClient } from "@vectorize-io/hindsight-client"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { withTimeout } from "@/util/timeout"
import path from "path"
import { MemoryHindsightBank } from "./bank"

export namespace MemoryHindsightService {
  const log = Log.create({ service: "memory.hindsight.service" })
  const host = "127.0.0.1"

  type Root = Awaited<ReturnType<typeof Config.get>>
  type Cfg = NonNullable<NonNullable<Root["memory"]>["hindsight"]>

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
    mode?: "default" | "ui"
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

  function unsupported(err: unknown) {
    return text(err).includes("unrecognized arguments: --idle-timeout")
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

  function uiVars(vars: Record<string, string | undefined>): Record<string, string | undefined> {
    return {
      ...vars,
      HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT: "86400",
    }
  }

  function muteVars(vars: Record<string, string | undefined>): Record<string, string | undefined> {
    return {
      ...vars,
      HINDSIGHT_API_LLM_PROVIDER: "none",
      HINDSIGHT_API_LLM_MODEL: "",
      HINDSIGHT_API_LLM_API_KEY: "",
      HINDSIGHT_API_LLM_BASE_URL: "",
    }
  }

  async function logtail(profile: string) {
    const file = path.join(Global.Path.home, ".hindsight", "profiles", `${profile}.log`)
    const body = await Bun.file(file)
      .text()
      .catch(() => "")
    return body.slice(-4_000)
  }

  async function logmark(profile: string) {
    const file = path.join(Global.Path.home, ".hindsight", "profiles", `${profile}.log`)
    return Bun.file(file)
      .text()
      .then((body) => body.length)
      .catch(() => 0)
  }

  function reason(err: unknown, body: string) {
    const textBody = `${text(err)}\n${body}`
    if (textBody.includes("LLM API key is required")) return "missing_api_key"
    if (textBody.includes("Invalid LLM provider")) return "invalid_provider"
    if (textBody.includes("Connection verification failed")) return "connection_verification_failed"
    if (textBody.match(/AuthenticationError|Auth error \(HTTP 401\)/)) return "auth_failed"
    if (textBody.match(/API error after \d+ attempts|InternalServerError/)) return "provider_error"
  }

  function issue(body: string) {
    if (body.includes("unrecognized arguments: --idle-timeout")) {
      return new Error("unrecognized arguments: --idle-timeout")
    }
    if (reason("", body)) {
      return new Error("Hindsight startup log indicates an LLM failure")
    }
  }

  async function watch(profile: string, at: number, live: () => boolean) {
    let prev = ""
    while (live()) {
      const body = await Bun.file(path.join(Global.Path.home, ".hindsight", "profiles", `${profile}.log`))
        .text()
        .then((text) => text.slice(at))
        .catch(() => "")
      if (body && body !== prev) {
        const err = issue(body)
        if (err) return err
        prev = body
      }
      await Bun.sleep(250)
    }
  }

  function model(value: string) {
    const [provider, ...rest] = value.split("/")
    return {
      provider,
      model: rest.join("/"),
    }
  }

  async function env(cfg: Root) {
    const opts = cfg.memory?.hindsight
    const out: Record<string, string | undefined> = {}
    if (!opts) return out
    const ref = !opts.llm_model && opts.llm_provider?.includes("/") ? model(opts.llm_provider) : undefined
    if (opts.llm_provider === "none") {
      out.HINDSIGHT_API_LLM_PROVIDER = "none"
      out.HINDSIGHT_API_LLM_MODEL = ""
      out.HINDSIGHT_API_LLM_API_KEY = ""
      out.HINDSIGHT_API_LLM_BASE_URL = ""
      return out
    }
    if (ref) out.HINDSIGHT_API_LLM_PROVIDER = ref.provider
    else if (opts.llm_provider) out.HINDSIGHT_API_LLM_PROVIDER = opts.llm_provider
    if (opts.llm_model) {
      const pair = opts.llm_model.includes("/") ? model(opts.llm_model) : undefined
      const provider = pair?.provider ?? opts.llm_provider
      if (provider) out.HINDSIGHT_API_LLM_PROVIDER = provider
      out.HINDSIGHT_API_LLM_MODEL = pair?.model ?? opts.llm_model
      if (opts.llm_base_url) out.HINDSIGHT_API_LLM_BASE_URL = opts.llm_base_url
      if (opts.llm_api_key) out.HINDSIGHT_API_LLM_API_KEY = opts.llm_api_key
      const auth = provider ? await Auth.get(provider) : undefined
      if (!out.HINDSIGHT_API_LLM_API_KEY && auth?.type === "api") out.HINDSIGHT_API_LLM_API_KEY = auth.key
      if (!out.HINDSIGHT_API_LLM_API_KEY && auth?.type === "oauth") out.HINDSIGHT_API_LLM_API_KEY = auth.access
      if (out.HINDSIGHT_API_LLM_BASE_URL) return out
      if (!provider) return out
      const base = cfg.provider?.[provider]?.options?.baseURL
      if (typeof base === "string") out.HINDSIGHT_API_LLM_BASE_URL = base
      return out
    }
    if (ref) out.HINDSIGHT_API_LLM_MODEL = ref.model
    if (opts.llm_api_key) out.HINDSIGHT_API_LLM_API_KEY = opts.llm_api_key
    if (opts.llm_base_url) out.HINDSIGHT_API_LLM_BASE_URL = opts.llm_base_url
    if (!ref) return out
    const auth = await Auth.get(ref.provider)
    if (!out.HINDSIGHT_API_LLM_API_KEY && auth?.type === "api") out.HINDSIGHT_API_LLM_API_KEY = auth.key
    if (!out.HINDSIGHT_API_LLM_API_KEY && auth?.type === "oauth") out.HINDSIGHT_API_LLM_API_KEY = auth.access
    if (out.HINDSIGHT_API_LLM_BASE_URL) return out
    const base = cfg.provider?.[ref.provider]?.options?.baseURL
    if (typeof base === "string") out.HINDSIGHT_API_LLM_BASE_URL = base
    return out
  }

  async function stop(s: State) {
    const server = s.server
    s.server = undefined
    s.client = undefined
    s.mode = undefined
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
      fallback: "local",
      error,
      profile: s.info.profile,
      root: s.info.root,
    })
  }

  async function boot(s: State, cfg: Root, opts: Cfg, ui = false) {
    const at = Date.now()
    const clear = ui
    const next = info("starting")
    const base = await env(cfg)
    const vars = ui ? uiVars(base) : base

    const make = (env: Record<string, string | undefined>) => {
      const server = new HindsightServer({
        profile: next.profile,
        host,
        port: next.port,
        env,
        readyTimeoutMs: opts.startup_timeout_ms,
        logger: logger(next),
      })
      const client = new HindsightClient({
        baseUrl: next.base_url,
      })
      s.server = server
      s.client = client
      return { server, client }
    }

    const start = async (server: HindsightServer) => {
      const ms = timer(opts, "startup_timeout_ms")
      if (!clear) return withTimeout(server.start(), ms)
      log.info("hindsight stale daemon cleanup", {
        profile: next.profile,
        root: next.root,
        port: next.port,
      })
      await server.stop().catch((err) => {
        log.warn("hindsight stale daemon cleanup failed", {
          error: text(err),
          profile: next.profile,
          root: next.root,
          port: next.port,
        })
      })
      const at = await logmark(next.profile)
      let live = true
      const run = server.start()
      const result = await Promise.race([
        run.then(
          () => ({ kind: "done" as const }),
          (err) => ({ kind: "error" as const, err }),
        ),
        watch(next.profile, at, () => live).then((err) => ({ kind: "watch" as const, err })),
        Bun.sleep(ms).then(() => ({ kind: "timeout" as const })),
      ]).finally(() => {
        live = false
      })
      if (result.kind === "done") return
      if (result.kind === "error") throw result.err
      if (result.kind === "watch" && result.err) throw result.err
      throw new Error(`Operation timed out after ${ms}ms`)
    }

    const run = async (env: Record<string, string | undefined>) => {
      const pair = make(env)
      await start(pair.server)
      return pair
    }

    const launch = async (env: Record<string, string | undefined>, extra?: Record<string, string>) => {
      s.info = next
      s.mode = ui ? "ui" : "default"
      log.info("starting hindsight", {
        profile: next.profile,
        root: next.root,
        port: next.port,
        llm_provider: env.HINDSIGHT_API_LLM_PROVIDER,
        llm_model: env.HINDSIGHT_API_LLM_MODEL,
        ...extra,
      })
      return run(env)
        .then((pair) => {
          const probe = Date.now()
          log.info("hindsight health check started", {
            mode: "startup",
            profile: next.profile,
            root: next.root,
          })
          return withTimeout(pair.server.checkHealth(), timer(opts, "query_timeout_ms")).then((ok) => ({
            ok,
            probe,
            pair,
          }))
        })
        .then(async ({ ok, probe, pair }) => {
          log.info("hindsight health check completed", {
            mode: "startup",
            profile: next.profile,
            root: next.root,
            ok,
            duration: Date.now() - probe,
          })
          if (!ok) {
            await degrade(s, new Error("Hindsight health check failed"))
            return
          }
          s.info = info("ready")
          log.info("hindsight ready", {
            duration: Date.now() - at,
            profile: s.info.profile,
            root: s.info.root,
            port: s.info.port,
            ...extra,
          })
          return {
            ...s.info,
            status: "ready",
            client: pair.client,
          } satisfies Ready
        })
    }

    return launch(vars).catch(async (err) => {
      if (ui && vars.HINDSIGHT_API_LLM_PROVIDER !== "none") {
        const why = reason(err, await logtail(next.profile))
        if (why) {
          log.warn("hindsight ui llm unavailable, retrying without llm", {
            duration: Date.now() - at,
            fallback: "llm_disabled",
            profile: next.profile,
            reason: why,
            root: next.root,
            port: next.port,
          })
          await stop(s)
          return launch(muteVars(vars), {
            fallback: "llm_disabled",
            reason: why,
          }).catch(async (err) => {
            await degrade(s, err)
            return undefined
          })
        }
      }
      if (ui && unsupported(err)) {
        log.warn("hindsight ui idle timeout unsupported, retrying", {
          profile: next.profile,
          root: next.root,
          port: next.port,
          fallback: "retry_without_idle_timeout",
        })
        await stop(s)
        return launch(base).catch(async (err) => {
          await degrade(s, err)
          return undefined
        })
      }
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
    s.boot = boot(s, cfg, opts).finally(() => {
      s.boot = undefined
    })
    return s.boot
  }

  export async function readyUi(): Promise<Ready | undefined> {
    const cfg = await Config.get()
    const opts = cfg.memory?.hindsight
    if (!opts?.enabled) return
    const s = state()
    if (s.info.status === "degraded") return
    if (s.info.status === "ready" && s.client && s.mode === "ui") {
      return {
        ...s.info,
        status: "ready",
        client: s.client,
      }
    }
    if (s.boot) {
      return s.boot.then((result) => {
        if (!result) return result
        return readyUi()
      })
    }
    s.boot = (async () => {
      if (s.info.status === "ready" && s.client) await stop(s)
      return boot(s, cfg, opts, true)
    })().finally(() => {
      s.boot = undefined
    })
    return s.boot
  }

  export async function health(): Promise<boolean> {
    const cfg = await Config.get()
    const opts = cfg.memory?.hindsight
    const s = state()
    if (!opts?.enabled || !s.server || s.info.status !== "ready") return false
    const at = Date.now()
    log.info("hindsight health check started", {
      mode: "runtime",
      profile: s.info.profile,
      root: s.info.root,
    })
    return withTimeout(s.server.checkHealth(), timer(opts, "query_timeout_ms"))
      .then(async (ok) => {
        log.info("hindsight health check completed", {
          mode: "runtime",
          profile: s.info.profile,
          root: s.info.root,
          ok,
          duration: Date.now() - at,
        })
        if (ok) return true
        await degrade(s, new Error("Hindsight health check failed"))
        return false
      })
      .catch(async (err) => {
        log.warn("hindsight health check failed", {
          mode: "runtime",
          profile: s.info.profile,
          root: s.info.root,
          duration: Date.now() - at,
          error: text(err),
          fallback: "local",
        })
        await degrade(s, err)
        return false
      })
  }

  export async function dispose(): Promise<void> {
    await stop(state())
  }
}
