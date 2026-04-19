import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Lockfile } from "../../server/lockfile"
import { Instance } from "../../project/instance"
import { InstanceBootstrap } from "../../project/bootstrap"
import { AuthToken } from "../../server/auth-token"
import { Lifecycle } from "../../server/lifecycle"
import { MemoryHindsightUI } from "../../memory/hindsight/ui"

export async function startServe(args: Record<string, unknown>, auto: boolean) {
  const opts = await resolveNetworkOptions(args as any)
  const token = (() => {
    if (AuthToken.loopback(opts.hostname)) return null
    const val = (args["auth-token"] as string | undefined) ?? AuthToken.generate()
    AuthToken.set(val)
    if (!auto) console.log(`Auth token: ${val}`)
    return val
  })()

  const server = Server.listen(opts)
  const port = server.port!
  const ui = auto ? undefined : await MemoryHindsightUI.start()

  return {
    dir: process.cwd(),
    opts,
    token,
    server,
    port,
    ui,
  }
}

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .option("auth-token", {
        type: "string",
        describe: "auth token for Bearer authentication (auto-generated when hostname is not loopback)",
      })
      .option("auto", {
        type: "boolean",
        describe: "auto-exit when no clients are connected (used by TUI worker)",
        hidden: true,
      }),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    const auto = !!(args as Record<string, unknown>).auto

    if (!auto && !Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }

    const dir = process.cwd()

    await Instance.provide({
      directory: dir,
      init: InstanceBootstrap,
      fn: async () => {
        const { token, server, port, ui } = await startServe(args as Record<string, unknown>, auto)

        const ok = await Lockfile.create(dir, {
          pid: process.pid,
          port,
          token,
          createdAt: Date.now(),
        })

        if (!ok) {
          console.error("Error: failed to create lock file (race condition). Another worker may have just started.")
          await server.stop()
          process.exitCode = 1
          return
        }

        if (!auto) console.log(`opencode server listening on http://${server.hostname}:${port}`)
        if (!auto && ui) console.log(`hindsight ui listening on ${ui.url}`)

        const shutdown = async () => {
          await Instance.disposeAll()
          await server.stop()
          await Lockfile.remove(dir)
          process.exit(0)
        }

        // Enable auto-exit lifecycle when spawned by TUI
        if (auto) {
          Lifecycle.enable(shutdown)
        }

        process.on("SIGTERM", shutdown)
        process.on("SIGINT", shutdown)

        // Keep process alive
        await new Promise(() => {})
      },
    })
  },
})
