import path from "path"
import os from "os"
import { Instance } from "../project/instance"
import { Todo } from "./todo"
import { Log } from "../util/log"

export namespace Recovery {
  const log = Log.create({ service: "session-recovery" })

  export interface Heartbeat {
    sessionID: string
    projectDir: string
    todoState: Todo.Info[]
    timestamp: number
    pid: number
  }

  function projectDir() {
    return path.join(Instance.directory, ".opencode", "recovery")
  }

  function globalDir() {
    return path.join(os.homedir(), ".opencode", "recovery")
  }

  function heartbeatPath(dir: string, sessionID: string) {
    return path.join(dir, `${sessionID}.json`)
  }

  export async function writeHeartbeat(sessionID: string) {
    const todos = await Todo.get(sessionID)
    const heartbeat: Heartbeat = {
      sessionID,
      projectDir: Instance.directory,
      todoState: todos,
      timestamp: Date.now(),
      pid: process.pid,
    }
    const data = JSON.stringify(heartbeat)
    const pDir = projectDir()
    const gDir = globalDir()

    Bun.write(heartbeatPath(pDir, sessionID), data).catch((err) => {
      log.debug("failed to write project heartbeat", { error: String(err) })
    })
    Bun.write(heartbeatPath(gDir, sessionID), data).catch((err) => {
      log.debug("failed to write global heartbeat", { error: String(err) })
    })
  }

  export async function deleteHeartbeat(sessionID: string) {
    const pPath = heartbeatPath(projectDir(), sessionID)
    const gPath = heartbeatPath(globalDir(), sessionID)
    const { unlink } = await import("fs/promises")
    await unlink(pPath).catch(() => {})
    await unlink(gPath).catch(() => {})
  }

  function isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function scanDir(dir: string): Promise<Heartbeat[]> {
    const results: Heartbeat[] = []
    const dirExists = await Bun.file(path.join(dir, ".."))
      .exists()
      .catch(() => false)
    if (!dirExists) return results
    const glob = new Bun.Glob("*.json")
    for await (const file of glob.scan({ cwd: dir, absolute: true })) {
      const content = await Bun.file(file)
        .text()
        .catch(() => "")
      if (!content) continue
      let parsed: Heartbeat
      try {
        parsed = JSON.parse(content)
      } catch {
        continue
      }
      if (!parsed?.sessionID || !parsed?.pid) continue
      if (isProcessRunning(parsed.pid)) continue
      results.push(parsed)
    }
    return results
  }

  export async function findStaleHeartbeats(): Promise<Heartbeat[]> {
    const seen = new Set<string>()
    const stale: Heartbeat[] = []

    const projectHeartbeats = await scanDir(projectDir()).catch(() => [] as Heartbeat[])
    for (const h of projectHeartbeats) {
      if (seen.has(h.sessionID)) continue
      seen.add(h.sessionID)
      stale.push(h)
    }

    const globalHeartbeats = await scanDir(globalDir()).catch(() => [] as Heartbeat[])
    for (const h of globalHeartbeats) {
      if (seen.has(h.sessionID)) continue
      if (h.projectDir !== Instance.directory) continue
      seen.add(h.sessionID)
      stale.push(h)
    }

    return stale
  }

  export async function ensureGitignore() {
    const gitignorePath = path.join(Instance.directory, ".gitignore")
    const entry = ".opencode/recovery/"
    const content = await Bun.file(gitignorePath)
      .text()
      .catch(() => "")
    if (content.includes(entry)) return
    const newContent = content.endsWith("\n") ? content + entry + "\n" : content + "\n" + entry + "\n"
    await Bun.write(gitignorePath, newContent).catch((err) => {
      log.debug("failed to update .gitignore", { error: String(err) })
    })
  }
}
