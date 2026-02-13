import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { HookChain } from "../../../src/session/hooks"
import { SessionLifecycleHooks } from "../../../src/session/hooks/session-lifecycle"
import { SessionStatus } from "../../../src/session/status"

describe("SessionLifecycleHooks", () => {
  async function withInstance(fn: () => Promise<void>, config?: Record<string, unknown>) {
    await using tmp = await tmpdir({
      git: true,
      config: config ?? {},
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        HookChain.reset()
        SessionLifecycleHooks.resetFailureCounts()
        SessionLifecycleHooks.resetNotificationLog()
        SessionLifecycleHooks.configureNotification({ enabled: true, sound: true })
        SessionLifecycleHooks.register()
        await fn()
      },
    })
  }

  // --- session-recovery ---

  describe("session-recovery", () => {
    test("mock crashed session (status 'busy') -> resume offered", async () => {
      await withInstance(async () => {
        const crashedSessionID = "s-crashed-1"

        // Simulate a stuck session by setting its status to busy
        SessionStatus.set(crashedSessionID, { type: "busy" })

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s-new-1",
          event: "session.created",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { recovery?: boolean; stuckSessions?: string[]; message?: string }
        expect(data.recovery).toBe(true)
        expect(data.stuckSessions).toContain(crashedSessionID)
        expect(data.message).toContain("status 'busy'")
        expect(data.message).toContain("crashed")
      })
    })

    test("mock clean session -> no recovery prompt", async () => {
      await withInstance(async () => {
        // No stuck sessions - all idle (default)
        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s-new-2",
          event: "session.created",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { recovery?: boolean }
        expect(data.recovery).toBeUndefined()
      })
    })

    test("non-created event -> no recovery check", async () => {
      await withInstance(async () => {
        SessionStatus.set("s-crashed-2", { type: "busy" })

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s-new-3",
          event: "session.updated",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { recovery?: boolean }
        expect(data.recovery).toBeUndefined()
      })
    })

    test("own session busy -> not reported as stuck", async () => {
      await withInstance(async () => {
        const sessionID = "s-self-busy"

        // Set own session as busy
        SessionStatus.set(sessionID, { type: "busy" })

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID,
          event: "session.created",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { recovery?: boolean }
        expect(data.recovery).toBeUndefined()
      })
    })
  })

  // --- session-notification ---

  describe("session-notification", () => {
    test("agent stopped -> notification sent", async () => {
      await withInstance(async () => {
        // Don't actually call osascript/notify-send in tests, just verify the log
        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s-notif-1",
          event: "agent.stopped",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const notifLog = SessionLifecycleHooks.getNotificationLog()
        expect(notifLog.length).toBeGreaterThanOrEqual(1)
        const notif = notifLog.find((n) => n.title === "OpenCode")
        expect(notif).toBeDefined()
        expect(notif!.message).toContain("build")
        expect(notif!.message).toContain("completed")
      })
    })

    test("notification disabled -> no notification", async () => {
      await withInstance(async () => {
        SessionLifecycleHooks.configureNotification({ enabled: false })

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s-notif-2",
          event: "agent.stopped",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const notifLog = SessionLifecycleHooks.getNotificationLog()
        expect(notifLog.length).toBe(0)
      })
    })

    test("non-stopped event -> no notification", async () => {
      await withInstance(async () => {
        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s-notif-3",
          event: "session.updated",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const notifLog = SessionLifecycleHooks.getNotificationLog()
        expect(notifLog.length).toBe(0)
      })
    })

    test("macOS platform -> osascript referenced", async () => {
      await withInstance(async () => {
        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s-notif-4",
          event: "agent.stopped",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const notifLog = SessionLifecycleHooks.getNotificationLog()
        // On macOS (darwin), the platform field should be "darwin"
        // On other platforms, it should reflect that platform
        expect(notifLog.length).toBeGreaterThanOrEqual(1)
        expect(notifLog[0].platform).toBe(process.platform)
      })
    })
  })

  // --- unstable-agent-babysitter ---

  describe("unstable-agent-babysitter", () => {
    test("3 consecutive failures -> diagnostic guidance injected", async () => {
      await withInstance(async () => {
        const sessionID = "s-babysit-1"
        const agent = "build"

        // Simulate 3 consecutive agent.error events
        for (let i = 0; i < 3; i++) {
          const ctx: HookChain.SessionLifecycleContext = {
            sessionID,
            event: "agent.error",
            data: { error: `Error ${i + 1}` },
            agent,
          }
          await HookChain.execute("session-lifecycle", ctx)

          if (i < 2) {
            const data = ctx.data as { diagnostic?: boolean }
            expect(data.diagnostic).toBeUndefined()
          }
          if (i === 2) {
            const data = ctx.data as { diagnostic?: boolean; message?: string }
            expect(data.diagnostic).toBe(true)
            expect(data.message).toContain("failed 3 consecutive times")
            expect(data.message).toContain("build")
          }
        }
      })
    })

    test("2 failures then success -> counter reset, no guidance", async () => {
      await withInstance(async () => {
        const sessionID = "s-babysit-2"
        const agent = "build"

        // 2 failures
        for (let i = 0; i < 2; i++) {
          const ctx: HookChain.SessionLifecycleContext = {
            sessionID,
            event: "agent.error",
            data: { error: `Error ${i + 1}` },
            agent,
          }
          await HookChain.execute("session-lifecycle", ctx)
        }

        expect(SessionLifecycleHooks.getFailureCount(sessionID, agent)).toBe(2)

        // Success resets counter
        const successCtx: HookChain.SessionLifecycleContext = {
          sessionID,
          event: "agent.stopped",
          data: {},
          agent,
        }
        await HookChain.execute("session-lifecycle", successCtx)

        expect(SessionLifecycleHooks.getFailureCount(sessionID, agent)).toBe(0)

        // Next failure should be count=1, no diagnostic
        const failCtx: HookChain.SessionLifecycleContext = {
          sessionID,
          event: "agent.error",
          data: { error: "Error after reset" },
          agent,
        }
        await HookChain.execute("session-lifecycle", failCtx)

        const data = failCtx.data as { diagnostic?: boolean }
        expect(data.diagnostic).toBeUndefined()
        expect(SessionLifecycleHooks.getFailureCount(sessionID, agent)).toBe(1)
      })
    })

    test("different agents tracked separately", async () => {
      await withInstance(async () => {
        const sessionID = "s-babysit-3"

        // 2 failures for agent "build"
        for (let i = 0; i < 2; i++) {
          const ctx: HookChain.SessionLifecycleContext = {
            sessionID,
            event: "agent.error",
            data: { error: `Error ${i + 1}` },
            agent: "build",
          }
          await HookChain.execute("session-lifecycle", ctx)
        }

        // 1 failure for agent "explore"
        const exploreCtx: HookChain.SessionLifecycleContext = {
          sessionID,
          event: "agent.error",
          data: { error: "Explore error" },
          agent: "explore",
        }
        await HookChain.execute("session-lifecycle", exploreCtx)

        expect(SessionLifecycleHooks.getFailureCount(sessionID, "build")).toBe(2)
        expect(SessionLifecycleHooks.getFailureCount(sessionID, "explore")).toBe(1)
      })
    })

    test("4th consecutive failure -> count increases", async () => {
      await withInstance(async () => {
        const sessionID = "s-babysit-4"
        const agent = "build"

        let lastCtx: HookChain.SessionLifecycleContext | undefined
        for (let i = 0; i < 4; i++) {
          lastCtx = {
            sessionID,
            event: "agent.error",
            data: { error: `Error ${i + 1}` },
            agent,
          }
          await HookChain.execute("session-lifecycle", lastCtx)
        }

        const data = lastCtx!.data as { diagnostic?: boolean; message?: string }
        expect(data.diagnostic).toBe(true)
        expect(data.message).toContain("failed 4 consecutive times")
      })
    })
  })

  // --- Config-driven disable ---

  describe("config-driven disable", () => {
    test("disabled session-recovery -> no recovery on stuck session", async () => {
      await withInstance(async () => {
        HookChain.reloadConfig({ "session-recovery": { enabled: false } })

        SessionStatus.set("s-crashed-cfg", { type: "busy" })

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s-new-cfg",
          event: "session.created",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const data = ctx.data as { recovery?: boolean }
        expect(data.recovery).toBeUndefined()
      })
    })

    test("disabled session-notification -> no notification on agent stop", async () => {
      await withInstance(async () => {
        HookChain.reloadConfig({ "session-notification": { enabled: false } })

        const ctx: HookChain.SessionLifecycleContext = {
          sessionID: "s-cfg-notif",
          event: "agent.stopped",
          data: {},
          agent: "build",
        }

        await HookChain.execute("session-lifecycle", ctx)

        const notifLog = SessionLifecycleHooks.getNotificationLog()
        expect(notifLog.length).toBe(0)
      })
    })

    test("disabled unstable-agent-babysitter -> no diagnostic on 3 failures", async () => {
      await withInstance(async () => {
        HookChain.reloadConfig({ "unstable-agent-babysitter": { enabled: false } })

        const sessionID = "s-cfg-babysit"
        const agent = "build"

        let lastCtx: HookChain.SessionLifecycleContext | undefined
        for (let i = 0; i < 3; i++) {
          lastCtx = {
            sessionID,
            event: "agent.error",
            data: { error: `Error ${i + 1}` },
            agent,
          }
          await HookChain.execute("session-lifecycle", lastCtx)
        }

        const data = lastCtx!.data as { diagnostic?: boolean }
        expect(data.diagnostic).toBeUndefined()
      })
    })
  })
})
