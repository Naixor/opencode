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

test("agent not in config -> not loaded in registry", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const hephaestus = await Agent.get("hephaestus")
      expect(hephaestus).toBeUndefined()
      const agents = await Agent.list()
      const names = agents.map((a) => a.name)
      expect(names).not.toContain("hephaestus")
    },
  })
})

test("agent enabled -> loaded and accessible", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        hephaestus: {
          enabled: true,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const hephaestus = await Agent.get("hephaestus")
      expect(hephaestus).toBeDefined()
      expect(hephaestus?.native).toBe(true)
    },
  })
})

test("Hephaestus has full tool access", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        hephaestus: {
          enabled: true,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("hephaestus")
      expect(agent).toBeDefined()
      expect(evalPerm(agent, "edit")).toBe("allow")
      expect(evalPerm(agent, "bash")).toBe("allow")
      expect(evalPerm(agent, "read")).toBe("allow")
      expect(evalPerm(agent, "grep")).toBe("allow")
      expect(evalPerm(agent, "glob")).toBe("allow")
      expect(agent?.mode).toBe("subagent")
    },
  })
})

test("Prometheus denies write/edit", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        prometheus: {
          enabled: true,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Prometheus replaces plan agent
      const agent = await Agent.get("plan")
      expect(agent).toBeDefined()
      expect(evalPerm(agent, "edit")).toBe("deny")
      // But plan file paths are allowed
      expect(PermissionNext.evaluate("edit", ".opencode/plans/foo.md", agent!.permission).action).toBe("allow")
    },
  })
})

test("Prometheus disabled -> original plan agent used for plan mode", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await Agent.get("plan")
      expect(plan).toBeDefined()
      expect(plan?.description).toBe("Plan mode. Disallows all edit tools.")
      // Original plan agent does not have a prompt set (or at least not the prometheus one)
      expect(plan?.prompt ?? "").not.toContain("Prometheus")
    },
  })
})

test("Prometheus enabled -> Prometheus used for plan mode", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        prometheus: {
          enabled: true,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await Agent.get("plan")
      expect(plan).toBeDefined()
      expect(plan?.prompt).toContain("Prometheus")
      expect(plan?.temperature).toBe(0.1)
      expect(plan?.mode).toBe("primary")
    },
  })
})

test("per-agent model override works", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        hephaestus: {
          enabled: true,
          model: "openai/gpt-4",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("hephaestus")
      expect(agent).toBeDefined()
      expect(agent?.model?.providerID).toBe("openai")
      expect(agent?.model?.modelID).toBe("gpt-4")
    },
  })
})

test("per-agent temperature override works", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        hephaestus: {
          enabled: true,
          temperature: 0.8,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("hephaestus")
      expect(agent).toBeDefined()
      expect(agent?.temperature).toBe(0.8)
    },
  })
})

test("per-agent prompt_append appended to system prompt", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        hephaestus: {
          enabled: true,
          prompt_append: "Always use TypeScript strict mode.",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("hephaestus")
      expect(agent).toBeDefined()
      expect(agent?.prompt).toContain("Hephaestus")
      expect(agent?.prompt).toContain("Always use TypeScript strict mode.")
    },
  })
})
