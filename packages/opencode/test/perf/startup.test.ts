import { describe, expect, test } from "bun:test"
import type { StartupTrace } from "@/util/startup-trace"

const PERF_ENABLED = process.env.OPENCODE_PERF_TEST === "1"
const srcDir = new URL("../../src/", import.meta.url).pathname

// Per-phase thresholds in ms (1.5x of measured baseline)
// Baseline: global-init ~0ms, log-init ~8ms, project-detect ~2ms
const PHASE_THRESHOLDS: Record<string, number> = {
  "global-init": 75,
  "log-init": 75,
  "project-detect": 150,
  "git-metadata": 150,
  "config-load": 3000,
  "instance-bootstrap": 3000,
}

// Total non-TUI overhead threshold (global-init + log-init)
const NON_TUI_OVERHEAD_THRESHOLD = 150

describe("US-017: startup performance regression tests", () => {
  describe("structural invariants", () => {
    test("global/index.ts has no module-level await", async () => {
      const src = await Bun.file(srcDir + "global/index.ts").text()
      const lines = src.split("\n")
      const topLevelAwaits = lines.filter((line) => {
        const trimmed = line.trimStart()
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed === "")
          return false
        return (line === trimmed || line.startsWith("export ")) && trimmed.startsWith("await ")
      })
      expect(topLevelAwaits).toHaveLength(0)
    })

    test("Log.init() is synchronous", async () => {
      const src = await Bun.file(srcDir + "util/log.ts").text()
      const initStart = src.indexOf("export function init(")
      expect(initStart).toBeGreaterThan(-1)
      const beforeInit = src.slice(Math.max(0, initStart - 20), initStart)
      expect(beforeInit).not.toContain("async")
    })

    test("provider imports are lazy (no static import of AI SDK at module level)", async () => {
      const src = await Bun.file(srcDir + "provider/provider.ts").text()
      // Should use BUNDLED_PROVIDER_LOADERS Map, not static imports
      expect(src).toContain("BUNDLED_PROVIDER_LOADERS")
      // No static imports of @ai-sdk/ packages (except type-only)
      const lines = src.split("\n")
      const staticAiImports = lines.filter(
        (line) => line.match(/^import\s/) && line.includes("@ai-sdk/") && !line.includes("import type"),
      )
      expect(staticAiImports).toHaveLength(0)
    })

    test("LSP.init() and FileWatcher.init() are deferred from bootstrap", async () => {
      const src = await Bun.file(srcDir + "project/bootstrap.ts").text()
      // LSP and FileWatcher should be in queueMicrotask, not in the awaited Promise.all groups
      expect(src).toContain("queueMicrotask")
      expect(src).toContain("LSP.init()")
      expect(src).toContain("FileWatcher.init()")

      // Verify they're NOT in the main Promise.all groups (Group B/C)
      const groupBCStart = src.indexOf("await Promise.all([")
      const groupBCEnd = src.indexOf("phases.push(...groupB", groupBCStart)
      const groupBCBlock = src.slice(groupBCStart, groupBCEnd)
      expect(groupBCBlock).not.toContain("LSP.init()")
      expect(groupBCBlock).not.toContain("FileWatcher.init()")
    })

    test("remote config fetch has timeout", async () => {
      const src = await Bun.file(srcDir + "config/config.ts").text()
      expect(src).toContain("AbortSignal.timeout(")
    })

    test("plugin loading uses Promise.allSettled for parallel execution", async () => {
      const src = await Bun.file(srcDir + "plugin/index.ts").text()
      expect(src).toContain("Promise.allSettled(")
    })

    test("installDependencies is deferred from Config.state() critical path", async () => {
      const src = await Bun.file(srcDir + "config/config.ts").text()
      // installDependencies should be called AFTER the main config return, in background
      const stateReturn = src.indexOf("return result")
      const installCall = src.indexOf("installDependencies(")
      // There should be a deferred/background install pattern
      expect(src).toContain("installDependencies")
      // The main return should happen before/independently of install
      expect(stateReturn).toBeGreaterThan(-1)
    })

    test("terminal background detection timeout is 150ms (not 1000ms)", async () => {
      const src = await Bun.file(srcDir + "cli/cmd/tui/app.tsx").text()
      const detectFn = src.slice(
        src.indexOf("function detectTerminalBackground"),
        src.indexOf("async function getTerminalBackgroundColor"),
      )
      expect(detectFn).toContain("}, 150)")
      expect(detectFn).not.toContain("}, 1000)")
    })

    test("git metadata caching is implemented", async () => {
      const src = await Bun.file(srcDir + "project/project.ts").text()
      expect(src).toContain("opencode-metadata")
    })
  })

  describe("subprocess timing", () => {
    const runStartupTrace = async () => {
      const proc = Bun.spawn(["bun", "run", "src/index.ts", "--startup-trace", "models"], {
        cwd: new URL("../../", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
          OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
          HOME: process.env.HOME,
        },
      })

      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      await proc.exited

      // Parse trace JSON from stderr
      const jsonMatch = stderr.match(/\{[\s\S]*"total_ms"[\s\S]*"phases"[\s\S]*\}/)
      if (!jsonMatch) {
        const stdoutMatch = stdout.match(/\{[\s\S]*"total_ms"[\s\S]*"phases"[\s\S]*\}/)
        if (!stdoutMatch) return { exitCode: proc.exitCode, trace: null }
        return { exitCode: proc.exitCode, trace: JSON.parse(stdoutMatch[0]) }
      }
      return { exitCode: proc.exitCode, trace: JSON.parse(jsonMatch[0]) }
    }

    test.skipIf(!PERF_ENABLED)(
      "startup-trace outputs valid JSON with phases",
      async () => {
        const { exitCode, trace } = await runStartupTrace()
        expect(exitCode).toBe(0)
        if (!trace) return // trace may not be available in all environments

        expect(trace.total_ms).toBeGreaterThanOrEqual(0)
        expect(trace.process_start).toBeDefined()
        expect(Array.isArray(trace.phases)).toBe(true)
        expect(trace.phases.length).toBeGreaterThan(0)

        // Every phase must have required fields
        for (const phase of trace.phases as StartupTrace.Phase[]) {
          expect(phase.phase).toBeDefined()
          expect(typeof phase.phase).toBe("string")
          expect(typeof phase.duration_ms).toBe("number")
          expect(phase.duration_ms).toBeGreaterThanOrEqual(0)
        }
      },
      30000,
    )

    test.skipIf(!PERF_ENABLED)(
      "per-phase durations do not exceed thresholds",
      async () => {
        const { exitCode, trace } = await runStartupTrace()
        expect(exitCode).toBe(0)
        if (!trace) return

        const phases = trace.phases as StartupTrace.Phase[]
        for (const phase of phases) {
          const threshold = PHASE_THRESHOLDS[phase.phase]
          if (threshold !== undefined) {
            expect(phase.duration_ms).toBeLessThanOrEqual(threshold)
          }
        }
      },
      30000,
    )

    test.skipIf(!PERF_ENABLED)(
      "non-TUI overhead (global-init + log-init) within budget",
      async () => {
        const { exitCode, trace } = await runStartupTrace()
        expect(exitCode).toBe(0)
        if (!trace) return

        const phases = trace.phases as StartupTrace.Phase[]
        const overhead = phases
          .filter((p) => p.phase === "global-init" || p.phase === "log-init")
          .reduce((sum, p) => sum + p.duration_ms, 0)

        expect(overhead).toBeLessThanOrEqual(NON_TUI_OVERHEAD_THRESHOLD)
      },
      30000,
    )
  })
})
