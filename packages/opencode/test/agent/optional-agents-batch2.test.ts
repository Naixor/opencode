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

test("Atlas denies task and delegate_task", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        atlas: {
          enabled: true,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("atlas")
      expect(agent).toBeDefined()
      expect(evalPerm(agent, "task")).toBe("deny")
      expect(evalPerm(agent, "delegate_task")).toBe("deny")
      // Atlas allows edit, read, grep etc (analysis-focused, not read-only)
      expect(evalPerm(agent, "edit")).toBe("allow")
      expect(evalPerm(agent, "read")).toBe("allow")
      expect(evalPerm(agent, "grep")).toBe("allow")
      expect(evalPerm(agent, "glob")).toBe("allow")
    },
  })
})

test("Librarian denies write, edit, task, delegate_task", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        librarian: {
          enabled: true,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("librarian")
      expect(agent).toBeDefined()
      expect(evalPerm(agent, "write")).toBe("deny")
      expect(evalPerm(agent, "edit")).toBe("deny")
      expect(evalPerm(agent, "task")).toBe("deny")
      expect(evalPerm(agent, "delegate_task")).toBe("deny")
      // Librarian allows read tools
      expect(evalPerm(agent, "read")).toBe("allow")
      expect(evalPerm(agent, "grep")).toBe("allow")
      expect(evalPerm(agent, "glob")).toBe("allow")
      expect(evalPerm(agent, "lsp")).toBe("allow")
    },
  })
})

test("Metis denies write, edit, task, delegate_task", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        metis: {
          enabled: true,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("metis")
      expect(agent).toBeDefined()
      expect(evalPerm(agent, "write")).toBe("deny")
      expect(evalPerm(agent, "edit")).toBe("deny")
      expect(evalPerm(agent, "task")).toBe("deny")
      expect(evalPerm(agent, "delegate_task")).toBe("deny")
      // Metis allows read tools
      expect(evalPerm(agent, "read")).toBe("allow")
      expect(evalPerm(agent, "grep")).toBe("allow")
      expect(evalPerm(agent, "glob")).toBe("allow")
      expect(evalPerm(agent, "lsp")).toBe("allow")
    },
  })
})

test("disabled agent not listed in Sisyphus delegation table", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // By default, optional agents are disabled
      const atlas = await Agent.get("atlas")
      expect(atlas).toBeUndefined()
      const prompt = await Sisyphus.buildDynamicPrompt()
      expect(prompt).not.toContain("| atlas |")
      expect(prompt).not.toContain("| librarian |")
      expect(prompt).not.toContain("| metis |")
    },
  })
})

test("enabled agent appears in Sisyphus delegation table", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        atlas: { enabled: true },
        librarian: { enabled: true },
        metis: { enabled: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const prompt = await Sisyphus.buildDynamicPrompt()
      expect(prompt).toContain("atlas")
      expect(prompt).toContain("librarian")
      expect(prompt).toContain("metis")
      expect(prompt).toContain("## Available Agents")
    },
  })
})
