import { createServer } from "node:net"
import fs from "node:fs/promises"
import path from "path"
import { BunProc } from "@/bun"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Process } from "@/util/process"
import { MemoryHindsightBackfill } from "./backfill"
import { MemoryHindsightService } from "./service"

const pkg = "@vectorize-io/hindsight-control-plane"
const ver = "0.5.1"
const reflect_before = "return g.NextResponse.json(R.data,{status:200})"
const reflect_bundle_before = "return g.NextResponse.json(JSON.parse(JSON.stringify(R.data)),{status:200})"
const reflect_source_before = "return NextResponse.json(response.data, { status: 200 });"
const reflect_after =
  "if(R.error){console.error('[opencode][hindsight][reflect] upstream error',R.error);return g.NextResponse.json({error:R.error},{status:500})}try{const j=JSON.stringify(R.data??null);if(j===undefined){console.warn('[opencode][hindsight][reflect] payload stringified to undefined',{type:typeof R.data,tag:Object.prototype.toString.call(R.data)});return g.NextResponse.json(null,{status:200})}return g.NextResponse.json(JSON.parse(j),{status:200})}catch(e){console.error('[opencode][hindsight][reflect] serialization failed',e,{type:typeof R.data,tag:Object.prototype.toString.call(R.data)});return g.NextResponse.json({error:'reflect serialization failed'},{status:500})}"
const reflect_source_after =
  "if (response.error) {\n      console.error('[opencode][hindsight][reflect] upstream error', response.error);\n      return NextResponse.json({ error: response.error }, { status: 500 });\n    }\n\n    try {\n      const json = JSON.stringify(response.data ?? null);\n      if (json === undefined) {\n        console.warn('[opencode][hindsight][reflect] payload stringified to undefined', {\n          type: typeof response.data,\n          tag: Object.prototype.toString.call(response.data),\n        });\n        return NextResponse.json(null, { status: 200 });\n      }\n      return NextResponse.json(JSON.parse(json), { status: 200 });\n    } catch (err) {\n      console.error('[opencode][hindsight][reflect] serialization failed', err, {\n        type: typeof response.data,\n        tag: Object.prototype.toString.call(response.data),\n      });\n      return NextResponse.json({ error: 'reflect serialization failed' }, { status: 500 });\n    }"

function reflectFiles(dir: string) {
  return [
    path.join(dir, "src", "app", "api", "reflect", "route.ts"),
    path.join(dir, "src", "app", "api", "reflect", "route.js"),
    path.join(dir, "app", "api", "reflect", "route.ts"),
    path.join(dir, "app", "api", "reflect", "route.js"),
    path.join(dir, ".next", "server", "app", "api", "reflect", "route.ts"),
    path.join(dir, ".next", "server", "app", "api", "reflect", "route.js"),
    path.join(dir, "server", "app", "api", "reflect", "route.ts"),
    path.join(dir, "server", "app", "api", "reflect", "route.js"),
  ]
}

function display(host: string) {
  if (host === "0.0.0.0") return "127.0.0.1"
  if (host === "::") return "::1"
  return host
}

export function href(host: string, port: number) {
  const name = display(host)
  if (name.includes(":")) return `http://[${name}]:${port}`
  return `http://${name}:${port}`
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function copy(headers: Headers) {
  const next = new Headers(headers)
  next.delete("content-encoding")
  next.delete("content-length")
  next.delete("transfer-encoding")
  return next
}

function clone(res: Response) {
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: copy(res.headers),
  })
}

function join(base: string, path: string) {
  return new URL(path, base)
}

function fail() {
  return new Response("Hindsight UI unavailable", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}

async function send(req: Request, url: URL) {
  const next = new Request(url, req)
  const headers = copy(next.headers)
  headers.delete("accept-encoding")
  headers.delete("host")
  const input = new Request(next, { headers })
  return fetch(input).catch(() => undefined)
}

export async function patchHindsightUi(dir: string) {
  let hits = 0
  for (const file of reflectFiles(dir)) {
    if (!(await Bun.file(file).exists())) continue
    const text = await Bun.file(file).text()
    const next = text
      .replaceAll(reflect_before, reflect_after)
      .replaceAll(reflect_bundle_before, reflect_after)
      .replaceAll(reflect_source_before, reflect_source_after)
    if (next === text) continue
    hits++
    await fs.writeFile(file, next)
  }
  if (hits > 0) return
}

async function reflect(req: Request, api_url: string) {
  const body = await req.json().catch(() => undefined)
  if (!body || typeof body !== "object") {
    return new Response("Bad request", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  }

  const input = body as Record<string, unknown>
  const bank =
    (typeof input.bank_id === "string" && input.bank_id) ||
    (typeof input.agent_id === "string" && input.agent_id) ||
    "default"
  const include = {
    ...(input.include_facts ? { facts: {} } : {}),
    ...(input.include_tool_calls ? { tool_calls: {} } : {}),
  }
  const headers = new Headers()
  headers.set("content-type", "application/json")
  const res = await fetch(join(api_url, `/v1/default/banks/${encodeURIComponent(bank)}/reflect`), {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: input.query,
      budget: input.budget ?? (input.thinking_budget ? "mid" : "low"),
      tags: input.tags,
      tags_match: input.tags_match,
      max_tokens: input.max_tokens || undefined,
      fact_types: input.fact_types || undefined,
      exclude_mental_models: input.exclude_mental_models || undefined,
      exclude_mental_model_ids: input.exclude_mental_model_ids || undefined,
      ...(Object.keys(include).length > 0 ? { include } : {}),
    }),
  }).catch(() => undefined)
  if (!res) return fail()
  return clone(res)
}

export async function free(host: string) {
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

export function startHindsightProxy(input: {
  hostname: string
  port: number
  target: string
  api_url: string
  bank_id: string
}) {
  return Bun.serve({
    hostname: input.hostname,
    port: input.port,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname === "/dashboard" && !url.searchParams.has("bank_id")) {
        return Response.redirect(join(input.target, `/banks/${encodeURIComponent(input.bank_id)}?view=data`), 307)
      }
      if (req.method === "GET" && url.pathname === "/api/version") {
        const res = await send(req, join(input.api_url, "/version"))
        if (res?.ok) return clone(res)
        return json({ version: ver })
      }
      if (req.method === "POST" && url.pathname === "/api/reflect") {
        return reflect(req, input.api_url)
      }
      const res = await send(req, join(input.target, url.pathname + url.search))
      if (!res) return fail()
      return clone(res)
    },
  })
}

async function probe(url: string) {
  const hit = async (path: string) => {
    try {
      const res = await fetch(`${url}${path}`, {
        signal: AbortSignal.timeout(3_000),
      })
      const body = (await res.text()).trim().slice(0, 200)
      return {
        path,
        ok: res.ok,
        status: res.status,
        body,
      }
    } catch (err) {
      return {
        path,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  const [ver, banks, health] = await Promise.all([hit("/version"), hit("/v1/default/banks"), hit("/health")])
  if (ver.ok && banks.ok) return
  const fail = !ver.ok ? ver : banks
  const detail = fail.error ?? `HTTP ${fail.status}${fail.body ? ` ${fail.body}` : ""}`
  const diag = health.ok
    ? ` health=HTTP ${health.status}${health.body ? ` ${health.body}` : ""}`
    : ` health=${health.error ?? `HTTP ${health.status}${health.body ? ` ${health.body}` : ""}`}`
  throw new Error(`Hindsight dataplane check failed at ${url}: ${fail.path} -> ${detail};${diag}`)
}

export async function loadHindsightUi(opts: { port?: number; hostname?: string; mute_llm?: boolean }) {
  const dir = await BunProc.install(pkg, ver)
  const root = path.join(dir, "standalone")
  const server = path.join(root, "server.js")
  await patchHindsightUi(root)

  const svc = await MemoryHindsightService.readyUi({
    mute_llm: opts.mute_llm === true,
  })
  if (!svc) {
    const info = await MemoryHindsightService.get()
    if (info.status === "degraded" && info.error) throw new Error(`Hindsight failed to start: ${info.error}`)
    throw new Error("Hindsight is not ready. Enable memory.hindsight.enabled first.")
  }
  await MemoryHindsightBackfill.run(svc.root)
  await probe(svc.base_url)

  const port = opts.port ?? 9999
  const hostname = opts.hostname ?? "127.0.0.1"

  return {
    dir: root,
    cmd: [BunProc.which(), server],
    env: {
      PORT: String(port),
      HOSTNAME: hostname,
      HINDSIGHT_CP_DATAPLANE_API_URL: svc.base_url,
    },
    bank_id: svc.bank_id,
    url: href(hostname, port),
    api_url: svc.base_url,
  }
}

export namespace MemoryHindsightUI {
  const log = Log.create({ service: "memory.hindsight.ui" })

  type Info = {
    url: string
    api_url: string
    bank_id: string
  }

  type State = {
    info?: Info
    boot?: Promise<Info | undefined>
    child?: Process.Child
    proxy?: ReturnType<typeof Bun.serve>
    abort?: AbortController
  }

  const state = Instance.state<State>(
    () => ({}),
    async (s) => {
      await stop(s)
    },
  )

  async function stop(s: State) {
    s.info = undefined
    s.proxy?.stop()
    s.proxy = undefined
    const child = s.child
    s.child = undefined
    s.abort?.abort()
    s.abort = undefined
    if (!child) return
    await child.exited.catch(() => undefined)
  }

  async function wait(url: string, child: Process.Child) {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("Hindsight UI exited before ready")
      }
      const ok = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(500),
      })
        .then((res) => res.status < 500)
        .catch(() => false)
      if (ok) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out waiting for Hindsight UI at ${url}`)
  }

  export async function start(input: { hostname?: string; port?: number } = {}) {
    const cfg = await Config.get()
    if (!cfg.memory?.hindsight.enabled) return
    const s = state()
    if (s.info) return s.info
    if (s.boot) return s.boot

    s.boot = (async () => {
      const hostname = input.hostname ?? "127.0.0.1"
      const port = input.port ?? (await free(hostname))
      const ui = await loadHindsightUi({
        hostname,
        port: await free(hostname),
      })
      const url = href(hostname, port)
      s.proxy = startHindsightProxy({
        hostname,
        port,
        target: ui.url,
        api_url: ui.api_url,
        bank_id: ui.bank_id,
      })
      s.abort = new AbortController()
      s.child = Process.spawn(ui.cmd, {
        cwd: ui.dir,
        env: {
          ...ui.env,
          BUN_BE_BUN: "1",
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        abort: s.abort.signal,
      })
      await wait(url, s.child)
      s.info = {
        url,
        api_url: ui.api_url,
        bank_id: ui.bank_id,
      }
      log.info("hindsight ui ready", {
        root: Instance.worktree,
        url,
        api_url: ui.api_url,
      })
      return s.info
    })()
      .catch(async (err) => {
        log.warn("hindsight ui failed", {
          root: Instance.worktree,
          error: err instanceof Error ? err.message : String(err),
        })
        await stop(s)
        return undefined
      })
      .finally(() => {
        s.boot = undefined
      })

    return s.boot
  }
}
