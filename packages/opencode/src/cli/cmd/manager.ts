import type { Argv } from "yargs"
import open from "open"
import { Server } from "../../server/server"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Instance } from "../../project/instance"
import { InstanceBootstrap } from "../../project/bootstrap"
import { ManagerState } from "../../server/manager-state"
import { LlmLog } from "../../log/query"
import { MemoryHindsightUI } from "../../memory/hindsight/ui"
import { networkInterfaces } from "os"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      if (netInfo.internal || netInfo.family !== "IPv4") continue
      if (netInfo.address.startsWith("172.")) continue
      results.push(netInfo.address)
    }
  }

  return results
}

interface Service {
  name: string
  description: string
  path: string
  url: string
}

type Ui =
  | {
      url: string
      api_url: string
      bank_id: string
    }
  | undefined

export async function startManager(args: Record<string, unknown>) {
  const opts = await resolveNetworkOptions(args as any)
  const server = Server.listen(opts)
  const mainPort = server.port!
  const mainHost = opts.hostname === "0.0.0.0" ? "localhost" : opts.hostname
  const mainBaseUrl = `http://${mainHost}:${mainPort}`
  const items = (ui: Ui) => [
    {
      id: "web",
      name: "Web Interface",
      description: "Main OpenCode web interface for sessions and chat",
      url: mainBaseUrl,
      icon: "💬",
    },
    {
      id: "memory",
      name: "Memory",
      description: "View, edit, and manage AI memory entries",
      url: `${mainBaseUrl}/memory/app`,
      icon: "🧠",
    },
    {
      id: "log-viewer",
      name: "Log Viewer",
      description: "Browse and analyze LLM interaction logs",
      url: `${mainBaseUrl}/log-viewer/app`,
      icon: "📊",
    },
    {
      id: "swarm",
      name: "Swarms",
      description: "Open the Swarm admin overview for your most recent project",
      url: `${mainBaseUrl}/swarm/app`,
      icon: "🐝",
    },
    ...(ui
      ? [
          {
            id: "hindsight",
            name: "Hindsight",
            description: "Browse the local Hindsight memory UI",
            url: ui.url,
            icon: "🔎",
          },
        ]
      : []),
  ]
  const list = (ui: Ui): Service[] => [
    {
      name: "Dashboard",
      description: "",
      path: "/manager/app",
      url: `${mainBaseUrl}/manager/app`,
    },
    {
      name: "Web Interface",
      description: "Main OpenCode web interface for sessions and chat",
      path: "/",
      url: mainBaseUrl,
    },
    {
      name: "Memory Manager",
      description: "View, edit, and manage AI memory entries",
      path: "/memory/app",
      url: `${mainBaseUrl}/memory/app`,
    },
    {
      name: "Log Viewer",
      description: "Browse and analyze LLM interaction logs",
      path: "/log-viewer/app",
      url: `${mainBaseUrl}/log-viewer/app`,
    },
    {
      name: "Swarms",
      description: "Open the Swarm admin overview for your most recent project",
      path: "/swarm/app",
      url: `${mainBaseUrl}/swarm/app`,
    },
    ...(ui
      ? [
          {
            name: "Hindsight",
            description: "Browse the local Hindsight memory UI",
            path: "/dashboard",
            url: ui.url,
          },
        ]
      : []),
  ]

  ManagerState.enable()
  ManagerState.register(items(undefined))
  void MemoryHindsightUI.start()
    .then((ui) => {
      ManagerState.register(items(ui))
    })
    .catch(() => {})

  return {
    opts,
    server,
    mainPort,
    mainBaseUrl,
    services: list(undefined),
    ui: undefined as Ui,
  }
}

export const ManagerCommand = cmd({
  command: "manager [service]",
  describe: "unified web management for all OpenCode services",
  builder: (yargs: Argv) =>
    withNetworkOptions(yargs)
      .positional("service", {
        type: "string",
        describe: "service to open directly (hindsight, log-viewer, memory, swarm, web)",
        choices: ["hindsight", "log-viewer", "memory", "swarm", "web"],
      })
      .option("skip-open", {
        type: "boolean",
        describe: "do not auto-open browser",
        default: false,
      })
      .option("reset-logs", {
        type: "boolean",
        describe: "clear all LLM log data (preserves table structure)",
        default: false,
      })
      .example("$0 manager", "start all services and open dashboard")
      .example("$0 manager hindsight", "start all services and open hindsight")
      .example("$0 manager log-viewer", "start all services and open log-viewer")
      .example("$0 manager memory", "start all services and open memory manager")
      .example("$0 manager swarm", "start all services and open swarm admin"),
  handler: async (args: Record<string, unknown>) => {
    if (args.resetLogs) {
      const result = LlmLog.reset()
      UI.println(
        UI.Style.TEXT_SUCCESS_BOLD + "  Reset complete: ",
        UI.Style.TEXT_NORMAL,
        `${result.deleted} log records deleted`,
      )
      return
    }

    const service = args.service as string | undefined
    const noOpen = !!args.skipOpen

    await Instance.provide({
      directory: process.cwd(),
      init: InstanceBootstrap,
      fn: async () => {
        if (!Flag.OPENCODE_SERVER_PASSWORD) {
          UI.println(UI.Style.TEXT_WARNING_BOLD + "!  " + "OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
        }

        const { opts, server, mainPort, mainBaseUrl, services, ui } = await startManager(args)

        // Collect all output first, then print at once to avoid interleaving with server logs
        const lines: string[] = []
        lines.push("")
        lines.push(UI.logo("  "))
        lines.push("")
        lines.push(UI.Style.TEXT_INFO_BOLD + "  OpenCode Manager" + UI.Style.TEXT_NORMAL)
        lines.push("")

        for (const svc of services) {
          lines.push(UI.Style.TEXT_INFO_BOLD + `  ${svc.name.padEnd(20)} ` + UI.Style.TEXT_NORMAL + svc.url)
        }

        lines.push("")

        if (opts.hostname === "0.0.0.0") {
          const networkIPs = getNetworkIPs()
          if (networkIPs.length > 0) {
            lines.push(UI.Style.TEXT_DIM + "  Network access:")
            for (const ip of networkIPs) {
              lines.push(UI.Style.TEXT_DIM + `    http://${ip}:${mainPort}`)
            }
            lines.push("")
          }
        }

        lines.push(UI.Style.TEXT_DIM + "  Press Ctrl+C to stop all services" + UI.Style.TEXT_NORMAL)
        lines.push("")

        // Print all at once
        Bun.stderr.write(lines.join("\n") + "\n")

        // Determine which URL to open
        if (!noOpen) {
          let openUrl: string
          switch (service) {
            case "hindsight":
              openUrl = ui?.url ?? `${mainBaseUrl}/manager/app`
              break
            case "log-viewer":
              openUrl = `${mainBaseUrl}/log-viewer/app`
              break
            case "memory":
              openUrl = `${mainBaseUrl}/memory/app`
              break
            case "web":
              openUrl = mainBaseUrl
              break
            case "swarm":
              openUrl = `${mainBaseUrl}/swarm/app`
              break
            default:
              openUrl = `${mainBaseUrl}/manager/app`
              break
          }
          open(openUrl).catch(() => {})
        }

        const shutdown = async () => {
          await Instance.disposeAll()
          await server.stop()
          process.exit(0)
        }
        process.on("SIGTERM", shutdown)
        process.on("SIGINT", shutdown)

        await new Promise(() => {})
      },
    })
  },
})
