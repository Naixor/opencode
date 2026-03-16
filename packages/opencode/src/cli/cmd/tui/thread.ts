import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import { Rpc } from "@/util/rpc"
import { type rpc } from "./worker"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { Log } from "@/util/log"
import { withTimeout } from "@/util/timeout"
import { withNetworkOptions, resolveNetworkOptions } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import type { Event } from "@opencode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { TuiConfig } from "@/config/tui"
import { Instance } from "@/project/instance"
import { Lockfile } from "@/server/lockfile"

declare global {
  const OPENCODE_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient): EventSource {
  return {
    on: (handler) => client.on<Event>("event", handler),
  }
}

async function target() {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = new URL("./cli/cmd/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("./worker.ts", import.meta.url)
}

/** Resolve the worker script path as a string for Bun.spawn(). */
async function workerPath(): Promise<string> {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = fileURLToPath(new URL("./cli/cmd/tui/worker.js", import.meta.url))
  if (await Filesystem.exists(dist)) return dist
  return fileURLToPath(new URL("./worker.ts", import.meta.url))
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

/** Spawn Worker as a detached background process. Returns the child process. */
async function spawnDetached(cwd: string): Promise<Bun.Subprocess> {
  const script = await workerPath()
  const args = ["bun", "run", script, "--mode", "auto"]
  if (process.argv.includes("--print-logs")) args.push("--print-logs")

  const child = Bun.spawn(args, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  })
  child.unref()

  return child
}

/** Wait for lock file to appear and return its data. Polls with backoff. */
async function waitForLockfile(dir: string, timeout = 10_000): Promise<Lockfile.Data> {
  const start = Date.now()
  let delay = 50
  while (Date.now() - start < timeout) {
    const data = await Lockfile.read(dir)
    if (data) return data
    await Bun.sleep(delay)
    delay = Math.min(delay * 2, 500)
  }
  throw new Error("Timed out waiting for Worker to start")
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      }),
  handler: async (args) => {
    // Keep ENABLE_PROCESSED_INPUT cleared even if other code flips it.
    // (Important when running under `bun run` wrappers on Windows.)
    const unguard = win32InstallCtrlCGuard()
    try {
      // Must be the very first thing — disables CTRL_C_EVENT before any Worker
      // spawn or async work so the OS cannot kill the process group.
      win32DisableProcessedInput()

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative paths against PWD to preserve behavior when using --cwd flag
      const root = process.env.PWD ?? process.cwd()
      const cwd = args.project ? path.resolve(root, args.project) : process.cwd()
      const file = await target()
      try {
        process.chdir(cwd)
      } catch {
        UI.error("Failed to change directory to " + cwd)
        return
      }

      const network = await resolveNetworkOptions(args)
      const external =
        process.argv.includes("--port") ||
        process.argv.includes("--hostname") ||
        process.argv.includes("--mdns") ||
        network.mdns ||
        network.port !== 0 ||
        network.hostname !== "127.0.0.1"

      // Check for existing Worker via lock file
      const existing = await Lockfile.acquire(cwd)

      let transport: {
        url: string
        fetch: typeof fetch | undefined
        events: EventSource | undefined
      }

      let cleanup: () => Promise<void>

      if (existing) {
        // Connect to existing Worker via HTTP
        const url = `http://127.0.0.1:${existing.port}`
        transport = { url, fetch: undefined, events: undefined }
        cleanup = async () => {
          // TUI doesn't own this Worker, just disconnect
        }
      } else if (external) {
        // External mode: spawn Worker thread (existing behavior for network-exposed servers)
        const worker = new Worker(file, {
          env: Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
        })
        worker.onerror = (e) => {
          Log.Default.error(e)
        }

        const client = Rpc.client<typeof rpc>(worker)
        const error = (e: unknown) => {
          Log.Default.error(e)
        }
        const reload = () => {
          client.call("reload", undefined).catch((err: unknown) => {
            Log.Default.warn("worker reload failed", {
              error: err instanceof Error ? err.message : String(err),
            })
          })
        }
        process.on("uncaughtException", error)
        process.on("unhandledRejection", error)
        process.on("SIGUSR2", reload)

        transport = {
          url: (await client.call("server", network)).url,
          fetch: undefined,
          events: undefined,
        }

        let stopped = false
        cleanup = async () => {
          if (stopped) return
          stopped = true
          process.off("uncaughtException", error)
          process.off("unhandledRejection", error)
          process.off("SIGUSR2", reload)
          await withTimeout(client.call("shutdown", undefined), 5000).catch((err: unknown) => {
            Log.Default.warn("worker shutdown failed", {
              error: err instanceof Error ? err.message : String(err),
            })
          })
          worker.terminate()
        }
      } else {
        // Default: spawn detached Worker process
        await spawnDetached(cwd)
        const lock = await waitForLockfile(cwd)
        const url = `http://127.0.0.1:${lock.port}`
        transport = { url, fetch: undefined, events: undefined }
        cleanup = async () => {
          // TUI launched this Worker but doesn't own its lifecycle.
          // Worker runs independently (detached) and will self-manage.
        }
      }

      const prompt = await input(args.prompt)
      const config = await Instance.provide({
        directory: cwd,
        fn: () => TuiConfig.get(),
      })

      setTimeout(() => {
        // Upgrade check — fire and forget
        Instance.provide({
          directory: cwd,
          fn: async () => {
            await (await import("@/cli/upgrade")).upgrade().catch(() => {})
          },
        }).catch(() => {})
      }, 1000).unref?.()

      try {
        await tui({
          url: transport.url,
          config,
          directory: cwd,
          fetch: transport.fetch,
          events: transport.events,
          args: {
            continue: args.continue,
            sessionID: args.session,
            agent: args.agent,
            model: args.model,
            prompt,
            fork: args.fork,
          },
          onExit: cleanup,
        })
      } finally {
        await cleanup()
      }
    } finally {
      unguard?.()
    }
    process.exit(0)
  },
})
