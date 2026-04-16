import { Installation } from "@/installation"
import { Server } from "@/server/server"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { Config } from "@/config/config"
import { registerAllHooks } from "@/session/hooks/register"
import { Lockfile } from "@/server/lockfile"
import { Lifecycle } from "@/server/lifecycle"
import { AuthToken } from "@/server/auth-token"
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
  try {
    Log.captureCrashSync("tui.worker.unhandledRejection", e instanceof Error ? e : String(e))
  } catch {}
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
  try {
    Log.captureCrashSync("tui.worker.uncaughtException", e)
  } catch {}
})

// Parse CLI arguments
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

const hostname = (() => {
  const idx = process.argv.indexOf("--hostname")
  if (idx === -1 || idx + 1 >= process.argv.length) return "127.0.0.1"
  return process.argv[idx + 1]
})()

const port = (() => {
  const idx = process.argv.indexOf("--port")
  if (idx === -1 || idx + 1 >= process.argv.length) return 0
  return parseInt(process.argv[idx + 1], 10) || 0
})()

const authTokenArg = (() => {
  const idx = process.argv.indexOf("--auth-token")
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined
  return process.argv[idx + 1]
})()

// Set up auth token when hostname is not loopback
const token = (() => {
  if (AuthToken.loopback(hostname)) return null
  const val = authTokenArg ?? AuthToken.generate()
  AuthToken.set(val)
  Log.Default.info("auth token", { token: val })
  return val
})()

let server: Bun.Server<BunWebSocketData> | undefined

// Start HTTP server and write lock file
const dir = process.cwd()
server = Server.listen({ port, hostname })
const bound = server.port!

const ok = await Lockfile.create(dir, {
  pid: process.pid,
  port: bound,
  token,
  createdAt: Date.now(),
})

if (!ok) {
  Log.Default.error("failed to create lock file (race condition with same PID)")
  server.stop(true)
  process.exit(1)
}

Log.Default.info("worker started", { mode, pid: process.pid, port: bound, hostname })

// Clean up and exit
const shutdown = async () => {
  Log.Default.info("worker shutting down")
  await Instance.disposeAll()
  if (server) server.stop(true)
  await Lockfile.remove(dir)
  process.exit(0)
}

// Enable auto-exit lifecycle for auto mode
if (mode === "auto") {
  Lifecycle.enable(shutdown)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

// RPC exports retained for type compatibility but no longer used at runtime.
export const rpc = {
  async reload() {
    Config.global.reset()
    await Instance.disposeAll()
  },
  async shutdown() {
    await shutdown()
  },
}
