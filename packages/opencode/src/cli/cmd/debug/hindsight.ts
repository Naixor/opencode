import { EOL } from "os"
import path from "path"
import open from "open"
import { BunProc } from "@/bun"
import { Config } from "../../../config/config"
import { UI } from "../../ui"
import { Process } from "../../../util/process"
import { MemoryHindsightBank } from "../../../memory/hindsight/bank"
import { MemoryHindsightService } from "../../../memory/hindsight/service"
import { MemoryHindsightState } from "../../../memory/hindsight/state"
import { Instance } from "../../../project/instance"
import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"

const pkg = "@vectorize-io/hindsight-control-plane"
const ver = "0.5.1"
function display(host: string) {
  if (host === "0.0.0.0") return "127.0.0.1"
  if (host === "::") return "::1"
  return host
}

function href(host: string, port: number) {
  const name = display(host)
  if (name.includes(":")) return `http://[${name}]:${port}`
  return `http://${name}:${port}`
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

export async function loadHindsightInspect() {
  const cfg = await Config.get()
  const opts = cfg.memory?.hindsight
  const file = MemoryHindsightState.filepath()
  const state = await MemoryHindsightState.load()
  return {
    config: {
      enabled: opts?.enabled ?? false,
      mode: opts?.mode ?? "embedded",
      extract: opts?.extract ?? false,
      recall: opts?.recall ?? false,
      backfill: opts?.backfill ?? false,
      auto_start: opts?.auto_start !== false,
      workspace_scope: opts?.workspace_scope ?? "worktree",
      llm_provider: opts?.llm_provider,
      llm_model: opts?.llm_model,
      llm_base_url: opts?.llm_base_url,
    },
    bank: {
      id: MemoryHindsightBank.bankId(Instance.worktree),
      workspace_hash: state.workspace_hash,
      workspace_scope: state.workspace_scope,
      root: Instance.worktree,
    },
    service: await MemoryHindsightService.get(),
    state: {
      path: file,
      exists: await Bun.file(file).exists(),
      backfill: state.backfill,
    },
  }
}

export async function loadHindsightUi(opts: { port?: number; hostname?: string }) {
  const dir = await BunProc.install(pkg, ver)
  const node = Bun.which("node")
  if (!node) throw new Error("Node.js is required to run the Hindsight Control Plane.")

  const svc = await MemoryHindsightService.readyUi()
  if (!svc) {
    const info = await MemoryHindsightService.get()
    if (info.status === "degraded" && info.error) throw new Error(`Hindsight failed to start: ${info.error}`)
    throw new Error("Hindsight is not ready. Enable memory.hindsight.enabled first.")
  }
  await probe(svc.base_url)

  const port = opts.port ?? 9999
  const hostname = opts.hostname ?? "127.0.0.1"

  return {
    dir,
    cmd: [
      node,
      path.join(dir, "bin", "cli.js"),
      "--port",
      String(port),
      "--hostname",
      hostname,
      "--api-url",
      svc.base_url,
    ],
    url: href(hostname, port),
    api_url: svc.base_url,
  }
}

export const HindsightUiCommand = cmd({
  command: "ui",
  describe: "start the Hindsight control plane",
  builder: (yargs) =>
    yargs
      .option("port", {
        type: "number",
        describe: "port to listen on",
        default: 9999,
      })
      .option("hostname", {
        type: "string",
        describe: "hostname to listen on",
        default: "127.0.0.1",
      })
      .option("skip-open", {
        type: "boolean",
        describe: "do not auto-open browser",
        default: false,
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const ui = await loadHindsightUi({
        port: typeof args.port === "number" ? args.port : 9999,
        hostname: typeof args.hostname === "string" ? args.hostname : "127.0.0.1",
      })

      UI.println(UI.Style.TEXT_INFO_BOLD + "  Hindsight Control Plane", UI.Style.TEXT_NORMAL)
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web UI:    ", UI.Style.TEXT_NORMAL, ui.url)
      UI.println(UI.Style.TEXT_INFO_BOLD + "  API URL:   ", UI.Style.TEXT_NORMAL, ui.api_url)
      UI.println(
        UI.Style.TEXT_WARNING_BOLD + "  Note: ",
        UI.Style.TEXT_NORMAL,
        "OpenCode local memory remains authoritative; edits in Hindsight UI do not sync back.",
      )
      UI.println(UI.Style.TEXT_DIM + "  Press Ctrl+C to stop the control plane" + UI.Style.TEXT_NORMAL)
      UI.empty()

      if (!args.skipOpen) open(ui.url).catch(() => {})

      const child = Process.spawn(ui.cmd, {
        cwd: ui.dir,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      })

      const stop = () => {
        if (child.exitCode !== null || child.signalCode !== null) return
        child.kill("SIGTERM")
      }

      process.on("SIGTERM", stop)
      process.on("SIGINT", stop)
      try {
        await child.exited
      } finally {
        process.off("SIGTERM", stop)
        process.off("SIGINT", stop)
      }
    })
  },
})

export const HindsightCommand = cmd({
  command: "hindsight",
  describe: "inspect local Hindsight status and tools",
  builder: (yargs) => yargs.command(HindsightUiCommand),
  async handler() {
    await bootstrap(process.cwd(), async () => {
      process.stdout.write(JSON.stringify(await loadHindsightInspect(), null, 2) + EOL)
    })
  },
})
