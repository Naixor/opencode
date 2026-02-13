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

test("Sisyphus returned as default agent when none specified", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.defaultAgent()
      expect(agent).toBe("sisyphus")
    },
  })
})

test("build agent still accessible by explicit name", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      expect(build?.mode).toBe("primary")
      expect(build?.native).toBe(true)
      expect(evalPerm(build, "edit")).toBe("allow")
      expect(evalPerm(build, "bash")).toBe("allow")
    },
  })
})

test("Sisyphus has unrestricted tool access", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sisyphus = await Agent.get("sisyphus")
      expect(sisyphus).toBeDefined()
      expect(evalPerm(sisyphus, "edit")).toBe("allow")
      expect(evalPerm(sisyphus, "bash")).toBe("allow")
      expect(evalPerm(sisyphus, "read")).toBe("allow")
      expect(evalPerm(sisyphus, "grep")).toBe("allow")
      expect(evalPerm(sisyphus, "glob")).toBe("allow")
      expect(evalPerm(sisyphus, "question")).toBe("allow")
    },
  })
})

test("Sisyphus temperature is 0.1", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sisyphus = await Agent.get("sisyphus")
      expect(sisyphus).toBeDefined()
      expect(sisyphus?.temperature).toBe(0.1)
    },
  })
})

test("Sisyphus respects PermissionNext rules", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        sisyphus: {
          permission: {
            bash: {
              "rm -rf *": "deny",
            },
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sisyphus = await Agent.get("sisyphus")
      expect(sisyphus).toBeDefined()
      expect(PermissionNext.evaluate("bash", "rm -rf *", sisyphus!.permission).action).toBe("deny")
      expect(evalPerm(sisyphus, "edit")).toBe("allow")
    },
  })
})

test("Sisyphus agent definition validates against Agent schema", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sisyphus = await Agent.get("sisyphus")
      expect(sisyphus).toBeDefined()
      const result = Agent.Info.safeParse(sisyphus)
      expect(result.success).toBe(true)
    },
  })
})

test("dynamic prompt contains agents table when agents exist", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const prompt = await Sisyphus.buildDynamicPrompt()
      expect(prompt).toContain("## Available Agents")
      expect(prompt).toContain("| Agent | Description | Mode |")
      expect(prompt).toContain("explore")
      expect(prompt).toContain("general")
    },
  })
})

test("dynamic prompt contains skills when available", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = `${dir}/.opencode/skill/test-skill`
      await Bun.write(
        `${skillDir}/SKILL.md`,
        `---
name: test-skill
description: A test skill for unit testing
---

# Test Skill
Do the test thing.
`,
      )
    },
  })
  const home = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const prompt = await Sisyphus.buildDynamicPrompt()
        expect(prompt).toContain("## Available Skills")
        expect(prompt).toContain("test-skill")
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = home
  }
})

test("dynamic prompt contains base sisyphus prompt", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const prompt = await Sisyphus.buildDynamicPrompt()
      expect(prompt).toContain("You are Sisyphus")
      expect(prompt).toContain("Task Discipline")
      expect(prompt).toContain("Delegation Guide")
    },
  })
})

test("Sisyphus is primary mode", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sisyphus = await Agent.get("sisyphus")
      expect(sisyphus?.mode).toBe("primary")
    },
  })
})
