import { Log } from "@/util/log"
import { Bus } from "@/bus"
import { Memory } from "../memory"
import { MemoryEvent } from "../event"

export namespace MemoryConfirmation {
  const log = Log.create({ service: "memory.confirmation" })

  const CONFIRM_MIN_DAYS = 7
  const CONFIRM_MIN_HITS = 2

  /**
   * Check all pending memories and auto-confirm those that meet the criteria:
   *   - Created more than CONFIRM_MIN_DAYS ago
   *   - hitCount >= CONFIRM_MIN_HITS
   */
  export async function checkPendingMemories(): Promise<number> {
    const pendings = await Memory.list({ scope: "personal", status: "pending" })
    const now = Date.now()
    let confirmed = 0

    for (const memory of pendings) {
      const ageInDays = (now - memory.createdAt) / (1000 * 60 * 60 * 24)
      if (ageInDays >= CONFIRM_MIN_DAYS && memory.hitCount >= CONFIRM_MIN_HITS) {
        const updated = await Memory.update(memory.id, { status: "confirmed", confirmedAt: now })
        if (updated) {
          log.info("auto-confirmed memory", { id: memory.id, ageInDays, hitCount: memory.hitCount })
          await Bus.publish(MemoryEvent.Confirmed, { info: updated })
          confirmed++
        }
      }
    }

    if (confirmed > 0) {
      log.info("auto-confirmation complete", { confirmed, total: pendings.length })
    }
    return confirmed
  }
}
