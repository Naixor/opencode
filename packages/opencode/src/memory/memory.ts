import z from "zod"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { MemoryStorage } from "./storage"

export namespace Memory {
  const log = Log.create({ service: "memory" })

  function text(err: unknown) {
    return err instanceof Error ? err.message : String(err)
  }

  async function sync(memory: Info) {
    return import("./hindsight/retain")
      .then((mod) => mod.MemoryHindsightRetain.memory(memory))
      .catch((err) => {
        log.warn("hindsight sync failed", { id: memory.id, error: text(err) })
      })
      .then(() => memory)
  }

  // --- Enums ---

  export const Category = z.enum(["style", "pattern", "tool", "domain", "workflow", "correction", "context"])
  export type Category = z.infer<typeof Category>

  export const Scope = z.enum(["personal", "team"])
  export type Scope = z.infer<typeof Scope>

  export const Status = z.enum(["pending", "confirmed"])
  export type Status = z.infer<typeof Status>

  // --- Team Memory multi-dimension isolation ---

  export const TeamScope = z.object({
    global: z.boolean().default(false),
    projectIds: z.array(z.string()).default([]),
    languages: z.array(z.string()).default([]),
    techStack: z.array(z.string()).default([]),
    modules: z.array(z.string()).default([]),
  })
  export type TeamScope = z.infer<typeof TeamScope>

  // --- Source traceability ---

  export const Source = z.object({
    sessionID: z.string(),
    llmLogID: z.string().optional(),
    messageID: z.string().optional(),
    method: z.enum(["auto", "manual", "promoted", "pulled"]),
    contextSnapshot: z.string().optional(),
  })
  export type Source = z.infer<typeof Source>

  // --- Core data model ---

  export const Info = z.object({
    id: z.string(),
    content: z.string(),
    categories: z.array(Category).min(1),
    scope: Scope,
    status: Status.default("confirmed"),
    tags: z.array(z.string()).default([]),
    source: Source,
    citations: z.array(z.string()).default([]),

    // lifecycle
    score: z.number().default(1.0),
    baseScore: z.number().default(1.0),
    useCount: z.number().default(0),
    hitCount: z.number().default(0),
    lastUsedAt: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    confirmedAt: z.number().optional(),
    expiresAt: z.number().optional(),

    // injection control
    inject: z.boolean().default(false),

    // team promotion
    teamCandidateAt: z.number().optional(),
    teamSubmittedAt: z.number().optional(),
    teamApprovedAt: z.number().optional(),
    promotedBy: z.string().optional(),

    // team scope (only for scope === "team")
    teamScope: TeamScope.optional(),
  })
  export type Info = z.infer<typeof Info>

  // --- Create input (partial, system fills defaults) ---

  export const CreateInput = Info.omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  }).partial({
    score: true,
    baseScore: true,
    useCount: true,
    hitCount: true,
    status: true,
    tags: true,
    citations: true,
    inject: true,
  })
  export type CreateInput = z.infer<typeof CreateInput>

  // --- CRUD operations ---

  export async function create(input: CreateInput): Promise<Info> {
    const now = Date.now()
    const base = input.score ?? 1.0
    const memory: Info = {
      ...input,
      id: Identifier.ascending("memory"),
      tags: input.tags ?? [],
      citations: input.citations ?? [],
      score: input.score ?? 1.0,
      baseScore: input.baseScore ?? base,
      useCount: input.useCount ?? 0,
      hitCount: input.hitCount ?? 0,
      status: input.status ?? "confirmed",
      inject: input.inject ?? false,
      createdAt: now,
      updatedAt: now,
    }
    const validated = Info.parse(memory)
    await MemoryStorage.save(validated)
    log.info("created", { id: validated.id, categories: validated.categories, scope: validated.scope })
    return sync(validated)
  }

  export async function get(id: string): Promise<Info | undefined> {
    const raw = await MemoryStorage.get(id)
    if (!raw) return undefined
    // Migrate legacy records missing baseScore
    if (raw.baseScore === undefined) raw.baseScore = raw.score
    return Info.parse(raw)
  }

  export async function update(id: string, patch: Partial<Omit<Info, "id" | "createdAt">>): Promise<Info | undefined> {
    const result = await MemoryStorage.atomicUpdate(id, (existing) => {
      // Migrate legacy records missing baseScore
      if (existing.baseScore === undefined) existing.baseScore = existing.score
      const merged: Info = {
        ...Info.parse(existing),
        ...patch,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: Date.now(),
      }
      return Info.parse(merged) as unknown as import("./storage").MemoryRecord
    })
    if (!result) return undefined
    log.info("updated", { id })
    return sync(Info.parse(result))
  }

  export async function remove(id: string): Promise<boolean> {
    const result = await MemoryStorage.remove(id)
    if (result) log.info("removed", { id })
    return result
  }

  export async function batchRemove(ids: string[]): Promise<number> {
    const count = await MemoryStorage.batchRemove(ids)
    if (count > 0) log.info("batch removed", { count, total: ids.length })
    return count
  }

  export async function list(filter?: {
    scope?: Scope
    status?: Status
    category?: Category // filter: matches any memory whose categories includes this value
    method?: Source["method"]
  }): Promise<Info[]> {
    const all = await MemoryStorage.loadAll()
    return all
      .map((m) => {
        // Migrate legacy records missing baseScore
        if (m.baseScore === undefined) m.baseScore = m.score
        return Info.parse(m)
      })
      .filter((m) => {
        if (filter?.scope && m.scope !== filter.scope) return false
        if (filter?.status && m.status !== filter.status) return false
        if (filter?.category && !m.categories.includes(filter.category)) return false
        if (filter?.method && m.source.method !== filter.method) return false
        return true
      })
  }

  export async function upsert(memory: Info): Promise<Info> {
    const validated = Info.parse({ ...memory, updatedAt: Date.now() })
    await MemoryStorage.save(validated)
    log.info("upserted", { id: validated.id })
    return validated
  }

  /**
   * Find a memory with similar content (keyword jaccard similarity >= 0.6).
   * Falls back to exact match if content is short.
   */
  export async function findSimilar(content: string): Promise<Info | undefined> {
    const all = await MemoryStorage.loadAll()
    const normalized = content.toLowerCase().trim()
    const words = tokenize(normalized)

    // For very short content, use exact match
    if (words.length <= 2) {
      const raw = all.find((m) => m.content.toLowerCase().trim() === normalized)
      if (!raw) return undefined
      if (raw.baseScore === undefined) raw.baseScore = raw.score
      return Info.parse(raw)
    }

    // Jaccard similarity on keyword sets
    let best: { record: (typeof all)[number]; score: number } | undefined
    for (const m of all) {
      const other = tokenize(m.content.toLowerCase().trim())
      const intersection = words.filter((w) => other.includes(w)).length
      const union = new Set([...words, ...other]).size
      const sim = union > 0 ? intersection / union : 0
      if (sim >= 0.6 && (!best || sim > best.score)) {
        best = { record: m, score: sim }
      }
    }
    if (!best) return undefined
    if (best.record.baseScore === undefined) best.record.baseScore = best.record.score
    return Info.parse(best.record)
  }

  // --- Meta key-value store (for tracking extraction state, etc.) ---

  export async function getMeta(key: string): Promise<number | undefined> {
    return MemoryStorage.getMeta(key)
  }

  export async function setMeta(key: string, value: number): Promise<void> {
    return MemoryStorage.setMeta(key, value)
  }

  // --- Counter helpers (atomic, no TOCTOU race) ---

  export async function incrementUseCount(id: string): Promise<void> {
    await MemoryStorage.increment(id, "useCount", { lastUsedAt: Date.now() })
  }

  export async function incrementHitCount(id: string): Promise<void> {
    await MemoryStorage.increment(id, "hitCount")
  }

  /** Batch increment useCount for multiple memories in one lock+persist cycle. */
  export async function batchIncrementUseCount(ids: string[]): Promise<number> {
    return MemoryStorage.batchIncrement(ids, "useCount", { lastUsedAt: Date.now() })
  }

  /** Batch increment hitCount for multiple memories in one lock+persist cycle. */
  export async function batchIncrementHitCount(ids: string[]): Promise<number> {
    return MemoryStorage.batchIncrement(ids, "hitCount")
  }

  // --- Dirty tracking (for recall cache invalidation) ---

  const dirtySet = new Set<string>()

  export function markDirty(sessionID: string): void {
    dirtySet.add(sessionID)
  }

  export function isDirty(sessionID: string): boolean {
    return dirtySet.has(sessionID)
  }

  export function clearDirty(sessionID: string): void {
    dirtySet.delete(sessionID)
  }

  // --- Session cleanup (prevents memory leaks in long-running processes) ---

  export function cleanupSession(sessionID: string): void {
    dirtySet.delete(sessionID)
  }

  // --- Internal helpers ---

  const STOP = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "can",
    "shall",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "during",
    "before",
    "after",
    "and",
    "but",
    "or",
    "nor",
    "not",
    "so",
    "yet",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
    "use",
    "using",
    "used",
  ])

  function tokenize(text: string): string[] {
    return text.split(/[\s,.:;!?()[\]{}"'`]+/).filter((w) => w.length >= 3 && !STOP.has(w))
  }
}
