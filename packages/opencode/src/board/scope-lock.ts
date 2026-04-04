import { Instance } from "../project/instance"
import { Log } from "../util/log"

export namespace ScopeLock {
  const log = Log.create({ service: "board.scope-lock" })

  interface LockEntry {
    agent: string
    taskID: string
  }

  // Instance-scoped state: Map<swarm_id, Map<path, LockEntry>>
  const state = Instance.state(() => new Map<string, Map<string, LockEntry>>())

  function locks(swarm: string): Map<string, LockEntry> {
    const all = state()
    if (!all.has(swarm)) all.set(swarm, new Map())
    return all.get(swarm)!
  }

  export function lock(swarm: string, taskID: string, scope: string[], agent: string) {
    const map = locks(swarm)
    for (const p of scope) {
      map.set(p, { agent, taskID })
    }
  }

  export function unlock(swarm: string, taskID: string) {
    const map = locks(swarm)
    for (const [p, entry] of [...map.entries()]) {
      if (entry.taskID === taskID) map.delete(p)
    }
  }

  export function check(swarm: string, filepath: string, agent: string): LockEntry | undefined {
    const map = locks(swarm)
    const entry = map.get(filepath)
    if (!entry) return undefined
    if (entry.agent === agent) return undefined
    return entry
  }
}
