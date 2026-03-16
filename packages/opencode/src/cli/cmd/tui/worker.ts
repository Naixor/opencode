import { Installation } from "@/installation"
import { Server } from "@/server/server"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { Config } from "@/config/config"
import { Flag } from "@/flag/flag"
import { registerAllHooks } from "@/session/hooks/register"
import { Lockfile } from "@/server/lockfile"
import type { BunWebSocketData } from "hono/bun"

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

registerAllHooks()

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// Parse --mode argument: "auto" (TUI-launched detached) or "serve" (opencode serve)
const mode = (() => {
  const idx = process.argv.indexOf("--mode")
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined
  const val = process.argv[idx + 1]
  if (val === "auto" || val === "serve") return val
  return undefined
})()

if (!mode) {
  Log.Default.error("worker requires --mode auto|serve")
  process.exit(1)
}

let server: Bun.Server<BunWebSocketData> | undefined

// Start HTTP server and write lock file
const dir = process.cwd()
server = Server.listen({ port: 0, hostname: "127.0.0.1" })
const port = server.port!

const ok = await Lockfile.create(dir, {
  pid: process.pid,
  port,
  token: null,
  createdAt: Date.now(),
})

if (!ok) {
  // Another Worker won the race — shut down
  Log.Default.info("lock file already exists, another worker is running")
  server.stop(true)
  process.exit(0)
}

Log.Default.info("worker started", { mode, pid: process.pid, port })

// Clean up lock file on exit signals
const cleanup = async () => {
  Log.Default.info("worker received exit signal, cleaning up")
  await Instance.disposeAll()
  if (server) server.stop(true)
  await Lockfile.remove(dir)
  process.exit(0)
}

process.on("SIGTERM", cleanup)
process.on("SIGINT", cleanup)

// RPC exports retained for type compatibility but no longer used at runtime.
// TUI connects via HTTP/SSE directly to the Worker's HTTP server.
export const rpc = {
  async reload() {
    Config.global.reset()
    await Instance.disposeAll()
  },
  async shutdown() {
    Log.Default.info("worker shutting down")
    await Instance.disposeAll()
    if (server) server.stop(true)
    await Lockfile.remove(dir)
  },
}
