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
 * IMPORTANT: Priority 130 ensures memory is appended LAST in system prompt.
 * This is critical for Anthropic prompt caching — cache is prefix-based,
 * so dynamic content (memory) must be at the end to avoid invalidating
 * the cache for stable prefix content (provider prompt, env, AGENTS.md).
 *
 * Phase 1 (early conversation): inject entire candidate pool
 * Phase 2 (after RECALL_THRESHOLD): use recall agent for precision filtering
 */
export function registerMemoryInjector(): void {
  HookChain.register(
    "memory-injector",
    "pre-llm",
    130,
    async (ctx) => {
      // Prevent recursion: memory-extractor/recall agents should not inject memories
      if (ctx.agent === "memory-extractor" || ctx.agent === "memory-recall") return

      const config = await Config.get()
      if (config.memory?.enabled === false) return

      const count = MemoryInject.countUserMessages(ctx.messages)
      const saved = MemoryInject.useResolved(ctx.sessionID, count)
      if (saved) {
        if (saved.memory) {
          ctx.system.push(saved.memory)
        }
        if (saved.ids.length > 0) {
          await Memory.batchIncrementUseCount(saved.ids)
        }
        if (saved.conflict) {
          ctx.system.push(saved.conflict)
        }
        if (saved.conflicts.length > 0) {
          await Bus.publish(MemoryEvent.ConflictDetected, {
            sessionID: ctx.sessionID,
            conflicts: saved.conflicts,
          })
        }
        log.info("reused resolved memory", {
          sessionID: ctx.sessionID,
          ids: saved.ids.length,
          conflicts: saved.conflicts.length,
        })
        return
      }

      const allMemories = await Memory.list()
      if (allMemories.length === 0) {
        MemoryInject.saveEmpty(ctx.sessionID, count)
        return
      }

      const limit = config.memory?.injectPoolLimit
      const pool = MemoryInject.buildCandidatePool(allMemories, limit)
      if (pool.length === 0) {
        MemoryInject.saveEmpty(ctx.sessionID, count)
        return
      }

      const phase = MemoryInject.getPhase(count)

      if (phase === "full") {
        // Phase 1: inject entire candidate pool + batch track usage
        const memory = MemoryInject.formatMemoriesForPrompt(pool)
        ctx.system.push(memory)
        await Memory.batchIncrementUseCount(pool.map((m) => m.id))
        MemoryInject.saveResolved(ctx.sessionID, {
          memory,
          ids: pool.map((m) => m.id),
          count,
        })
        log.info("phase 1 injection", { sessionID: ctx.sessionID, poolSize: pool.length })
        return
      }

      // Phase 2: use recall agent for filtering
      if (MemoryInject.shouldReRecall(ctx.sessionID, count)) {
        try {
          const recent = (ctx.messages ?? []).slice(-6).flatMap((msg) => {
            if (typeof msg !== "object" || msg === null || !("role" in msg) || typeof msg.role !== "string") return []
            if (!("content" in msg)) return []
            return [
              {
                role: msg.role,
                content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
              },
            ]
          })
          const result = await MemoryRecall.invoke({ sessionID: ctx.sessionID, memories: pool, recentMessages: recent })
          MemoryInject.cacheRecallResult(ctx.sessionID, result, count)
          log.info("recall agent completed", {
            sessionID: ctx.sessionID,
            relevant: result.relevant.length,
            conflicts: result.conflicts.length,
          })
        } catch (err) {
          log.error("recall agent failed, falling back to full injection", { error: err })
          const memory = MemoryInject.formatMemoriesForPrompt(pool)
          ctx.system.push(memory)
          MemoryInject.saveResolved(ctx.sessionID, {
            memory,
            ids: pool.map((m) => m.id),
            count,
          })
          return
        }
      }

      const cached = MemoryInject.getCachedRecall(ctx.sessionID)
      if (!cached) {
        // Cache miss — fallback to full injection
        const memory = MemoryInject.formatMemoriesForPrompt(pool)
        ctx.system.push(memory)
        MemoryInject.saveResolved(ctx.sessionID, {
          memory,
          ids: pool.map((m) => m.id),
          count,
        })
        return
      }

      // Inject filtered memories
      const relevant = allMemories.filter((m) => cached.relevant.includes(m.id))
      const memory = relevant.length > 0 ? MemoryInject.formatMemoriesForPrompt(relevant) : ""
      if (relevant.length > 0) {
        ctx.system.push(memory)
        await Memory.batchIncrementUseCount(relevant.map((m) => m.id))
      }

      // Handle conflicts
      const conflict = cached.conflicts.length > 0 ? MemoryInject.formatConflictWarning(cached.conflicts) : ""
      if (cached.conflicts.length > 0) {
        ctx.system.push(conflict)
        await Bus.publish(MemoryEvent.ConflictDetected, {
          sessionID: ctx.sessionID,
          conflicts: cached.conflicts,
        })
      }

      if (memory || conflict) {
        MemoryInject.saveResolved(ctx.sessionID, {
          memory,
          conflict,
          ids: relevant.map((m) => m.id),
          conflicts: cached.conflicts,
          count,
        })
      } else {
        MemoryInject.saveEmpty(ctx.sessionID, count)
      }

      await Bus.publish(MemoryEvent.RecallComplete, {
        sessionID: ctx.sessionID,
        injectedCount: relevant.length,
        recalledCount: cached.relevant.length,
      })
    },
    { injector: true },
  )

  // Clean up session-scoped caches when session ends
  HookChain.register("memory-inject-cleanup", "session-lifecycle", 250, async (ctx) => {
    if (ctx.event !== "session.deleted") return
    MemoryInject.clearCache(ctx.sessionID)
    Memory.cleanupSession(ctx.sessionID)
  })
}
