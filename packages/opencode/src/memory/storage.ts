import path from "path"
import fs from "fs/promises"
import { Log } from "@/util/log"
import { Lock } from "@/util/lock"
import { Global } from "@/global"
import { Instance } from "@/project/instance"

/**
 * Memory entry shape for the storage layer.
 * Mirrors Memory.Info but avoids circular dependency.
 */
export interface MemoryRecord {
  id: string
  content: string
  category: string
  scope: string
  status: string
  tags: string[]
  source: {
    sessionID: string
    llmLogID?: string
    messageID?: string
    method: string
    contextSnapshot?: string
  }
  citations: string[]
  score: number
  baseScore?: number
  useCount: number
  hitCount: number
  lastUsedAt?: number
  createdAt: number
  updatedAt: number
  confirmedAt?: number
  expiresAt?: number
  inject: boolean
  teamCandidateAt?: number
  teamSubmittedAt?: number
  teamApprovedAt?: number
  promotedBy?: string
  teamScope?: {
    global: boolean
    projectIds: string[]
    languages: string[]
    techStack: string[]
    modules: string[]
  }
}

export namespace MemoryStorage {
  const log = Log.create({ service: "memory.storage" })

  interface Store {
    memories: Record<string, MemoryRecord>
    meta: Record<string, number>
  }

  // --- In-memory cache ---
  let cache: Store | undefined

  function projectDir(): string {
    try {
      const dir = Instance.directory
      return path.join(Global.Path.data, "memory", encodeURIComponent(dir))
    } catch {
      return path.join(Global.Path.data, "memory", "global")
    }
  }

  function filePath(): string {
    return path.join(projectDir(), "personal.json")
  }

  async function ensureDir(): Promise<void> {
    await fs.mkdir(projectDir(), { recursive: true })
  }

  async function load(): Promise<Store> {
    if (cache) return cache
    try {
      const raw = await Bun.file(filePath()).text()
      const data = JSON.parse(raw) as Store
      cache = {
        memories: data.memories ?? {},
        meta: data.meta ?? {},
      }
    } catch {
      cache = { memories: {}, meta: {} }
    }
    return cache
  }

  /**
   * Atomic persist: write to temp file then rename.
   * Prevents data loss on crash/power-loss mid-write.
   */
  async function persist(store: Store): Promise<void> {
    await ensureDir()
    const fp = filePath()
    const tmp = fp + ".tmp." + Date.now()
    await Bun.write(tmp, JSON.stringify(store, null, 2))
    await fs.rename(tmp, fp)
    cache = store
  }

  /** Invalidate in-memory cache (for testing or reload). */
  export function invalidate(): void {
    cache = undefined
  }

  export async function save(memory: MemoryRecord): Promise<void> {
    const fp = filePath()
    using _ = await Lock.write(fp)
    const store = await load()
    store.memories[memory.id] = memory
    await persist(store)
  }

  export async function get(id: string): Promise<MemoryRecord | undefined> {
    const fp = filePath()
    using _ = await Lock.read(fp)
    const store = await load()
    return store.memories[id]
  }

  export async function remove(id: string): Promise<boolean> {
    const fp = filePath()
    using _ = await Lock.write(fp)
    const store = await load()
    if (!(id in store.memories)) return false
    delete store.memories[id]
    await persist(store)
    return true
  }

  export async function loadAll(): Promise<MemoryRecord[]> {
    const fp = filePath()
    using _ = await Lock.read(fp)
    const store = await load()
    return Object.values(store.memories)
  }

  /**
   * Atomically increment a numeric field and optionally set lastUsedAt.
   * Avoids TOCTOU race in read-modify-write patterns.
   */
  export async function increment(
    id: string,
    field: "useCount" | "hitCount",
    opts?: { lastUsedAt?: number },
  ): Promise<boolean> {
    const fp = filePath()
    using _ = await Lock.write(fp)
    const store = await load()
    const memory = store.memories[id]
    if (!memory) return false
    memory[field] = (memory[field] ?? 0) + 1
    if (opts?.lastUsedAt) memory.lastUsedAt = opts.lastUsedAt
    memory.updatedAt = Date.now()
    await persist(store)
    return true
  }

  /**
   * Atomically increment a field for multiple records in one lock + persist cycle.
   * Avoids N sequential writes for batch operations.
   */
  export async function batchIncrement(
    ids: string[],
    field: "useCount" | "hitCount",
    opts?: { lastUsedAt?: number },
  ): Promise<number> {
    if (ids.length === 0) return 0
    const fp = filePath()
    using _ = await Lock.write(fp)
    const store = await load()
    const now = Date.now()
    let count = 0
    for (const id of ids) {
      const memory = store.memories[id]
      if (!memory) continue
      memory[field] = (memory[field] ?? 0) + 1
      if (opts?.lastUsedAt) memory.lastUsedAt = opts.lastUsedAt
      memory.updatedAt = now
      count++
    }
    if (count > 0) await persist(store)
    return count
  }

  /**
   * Atomically update a record under a single write lock.
   * Avoids TOCTOU race from separate get() + save() calls.
   */
  export async function atomicUpdate(
    id: string,
    fn: (record: MemoryRecord) => MemoryRecord,
  ): Promise<MemoryRecord | undefined> {
    const fp = filePath()
    using _ = await Lock.write(fp)
    const store = await load()
    const existing = store.memories[id]
    if (!existing) return undefined
    const updated = fn(existing)
    store.memories[id] = updated
    await persist(store)
    return updated
  }

  /**
   * Atomically remove multiple records in one lock + persist cycle.
   */
  export async function batchRemove(ids: string[]): Promise<number> {
    const fp = filePath()
    using _ = await Lock.write(fp)
    const store = await load()
    let count = 0
    for (const id of ids) {
      if (id in store.memories) {
        delete store.memories[id]
        count++
      }
    }
    if (count > 0) await persist(store)
    return count
  }

  export async function getMeta(key: string): Promise<number | undefined> {
    const fp = filePath()
    using _ = await Lock.read(fp)
    const store = await load()
    return store.meta[key]
  }

  export async function setMeta(key: string, value: number): Promise<void> {
    const fp = filePath()
    using _ = await Lock.write(fp)
    const store = await load()
    store.meta[key] = value
    await persist(store)
  }

  /** Clear all data (for testing) */
  export async function clear(): Promise<void> {
    const fp = filePath()
    using _ = await Lock.write(fp)
    await persist({ memories: {}, meta: {} })
  }
}
