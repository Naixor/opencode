import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import path from "path"
import { UI } from "@/cli/ui"
import { Log } from "@/util/log"
import { withNetworkOptions, resolveNetworkOptions } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { TuiConfig } from "@/config/tui"
import { Instance } from "@/project/instance"
import { Lockfile } from "@/server/lockfile"
import { fileURLToPath } from "url"

declare global {
  const OPENCODE_WORKER_PATH: string
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

/** Spawn Worker as a detached background process. */
async function spawnDetached(cwd: string): Promise<void> {
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
      try {
        process.chdir(cwd)
      } catch {
        UI.error("Failed to change directory to " + cwd)
        return
      }

      // Check for existing Worker via lock file
      const existing = await Lockfile.acquire(cwd)

      let url: string
      if (existing) {
        // Connect to existing Worker via HTTP
        url = `http://127.0.0.1:${existing.port}`
      } else {
        // Spawn detached Worker process and wait for it to be ready
        await spawnDetached(cwd)
        const lock = await waitForLockfile(cwd)
        url = `http://127.0.0.1:${lock.port}`
      }

      const prompt = await input(args.prompt)
      const config = await Instance.provide({
        directory: cwd,
        fn: () => TuiConfig.get(),
      })

      setTimeout(() => {
        Instance.provide({
          directory: cwd,
          fn: async () => {
            await (await import("@/cli/upgrade")).upgrade().catch(() => {})
          },
        }).catch(() => {})
      }, 1000).unref?.()

      const cleanup = async () => {
        // TUI doesn't own the Worker lifecycle — it runs independently (detached).
      }

      try {
        await tui({
          url,
          config,
          directory: cwd,
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
