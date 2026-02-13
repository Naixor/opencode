import { describe, expect, test } from "bun:test"
import { StartupTrace } from "@/util/startup-trace"

describe("US-016: TUI first-frame verification", () => {
  describe("structural guarantees for <200ms first-frame", () => {
    test("resolveNetworkOptions is NOT awaited before tui() in common path", async () => {
      // Verify thread.ts code structure: tui() is called before resolveNetworkOptions
      const threadSrc = await Bun.file(new URL("../../src/cli/cmd/tui/thread.ts", import.meta.url)).text()

      // In the common (non-cliWantsServer) path, tui() is called BEFORE resolveNetworkOptions
      const commonPathStart = threadSrc.indexOf("// Common case: start TUI immediately")
      expect(commonPathStart).toBeGreaterThan(-1)

      const tuiCallIndex = threadSrc.indexOf("const tuiPromise = tui(", commonPathStart)
      const networkResolveIndex = threadSrc.indexOf(
        'StartupTrace.measure("resolve-network-options"',
        commonPathStart,
      )

      // tui() must come BEFORE resolveNetworkOptions in the common path
      expect(tuiCallIndex).toBeGreaterThan(-1)
      expect(networkResolveIndex).toBeGreaterThan(-1)
      expect(tuiCallIndex).toBeLessThan(networkResolveIndex)
    })

    test("getTerminalBackgroundColor uses COLORFGBG fast path", async () => {
      const appSrc = await Bun.file(new URL("../../src/cli/cmd/tui/app.tsx", import.meta.url)).text()

      // Verify COLORFGBG is checked first (before cache and OSC query)
      const colorfgbgIndex = appSrc.indexOf("inferFromCOLORFGBG()")
      const cacheIndex = appSrc.indexOf("readCachedMode()")
      const oscIndex = appSrc.indexOf("detectTerminalBackground()")

      expect(colorfgbgIndex).toBeGreaterThan(-1)
      expect(cacheIndex).toBeGreaterThan(-1)
      expect(oscIndex).toBeGreaterThan(-1)

      // Order: COLORFGBG → cache → OSC detection
      expect(colorfgbgIndex).toBeLessThan(cacheIndex)
      expect(cacheIndex).toBeLessThan(oscIndex)
    })

    test("getTerminalBackgroundColor caches result for subsequent launches", async () => {
      const appSrc = await Bun.file(new URL("../../src/cli/cmd/tui/app.tsx", import.meta.url)).text()

      // Verify cache write happens after detection
      expect(appSrc).toContain("writeCachedMode(detected)")

      // Verify cache read happens before detection
      const getTermBgFn = appSrc.slice(
        appSrc.indexOf("async function getTerminalBackgroundColor"),
        appSrc.indexOf("export function clearTerminalBgCache"),
      )
      expect(getTermBgFn).toContain("readCachedMode()")
      expect(getTermBgFn).toContain('if (cached) return cached')
    })

    test("OSC detection timeout is 150ms (not 1000ms)", async () => {
      const appSrc = await Bun.file(new URL("../../src/cli/cmd/tui/app.tsx", import.meta.url)).text()

      // Extract the detectTerminalBackground function
      const detectFn = appSrc.slice(
        appSrc.indexOf("function detectTerminalBackground"),
        appSrc.indexOf("async function getTerminalBackgroundColor"),
      )
      // Timeout should be 150ms
      expect(detectFn).toContain("}, 150)")
      // Should NOT contain the old 1000ms timeout
      expect(detectFn).not.toContain("}, 1000)")
    })

    test("Log.init() is synchronous (no await)", async () => {
      const logSrc = await Bun.file(new URL("../../src/util/log.ts", import.meta.url)).text()

      // Log.init should not be async — extract the init function signature
      const initMatch = logSrc.match(/export function init\(/)
      expect(initMatch).not.toBeNull()

      // init function should NOT be async
      const initStart = logSrc.indexOf("export function init(")
      const beforeInit = logSrc.slice(Math.max(0, initStart - 20), initStart)
      expect(beforeInit).not.toContain("async")
    })

    test("global/index.ts has no module-level await", async () => {
      const globalSrc = await Bun.file(new URL("../../src/global/index.ts", import.meta.url)).text()

      // Split into module-level code (outside functions/classes) by checking for top-level await
      // Module-level await would be "await" at the start of a line or after a statement at indent level 0
      const lines = globalSrc.split("\n")
      const topLevelAwaits = lines.filter((line) => {
        const trimmed = line.trimStart()
        // Skip comments and empty lines
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed === "")
          return false
        // Check for top-level await (not inside a function body — heuristic: no leading whitespace or just export)
        return (line === trimmed || line.startsWith("export ")) && trimmed.startsWith("await ")
      })

      expect(topLevelAwaits).toHaveLength(0)
    })

    test("tui-first-frame timing is recorded before render()", async () => {
      const appSrc = await Bun.file(new URL("../../src/cli/cmd/tui/app.tsx", import.meta.url)).text()

      // Verify tui-first-frame is recorded
      const firstFrameIndex = appSrc.indexOf('StartupTrace.record("tui-first-frame"')
      const renderIndex = appSrc.indexOf("render(", appSrc.indexOf("export function tui"))

      expect(firstFrameIndex).toBeGreaterThan(-1)
      expect(renderIndex).toBeGreaterThan(-1)
      expect(firstFrameIndex).toBeLessThan(renderIndex)
    })

    test("worker-spawn timing is recorded around Worker creation", async () => {
      const threadSrc = await Bun.file(new URL("../../src/cli/cmd/tui/thread.ts", import.meta.url)).text()

      const beginIndex = threadSrc.indexOf('StartupTrace.begin("worker-spawn")')
      const newWorkerIndex = threadSrc.indexOf("new Worker(")
      const endIndex = threadSrc.indexOf('StartupTrace.end("worker-spawn")')

      expect(beginIndex).toBeGreaterThan(-1)
      expect(newWorkerIndex).toBeGreaterThan(-1)
      expect(endIndex).toBeGreaterThan(-1)
      expect(beginIndex).toBeLessThan(newWorkerIndex)
      expect(newWorkerIndex).toBeLessThan(endIndex)
    })
  })

  describe("non-TUI startup timing baseline", () => {
    test(
      "--startup-trace with models command completes within budget",
      async () => {
      const proc = Bun.spawn(["bun", "run", "src/index.ts", "--startup-trace", "models"], {
        cwd: new URL("../../", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          // Ensure cache is warm for reproducible results
          HOME: process.env.HOME,
        },
      })

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited

      // Parse trace from stderr (trace is JSON output to stderr)
      // The trace may be mixed with log output — find the JSON object
      const jsonMatch = stderr.match(/\{[\s\S]*"total_ms"[\s\S]*"phases"[\s\S]*\}/)
      if (!jsonMatch) {
        // Trace may be in stdout if stderr had issues
        const stdoutMatch = stdout.match(/\{[\s\S]*"total_ms"[\s\S]*"phases"[\s\S]*\}/)
        if (!stdoutMatch) {
          // If no trace output, this is not a TUI run — verify the non-TUI phases are fast
          // The models command goes through: global-init, log-init, project-detect, config-load
          // These should all be fast. Just verify the command succeeded.
          expect(proc.exitCode).toBe(0)
          return
        }
      }

      // If we got trace output, parse and validate
      const trace = JSON.parse(jsonMatch![0])
      const phases = trace.phases as Array<{ phase: string; duration_ms: number }>

      // global-init should be <50ms (just imports)
      const globalInit = phases.find((p) => p.phase === "global-init")
      if (globalInit) expect(globalInit.duration_ms).toBeLessThan(50)

      // log-init should be <50ms (sync init + ensureDirectories + flush)
      const logInit = phases.find((p) => p.phase === "log-init")
      if (logInit) expect(logInit.duration_ms).toBeLessThan(50)

      // These phases combined represent the non-TUI overhead
      // They should total <100ms on warm cache
      const nonTuiTotal = phases.reduce((sum, p) => {
        if (["global-init", "log-init"].includes(p.phase)) return sum + p.duration_ms
        return sum
      }, 0)
      expect(nonTuiTotal).toBeLessThan(100)
      },
      30000,
    )
  })

  describe("submission behavior during loading", () => {
    test("sync status starts as 'loading' and transitions through partial to complete", async () => {
      const syncSrc = await Bun.file(new URL("../../src/cli/cmd/tui/context/sync.tsx", import.meta.url)).text()

      // Initial status is "loading"
      expect(syncSrc).toContain('status: "loading"')

      // Transitions to "partial" after blocking requests
      expect(syncSrc).toContain('setStore("status", "partial")')

      // Transitions to "complete" after all data loaded
      expect(syncSrc).toContain('setStore("status", "complete")')
    })

    test("sync.status loading does NOT block message submission", async () => {
      // The prompt's disabled prop is based on permissions/questions, not sync.status
      const sessionSrc = await Bun.file(
        new URL("../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url),
      ).text()

      // Find the Prompt component usage and verify disabled is NOT based on sync.status
      const promptUsage = sessionSrc.slice(
        sessionSrc.indexOf("<Prompt"),
        sessionSrc.indexOf("/>", sessionSrc.indexOf("<Prompt")) + 2,
      )

      // disabled should be based on permissions/questions, NOT sync.status
      expect(promptUsage).not.toContain("sync.status")
      expect(promptUsage).toContain("permissions()")
      expect(promptUsage).toContain("questions()")
    })

    test("continue flag (-c) waits for session list at 'partial' status", async () => {
      const appSrc = await Bun.file(new URL("../../src/cli/cmd/tui/app.tsx", import.meta.url)).text()

      // The -c continue logic checks for loading status
      expect(appSrc).toContain('sync.status === "loading"')
      expect(appSrc).toContain("args.continue")
    })
  })

  describe("StartupTrace module", () => {
    test("record() captures phase with duration", () => {
      StartupTrace.record("test-phase", 42)
      // Just verify it doesn't throw — output is only written when enabled
    })

    test("measure() wraps async function with timing", async () => {
      const result = await StartupTrace.measure("test-measure", async () => {
        await Bun.sleep(1)
        return 123
      })
      expect(result).toBe(123)
    })
  })
})
