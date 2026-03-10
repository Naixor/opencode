import { Scheduler } from "../scheduler"
import { Config } from "../config/config"
import { LlmLog } from "./query"
import { Log } from "../util/log"

export namespace LlmLogScheduler {
  const log = Log.create({ service: "llm-log-scheduler" })

  export async function init() {
    const config = await Config.get()
    if (config.llmLog?.enabled === false) return

    const intervalHours = config.llmLog?.cleanup_interval_hours ?? 24
    const intervalMs = intervalHours * 60 * 60 * 1000

    Scheduler.register({
      id: "llm-log.cleanup",
      interval: intervalMs,
      scope: "instance",
      run: async () => {
        const config = await Config.get()
        if (config.llmLog?.enabled === false) return

        try {
          const result = LlmLog.cleanup({
            max_age_days: config.llmLog?.max_age_days,
            max_records: config.llmLog?.max_records,
          })
          if (result.total_deleted > 0) {
            log.info("cleanup completed", {
              deleted_by_age: result.deleted_by_age,
              deleted_by_count: result.deleted_by_count,
              total_deleted: result.total_deleted,
              protected_count: result.protected_count,
            })
          }
        } catch (err) {
          log.error("cleanup failed", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    })

    log.info("auto cleanup scheduled", { intervalHours })
  }
}
