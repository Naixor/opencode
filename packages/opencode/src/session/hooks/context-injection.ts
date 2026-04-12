import path from "path"
import { Log } from "../../util/log"
import { HookChain } from "./index"
import { Instance } from "../../project/instance"
import { InstructionPrompt } from "../instruction"

export namespace ContextInjectionHooks {
  const log = Log.create({ service: "hooks.context-injection" })

  // --- Per-session caches ---

  const agentsCache = new Map<string, string | null>()
  const readmeCache = new Map<string, { dir: string; content: string | null }>()
  const rulesCache = new Map<string, string[] | null>()
  const compactionContext = new Map<string, string[]>()
  const compactionTodos = new Map<string, string[]>()

  export function resetCaches(): void {
    agentsCache.clear()
    readmeCache.clear()
    rulesCache.clear()
    compactionContext.clear()
    compactionTodos.clear()
  }

  // --- directory-agents-injector (PreLLMChain, priority 100) ---
  // Scans for AGENTS.md in project root and .opencode/, injects into system prompt

  async function findAgentsMd(): Promise<Array<{ path: string; content: string }>> {
    const dir = Instance.directory
    const candidates = [path.join(dir, "AGENTS.md"), path.join(dir, ".opencode", "AGENTS.md")]
    const result: Array<{ path: string; content: string }> = []

    for (const candidate of candidates) {
      const exists = await Bun.file(candidate).exists()
      if (!exists) continue
      const content = await InstructionPrompt.load(candidate)
      if (!content) continue
      result.push({ path: candidate, content })
    }

    return result
  }

  function registerDirectoryAgentsInjector(): void {
    HookChain.register(
      "directory-agents-injector",
      "pre-llm",
      100,
      async (ctx) => {
        if ((ctx.level ?? "full") !== "full") return

        const cached = agentsCache.get(ctx.sessionID)
        if (cached !== undefined) {
          if (cached) ctx.system.push(cached)
          return
        }

        const result = await findAgentsMd()
        if (result.length === 0) {
          agentsCache.set(ctx.sessionID, null)
          return
        }

        const items = result.filter((item) => !InstructionPrompt.seen(ctx.system, item.path))
        if (items.length === 0) {
          agentsCache.set(ctx.sessionID, null)
          return
        }

        const injection = items.map((item) => InstructionPrompt.render(item.path, item.content)).join("\n\n")
        agentsCache.set(ctx.sessionID, injection)
        ctx.system.push(injection)
        log.info("injected AGENTS.md", { sessionID: ctx.sessionID, paths: items.map((item) => item.path) })
      },
      { injector: true },
    )
  }

  // --- directory-readme-injector (PreLLMChain, priority 110) ---
  // Injects README.md only for first message or when working directory changes

  async function findReadmeMd(dir: string): Promise<{ path: string; content: string } | null> {
    const candidate = path.join(dir, "README.md")
    const exists = await Bun.file(candidate).exists()
    if (!exists) return null
    const content = await InstructionPrompt.load(candidate)
    if (!content) return null
    return { path: candidate, content }
  }

  function registerDirectoryReadmeInjector(): void {
    HookChain.register(
      "directory-readme-injector",
      "pre-llm",
      110,
      async (ctx) => {
        const currentDir = Instance.directory
        const cached = readmeCache.get(ctx.sessionID)

        // Skip if same directory as last injection
        if (cached && cached.dir === currentDir) return

        const result = await findReadmeMd(currentDir)
        if (!result) {
          readmeCache.set(ctx.sessionID, { dir: currentDir, content: null })
          return
        }

        const injection = `Project README.md (${result.path}):\n${result.content}`
        readmeCache.set(ctx.sessionID, { dir: currentDir, content: injection })
        ctx.system.push(injection)
        log.info("injected README.md", { sessionID: ctx.sessionID, path: result.path })
      },
      { injector: true },
    )
  }

  // --- rules-injector (PreLLMChain, priority 120) ---
  // Injects custom rules from .opencode/rules/*.md and .claude/rules/*.md

  async function findRuleFiles(): Promise<Array<{ path: string; content: string }>> {
    const dir = Instance.directory
    const rulesDirs = [path.join(dir, ".opencode", "rules"), path.join(dir, ".claude", "rules")]

    const results: Array<{ path: string; content: string }> = []

    for (const rulesDir of rulesDirs) {
      const dirExists = await Bun.file(rulesDir)
        .exists()
        .catch(() => false)
      if (!dirExists) {
        // Check if the directory exists using glob
        const glob = new Bun.Glob("*.md")
        const files: string[] = []
        try {
          for await (const file of glob.scan({ cwd: rulesDir, absolute: true })) {
            files.push(file)
          }
        } catch {
          continue
        }

        for (const file of files) {
          const content = await InstructionPrompt.load(file)
          if (content) results.push({ path: file, content })
        }
      }
    }

    return results
  }

  function registerRulesInjector(): void {
    HookChain.register(
      "rules-injector",
      "pre-llm",
      120,
      async (ctx) => {
        const cached = rulesCache.get(ctx.sessionID)
        if (cached !== undefined) {
          if (cached) cached.forEach((r) => ctx.system.push(r))
          return
        }

        const ruleFiles = await findRuleFiles()
        if (ruleFiles.length === 0) {
          rulesCache.set(ctx.sessionID, null)
          return
        }

        const injections = ruleFiles.map((f) => {
          return `Custom rules from ${f.path}:\n${f.content}`
        })

        rulesCache.set(ctx.sessionID, injections)
        injections.forEach((r) => ctx.system.push(r))
        log.info("injected rules", {
          sessionID: ctx.sessionID,
          count: ruleFiles.length,
          paths: ruleFiles.map((f) => f.path),
        })
      },
      { injector: true },
    )
  }

  // --- compaction-context-injector (SessionLifecycleChain, priority 100) ---
  // At compaction, preserve critical context and re-inject post-compaction

  export function extractCriticalContext(messages: Array<{ role: string; content: string }>): string[] {
    const context: string[] = []

    for (const msg of messages) {
      if (!msg.content) continue
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)

      // Extract file paths being worked on
      const filePathMatches = content.match(
        /(?:working on|editing|modified|created|changed)\s+[`"]?([^\s`"]+\.\w+)[`"]?/gi,
      )
      if (filePathMatches) {
        context.push(...filePathMatches.map((m) => `File reference: ${m}`))
      }

      // Extract key decisions or architectural notes
      if (content.includes("decision:") || content.includes("DECISION:")) {
        const lines = content.split("\n").filter((l) => l.toLowerCase().includes("decision:"))
        context.push(...lines)
      }
    }

    // Deduplicate
    return [...new Set(context)]
  }

  function registerCompactionContextInjector(): void {
    HookChain.register("compaction-context-injector", "session-lifecycle", 100, async (ctx) => {
      if (ctx.event === "session.compacting") {
        const data = ctx.data as
          | {
              messages?: Array<{ role: string; content: string }>
              context?: string[]
            }
          | undefined

        const messages = data?.messages ?? []
        const critical = extractCriticalContext(messages)

        if (critical.length > 0) {
          compactionContext.set(ctx.sessionID, critical)
          // Inject into compaction context for re-injection
          ctx.data = {
            ...ctx.data,
            context: [...(data?.context ?? []), ...critical],
          }
          log.info("preserved compaction context", {
            sessionID: ctx.sessionID,
            items: critical.length,
          })
        }
        return
      }

      // On session.created after compaction, re-inject preserved context
      if (ctx.event === "session.created") {
        const preserved = compactionContext.get(ctx.sessionID)
        if (preserved && preserved.length > 0) {
          ctx.data = {
            ...ctx.data,
            preservedContext: preserved,
          }
          log.info("re-injected compaction context", {
            sessionID: ctx.sessionID,
            items: preserved.length,
          })
        }
      }
    })
  }

  // --- compaction-todo-preserver (SessionLifecycleChain, priority 110) ---
  // Extract incomplete todos from pre-compaction messages, re-inject post-compaction

  const TODO_PATTERNS = [
    /\[ \]\s+(.+)/g, // Markdown unchecked checkbox
    /TODO:\s*(.+)/gi, // TODO: comments
    /FIXME:\s*(.+)/gi, // FIXME: comments
    /(?:still need to|remaining|incomplete|pending):\s*(.+)/gi, // Natural language
  ]

  export function extractIncompleteTodos(messages: Array<{ role: string; content: string }>): string[] {
    const todos: string[] = []

    for (const msg of messages) {
      if (!msg.content) continue
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)

      for (const pattern of TODO_PATTERNS) {
        // Reset regex state
        pattern.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = pattern.exec(content)) !== null) {
          const todo = match[1]?.trim()
          if (todo && todo.length > 0 && todo.length < 500) {
            todos.push(todo)
          }
        }
      }
    }

    // Deduplicate
    return [...new Set(todos)]
  }

  function registerCompactionTodoPreserver(): void {
    HookChain.register("compaction-todo-preserver", "session-lifecycle", 110, async (ctx) => {
      if (ctx.event === "session.compacting") {
        const data = ctx.data as
          | {
              messages?: Array<{ role: string; content: string }>
              context?: string[]
            }
          | undefined

        const messages = data?.messages ?? []
        const todos = extractIncompleteTodos(messages)

        if (todos.length > 0) {
          compactionTodos.set(ctx.sessionID, todos)
          const todoSection = "Incomplete tasks from before compaction:\n" + todos.map((t) => `- [ ] ${t}`).join("\n")
          ctx.data = {
            ...ctx.data,
            context: [...(data?.context ?? []), todoSection],
          }
          log.info("preserved todos during compaction", {
            sessionID: ctx.sessionID,
            count: todos.length,
          })
        }
        return
      }

      // On session.created after compaction, re-inject preserved todos
      if (ctx.event === "session.created") {
        const preserved = compactionTodos.get(ctx.sessionID)
        if (preserved && preserved.length > 0) {
          ctx.data = {
            ...ctx.data,
            preservedTodos: preserved,
          }
          log.info("re-injected todos after compaction", {
            sessionID: ctx.sessionID,
            count: preserved.length,
          })
        }
      }
    })
  }

  // --- Exposed helpers for testing ---

  export function getAgentsCache(): Map<string, string | null> {
    return agentsCache
  }

  export function getReadmeCache(): Map<string, { dir: string; content: string | null }> {
    return readmeCache
  }

  export function getRulesCache(): Map<string, string[] | null> {
    return rulesCache
  }

  export function getCompactionContext(): Map<string, string[]> {
    return compactionContext
  }

  export function getCompactionTodos(): Map<string, string[]> {
    return compactionTodos
  }

  // --- Register all context injection hooks ---

  export function register(): void {
    registerDirectoryAgentsInjector()
    registerDirectoryReadmeInjector()
    registerRulesInjector()
    registerCompactionContextInjector()
    registerCompactionTodoPreserver()
  }
}
