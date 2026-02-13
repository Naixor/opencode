import z from "zod"
import { Log } from "../../util/log"
import { Instance } from "../../project/instance"
import { Plugin } from "../../plugin"

export namespace HookChain {
  const log = Log.create({ service: "hooks" })

  // --- Schemas & Types ---

  export const ChainType = z.enum(["pre-llm", "pre-tool", "post-tool", "session-lifecycle"])
  export type ChainType = z.infer<typeof ChainType>

  export const PreLLMContext = z.object({
    sessionID: z.string(),
    system: z.array(z.string()),
    agent: z.string(),
    model: z.string(),
    variant: z.string().optional(),
    messages: z.array(z.any()),
  })
  export type PreLLMContext = z.infer<typeof PreLLMContext>

  export const PreToolContext = z.object({
    sessionID: z.string(),
    toolName: z.string(),
    args: z.record(z.string(), z.any()),
    agent: z.string(),
  })
  export type PreToolContext = z.infer<typeof PreToolContext>

  export const PostToolContext = z.object({
    sessionID: z.string(),
    toolName: z.string(),
    args: z.record(z.string(), z.any()),
    result: z.object({
      output: z.string(),
      title: z.string().optional(),
      metadata: z.any().optional(),
    }),
    agent: z.string(),
  })
  export type PostToolContext = z.infer<typeof PostToolContext>

  export const SessionLifecycleEvent = z.enum([
    "session.created",
    "session.updated",
    "session.compacting",
    "session.error",
    "session.deleted",
    "agent.stopped",
    "agent.error",
  ])
  export type SessionLifecycleEvent = z.infer<typeof SessionLifecycleEvent>

  export const SessionLifecycleContext = z.object({
    sessionID: z.string(),
    event: SessionLifecycleEvent,
    data: z.any().optional(),
    agent: z.string().optional(),
  })
  export type SessionLifecycleContext = z.infer<typeof SessionLifecycleContext>

  export type ContextMap = {
    "pre-llm": PreLLMContext
    "pre-tool": PreToolContext
    "post-tool": PostToolContext
    "session-lifecycle": SessionLifecycleContext
  }

  // --- Hook Definition ---

  export type Handler<T extends ChainType> = (ctx: ContextMap[T]) => Promise<void>

  export type HookDefinition<T extends ChainType = ChainType> = {
    name: string
    chainType: T
    priority: number
    enabled: boolean
    handler: Handler<T>
  }

  // --- Compiled Chain ---

  type CompiledChain<T extends ChainType> = {
    chainType: T
    hooks: ReadonlyArray<HookDefinition<T>>
  }

  // --- State (synchronous, per-instance) ---

  type ChainState = {
    registered: Map<ChainType, HookDefinition[]>
    compiled: Map<ChainType, CompiledChain<ChainType>> | undefined
    config: Record<string, { enabled: boolean }>
  }

  const state = Instance.state(
    (): ChainState => ({
      registered: new Map(),
      compiled: undefined,
      config: {},
    }),
  )

  // --- Init (called once at session start to load config) ---

  export async function init(hooksConfig?: Record<string, { enabled: boolean }>): Promise<void> {
    const s = state()
    s.config = hooksConfig ?? {}

    // Update enabled state for already registered hooks
    for (const [, hooks] of s.registered) {
      for (const hook of hooks) {
        const configEntry = s.config[hook.name]
        hook.enabled = configEntry?.enabled ?? true
      }
    }

    // Force recompilation
    s.compiled = undefined
  }

  // --- Registration ---

  export function register<T extends ChainType>(
    name: string,
    chainType: T,
    priority: number,
    handler: Handler<T>,
  ): void {
    const s = state()
    const hooks = s.registered.get(chainType) ?? []
    const configEntry = s.config[name]
    const enabled = configEntry?.enabled ?? true

    hooks.push({
      name,
      chainType,
      priority,
      enabled,
      handler: handler as Handler<ChainType>,
    })

    s.registered.set(chainType, hooks)
    s.compiled = undefined
    log.info("registered hook", { name, chainType, priority, enabled })
  }

  // --- Compilation ---

  export function compile(): void {
    const s = state()
    if (s.compiled) return

    const compiled = new Map<ChainType, CompiledChain<ChainType>>()

    for (const chainType of ChainType.options) {
      const hooks = (s.registered.get(chainType) ?? [])
        .filter((h: HookDefinition) => h.enabled)
        .sort((a: HookDefinition, b: HookDefinition) => a.priority - b.priority)

      compiled.set(chainType, {
        chainType,
        hooks: Object.freeze([...hooks]),
      })
    }

    s.compiled = compiled
    log.info("compiled chains", {
      counts: Object.fromEntries(
        ChainType.options.map((t) => [t, compiled.get(t)?.hooks.length ?? 0]),
      ),
    })
  }

  function getCompiledChain<T extends ChainType>(chainType: T): CompiledChain<T> {
    const s = state()
    if (!s.compiled) {
      compile()
    }
    return s.compiled!.get(chainType) as unknown as CompiledChain<T>
  }

  // --- Execution ---

  export async function execute<T extends ChainType>(
    chainType: T,
    ctx: ContextMap[T],
  ): Promise<void> {
    const chain = getCompiledChain(chainType)

    for (const hook of chain.hooks) {
      await (hook.handler as Handler<T>)(ctx).catch((err: unknown) => {
        log.error("hook execution error", {
          hook: hook.name,
          chainType,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }

  // --- Combined execution with Plugin.trigger() ---
  // External plugins run first, then internal middleware chain

  export async function executePreLLM(
    pluginHookName: "experimental.chat.system.transform",
    pluginInput: Record<string, unknown>,
    pluginOutput: { system: string[] },
    ctx: PreLLMContext,
  ): Promise<void> {
    await Plugin.trigger(pluginHookName, pluginInput, pluginOutput)
    ctx.system = pluginOutput.system
    await execute("pre-llm", ctx)
    pluginOutput.system = ctx.system
  }

  export async function executePreTool(
    pluginInput: Record<string, unknown>,
    pluginOutput: { args: Record<string, unknown> },
    ctx: PreToolContext,
  ): Promise<void> {
    await Plugin.trigger("tool.execute.before", pluginInput, pluginOutput)
    ctx.args = pluginOutput.args as Record<string, unknown>
    await execute("pre-tool", ctx)
    pluginOutput.args = ctx.args
  }

  export async function executePostTool(
    pluginInput: Record<string, unknown>,
    pluginOutput: { title: string; output: string; metadata: unknown },
    ctx: PostToolContext,
  ): Promise<void> {
    await Plugin.trigger("tool.execute.after", pluginInput, pluginOutput)
    ctx.result = {
      output: pluginOutput.output,
      title: pluginOutput.title,
      metadata: pluginOutput.metadata,
    }
    await execute("post-tool", ctx)
    pluginOutput.output = ctx.result.output
    pluginOutput.title = ctx.result.title ?? pluginOutput.title
    pluginOutput.metadata = ctx.result.metadata
  }

  // --- Config reload ---

  export function reloadConfig(hooksConfig: Record<string, { enabled: boolean }>): void {
    const s = state()
    s.config = hooksConfig

    for (const [, hooks] of s.registered) {
      for (const hook of hooks) {
        const configEntry = hooksConfig[hook.name]
        hook.enabled = configEntry?.enabled ?? true
      }
    }

    s.compiled = undefined
    log.info("reloaded hook config")
  }

  // --- Introspection ---

  export function listRegistered(
    chainType?: ChainType,
  ): ReadonlyArray<{ name: string; chainType: ChainType; priority: number; enabled: boolean }> {
    const s = state()
    const toInfo = (h: HookDefinition) => ({
      name: h.name,
      chainType: h.chainType,
      priority: h.priority,
      enabled: h.enabled,
    })

    if (chainType) {
      return (s.registered.get(chainType) ?? []).map(toInfo)
    }

    const result: Array<{ name: string; chainType: ChainType; priority: number; enabled: boolean }> = []
    for (const [, hooks] of s.registered) {
      for (const hook of hooks) {
        result.push(toInfo(hook))
      }
    }
    return result
  }

  // --- Reset (for testing) ---

  export function reset(): void {
    const s = state()
    s.registered.clear()
    s.compiled = undefined
    s.config = {}
  }
}
