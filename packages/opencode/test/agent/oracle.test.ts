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

test("Oracle denies write, edit, task, delegate_task", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("oracle")
      expect(agent).toBeDefined()
      expect(evalPerm(agent, "write")).toBe("deny")
      expect(evalPerm(agent, "edit")).toBe("deny")
      expect(evalPerm(agent, "task")).toBe("deny")
      expect(evalPerm(agent, "delegate_task")).toBe("deny")
    },
  })
})

test("Oracle allows read, grep, glob, lsp", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("oracle")
      expect(agent).toBeDefined()
      expect(evalPerm(agent, "read")).toBe("allow")
      expect(evalPerm(agent, "grep")).toBe("allow")
      expect(evalPerm(agent, "glob")).toBe("allow")
      expect(evalPerm(agent, "lsp")).toBe("allow")
    },
  })
})

test("Oracle temperature is 0.1", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("oracle")
      expect(agent).toBeDefined()
      expect(agent?.temperature).toBe(0.1)
    },
  })
})

test("Oracle prompt contains effort estimation guidance", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("oracle")
      expect(agent).toBeDefined()
      expect(agent?.prompt).toContain("Effort Estimation")
      expect(agent?.prompt).toContain("Quick")
      expect(agent?.prompt).toContain("Short")
      expect(agent?.prompt).toContain("Medium")
      expect(agent?.prompt).toContain("Large")
    },
  })
})

test("Oracle registered as subagent mode", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("oracle")
      expect(agent).toBeDefined()
      expect(agent?.mode).toBe("subagent")
      expect(agent?.native).toBe(true)
    },
  })
})

test("Oracle appears in Sisyphus delegation table", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const prompt = await Sisyphus.buildDynamicPrompt()
      expect(prompt).toContain("oracle")
      expect(prompt).toContain("## Available Agents")
    },
  })
})
