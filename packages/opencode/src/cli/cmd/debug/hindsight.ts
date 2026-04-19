import { EOL } from "os"
import open from "open"
import { Config } from "../../../config/config"
import { UI } from "../../ui"
import { Process } from "../../../util/process"
import { MemoryHindsightBank } from "../../../memory/hindsight/bank"
import { MemoryHindsightService } from "../../../memory/hindsight/service"
import { MemoryHindsightState } from "../../../memory/hindsight/state"
import { free, href, loadHindsightUi, patchHindsightUi, startHindsightProxy } from "../../../memory/hindsight/ui"
import { Instance } from "../../../project/instance"
import { Project } from "../../../project/project"
import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"

export { free, href, loadHindsightUi, patchHindsightUi, startHindsightProxy } from "../../../memory/hindsight/ui"

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

export async function hindsightRoot(dir: string) {
  return Project.fromDirectory(dir)
    .then((result) => result.project.worktree)
    .catch(() => dir)
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
    await bootstrap(await hindsightRoot(process.cwd()), async () => {
      const port = typeof args.port === "number" ? args.port : 9999
      const hostname = typeof args.hostname === "string" ? args.hostname : "127.0.0.1"
      const backend = await free(hostname)
      const ui = await loadHindsightUi({
        port: backend,
        hostname,
      })
      const url = href(hostname, port)
      const proxy = startHindsightProxy({
        hostname,
        port,
        target: ui.url,
        api_url: ui.api_url,
        bank_id: ui.bank_id,
      })

      const child = Process.spawn(ui.cmd, {
        cwd: ui.dir,
        env: {
          ...ui.env,
          BUN_BE_BUN: "1",
        },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      })

      UI.println(UI.Style.TEXT_INFO_BOLD + "  Hindsight Control Plane", UI.Style.TEXT_NORMAL)
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web UI:    ", UI.Style.TEXT_NORMAL, url)
      UI.println(UI.Style.TEXT_INFO_BOLD + "  API URL:   ", UI.Style.TEXT_NORMAL, ui.api_url)
      UI.println(
        UI.Style.TEXT_WARNING_BOLD + "  Note: ",
        UI.Style.TEXT_NORMAL,
        "OpenCode local memory remains authoritative; edits in Hindsight UI do not sync back.",
      )
      UI.println(UI.Style.TEXT_DIM + "  Press Ctrl+C to stop the control plane" + UI.Style.TEXT_NORMAL)
      UI.empty()

      if (!args.skipOpen) open(url).catch(() => {})

      const stop = () => {
        proxy.stop()
        if (child.exitCode !== null || child.signalCode !== null) return
        child.kill("SIGTERM")
      }

      process.on("SIGTERM", stop)
      process.on("SIGINT", stop)
      try {
        await child.exited
      } finally {
        proxy.stop()
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
