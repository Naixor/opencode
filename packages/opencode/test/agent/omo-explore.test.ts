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

test("omo-explore denies write, edit, task, delegate_task tools", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("omo-explore")
      expect(agent).toBeDefined()
      expect(evalPerm(agent, "write")).toBe("deny")
      expect(evalPerm(agent, "edit")).toBe("deny")
      expect(evalPerm(agent, "task")).toBe("deny")
      expect(evalPerm(agent, "delegate_task")).toBe("deny")
    },
  })
})

test("omo-explore allows grep, glob, read, lsp, ast_grep_search tools", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("omo-explore")
      expect(agent).toBeDefined()
      expect(evalPerm(agent, "grep")).toBe("allow")
      expect(evalPerm(agent, "glob")).toBe("allow")
      expect(evalPerm(agent, "read")).toBe("allow")
      expect(evalPerm(agent, "lsp")).toBe("allow")
      expect(evalPerm(agent, "ast_grep_search")).toBe("allow")
    },
  })
})

test("omo-explore system prompt contains parallel execution guidance", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("omo-explore")
      expect(agent).toBeDefined()
      expect(agent?.prompt).toContain("parallel")
      expect(agent?.prompt).toContain("3 or more tools simultaneously")
    },
  })
})

test("omo-explore system prompt contains tool strategy priority", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("omo-explore")
      expect(agent).toBeDefined()
      expect(agent?.prompt).toContain("Tool Strategy Priority")
      expect(agent?.prompt).toContain("LSP")
      expect(agent?.prompt).toContain("ast_grep_search")
      expect(agent?.prompt).toContain("grep")
      expect(agent?.prompt).toContain("glob")
    },
  })
})

test("original explore agent unchanged (same prompt, same tools)", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore).toBeDefined()
      expect(explore?.mode).toBe("subagent")
      expect(explore?.prompt).toContain("file search specialist")
      expect(evalPerm(explore, "grep")).toBe("allow")
      expect(evalPerm(explore, "glob")).toBe("allow")
      expect(evalPerm(explore, "read")).toBe("allow")
      expect(evalPerm(explore, "bash")).toBe("allow")
      expect(evalPerm(explore, "edit")).toBe("deny")
      expect(evalPerm(explore, "write")).toBe("deny")
    },
  })
})

test("omo-explore is subagent mode", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("omo-explore")
      expect(agent).toBeDefined()
      expect(agent?.mode).toBe("subagent")
      expect(agent?.native).toBe(true)
    },
  })
})

test("Sisyphus delegation table lists omo-explore", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const prompt = await Sisyphus.buildDynamicPrompt()
      expect(prompt).toContain("omo-explore")
      expect(prompt).toContain("## Available Agents")
    },
  })
})

test("omo-explore agent definition validates against Agent schema", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("omo-explore")
      expect(agent).toBeDefined()
      const result = Agent.Info.safeParse(agent)
      expect(result.success).toBe(true)
    },
  })
})
