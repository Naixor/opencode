import path from "path"
import fs from "fs/promises"
import { Log } from "../../util/log"
import { HookChain } from "./index"
import { Flag } from "../../flag/flag"
import { Global } from "../../global"
import { Instance } from "../../project/instance"
import { ScopeLock } from "../../board/scope-lock"
import { BoardTask } from "../../board/task"
import { BoardSignal } from "../../board/signal"
import { Discussion } from "../../board/discussion"

const STRATEGY_FILE = "conductor-strategy.md"
const SWARM_DIR = "swarm"

export namespace SwarmHooks {
  const log = Log.create({ service: "hooks.swarm" })

  // Cache per session to avoid repeated file reads
  const cache = new Map<string, string | null>()
  const discussionCache = new Map<string, string | null>()

  function templatePath(): string {
    return path.join(import.meta.dir, "../../board/strategy-template.md")
  }

  // Search order: project .opencode/swarm/ → global ~/.config/opencode/swarm/
  function strategyCandidates(): string[] {
    return [
      path.join(Instance.worktree, ".opencode", SWARM_DIR, STRATEGY_FILE),
      path.join(Global.Path.config, SWARM_DIR, STRATEGY_FILE),
    ]
  }

  async function readStrategy(): Promise<string | null> {
    for (const fp of strategyCandidates()) {
      const content = await fs.readFile(fp, "utf-8").catch(() => null)
      if (content) return content
    }
    return null
  }

  // Scaffold strategy file into global config dir on first use
  async function scaffold(): Promise<string | null> {
    const template = await Bun.file(templatePath())
      .text()
      .catch(() => "")
    if (!template) return null
    const dir = path.join(Global.Path.config, SWARM_DIR)
    const fp = path.join(dir, STRATEGY_FILE)
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(fp, template)
    log.info("scaffolded conductor strategy", { path: fp })
    log.info(
      [
        "🐝 Swarm mode enabled — conductor strategy scaffolded",
        "",
        "  Customizable files:",
        `    Global:  ${fp}`,
        `    Project: ${path.join(Instance.worktree, ".opencode", SWARM_DIR, STRATEGY_FILE)}`,
        "",
        "  Quick start:",
        "    /swarm launch <goal>     — start a multi-agent swarm",
        "    /swarm status             — list swarms in this workspace",
        "    /swarm stop <id>          — stop a swarm",
        "    /swarm msg <id> <note>    — message the conductor",
        "    /swarm discuss <topic>    — start a multi-role discussion",
        "    /swarm help               — show subcommands",
        "",
        "  Edit the strategy file to customize how the Conductor plans, assigns, and monitors tasks.",
      ].join("\n"),
    )
    return template
  }

  // --- conductor-strategy-injector (PreLLMChain, priority 150) ---
  // Loads conductor-strategy.md from config dirs (project → global), scaffolds on first use

  function registerStrategyInjector(): void {
    HookChain.register(
      "conductor-strategy-injector",
      "pre-llm",
      150,
      async (ctx) => {
        if (ctx.agent !== "conductor") return

        const cached = cache.get(ctx.sessionID)
        if (cached !== undefined) {
          if (cached) ctx.system.push(cached)
          return
        }

        let content = await readStrategy()
        if (!content) content = await scaffold()
        if (!content) {
          cache.set(ctx.sessionID, null)
          return
        }
        const injection = `\n## Strategy\n\n${content}`
        cache.set(ctx.sessionID, injection)
        ctx.system.push(injection)
        log.info("injected conductor strategy", { sessionID: ctx.sessionID })

        // Check for discussion tasks and inject discussion protocol
        const dcached = discussionCache.get(ctx.sessionID)
        if (dcached !== undefined) {
          if (dcached) ctx.system.push(dcached)
          return
        }
        const swarm = ctx.metadata?.swarm_id as string | undefined
        if (!swarm) {
          discussionCache.set(ctx.sessionID, null)
          return
        }
        const tasks = await BoardTask.list(swarm)
        const hasDiscuss = tasks.some((t) => t.type === "discuss")
        if (!hasDiscuss) {
          discussionCache.set(ctx.sessionID, null)
          return
        }
        const dp = path.join(import.meta.dir, "../../agent/prompt/conductor-discussion.txt")
        const dcontent = await Bun.file(dp)
          .text()
          .catch(() => "")
        if (!dcontent) {
          discussionCache.set(ctx.sessionID, null)
          return
        }
        discussionCache.set(ctx.sessionID, dcontent)
        ctx.system.push(dcontent)
        log.info("injected discussion protocol", { sessionID: ctx.sessionID })
      },
      { injector: true },
    )
  }

  // --- scope-lock-checker (PreToolChain, priority 50) ---
  // Checks file scope locks before edit/write tools in swarm context

  function registerScopeLockChecker(): void {
    HookChain.register("scope-lock-checker", "pre-tool", 50, async (ctx) => {
      if (!Flag.OPENCODE_SWARM) return
      if (ctx.toolName !== "edit" && ctx.toolName !== "write") return

      const swarm = ctx.metadata?.swarm_id as string | undefined
      const agent = ctx.agent
      if (!swarm) return

      const fp = (ctx.args.filePath ?? ctx.args.file_path) as string | undefined
      if (!fp) return

      const locked = ScopeLock.check(swarm, fp, agent)
      if (locked) {
        throw new Error(
          `File ${fp} is locked by agent "${locked.agent}" for task ${locked.taskID}. Wait for that task to complete or ask the Conductor to resolve the conflict.`,
        )
      }
    })
  }

  // --- checkpoint-publisher (PostToolChain, priority 200) ---
  // Auto-publishes checkpoint artifacts after successful bash typecheck or delegate_task in swarm context

  function registerCheckpointPublisher(): void {
    HookChain.register("checkpoint-publisher", "post-tool", 200, async (ctx) => {
      if (!Flag.OPENCODE_SWARM) return
      const swarm = ctx.metadata?.swarm_id as string | undefined
      const task = ctx.metadata?.task_id as string | undefined
      if (!swarm || !task) return

      const cmd = (ctx.args.command ?? "") as string
      const isBash = ctx.toolName === "bash" && /\b(tsc|tsgo|typecheck)\b/.test(cmd)
      const isDelegate = ctx.toolName === "delegate_task"
      if (!isBash && !isDelegate) return

      // Only checkpoint on success
      const output = ctx.result.output ?? ""
      if (isBash && /error TS\d+/.test(output)) return

      const { BoardArtifact } = await import("../../board/artifact")
      await BoardArtifact.post({
        type: "checkpoint",
        task_id: task,
        swarm_id: swarm,
        author: ctx.agent,
        content: `Checkpoint after ${ctx.toolName}: ${ctx.result.title ?? "completed"}\n\n${output.slice(0, 500)}`,
      }).catch((e) => log.warn("checkpoint publish failed", { error: e }))
    })
  }

  // --- discussion-thread-injector (PreLLMChain, priority 160) ---
  // Injects the full discussion thread into Worker context so they see all opinions

  function registerThreadInjector(): void {
    HookChain.register(
      "discussion-thread-injector",
      "pre-llm",
      160,
      async (ctx) => {
        if (!Flag.OPENCODE_SWARM) return
        const swarm = ctx.metadata?.swarm_id as string | undefined
        const channel = ctx.metadata?.discussion_channel as string | undefined
        if (!swarm || !channel) return

        const signals = await BoardSignal.thread(swarm, channel)
        if (signals.length === 0) return

        const round = await Discussion.status(swarm, channel)
        const header = round ? `Current round: ${round.round}` : ""

        const grouped = new Map<number, BoardSignal.Info[]>()
        for (const s of signals) {
          const r = (s.payload.round as number) ?? 1
          if (!grouped.has(r)) grouped.set(r, [])
          grouped.get(r)!.push(s)
        }

        const lines: string[] = ["## Discussion Thread (read before responding)", ""]
        if (header) lines.push(header, "")
        for (const [r, sigs] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
          lines.push(`### Round ${r}`)
          for (const s of sigs) {
            const summary = (s.payload.summary as string) ?? JSON.stringify(s.payload).slice(0, 200)
            lines.push(`  [${s.from}] ${s.type}: ${summary}`)
          }
          lines.push("")
        }

        ctx.system.push(lines.join("\n"))
      },
      { injector: true },
    )
  }

  // --- swarm-onboarding (eager, runs once at registration) ---
  // Pre-scaffolds strategy file when OPENCODE_SWARM is enabled so users
  // discover the customizable config before their first /swarm launch.

  async function onboard(): Promise<void> {
    if (!Flag.OPENCODE_SWARM) return
    const existing = await readStrategy()
    if (existing) return
    await scaffold()
  }

  export function register(): void {
    registerStrategyInjector()
    registerScopeLockChecker()
    registerCheckpointPublisher()
    registerThreadInjector()
    onboard().catch((e) => log.warn("swarm onboarding failed", { error: e }))
  }
}
