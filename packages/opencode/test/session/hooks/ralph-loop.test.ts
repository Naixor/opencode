import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { HookChain } from "../../../src/session/hooks"
import { RalphLoop } from "../../../src/session/hooks/ralph-loop"
import { SessionStatus } from "../../../src/session/status"
import { registerMemoryInjector } from "../../../src/memory/hooks/inject"
import { Memory } from "../../../src/memory/memory"
import { MemoryInject } from "../../../src/memory/engine/injector"
import { MemoryRecall } from "../../../src/memory/engine/recall"
import { MemoryStorage } from "../../../src/memory/storage"
import { Session } from "../../../src/session"
import { SessionPrompt } from "../../../src/session/prompt"
import { Identifier } from "../../../src/id/id"

const spies: Array<ReturnType<typeof spyOn>> = []

afterEach(() => {
  for (const spy of spies) spy.mockRestore()
  spies.length = 0
  HookChain.reset()
  RalphLoop.reset()
  MemoryInject.reset()
})

async function withInstance(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      HookChain.reset()
      RalphLoop.reset()
      MemoryInject.reset()
      await MemoryStorage.clear()
      registerMemoryInjector()
      RalphLoop.register()
      await fn()
    },
  })
}

async function addMemory(content: string) {
  return Memory.create({
    content,
    categories: ["context"],
    scope: "personal",
    source: { sessionID: "ses_memory", method: "manual" },
  })
}

function ctx(sessionID: string, count: number): HookChain.PreLLMContext {
  return {
    sessionID,
    system: ["base"],
    agent: "build",
    model: "openai/gpt-5.2",
    messages: Array.from({ length: count }, (_, i) => ({ role: "user", content: `msg ${i}` })),
  }
}

async function runInject(sessionID: string, count: number) {
  const input = ctx(sessionID, count)
  await HookChain.execute("pre-llm", input)
  return input.system.join("\n")
}

function watchPrompts() {
  const calls: string[] = []
  spies.push(
    spyOn(SessionPrompt, "prompt").mockImplementation((async (input) => {
      calls.push(input.sessionID)
      return {} as Awaited<ReturnType<typeof SessionPrompt.prompt>>
    }) as typeof SessionPrompt.prompt),
  )
  return calls
}

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const result = await fn()
    if (result !== undefined) return result
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

async function nextSession(originID: string) {
  return waitFor(async () => {
    const state = RalphLoop.getState(originID)
    if (!state) return
    if (state.currentSessionID === originID) return
    return state.currentSessionID
  })
}

async function addDone(sessionID: string) {
  await addAssistantText(sessionID, "<promise>DONE</promise>")
}

async function addAssistantText(sessionID: string, text: string) {
  const user = Identifier.ascending("message")
  const assistant = Identifier.ascending("message")

  await Session.updateMessage({
    id: user,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5.2" },
  })

  await Session.updateMessage({
    id: assistant,
    sessionID,
    role: "assistant",
    parentID: user,
    time: { created: Date.now() },
    modelID: "gpt-5.2",
    providerID: "openai",
    mode: "build",
    agent: "build",
    path: {
      cwd: Instance.directory,
      root: Instance.worktree,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    finish: "stop",
  })

  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistant,
    sessionID,
    type: "text",
    text,
  })
}

describe("RalphLoop memory inheritance", () => {
  test("stores rendered memory and conflict payloads on the parent session", async () => {
    await withInstance(async () => {
      const session = await Session.create({})
      const memory = await addMemory("parent-memory")

      spies.push(
        spyOn(MemoryRecall, "invoke").mockResolvedValue({
          relevant: [memory.id],
          conflicts: [{ memoryA: memory.id, memoryB: "mem_other", reason: "rule mismatch" }],
        }),
      )

      await runInject(session.id, 3)

      const saved = MemoryInject.getResolved(session.id)
      expect(saved?.memory).toContain("parent-memory")
      expect(saved?.conflict).toContain("rule mismatch")
      expect(saved?.empty).toBe(false)
    })
  })

  test("ralph-loop children reuse parent memory and start with fresh history", async () => {
    await withInstance(async () => {
      const origin = await Session.create({})
      await addMemory("parent-memory")
      await runInject(origin.id, 1)
      await MemoryStorage.clear()
      await addMemory("new-memory")

      const calls = watchPrompts()

      await RalphLoop.start(origin.id, "ship it")
      SessionStatus.set(origin.id, { type: "idle" })

      const childID = await nextSession(origin.id)
      expect(calls).toContain(childID)

      const child = await Session.get(childID)
      expect(child.parentID).toBe(origin.id)
      expect(await Session.messages({ sessionID: childID })).toHaveLength(0)

      const system = await runInject(childID, 1)
      expect(system).toContain("parent-memory")
      expect(system).not.toContain("new-memory")
    })
  })

  test("ultrawork work sessions reuse parent memory on their first turn", async () => {
    await withInstance(async () => {
      const origin = await Session.create({})
      await addMemory("parent-memory")
      await runInject(origin.id, 1)
      await MemoryStorage.clear()
      await addMemory("new-memory")

      watchPrompts()

      await RalphLoop.start(origin.id, "ship it", { ultrawork: true })
      SessionStatus.set(origin.id, { type: "idle" })

      const childID = await nextSession(origin.id)
      const system = await runInject(childID, 1)
      expect(system).toContain("parent-memory")
      expect(system).not.toContain("new-memory")
    })
  })

  test("children fall back to normal injection when the parent resolved to empty memory", async () => {
    await withInstance(async () => {
      const origin = await Session.create({})
      await runInject(origin.id, 1)
      await addMemory("fresh-memory")

      watchPrompts()

      await RalphLoop.start(origin.id, "ship it")
      SessionStatus.set(origin.id, { type: "idle" })

      const childID = await nextSession(origin.id)
      const system = await runInject(childID, 1)
      expect(system).toContain("fresh-memory")
    })
  })

  test("root sessions keep normal refresh behavior", async () => {
    await withInstance(async () => {
      const session = await Session.create({})
      await addMemory("first-memory")
      const first = await runInject(session.id, 1)
      expect(first).toContain("first-memory")

      await MemoryStorage.clear()
      await addMemory("second-memory")
      const second = await runInject(session.id, 2)
      expect(second).toContain("second-memory")
      expect(second).not.toContain("first-memory")
    })
  })

  test("oracle verification sessions keep current memory behavior", async () => {
    await withInstance(async () => {
      const origin = await Session.create({})
      await addMemory("parent-memory")
      await runInject(origin.id, 1)
      await addDone(origin.id)
      await MemoryStorage.clear()
      await addMemory("oracle-memory")

      watchPrompts()

      await RalphLoop.start(origin.id, "ship it", { ultrawork: true })
      SessionStatus.set(origin.id, { type: "idle" })

      const childID = await nextSession(origin.id)
      const system = await runInject(childID, 1)
      expect(system).toContain("oracle-memory")
      expect(system).not.toContain("parent-memory")
    })
  })

  test("ultrawork stops when oracle verifier returns VERIFIED COMPLETE", async () => {
    await withInstance(async () => {
      const origin = await Session.create({})
      watchPrompts()

      await addDone(origin.id)
      await RalphLoop.start(origin.id, "ship it", { ultrawork: true })
      SessionStatus.set(origin.id, { type: "idle" })

      const verifyID = await nextSession(origin.id)
      RalphLoop.setVerificationSession(origin.id, verifyID)
      await addAssistantText(verifyID, "VERIFIED COMPLETE\n\nNo active work remains.")

      SessionStatus.set(verifyID, { type: "idle" })

      await waitFor(() => {
        if (!RalphLoop.getState(origin.id)) return true
      })
      expect(RalphLoop.getState(origin.id)).toBeNull()
    })
  })

  test("cancelForSession cancels active ultrawork from a child session", async () => {
    await withInstance(async () => {
      const origin = await Session.create({})
      const calls = watchPrompts()

      await addDone(origin.id)
      await RalphLoop.start(origin.id, "ship it", { ultrawork: true })
      SessionStatus.set(origin.id, { type: "idle" })

      const verifyID = await nextSession(origin.id)
      expect(RalphLoop.getStateForSession(verifyID)?.originSessionID).toBe(origin.id)

      expect(await RalphLoop.cancelForSession(verifyID)).toBe(true)
      expect(RalphLoop.getState(origin.id)).toBeNull()
      expect(calls).toEqual([verifyID])
    })
  })
})
