import { HookChain } from "@/session/hooks"
import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { Memory } from "../memory"
import { MemoryInject } from "../engine/injector"

const log = Log.create({ service: "memory.hooks.hit-tracker" })

const TRACKABLE = new Set(["write", "edit", "create", "bash", "multi_edit"])

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
  "both",
  "either",
  "neither",
  "each",
  "every",
  "all",
  "any",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "only",
  "own",
  "same",
  "than",
  "too",
  "very",
  "just",
  "because",
  "if",
  "when",
  "use",
  "using",
  "used",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
])

/**
 * Extract significant keywords from memory content for matching.
 * Filters out common stop words and short tokens.
 */
function keywords(content: string): string[] {
  return content
    .toLowerCase()
    .split(/[\s,.:;!?()[\]{}"'`]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
}

/**
 * Register the post-tool memory hit tracker.
 *
 * Priority 210: runs after tool output truncation.
 *
 * Compares generated tool output against injected memories to detect
 * which memories actually influenced the response. Increments hitCount
 * for matching memories via batch operation.
 */
export function registerHitTracker(): void {
  HookChain.register("memory-hit-tracker", "post-tool", 210, async (ctx) => {
    const config = await Config.get()
    if (config.memory?.enabled === false) return
    if (!TRACKABLE.has(ctx.toolName)) return

    const cached = MemoryInject.getCachedRecall(ctx.sessionID)
    if (!cached || cached.relevant.length === 0) return

    const output = ctx.result.output.toLowerCase()

    // Only load relevant memories, not all
    const allMemories = await Memory.list()
    const relevant = allMemories.filter((m) => cached.relevant.includes(m.id))

    const hits: string[] = []
    for (const memory of relevant) {
      const kws = keywords(memory.content)
      const matched = kws.filter((kw) => output.includes(kw)).length
      const ratio = kws.length > 0 ? matched / kws.length : 0

      if (ratio >= 0.3) {
        hits.push(memory.id)
        log.info("memory hit detected", {
          memoryID: memory.id,
          toolName: ctx.toolName,
          matchRatio: Math.round(ratio * 100) + "%",
        })
      }
    }

    // Batch increment all hits in one lock+persist cycle
    if (hits.length > 0) {
      await Memory.batchIncrementHitCount(hits)
    }
  })
}
