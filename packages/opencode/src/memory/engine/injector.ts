import { Log } from "@/util/log"
import { Memory } from "../memory"
import { load, injectSections } from "../prompt/loader"
import { render } from "../prompt/template"
import { ConfigPaths } from "@/config/paths"
import { Instance } from "@/project/instance"

export namespace MemoryInject {
  const log = Log.create({ service: "memory.injector" })

  const DEFAULT_POOL_LIMIT = 200
  const RECALL_THRESHOLD = 3
  const RE_RECALL_INTERVAL = 5
  const MAX = 160
  const TAGS = 3
  const order = ["style", "pattern", "tool", "workflow", "domain", "correction", "context"] satisfies Array<
    Memory.Info["category"]
  >

  // --- Recall cache ---

  interface CachedRecall {
    relevant: string[]
    conflicts: Array<{ memoryA: string; memoryB: string; reason: string }>
    count: number
  }

  const cache = new Map<string, CachedRecall>()

  /**
   * Build the candidate pool: manual memories in full + auto memories by score up to limit.
   */
  export function buildCandidatePool(allMemories: Memory.Info[], limit?: number): Memory.Info[] {
    const cap = limit ?? DEFAULT_POOL_LIMIT
    const manual = allMemories.filter((m) => m.inject || m.source.method === "manual" || m.source.method === "pulled")
    const auto = allMemories.filter((m) => !m.inject && m.source.method !== "manual" && m.source.method !== "pulled")

    const slots = Math.max(0, cap - manual.length)
    const top = auto.sort((a, b) => b.score - a.score).slice(0, slots)

    return [...manual, ...top]
  }

  /**
   * Determine the injection phase based on user message count.
   */
  export function getPhase(count: number): "full" | "recall" {
    return count < RECALL_THRESHOLD ? "full" : "recall"
  }

  /**
   * Check if we should re-invoke the recall agent.
   */
  export function shouldReRecall(sessionID: string, count: number): boolean {
    const cached = cache.get(sessionID)
    if (!cached) return true
    if (count - cached.count >= RE_RECALL_INTERVAL) return true
    if (Memory.isDirty(sessionID)) return true
    return false
  }

  /**
   * Store recall results in cache.
   */
  export function cacheRecallResult(
    sessionID: string,
    result: { relevant: string[]; conflicts: CachedRecall["conflicts"] },
    count: number,
  ): void {
    cache.set(sessionID, {
      ...result,
      count,
    })
    Memory.clearDirty(sessionID)
  }

  /**
   * Get cached recall result for a session.
   */
  export function getCachedRecall(sessionID: string): CachedRecall | undefined {
    return cache.get(sessionID)
  }

  /**
   * Clear recall cache for a session (e.g., on session end).
   */
  export function clearCache(sessionID: string): void {
    cache.delete(sessionID)
  }

  /**
   * Format memories for injection into system prompt.
   */
  export function formatMemoriesForPrompt(memories: Memory.Info[]): string {
    if (memories.length === 0) return ""

    return [
      "<memory>",
      "Apply only the relevant memories. Do not mention them unless asked.",
      "",
      ...block(memories),
      "</memory>",
    ].join("\n")
  }

  /**
   * Format conflict warnings for system prompt.
   */
  export function formatConflictWarning(
    conflicts: Array<{ memoryA: string; memoryB: string; reason: string }>,
  ): string {
    if (conflicts.length === 0) return ""

    const lines = conflicts.map((c) => `- Conflict between [${c.memoryA}] and [${c.memoryB}]: ${c.reason}`)

    return [
      "<memory-conflicts>",
      "Warning: The following memory conflicts were detected. Ask the user to resolve them.",
      "",
      ...lines,
      "</memory-conflicts>",
    ].join("\n")
  }

  /**
   * Format memories for injection using template loader (async version).
   */
  export async function formatMemoriesAsync(memories: Memory.Info[]): Promise<string> {
    if (memories.length === 0) return ""

    const tpl = await load("inject", await ConfigPaths.directories(Instance.directory, Instance.worktree))
    const parts = injectSections(tpl)

    return render(parts.injection, { MEMORY_ITEMS: block(memories).join("\n") })
  }

  /**
   * Format conflict warnings using template loader (async version).
   */
  export async function formatConflictAsync(
    conflicts: Array<{ memoryA: string; memoryB: string; reason: string }>,
  ): Promise<string> {
    if (conflicts.length === 0) return ""

    const tpl = await load("inject", await ConfigPaths.directories(Instance.directory, Instance.worktree))
    const parts = injectSections(tpl)

    const lines = conflicts.map((c) => `- Conflict between [${c.memoryA}] and [${c.memoryB}]: ${c.reason}`)

    return render(parts.conflict, { CONFLICT_ITEMS: lines.join("\n") })
  }

  /**
   * Count user messages in the message history.
   */
  export function countUserMessages(messages: unknown[]): number {
    return messages.filter(
      (m): m is { role: string } =>
        typeof m === "object" && m !== null && "role" in m && (m as { role: string }).role === "user",
    ).length
  }

  function block(memories: Memory.Info[]): string[] {
    return order.flatMap((category) => {
      const group = memories.filter((m) => m.category === category)
      if (group.length === 0) return []
      return [`${category}:`, ...group.map((m) => item(m)), ""]
    })
  }

  function item(memory: Memory.Info): string {
    const content = clip(memory.content)
    const scope = memory.scope === "team" ? " [team]" : ""
    const tags = memory.tags.length === 0 ? "" : ` ${tag(memory.tags)}`
    return `- ${content}${scope}${tags}`
  }

  function tag(tags: string[]): string {
    const list = tags.slice(0, TAGS)
    const more = tags.length - list.length
    const suffix = more > 0 ? ` +${more}` : ""
    return `${list.map((tag) => `#${tag}`).join(" ")}${suffix}`
  }

  function clip(text: string): string {
    const clean = text.replace(/\s+/g, " ").trim()
    if (clean.length <= MAX) return clean
    return `${clean.slice(0, MAX - 3).trimEnd()}...`
  }
}
