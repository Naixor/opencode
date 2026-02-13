import { test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Sisyphus } from "../../src/agent/sisyphus"
import { PermissionNext } from "../../src/permission/next"

function evalPerm(agent: Agent.Info | undefined, permission: string): PermissionNext.Action | undefined {
  if (!agent) return undefined
  return PermissionNext.evaluate(permission, "*", agent.permission).action
}

test("Momus denies write, edit, task, delegate_task", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        momus: {
          enabled: true,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("momus")
      expect(agent).toBeDefined()
      expect(evalPerm(agent, "write")).toBe("deny")
      expect(evalPerm(agent, "edit")).toBe("deny")
      expect(evalPerm(agent, "task")).toBe("deny")
      expect(evalPerm(agent, "delegate_task")).toBe("deny")
      // Momus allows read tools
      expect(evalPerm(agent, "read")).toBe("allow")
      expect(evalPerm(agent, "grep")).toBe("allow")
      expect(evalPerm(agent, "glob")).toBe("allow")
      expect(evalPerm(agent, "lsp")).toBe("allow")
    },
  })
})

test("Multimodal-Looker only allows read tool", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        "multimodal-looker": {
          enabled: true,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("multimodal-looker")
      expect(agent).toBeDefined()
      // Only read is allowed
      expect(evalPerm(agent, "read")).toBe("allow")
      // Everything else denied
      expect(evalPerm(agent, "write")).toBe("deny")
      expect(evalPerm(agent, "edit")).toBe("deny")
      expect(evalPerm(agent, "task")).toBe("deny")
      expect(evalPerm(agent, "delegate_task")).toBe("deny")
      expect(evalPerm(agent, "grep")).toBe("deny")
      expect(evalPerm(agent, "glob")).toBe("deny")
      expect(evalPerm(agent, "bash")).toBe("deny")
    },
  })
})

test("Sisyphus-Junior denies task tool (recursion prevention)", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        "sisyphus-junior": {
          enabled: true,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("sisyphus-junior")
      expect(agent).toBeDefined()
      expect(evalPerm(agent, "task")).toBe("deny")
      // Sisyphus-Junior allows most tools except task
      expect(evalPerm(agent, "read")).toBe("allow")
      expect(evalPerm(agent, "edit")).toBe("allow")
      expect(evalPerm(agent, "grep")).toBe("allow")
      expect(evalPerm(agent, "glob")).toBe("allow")
      expect(evalPerm(agent, "bash")).toBe("allow")
      expect(evalPerm(agent, "question")).toBe("allow")
    },
  })
})

test("disabled agents not listed in delegation table", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // By default, optional agents are disabled
      const momus = await Agent.get("momus")
      expect(momus).toBeUndefined()
      const looker = await Agent.get("multimodal-looker")
      expect(looker).toBeUndefined()
      const junior = await Agent.get("sisyphus-junior")
      expect(junior).toBeUndefined()
      const prompt = await Sisyphus.buildDynamicPrompt()
      expect(prompt).not.toContain("| momus |")
      expect(prompt).not.toContain("| multimodal-looker |")
      expect(prompt).not.toContain("| sisyphus-junior |")
    },
  })
})

test("enabled agents appear in delegation table", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        momus: { enabled: true },
        "multimodal-looker": { enabled: true },
        "sisyphus-junior": { enabled: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const prompt = await Sisyphus.buildDynamicPrompt()
      expect(prompt).toContain("momus")
      expect(prompt).toContain("multimodal-looker")
      expect(prompt).toContain("sisyphus-junior")
      expect(prompt).toContain("## Available Agents")
    },
  })
})
