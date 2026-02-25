import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { SkillTool } from "../../src/tool/skill"
import { Skill } from "../../src/skill"
import { tmpdir } from "../fixture/fixture"
import { SecurityConfig } from "../../src/security/config"
import { MCP } from "../../src/mcp"
import type { PermissionNext } from "../../src/permission/next"
import type { Tool } from "../../src/tool/tool"
import type { Agent } from "../../src/agent/agent"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
}

function makeAgent(overrides: Partial<Agent.Info> = {}): Agent.Info {
  return {
    name: "sisyphus",
    mode: "primary",
    permission: [],
    options: {},
    ...overrides,
  } as Agent.Info
}

// Mock MCP state
const mockMcpTools: Record<string, unknown> = {}
const mockMcpResources: Record<string, unknown> = {}
const mockMcpPrompts: Record<string, unknown> = {}
const mockMcpStatuses: Record<string, { status: string; error?: string }> = {}

function resetMcpMocks() {
  for (const key of Object.keys(mockMcpTools)) delete mockMcpTools[key]
  for (const key of Object.keys(mockMcpResources)) delete mockMcpResources[key]
  for (const key of Object.keys(mockMcpPrompts)) delete mockMcpPrompts[key]
  for (const key of Object.keys(mockMcpStatuses)) delete mockMcpStatuses[key]
}

const spies: Array<ReturnType<typeof spyOn>> = []

beforeEach(() => {
  resetMcpMocks()
  spies.push(
    spyOn(SecurityConfig, "getMcpPolicy").mockImplementation(() => "trusted"),
    spyOn(MCP, "status").mockImplementation(async () => ({ ...mockMcpStatuses }) as ReturnType<typeof MCP.status>),
    spyOn(MCP, "tools").mockImplementation(async () => ({ ...mockMcpTools }) as ReturnType<typeof MCP.tools>),
    spyOn(MCP, "resources").mockImplementation(async () => ({ ...mockMcpResources }) as ReturnType<typeof MCP.resources>),
    spyOn(MCP, "prompts").mockImplementation(async () => ({ ...mockMcpPrompts }) as ReturnType<typeof MCP.prompts>),
  )
})

afterEach(() => {
  spies.forEach((s) => s.mockRestore())
  spies.length = 0
})

describe("US-027: Enhance Skill tool", () => {
  describe("MCP capabilities listing", () => {
    test("skill with MCP config -> tools/resources/prompts listed", async () => {
      // Set up mock MCP data
      mockMcpStatuses["websearch"] = { status: "connected" }
      mockMcpTools["websearch_search"] = {}
      mockMcpTools["websearch_crawl"] = {}
      mockMcpResources["websearch:docs"] = {}
      mockMcpPrompts["websearch:summarize"] = {}

      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skill", "search-skill")
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: search-skill
description: A search skill with MCP.
mcp:
  - websearch
---

# Search Skill

Use websearch MCP.
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
            const tool = await SkillTool.init({ agent: makeAgent() })
            expect(tool.description).toContain("<mcp_capabilities>")
            expect(tool.description).toContain('<mcp_server name="websearch">')
            expect(tool.description).toContain("<tools>search, crawl</tools>")
            expect(tool.description).toContain("<resources>docs</resources>")
            expect(tool.description).toContain("<prompts>summarize</prompts>")
          },
        })
      } finally {
        process.env.OPENCODE_TEST_HOME = home
      }
    })

    test("skill without MCP -> no MCP section", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skill", "plain-skill")
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: plain-skill
description: A plain skill.
---

# Plain Skill
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
            const tool = await SkillTool.init({ agent: makeAgent() })
            expect(tool.description).not.toContain("<mcp_capabilities>")
            expect(tool.description).toContain("plain-skill")
          },
        })
      } finally {
        process.env.OPENCODE_TEST_HOME = home
      }
    })
  })

  describe("lazy content loading", () => {
    test("large skill -> content not read until invoked", async () => {
      // Create a large content string (>50KB)
      const largeContent = "x".repeat(60_000)

      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skill", "large-skill")
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: large-skill
description: A large skill.
---

${largeContent}
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
            // After loading, skill should be lazy (content = "")
            const skills = await Skill.all()
            const skill = skills.find((s) => s.name === "large-skill")
            expect(skill).toBeDefined()
            expect(skill!.content).toBe("")
            expect(Skill.isLazy("large-skill")).toBe(true)

            // After get(), content should be loaded
            const loaded = await Skill.get("large-skill")
            expect(loaded).toBeDefined()
            expect(loaded!.content.length).toBeGreaterThan(50_000)
            expect(Skill.isLazy("large-skill")).toBe(false)
          },
        })
      } finally {
        process.env.OPENCODE_TEST_HOME = home
      }
    })

    test("small skill -> content loaded immediately", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skill", "small-skill")
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: small-skill
description: A small skill.
---

Small content.
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
            const skills = await Skill.all()
            const skill = skills.find((s) => s.name === "small-skill")
            expect(skill).toBeDefined()
            expect(skill!.content).toContain("Small content.")
            expect(Skill.isLazy("small-skill")).toBe(false)
          },
        })
      } finally {
        process.env.OPENCODE_TEST_HOME = home
      }
    })
  })

  describe("skill-to-agent restriction", () => {
    test("skill.agent='sisyphus', current='explore' -> denied", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skill", "restricted-skill")
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: restricted-skill
description: A restricted skill.
agent:
  - sisyphus
---

# Restricted Skill
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
            const exploreAgent = makeAgent({ name: "explore" })
            const tool = await SkillTool.init({ agent: exploreAgent })
            // Skill should not appear in description for explore agent
            expect(tool.description).not.toContain("restricted-skill")
          },
        })
      } finally {
        process.env.OPENCODE_TEST_HOME = home
      }
    })

    test("skill.agent='sisyphus', current='sisyphus' -> allowed", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skill", "allowed-skill")
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: allowed-skill
description: An allowed skill.
agent:
  - sisyphus
---

# Allowed Skill
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
            const sisyphusAgent = makeAgent({ name: "sisyphus" })
            const tool = await SkillTool.init({ agent: sisyphusAgent })
            expect(tool.description).toContain("allowed-skill")
          },
        })
      } finally {
        process.env.OPENCODE_TEST_HOME = home
      }
    })

    test("skill without agent restriction -> available to all agents", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skill", "open-skill")
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: open-skill
description: An open skill.
---

# Open Skill
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
            const agent = makeAgent({ name: "random-agent" })
            const tool = await SkillTool.init({ agent })
            expect(tool.description).toContain("open-skill")
          },
        })
      } finally {
        process.env.OPENCODE_TEST_HOME = home
      }
    })
  })

  describe("<skill-instruction> XML extraction", () => {
    test("skill with <skill-instruction> -> only that block returned", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skill", "instruction-skill")
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: instruction-skill
description: Skill with instruction block.
---

Some preamble text that should not be returned.

<skill-instruction>
Only this content should be returned.
It contains the actual instructions.
</skill-instruction>

Some epilogue text that should not be returned.
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
            const tool = await SkillTool.init({ agent: makeAgent() })
            const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
            const ctx: Tool.Context = {
              ...baseCtx,
              ask: async (req) => {
                requests.push(req)
              },
            }
            const result = await tool.execute({ name: "instruction-skill" }, ctx)
            expect(result.output).toContain("Only this content should be returned.")
            expect(result.output).toContain("It contains the actual instructions.")
            expect(result.output).not.toContain("Some preamble text")
            expect(result.output).not.toContain("Some epilogue text")
            expect(result.metadata.hasInstruction).toBe(true)
          },
        })
      } finally {
        process.env.OPENCODE_TEST_HOME = home
      }
    })

    test("skill without <skill-instruction> -> full content returned", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skill", "full-skill")
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: full-skill
description: Full content skill.
---

# Full Skill

All this content should be returned.
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
            const tool = await SkillTool.init({ agent: makeAgent() })
            const ctx: Tool.Context = {
              ...baseCtx,
              ask: async () => {},
            }
            const result = await tool.execute({ name: "full-skill" }, ctx)
            expect(result.output).toContain("All this content should be returned.")
            expect(result.metadata.hasInstruction).toBe(false)
          },
        })
      } finally {
        process.env.OPENCODE_TEST_HOME = home
      }
    })
  })

  describe("PermissionNext filtering", () => {
    test("skill denied by PermissionNext -> not listed", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skill", "denied-skill")
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: denied-skill
description: A denied skill.
---

# Denied Skill
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
            const agent = makeAgent({
              permission: [
                { permission: "skill", pattern: "denied-skill", action: "deny" },
              ],
            })
            const tool = await SkillTool.init({ agent })
            expect(tool.description).not.toContain("denied-skill")
          },
        })
      } finally {
        process.env.OPENCODE_TEST_HOME = home
      }
    })
  })

  describe("Skill.extractInstruction", () => {
    test("extracts instruction block", () => {
      const content = `
Preamble
<skill-instruction>
Important instructions here.
</skill-instruction>
Epilogue
`
      const { instruction, hasBlock } = Skill.extractInstruction(content)
      expect(hasBlock).toBe(true)
      expect(instruction).toBe("Important instructions here.")
    })

    test("returns full content when no block", () => {
      const content = "Just some regular content."
      const { instruction, hasBlock } = Skill.extractInstruction(content)
      expect(hasBlock).toBe(false)
      expect(instruction).toBe(content)
    })
  })

  describe("Skill.Info schema", () => {
    test("mcp field parsed from frontmatter", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skill", "mcp-skill")
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: mcp-skill
description: Skill with MCP.
mcp:
  - websearch
  - context7
---

# MCP Skill
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
            const skill = await Skill.get("mcp-skill")
            expect(skill).toBeDefined()
            expect(skill!.mcp).toEqual(["websearch", "context7"])
          },
        })
      } finally {
        process.env.OPENCODE_TEST_HOME = home
      }
    })

    test("agent field parsed from frontmatter", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skill", "agent-skill")
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: agent-skill
description: Agent-restricted skill.
agent:
  - sisyphus
  - hephaestus
---

# Agent Skill
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
            const skill = await Skill.get("agent-skill")
            expect(skill).toBeDefined()
            expect(skill!.agent).toEqual(["sisyphus", "hephaestus"])
          },
        })
      } finally {
        process.env.OPENCODE_TEST_HOME = home
      }
    })
  })
})
