import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { HookChain } from "../../../src/session/hooks"
import { OutputManagementHooks } from "../../../src/session/hooks/output-management"
import { ContextInjectionHooks } from "../../../src/session/hooks/context-injection"
import { ErrorRecoveryHooks } from "../../../src/session/hooks/error-recovery"
import { DetectionCheckingHooks } from "../../../src/session/hooks/detection-checking"
import { AgentEnforcementHooks } from "../../../src/session/hooks/agent-enforcement"
import { SessionLifecycleHooks } from "../../../src/session/hooks/session-lifecycle"
import { LLMParameterHooks } from "../../../src/session/hooks/llm-parameters"

// --- Benchmark helpers ---

function generateText(sizeBytes: number): string {
  const chunk = "The quick brown fox jumps over the lazy dog. "
  const reps = Math.ceil(sizeBytes / chunk.length)
  return chunk.repeat(reps).slice(0, sizeBytes)
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

async function measureMs(fn: () => Promise<void>, iterations: number): Promise<{ p50: number; p99: number; mean: number; min: number; max: number }> {
  const times: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    await fn()
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  const sum = times.reduce((a, b) => a + b, 0)
  return {
    p50: percentile(times, 50),
    p99: percentile(times, 99),
    mean: sum / times.length,
    min: times[0],
    max: times[times.length - 1],
  }
}

function measureSyncMs(fn: () => void, iterations: number): { p50: number; p99: number; mean: number; min: number; max: number } {
  const times: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    fn()
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  const sum = times.reduce((a, b) => a + b, 0)
  return {
    p50: percentile(times, 50),
    p99: percentile(times, 99),
    mean: sum / times.length,
    min: times[0],
    max: times[times.length - 1],
  }
}

function logBench(label: string, stats: { p50: number; p99: number; mean: number; min: number; max: number }): void {
  console.log(`[BENCH] ${label}: p50=${stats.p50.toFixed(3)}ms p99=${stats.p99.toFixed(3)}ms mean=${stats.mean.toFixed(3)}ms min=${stats.min.toFixed(3)}ms max=${stats.max.toFixed(3)}ms`)
}

// --- Benchmark tests ---

describe("HookChain Performance Benchmarks", () => {
  async function withInstance(fn: () => Promise<void>) {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        HookChain.reset()
        await fn()
      },
    })
  }

  // --- PreLLMChain: 5 hooks p50/p99 ---

  test("bench: PreLLMChain 5 hooks p50/p99 latency", async () => {
    await withInstance(async () => {
      for (let i = 0; i < 5; i++) {
        HookChain.register(`pre-llm-bench-${i}`, "pre-llm", (i + 1) * 100, async (ctx) => {
          ctx.system.push(`hook-${i}`)
        })
      }

      const ctx = (): HookChain.PreLLMContext => ({
        sessionID: "bench-session",
        system: ["base prompt"],
        agent: "build",
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hello" }],
      })

      // Warm up (triggers compilation)
      await HookChain.execute("pre-llm", ctx())

      const stats = await measureMs(() => HookChain.execute("pre-llm", ctx()), 200)
      logBench("PreLLMChain 5 hooks", stats)

      expect(stats.p50).toBeLessThan(5)
      expect(stats.p99).toBeLessThan(10)
    })
  })

  // --- PreToolChain: 3 hooks p50/p99 ---

  test("bench: PreToolChain 3 hooks p50/p99 latency", async () => {
    await withInstance(async () => {
      for (let i = 0; i < 3; i++) {
        HookChain.register(`pre-tool-bench-${i}`, "pre-tool", (i + 1) * 100, async () => {
          // minimal work
        })
      }

      const ctx = (): HookChain.PreToolContext => ({
        sessionID: "bench-session",
        toolName: "edit",
        args: { file_path: "/test.ts", old_string: "foo", new_string: "bar" },
        agent: "build",
      })

      await HookChain.execute("pre-tool", ctx())

      const stats = await measureMs(() => HookChain.execute("pre-tool", ctx()), 200)
      logBench("PreToolChain 3 hooks", stats)

      expect(stats.p50).toBeLessThan(2)
      expect(stats.p99).toBeLessThan(5)
    })
  })

  // --- PostToolChain: 5 hooks p50/p99 ---

  test("bench: PostToolChain 5 hooks p50/p99 latency", async () => {
    await withInstance(async () => {
      for (let i = 0; i < 5; i++) {
        HookChain.register(`post-tool-bench-${i}`, "post-tool", (i + 1) * 100, async (ctx) => {
          ctx.result.output = ctx.result.output + `[hook-${i}]`
        })
      }

      const ctx = (): HookChain.PostToolContext => ({
        sessionID: "bench-session",
        toolName: "read",
        args: { file_path: "/test.ts" },
        result: { output: "file content here", title: "Read" },
        agent: "build",
      })

      await HookChain.execute("post-tool", ctx())

      const stats = await measureMs(() => HookChain.execute("post-tool", ctx()), 200)
      logBench("PostToolChain 5 hooks", stats)

      expect(stats.p50).toBeLessThan(10)
      expect(stats.p99).toBeLessThan(20)
    })
  })

  // --- tool-output-truncator on 1KB/100KB/1MB/10MB ---

  test("bench: tool-output-truncator 1KB input", () => {
    const input = generateText(1024)
    const stats = measureSyncMs(() => {
      OutputManagementHooks.truncateOutput(input, 50 * 1024)
    }, 1000)
    logBench("truncateOutput 1KB (no truncation)", stats)
    expect(stats.p50).toBeLessThan(1)
  })

  test("bench: tool-output-truncator 100KB input", () => {
    const input = generateText(100 * 1024)
    const stats = measureSyncMs(() => {
      OutputManagementHooks.truncateOutput(input, 50 * 1024)
    }, 500)
    logBench("truncateOutput 100KB", stats)
    expect(stats.p50).toBeLessThan(5)
  })

  test("bench: tool-output-truncator 1MB input", () => {
    const input = generateText(1024 * 1024)
    const stats = measureSyncMs(() => {
      OutputManagementHooks.truncateOutput(input, 50 * 1024)
    }, 100)
    logBench("truncateOutput 1MB", stats)
    expect(stats.p50).toBeLessThan(20)
  })

  test("bench: tool-output-truncator 10MB input", () => {
    const input = generateText(10 * 1024 * 1024)
    const stats = measureSyncMs(() => {
      OutputManagementHooks.truncateOutput(input, 50 * 1024)
    }, 20)
    logBench("truncateOutput 10MB", stats)
    expect(stats.p50).toBeLessThan(50)
  })

  // --- context-window-monitor token counting ---

  test("bench: context-window-monitor token estimation", () => {
    const text = generateText(100 * 1024) // 100KB of text
    const stats = measureSyncMs(() => {
      OutputManagementHooks.estimateTokens(text)
    }, 1000)
    logBench("estimateTokens 100KB", stats)
    expect(stats.p50).toBeLessThan(1)
  })

  test("bench: context-window-monitor full context usage estimation", () => {
    const ctx: HookChain.PreLLMContext = {
      sessionID: "bench",
      system: [generateText(10 * 1024)], // 10KB system prompt
      agent: "build",
      model: "claude-opus-4-6",
      messages: Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: generateText(2 * 1024), // 2KB per message
      })),
    }

    const stats = measureSyncMs(() => {
      OutputManagementHooks.estimateContextUsage(ctx)
    }, 200)
    logBench("estimateContextUsage (10KB system + 50 messages)", stats)
    // JSON.stringify on 50 messages is heavier — allow more headroom
    expect(stats.p50).toBeLessThan(5)
  })

  // --- Disabled hook overhead ---

  test("bench: disabled hook overhead 1000 iterations", async () => {
    await withInstance(async () => {
      HookChain.register("disabled-bench-hook", "pre-llm", 100, async () => {
        throw new Error("should not run")
      })
      HookChain.reloadConfig({ "disabled-bench-hook": { enabled: false } })

      const ctx = (): HookChain.PreLLMContext => ({
        sessionID: "bench",
        system: [],
        agent: "build",
        model: "m1",
        messages: [],
      })

      // Warm up
      await HookChain.execute("pre-llm", ctx())

      const stats = await measureMs(() => HookChain.execute("pre-llm", ctx()), 1000)
      logBench("disabled hook chain (1000 iters)", stats)

      // Disabled hooks should have negligible overhead
      expect(stats.p50).toBeLessThan(0.1)
    })
  })

  // --- AGENTS.md injection cache hit vs miss ---

  test("bench: AGENTS.md injection cache hit vs miss", async () => {
    await withInstance(async () => {
      ContextInjectionHooks.resetCaches()
      ContextInjectionHooks.register()

      // Pre-populate cache for session to simulate cache hit
      const cache = ContextInjectionHooks.getAgentsCache()
      cache.set("bench-cached", "Cached AGENTS.md content for benchmarking purposes")

      // Cache hit: agents cache already populated
      const ctxHit = (): HookChain.PreLLMContext => ({
        sessionID: "bench-cached",
        system: ["base"],
        agent: "build",
        model: "claude-opus-4-6",
        messages: [],
      })

      // Warm up
      await HookChain.execute("pre-llm", ctxHit())

      const hitStats = await measureMs(() => HookChain.execute("pre-llm", ctxHit()), 200)
      logBench("AGENTS.md cache HIT", hitStats)

      // Cache miss: new session ID each time forces file lookup (will fail gracefully — no AGENTS.md in temp dir)
      let missCount = 0
      const ctxMiss = (): HookChain.PreLLMContext => ({
        sessionID: `bench-miss-${missCount++}`,
        system: ["base"],
        agent: "build",
        model: "claude-opus-4-6",
        messages: [],
      })

      const missStats = await measureMs(() => HookChain.execute("pre-llm", ctxMiss()), 50)
      logBench("AGENTS.md cache MISS (file not found)", missStats)

      expect(hitStats.p50).toBeLessThan(0.5)
      // Cache miss involves file I/O — allow more time
      console.log(`[BENCH] Cache hit/miss ratio: ${(missStats.p50 / Math.max(hitStats.p50, 0.001)).toFixed(1)}x slower on miss`)
    })
  })

  // --- Full pipeline with all hooks ---

  test("bench: full pipeline with all hooks registered", async () => {
    await withInstance(async () => {
      // Register all hook modules
      ErrorRecoveryHooks.resetErrorHistory()
      OutputManagementHooks.resetThresholds()
      ContextInjectionHooks.resetCaches()
      DetectionCheckingHooks.resetCommentThreshold()
      AgentEnforcementHooks.resetStopSignals()
      SessionLifecycleHooks.resetNotificationLog()
      SessionLifecycleHooks.resetFailureCounts()

      ErrorRecoveryHooks.register()
      OutputManagementHooks.register()
      ContextInjectionHooks.register()
      DetectionCheckingHooks.register()
      AgentEnforcementHooks.register()
      SessionLifecycleHooks.register()
      LLMParameterHooks.register()

      const hookCount = HookChain.listRegistered().length
      console.log(`[BENCH] Total hooks registered: ${hookCount}`)

      // Pre-populate caches for realistic steady-state
      const cache = ContextInjectionHooks.getAgentsCache()
      cache.set("full-bench", null)
      const readmeCache = ContextInjectionHooks.getReadmeCache()
      readmeCache.set("full-bench", { dir: "/tmp/bench", content: null })
      const rulesCache = ContextInjectionHooks.getRulesCache()
      rulesCache.set("full-bench", null)

      // Benchmark PreLLM chain (has the most hooks)
      const preLlmCtx = (): HookChain.PreLLMContext => ({
        sessionID: "full-bench",
        system: [generateText(5 * 1024)],
        agent: "build",
        model: "claude-opus-4-6",
        messages: Array.from({ length: 10 }, (_, i) => ({
          role: i % 2 === 0 ? "user" : "assistant",
          content: generateText(1024),
        })),
      })

      await HookChain.execute("pre-llm", preLlmCtx())

      const preLlmStats = await measureMs(() => HookChain.execute("pre-llm", preLlmCtx()), 100)
      logBench("Full pipeline: PreLLM chain", preLlmStats)

      // Benchmark PostTool chain
      const postToolCtx = (): HookChain.PostToolContext => ({
        sessionID: "full-bench",
        toolName: "read",
        args: { file_path: "/test.ts" },
        result: { output: generateText(10 * 1024), title: "Read" },
        agent: "build",
      })

      await HookChain.execute("post-tool", postToolCtx())

      const postToolStats = await measureMs(() => HookChain.execute("post-tool", postToolCtx()), 100)
      logBench("Full pipeline: PostTool chain", postToolStats)

      // Benchmark PreTool chain
      const preToolCtx = (): HookChain.PreToolContext => ({
        sessionID: "full-bench",
        toolName: "edit",
        args: { file_path: "/test.ts", old_string: "a", new_string: "b" },
        agent: "build",
      })

      await HookChain.execute("pre-tool", preToolCtx())

      const preToolStats = await measureMs(() => HookChain.execute("pre-tool", preToolCtx()), 100)
      logBench("Full pipeline: PreTool chain", preToolStats)

      // Benchmark SessionLifecycle chain
      const lifecycleCtx = (): HookChain.SessionLifecycleContext => ({
        sessionID: "full-bench",
        event: "session.created",
        data: {},
        agent: "build",
      })

      await HookChain.execute("session-lifecycle", lifecycleCtx())

      const lifecycleStats = await measureMs(() => HookChain.execute("session-lifecycle", lifecycleCtx()), 100)
      logBench("Full pipeline: SessionLifecycle chain", lifecycleStats)

      // Assert performance targets
      expect(preLlmStats.p50).toBeLessThan(5)
      expect(postToolStats.p50).toBeLessThan(10)
      expect(preToolStats.p50).toBeLessThan(2)
    })
  })

  // --- Compilation benchmark ---

  test("bench: chain compilation cost", async () => {
    await withInstance(async () => {
      // Register 20 hooks across all chain types
      for (let i = 0; i < 5; i++) {
        HookChain.register(`compile-prellm-${i}`, "pre-llm", i * 100, async () => {})
        HookChain.register(`compile-pretool-${i}`, "pre-tool", i * 100, async () => {})
        HookChain.register(`compile-posttool-${i}`, "post-tool", i * 100, async () => {})
        HookChain.register(`compile-lifecycle-${i}`, "session-lifecycle", i * 100, async () => {})
      }

      const stats = measureSyncMs(() => {
        // Force recompilation each time
        HookChain.reloadConfig({})
        HookChain.compile()
      }, 500)
      logBench("Chain compilation (20 hooks)", stats)

      expect(stats.p50).toBeLessThan(1)
    })
  })

  // --- Grep match counting ---

  test("bench: grep output match counting", () => {
    // 500 lines of grep output
    const lines = Array.from({ length: 500 }, (_, i) => `src/file${i}.ts:${i}: const x = ${i}`)
    const output = lines.join("\n")

    const stats = measureSyncMs(() => {
      OutputManagementHooks.countGrepMatches(output)
    }, 500)
    logBench("countGrepMatches 500 lines", stats)
    expect(stats.p50).toBeLessThan(1)
  })

  // --- Context extraction benchmark ---

  test("bench: extractCriticalContext on large message history", () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Working on editing src/file${i}.ts and modified utils/helper${i}.ts. Decision: use pattern ${i} for the implementation. ${generateText(500)}`,
    }))

    const stats = measureSyncMs(() => {
      ContextInjectionHooks.extractCriticalContext(messages)
    }, 100)
    logBench("extractCriticalContext 100 messages", stats)
    expect(stats.p50).toBeLessThan(10)
  })

  // --- Todo extraction benchmark ---

  test("bench: extractIncompleteTodos on large message history", () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `- [ ] Task item ${i}\nTODO: fix issue ${i}\nFIXME: resolve bug ${i}\nStill need to: complete feature ${i}\n${generateText(200)}`,
    }))

    const stats = measureSyncMs(() => {
      ContextInjectionHooks.extractIncompleteTodos(messages)
    }, 100)
    logBench("extractIncompleteTodos 100 messages", stats)
    expect(stats.p50).toBeLessThan(10)
  })

  // --- Model context window lookup ---

  test("bench: getModelContextWindow lookup", () => {
    const models = ["claude-opus-4-6", "claude-sonnet-4-5", "gpt-4o", "gpt-3.5-turbo", "gemini-pro", "unknown-model"]

    const stats = measureSyncMs(() => {
      for (const model of models) {
        OutputManagementHooks.getModelContextWindow(model)
      }
    }, 1000)
    logBench("getModelContextWindow 6 models", stats)
    expect(stats.p50).toBeLessThan(0.1)
  })
})
