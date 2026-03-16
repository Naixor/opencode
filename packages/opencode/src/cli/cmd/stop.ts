import { cmd } from "./cmd"
import { Lockfile } from "@/server/lockfile"
import { UI } from "@/cli/ui"

export const StopCommand = cmd({
  command: "stop",
  describe: "stop the background worker for the current directory",
  builder: (yargs) => yargs,
  handler: async () => {
    const dir = process.cwd()
    const lock = await Lockfile.acquire(dir)

    if (!lock) {
      UI.println("No running worker found for this directory.")
      return
    }

    try {
      process.kill(lock.pid, "SIGTERM")
      UI.println(`Sent SIGTERM to worker (PID ${lock.pid}).`)
    } catch {
      UI.println(`Worker (PID ${lock.pid}) not responding, cleaning up lock file.`)
      await Lockfile.remove(dir)
    }
  },
})
