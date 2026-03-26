import { HookChain } from "@/session/hooks"
import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { Memory } from "../memory"
import { MemoryInject } from "../engine/injector"
import { MemoryRecall } from "../engine/recall"
import { MemoryEvent } from "../event"

const log = Log.create({ service: "memory.hooks.inject" })

/**
 * Register the pre-llm memory injection hook.
 *
 * Priority 130: runs after agents (100) and rules (120) injection.
 *
 * Phase 1 (early conversation): inject entire candidate pool
 * Phase 2 (after RECALL_THRESHOLD): use recall agent for precision filtering
 */
export function registerMemoryInjector(): void {
  HookChain.register("memory-injector", "pre-llm", 130, async (ctx) => {
    // Prevent recursion: memory-extractor/recall agents should not inject memories
    if (ctx.agent === "memory-extractor" || ctx.agent === "memory-recall") return

    const config = await Config.get()
    if (config.memory?.enabled === false) return

    const allMemories = await Memory.list()
    if (allMemories.length === 0) return

    const limit = config.memory?.injectPoolLimit
    const pool = MemoryInject.buildCandidatePool(allMemories, limit)
    if (pool.length === 0) return

    const count = MemoryInject.countUserMessages(ctx.messages)
    const phase = MemoryInject.getPhase(count)

    if (phase === "full") {
      // Phase 1: inject entire candidate pool + batch track usage
      ctx.system.push(MemoryInject.formatMemoriesForPrompt(pool))
      await Memory.batchIncrementUseCount(pool.map((m) => m.id))
      log.info("phase 1 injection", { sessionID: ctx.sessionID, poolSize: pool.length })
      return
    }

    // Phase 2: use recall agent for filtering
    if (MemoryInject.shouldReRecall(ctx.sessionID, count)) {
      try {
        const recent = (ctx.messages ?? []).slice(-6).map((m: any) => ({
          role: m.role as string,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        }))
        const result = await MemoryRecall.invoke({ sessionID: ctx.sessionID, memories: pool, recentMessages: recent })
        MemoryInject.cacheRecallResult(ctx.sessionID, result, count)
        log.info("recall agent completed", {
          sessionID: ctx.sessionID,
          relevant: result.relevant.length,
          conflicts: result.conflicts.length,
        })
      } catch (err) {
        log.error("recall agent failed, falling back to full injection", { error: err })
        ctx.system.push(MemoryInject.formatMemoriesForPrompt(pool))
        return
      }
    }

    const cached = MemoryInject.getCachedRecall(ctx.sessionID)
    if (!cached) {
      // Cache miss — fallback to full injection
      ctx.system.push(MemoryInject.formatMemoriesForPrompt(pool))
      return
    }

    // Inject filtered memories
    const relevant = allMemories.filter((m) => cached.relevant.includes(m.id))
    if (relevant.length > 0) {
      ctx.system.push(MemoryInject.formatMemoriesForPrompt(relevant))
      await Memory.batchIncrementUseCount(relevant.map((m) => m.id))
    }

    // Handle conflicts
    if (cached.conflicts.length > 0) {
      ctx.system.push(MemoryInject.formatConflictWarning(cached.conflicts))
      await Bus.publish(MemoryEvent.ConflictDetected, {
        sessionID: ctx.sessionID,
        conflicts: cached.conflicts,
      })
    }

    await Bus.publish(MemoryEvent.RecallComplete, {
      sessionID: ctx.sessionID,
      injectedCount: relevant.length,
      recalledCount: cached.relevant.length,
    })
  })

  // Clean up session-scoped caches when session ends
  HookChain.register("memory-inject-cleanup", "session-lifecycle", 250, async (ctx) => {
    if (ctx.event !== "session.deleted") return
    MemoryInject.clearCache(ctx.sessionID)
    Memory.cleanupSession(ctx.sessionID)
  })
}
