import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Identifier } from "../../src/id/id"
import { TaskTool } from "../../src/tool/task"
import { RalphLoop } from "../../src/session/hooks/ralph-loop"

const spies: Array<ReturnType<typeof spyOn>> = []

afterEach(() => {
  for (const spy of spies) spy.mockRestore()
  spies.length = 0
})

async function withInstance(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true, config: {} })
  await Instance.provide({
    directory: tmp.path,
    fn,
  })
}

async function addAssistant(sessionID: string) {
  const parentID = Identifier.ascending("message")
  const id = Identifier.ascending("message")
  await Session.updateMessage({
    id: parentID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5.2" },
  })
  await Session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    parentID,
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
  return id
}

describe("TaskTool", () => {
  test("binds oracle subagent sessions to ultrawork verification", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const messageID = await addAssistant(parent.id)
      const tool = await TaskTool.init()
      let bound: { parentID: string; childID: string } | undefined

      spies.push(
        spyOn(SessionPrompt, "prompt").mockResolvedValue({
          parts: [
            {
              type: "text",
              text: "ok",
            },
          ],
        } as Awaited<ReturnType<typeof SessionPrompt.prompt>>),
      )
      spies.push(
        spyOn(RalphLoop, "setVerificationSession").mockImplementation((parentID, childID) => {
          bound = { parentID, childID }
        }),
      )

      await tool.execute(
        {
          description: "Oracle verify completion",
          prompt: "Verify completion",
          subagent_type: "oracle",
          category: "ultrabrain",
        },
        {
          sessionID: parent.id,
          messageID,
          callID: "call_1",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        },
      )

      expect(bound?.parentID).toBe(parent.id)
      expect(bound?.childID).toBeTruthy()
    })
  })
})
