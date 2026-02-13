import z from "zod"
import { Log } from "../../util/log"
import { Instance } from "../../project/instance"
import { Bus } from "../../bus"
import { BusEvent } from "../../bus/bus-event"
import { randomUUIDv7 } from "bun"

export namespace BackgroundManager {
  const log = Log.create({ service: "background-manager" })

  // --- Schemas & Types ---

  export const TaskStatus = z.enum(["pending", "running", "completed", "failed", "cancelled"])
  export type TaskStatus = z.infer<typeof TaskStatus>

  export const TaskInfo = z.object({
    id: z.string(),
    description: z.string().optional(),
    status: TaskStatus,
    provider: z.string().optional(),
    model: z.string().optional(),
    category: z.string().optional(),
    sessionID: z.string().optional(),
    createdAt: z.number(),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
    result: z.any().optional(),
    error: z.string().optional(),
  })
  export type TaskInfo = z.infer<typeof TaskInfo>

  export const ConcurrencyConfig = z.object({
    defaultConcurrency: z.number().int().positive().default(3),
    providerConcurrency: z.record(z.string(), z.number().int().positive()).default({}),
    modelConcurrency: z.record(z.string(), z.number().int().positive()).default({}),
    staleTimeoutMs: z.number().int().positive().default(180000),
    persist_on_exit: z.boolean().default(false),
  })
  export type ConcurrencyConfig = z.infer<typeof ConcurrencyConfig>

  // --- Events ---

  export const Event = {
    Created: BusEvent.define(
      "background.task.created",
      z.object({ task: TaskInfo }),
    ),
    Started: BusEvent.define(
      "background.task.started",
      z.object({ task: TaskInfo }),
    ),
    Completed: BusEvent.define(
      "background.task.completed",
      z.object({ task: TaskInfo }),
    ),
    Failed: BusEvent.define(
      "background.task.failed",
      z.object({ task: TaskInfo }),
    ),
    Cancelled: BusEvent.define(
      "background.task.cancelled",
      z.object({ task: TaskInfo }),
    ),
  }

  // --- Callbacks ---

  export type Callbacks = {
    onSubagentSessionCreated?: (sessionID: string) => void
    onShutdown?: () => void
    onExecute?: (task: TaskInfo) => Promise<unknown>
  }

  // --- State ---

  type ManagerState = {
    tasks: Map<string, TaskInfo>
    queue: string[]
    config: ConcurrencyConfig
    callbacks: Callbacks
    securityConfig: Readonly<Record<string, unknown>> | undefined
    staleCheckInterval: ReturnType<typeof setInterval> | undefined
  }

  const state = Instance.state(
    (): ManagerState => ({
      tasks: new Map(),
      queue: [],
      config: ConcurrencyConfig.parse({}),
      callbacks: {},
      securityConfig: undefined,
      staleCheckInterval: undefined,
    }),
    async (entry) => {
      if (entry.staleCheckInterval) {
        clearInterval(entry.staleCheckInterval)
      }
      if (entry.config.persist_on_exit) {
        entry.callbacks.onShutdown?.()
        return
      }
      // Cancel all running tasks on exit
      for (const [id, task] of entry.tasks) {
        if (task.status === "running" || task.status === "pending") {
          entry.tasks.set(id, { ...task, status: "cancelled", completedAt: Date.now() })
        }
      }
      entry.callbacks.onShutdown?.()
    },
  )

  // --- Configuration ---

  export function configure(config: Partial<ConcurrencyConfig>): void {
    const s = state()
    s.config = ConcurrencyConfig.parse({ ...s.config, ...config })
    log.info("configured", {
      defaultConcurrency: s.config.defaultConcurrency,
      staleTimeoutMs: s.config.staleTimeoutMs,
      persist_on_exit: s.config.persist_on_exit,
    })
  }

  export function setCallbacks(callbacks: Callbacks): void {
    state().callbacks = callbacks
  }

  export function setSecurityConfig(securityConfig: Record<string, unknown>): void {
    state().securityConfig = Object.freeze(securityConfig)
  }

  // --- Task Creation ---

  export function create(input: {
    description?: string
    provider?: string
    model?: string
    category?: string
  }): TaskInfo {
    const s = state()
    const id = `bg_${randomUUIDv7()}`
    const task: TaskInfo = {
      id,
      description: input.description,
      status: "pending",
      provider: input.provider,
      model: input.model,
      category: input.category,
      createdAt: Date.now(),
    }

    s.tasks.set(id, task)
    s.queue.push(id)

    Bus.publish(Event.Created, { task }).catch(() => {})
    log.info("task created", { id, description: input.description })

    // Try to dequeue immediately
    dequeue()

    return task
  }

  // --- Task Execution / Dequeue ---

  function dequeue(): void {
    const s = state()

    while (s.queue.length > 0) {
      const running = runningTasks()
      if (running.length >= s.config.defaultConcurrency) return

      const nextId = findNextEligible(s)
      if (!nextId) return

      const idx = s.queue.indexOf(nextId)
      if (idx !== -1) s.queue.splice(idx, 1)

      const task = s.tasks.get(nextId)
      if (!task) continue

      startTask(task)
    }
  }

  function findNextEligible(s: ManagerState): string | undefined {
    for (const id of s.queue) {
      const task = s.tasks.get(id)
      if (!task) continue

      // Check provider concurrency
      if (task.provider && s.config.providerConcurrency[task.provider]) {
        const providerRunning = runningTasks().filter((t) => t.provider === task.provider).length
        if (providerRunning >= s.config.providerConcurrency[task.provider]) continue
      }

      // Check model concurrency
      if (task.model && s.config.modelConcurrency[task.model]) {
        const modelRunning = runningTasks().filter((t) => t.model === task.model).length
        if (modelRunning >= s.config.modelConcurrency[task.model]) continue
      }

      return id
    }
    return undefined
  }

  function startTask(task: TaskInfo): void {
    const s = state()
    const updated: TaskInfo = { ...task, status: "running", startedAt: Date.now() }
    s.tasks.set(task.id, updated)

    Bus.publish(Event.Started, { task: updated }).catch(() => {})
    log.info("task started", { id: task.id })

    if (updated.sessionID) {
      s.callbacks.onSubagentSessionCreated?.(updated.sessionID)
    }

    // Execute the task via callback
    const executor = s.callbacks.onExecute
    if (executor) {
      executor(updated)
        .then((result) => {
          complete(task.id, result)
        })
        .catch((err: unknown) => {
          fail(task.id, err instanceof Error ? err.message : String(err))
        })
    }
  }

  // --- Task Status Transitions ---

  export function complete(id: string, result?: unknown): void {
    const s = state()
    const task = s.tasks.get(id)
    if (!task) return
    if (task.status !== "running") return

    const updated: TaskInfo = {
      ...task,
      status: "completed",
      completedAt: Date.now(),
      result,
    }
    s.tasks.set(id, updated)

    Bus.publish(Event.Completed, { task: updated }).catch(() => {})
    log.info("task completed", { id })

    dequeue()
  }

  export function fail(id: string, error: string): void {
    const s = state()
    const task = s.tasks.get(id)
    if (!task) return
    if (task.status !== "running") return

    const updated: TaskInfo = {
      ...task,
      status: "failed",
      completedAt: Date.now(),
      error,
    }
    s.tasks.set(id, updated)

    Bus.publish(Event.Failed, { task: updated }).catch(() => {})
    log.info("task failed", { id, error })

    dequeue()
  }

  export function cancel(id: string): void {
    const s = state()
    const task = s.tasks.get(id)
    if (!task) return
    if (task.status !== "running" && task.status !== "pending") return

    // Remove from queue if pending
    const queueIdx = s.queue.indexOf(id)
    if (queueIdx !== -1) s.queue.splice(queueIdx, 1)

    const updated: TaskInfo = {
      ...task,
      status: "cancelled",
      completedAt: Date.now(),
    }
    s.tasks.set(id, updated)

    Bus.publish(Event.Cancelled, { task: updated }).catch(() => {})
    log.info("task cancelled", { id })

    dequeue()
  }

  // --- Queries ---

  export function get(id: string): TaskInfo | undefined {
    return state().tasks.get(id)
  }

  export function list(): ReadonlyArray<TaskInfo> {
    return [...state().tasks.values()]
  }

  export function runningTasks(): ReadonlyArray<TaskInfo> {
    return [...state().tasks.values()].filter((t) => t.status === "running")
  }

  export function pendingTasks(): ReadonlyArray<TaskInfo> {
    return [...state().tasks.values()].filter((t) => t.status === "pending")
  }

  export function getSecurityConfig(): Readonly<Record<string, unknown>> | undefined {
    return state().securityConfig
  }

  export function getConfig(): ConcurrencyConfig {
    return state().config
  }

  // --- Stale Task Detection ---

  export function startStaleDetection(): void {
    const s = state()
    if (s.staleCheckInterval) return

    s.staleCheckInterval = setInterval(() => {
      cleanupStaleTasks()
    }, Math.min(s.config.staleTimeoutMs, 60000))
  }

  export function cleanupStaleTasks(): number {
    const s = state()
    const now = Date.now()
    const staleTimeout = s.config.staleTimeoutMs
    const cleaned: string[] = []

    for (const [id, task] of s.tasks) {
      if (task.status !== "running") continue
      if (!task.startedAt) continue
      if (now - task.startedAt < staleTimeout) continue

      const updated: TaskInfo = {
        ...task,
        status: "failed",
        completedAt: now,
        error: `Task stale: exceeded ${staleTimeout}ms timeout`,
      }
      s.tasks.set(id, updated)
      cleaned.push(id)

      Bus.publish(Event.Failed, { task: updated }).catch(() => {})
      log.info("stale task cleaned up", { id, elapsed: now - task.startedAt })
    }

    if (cleaned.length > 0) {
      dequeue()
    }

    return cleaned.length
  }

  // --- Reset (for testing) ---

  export function reset(): void {
    const s = state()
    if (s.staleCheckInterval) {
      clearInterval(s.staleCheckInterval)
      s.staleCheckInterval = undefined
    }
    s.tasks.clear()
    s.queue = []
    s.config = ConcurrencyConfig.parse({})
    s.callbacks = {}
    s.securityConfig = undefined
  }
}
