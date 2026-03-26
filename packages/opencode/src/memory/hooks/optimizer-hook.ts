import { HookChain } from "@/session/hooks"
import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { Memory } from "../memory"
import { MemoryDecay } from "../optimizer/decay"
import { MemoryConfirmation } from "../engine/confirmation"
import { MemoryEvent } from "../event"

const log = Log.create({ service: "memory.hooks.optimizer" })

/**
 * Register optimizer hook on session-lifecycle.
 *
 * Priority 220: runs after extraction hooks.
 *
 * Triggers periodic maintenance (max once per day):
 *   - Decay score updates
 *   - Inject pool capacity monitoring
 *   - Pending → confirmed checks
 *   - Team candidate detection
 */
export function registerOptimizerHook(): void {
  HookChain.register("memory-optimizer", "session-lifecycle", 220, async (ctx) => {
    if (ctx.event !== "session.created") return

    const config = await Config.get()
    if (config.memory?.enabled === false) return
    if (config.memory?.autoOptimize === false) return

    // Rate limit: max once per day
    const lastMaintain = await Memory.getMeta("lastMaintainAt")
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
    if (lastMaintain && lastMaintain > oneDayAgo) return

    // Mark BEFORE running to prevent concurrent maintenance (optimistic lock).
    // If maintenance fails, it will retry next day.
    await Memory.setMeta("lastMaintainAt", Date.now())

    log.info("running periodic maintenance", { sessionID: ctx.sessionID })

    // 1. Decay + capacity check
    try {
      const result = await MemoryDecay.maintain()

      // 2. Publish capacity events (>= 80% or >= 100%)
      if (result.usage >= 0.8) {
        await Bus.publish(MemoryEvent.CapacityWarning, {
          poolSize: result.poolSize,
          poolLimit: result.poolLimit,
          usage: result.usage,
        })
      }

      log.info("maintenance complete", {
        totalMemories: result.totalMemories,
        poolSize: result.poolSize,
        usage: Math.round(result.usage * 100) + "%",
      })
    } catch (err) {
      log.error("decay maintenance failed", { error: err })
    }

    // 3. Check pending confirmations (independent of decay)
    try {
      await MemoryConfirmation.checkPendingMemories()
    } catch (err) {
      log.error("confirmation check failed", { error: err })
    }

    // 4. Detect team candidates (independent)
    try {
      await detectTeamCandidates(config)
    } catch (err) {
      log.error("team candidate detection failed", { error: err })
    }
  })
}

/**
 * Detect memories that qualify as team promotion candidates.
 */
async function detectTeamCandidates(config: Config.Info): Promise<void> {
  const threshold = config.memory?.promotionThreshold
  const minScore = threshold?.minScore ?? 5.0
  const minUseCount = threshold?.minUseCount ?? 5
  const minAgeInDays = threshold?.minAgeInDays ?? 14

  const personal = await Memory.list({ scope: "personal", status: "confirmed" })
  const now = Date.now()
  const candidates: Memory.Info[] = []

  for (const memory of personal) {
    if (memory.teamCandidateAt) continue // Already detected
    if (memory.teamSubmittedAt) continue // Already submitted
    if (memory.category === "correction") continue // Corrections don't promote

    const ageInDays = (now - memory.createdAt) / (1000 * 60 * 60 * 24)
    if (memory.score >= minScore && memory.useCount >= minUseCount && ageInDays >= minAgeInDays) {
      await Memory.update(memory.id, { teamCandidateAt: now })
      candidates.push(memory)
    }
  }

  if (candidates.length > 0) {
    log.info("team candidates detected", { count: candidates.length })
    await Bus.publish(MemoryEvent.TeamCandidatesFound, { candidates })
  }
}
