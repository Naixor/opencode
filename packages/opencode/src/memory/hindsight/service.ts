import { HindsightServer } from "@vectorize-io/hindsight-all"
import { HindsightClient } from "@vectorize-io/hindsight-client"
import { createServer } from "node:net"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Instance } from "@/project/instance"
import { SystemPrompt } from "@/session/system"
import { Log } from "@/util/log"
import { withTimeout } from "@/util/timeout"
import crypto from "crypto"
import os from "os"
import path from "path"
import { MemoryHindsightBank } from "./bank"

export namespace MemoryHindsightService {
  const log = Log.create({ service: "memory.hindsight.service" })
  const host = "127.0.0.1"
  const codex_url = "https://chatgpt.com/backend-api/codex/responses"

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
    proxy?: ReturnType<typeof Bun.serve>
    proxy_url?: string
    proxy_key?: string
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
      HINDSIGHT_API_ENABLE_OBSERVATIONS: "true",
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

  async function chosen(opts: Cfg) {
    if (opts.llm_model) {
      const pair = opts.llm_model.includes("/") ? model(opts.llm_model) : undefined
      return {
        provider: pair?.provider ?? opts.llm_provider,
        model: pair?.model ?? opts.llm_model,
      }
    }

    if (opts.llm_provider?.includes("/")) {
      return model(opts.llm_provider)
    }

    if (opts.llm_provider) {
      return {
        provider: opts.llm_provider,
        model: "",
      }
    }

    const ref = await Provider.defaultModel().catch(() => undefined)
    if (!ref) return
    return {
      provider: ref.providerID,
      model: ref.modelID,
    }
  }

  async function free() {
    return new Promise<number>((resolve, reject) => {
      const srv = createServer()
      srv.once("error", reject)
      srv.listen(0, host, () => {
        const addr = srv.address()
        if (!addr || typeof addr === "string") {
          srv.close(() => reject(new Error("Failed to allocate port")))
          return
        }
        srv.close((err) => {
          if (err) {
            reject(err)
            return
          }
          resolve(addr.port)
        })
      })
    })
  }

  async function proxy(s: State, auth: Extract<Auth.Info, { type: "oauth" }>) {
    if (s.proxy && s.proxy_url && s.proxy_key) {
      return {
        url: s.proxy_url,
        key: s.proxy_key,
      }
    }

    const port = await free()
    const key = crypto.randomUUID()
    type Msg = { role: string; content: unknown }
    type Out =
      | { role: "system" | "developer"; content: string }
      | { role: "user" | "assistant"; content: { type: string; text: string }[] }

    const text = (value: unknown): string => {
      if (typeof value === "string") return value
      if (!Array.isArray(value)) return ""
      return value
        .flatMap((item) => {
          if (typeof item === "string") return [item]
          if (!item || typeof item !== "object") return []
          if ("text" in item && typeof item.text === "string") return [item.text]
          return []
        })
        .join("")
    }

    const events = (body: string) =>
      body
        .split("\n\n")
        .flatMap((chunk) => chunk.split("\n"))
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line && line !== "[DONE]")
        .flatMap((line) => {
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })

    const pack = (messages: Msg[]) => {
      const sys = messages
        .filter((item) => item.role === "system" || item.role === "developer")
        .map((item) => text(item.content))
        .filter(Boolean)
      const input = messages.flatMap((item): Out[] => {
        if (item.role === "assistant") {
          return [{ role: "assistant", content: [{ type: "output_text", text: text(item.content) }] }]
        }
        if (item.role === "user") {
          return [{ role: "user", content: [{ type: "input_text", text: text(item.content) }] }]
        }
        return []
      })
      return {
        instructions: [SystemPrompt.instructions(), ...sys].filter(Boolean).join("\n\n"),
        input,
      }
    }

    const output = (body: any) => {
      const items: any[] = Array.isArray(body.output) ? body.output : []
      const msg = items.find((item: any) => item?.type === "message" && item?.role === "assistant")
      const calls = items.filter((item: any) => item?.type === "function_call")
      return {
        id: typeof body.id === "string" ? body.id : crypto.randomUUID(),
        object: "chat.completion",
        created: typeof body.created_at === "number" ? body.created_at : Math.floor(Date.now() / 1000),
        model: typeof body.model === "string" ? body.model : "",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: Array.isArray(msg?.content)
                ? msg.content
                    .filter(
                      (item: { type?: string; text?: string }) =>
                        item?.type === "output_text" && typeof item.text === "string",
                    )
                    .map((item: { text?: string }) => item.text ?? "")
                    .join("")
                : "",
              ...(calls.length
                ? {
                    tool_calls: calls.map((item: any, i: number) => ({
                      id:
                        typeof item.call_id === "string"
                          ? item.call_id
                          : typeof item.id === "string"
                            ? item.id
                            : `call_${i}`,
                      type: "function",
                      function: {
                        name: typeof item.name === "string" ? item.name : "tool",
                        arguments: typeof item.arguments === "string" ? item.arguments : "{}",
                      },
                    })),
                  }
                : {}),
            },
            finish_reason: calls.length ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: body.usage?.input_tokens ?? 0,
          completion_tokens: body.usage?.output_tokens ?? 0,
          total_tokens: body.usage?.total_tokens ?? (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0),
        },
      }
    }

    s.proxy = Bun.serve({
      hostname: host,
      port,
      async fetch(req) {
        const authz = req.headers.get("authorization")
        if (authz !== `Bearer ${key}`) {
          return new Response("Unauthorized", { status: 401 })
        }

        const headers = new Headers(req.headers)
        headers.delete("authorization")
        headers.delete("host")
        headers.set("authorization", `Bearer ${auth.access}`)
        headers.set("originator", "opencode")
        headers.set("User-Agent", `opencode/${Installation.VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`)
        if (auth.accountId) headers.set("ChatGPT-Account-Id", auth.accountId)

        const url = new URL(req.url)
        if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
          return new Response("Not found", { status: 404 })
        }

        const body = await req.json().catch(() => undefined)
        if (!body || typeof body !== "object" || !Array.isArray((body as any).messages)) {
          return new Response("Bad request", { status: 400 })
        }

        const payload = pack((body as any).messages)
        const res = await fetch(codex_url, {
          method: req.method,
          headers,
          body: JSON.stringify({
            model: typeof (body as any).model === "string" ? (body as any).model : "",
            instructions: payload.instructions,
            input: payload.input,
            temperature: typeof (body as any).temperature === "number" ? (body as any).temperature : undefined,
            top_p: typeof (body as any).top_p === "number" ? (body as any).top_p : undefined,
            store: false,
            stream: true,
          }),
          redirect: "manual",
        })

        if (!res.ok) {
          return new Response(res.body, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          })
        }

        const json = events(await res.text().catch(() => "")).findLast(
          (item: any) => item?.type === "response.completed" || item?.type === "response.incomplete",
        )?.response
        if (!json) {
          return new Response("Bad gateway", { status: 502 })
        }

        return Response.json(output(json), {
          status: res.status,
          statusText: res.statusText,
        })
      },
    })
    s.proxy_url = `http://${host}:${port}/v1`
    s.proxy_key = key
    return {
      url: s.proxy_url,
      key: s.proxy_key,
    }
  }

  async function env(cfg: Root, s: State) {
    const opts = cfg.memory?.hindsight
    const out: Record<string, string | undefined> = {}
    if (!opts) return out
    if (opts.llm_provider === "none") {
      out.HINDSIGHT_API_LLM_PROVIDER = "none"
      out.HINDSIGHT_API_LLM_MODEL = ""
      out.HINDSIGHT_API_LLM_API_KEY = ""
      out.HINDSIGHT_API_LLM_BASE_URL = ""
      return out
    }
    const ref = await chosen(opts)
    if (ref?.provider) out.HINDSIGHT_API_LLM_PROVIDER = ref.provider
    if (ref?.model) out.HINDSIGHT_API_LLM_MODEL = ref.model
    if (opts.llm_api_key) out.HINDSIGHT_API_LLM_API_KEY = opts.llm_api_key
    if (opts.llm_base_url) out.HINDSIGHT_API_LLM_BASE_URL = opts.llm_base_url
    if (!ref?.provider) return out
    const auth = await Auth.get(ref.provider)
    if (ref.provider === "openai" && auth?.type === "oauth") {
      const next = await proxy(s, auth)
      out.HINDSIGHT_API_LLM_PROVIDER = "openai"
      out.HINDSIGHT_API_LLM_BASE_URL = next.url
      out.HINDSIGHT_API_LLM_API_KEY = next.key
      return out
    }
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
    s.proxy?.stop()
    s.proxy = undefined
    s.proxy_url = undefined
    s.proxy_key = undefined
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

  async function boot(s: State, cfg: Root, opts: Cfg, ui = false, mute = false) {
    const at = Date.now()
    const clear = ui
    const next = info("starting")
    const base = await env(cfg, s)
    const vars = mute ? muteVars(ui ? uiVars(base) : base) : ui ? uiVars(base) : base

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

  export async function readyUi(input?: { mute_llm?: boolean }): Promise<Ready | undefined> {
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
        return readyUi(input)
      })
    }
    s.boot = (async () => {
      if (s.info.status === "ready" && s.client) await stop(s)
      return boot(s, cfg, opts, true, input?.mute_llm === true)
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
