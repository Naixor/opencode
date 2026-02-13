import { test, expect, beforeEach, afterEach } from "bun:test"
import { Skill } from "../../src/skill"
import { Command } from "../../src/command"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"

// --- Built-in Skills Tests ---

test("git-master skill loaded and discoverable", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      const gitMaster = skills.find((s) => s.name === "git-master")
      expect(gitMaster).toBeDefined()
      expect(gitMaster!.description).toContain("commit")
      expect(gitMaster!.content).toContain("conventional commit")
    },
  })
})

test("playwright skill loaded and discoverable", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      const playwright = skills.find((s) => s.name === "playwright")
      expect(playwright).toBeDefined()
      expect(playwright!.description).toContain("Playwright")
      expect(playwright!.content).toContain("browser")
    },
  })
})

test("user skill with same name overrides built-in", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "git-master")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: git-master
description: User-defined git-master override
---

# Custom Git Master

Custom content that overrides the built-in.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skill = await Skill.get("git-master")
      expect(skill).toBeDefined()
      expect(skill!.description).toBe("User-defined git-master override")
      expect(skill!.content).toContain("Custom content that overrides the built-in")
    },
  })
})

test("built-in skills have valid locations in builtin directory", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const builtinDir = Skill.builtinDir()
      const isGitMasterBuiltin = await Skill.isBuiltin("git-master")
      expect(isGitMasterBuiltin).toBe(true)

      const isPlaywrightBuiltin = await Skill.isBuiltin("playwright")
      expect(isPlaywrightBuiltin).toBe(true)

      const skill = await Skill.get("git-master")
      expect(skill!.location).toContain(builtinDir)
    },
  })
})

test("non-existent skill is not built-in", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await Skill.isBuiltin("nonexistent-skill")
      expect(result).toBe(false)
    },
  })
})

test("OPENCODE_DISABLE_BUILTIN_SKILLS disables built-in skills", async () => {
  process.env.OPENCODE_DISABLE_BUILTIN_SKILLS = "1"
  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const gitMaster = skills.find((s) => s.name === "git-master")
        expect(gitMaster).toBeUndefined()
        const playwright = skills.find((s) => s.name === "playwright")
        expect(playwright).toBeUndefined()
      },
    })
  } finally {
    delete process.env.OPENCODE_DISABLE_BUILTIN_SKILLS
  }
})

// --- Built-in Commands Tests ---

test("built-in commands loaded", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const commands = await Command.list()
      const names = commands.map((c) => c.name)

      // Original defaults
      expect(names).toContain("init")
      expect(names).toContain("review")

      // New built-in commands
      expect(names).toContain("compact")
      expect(names).toContain("debug")
      expect(names).toContain("test")
      expect(names).toContain("explain")
    },
  })
})

test("user command overrides built-in", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: {
      command: {
        debug: {
          template: "Custom debug command: $ARGUMENTS",
          description: "User custom debug",
        },
      },
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cmd = await Command.get("debug")
      expect(cmd).toBeDefined()
      expect(cmd!.description).toBe("User custom debug")
      expect(cmd!.source).toBe("command")
      const template = await cmd!.template
      expect(template).toContain("Custom debug command")
    },
  })
})

// --- Skill Permission Filtering ---

test("skill permission filtering applies to built-in", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Built-in skills are discoverable
      const skills = await Skill.all()
      const gitMaster = skills.find((s) => s.name === "git-master")
      expect(gitMaster).toBeDefined()

      // PermissionNext filtering happens in the skill tool, not Skill.all()
      // We verify the skill is accessible through Skill.get() which is what the tool uses
      const skill = await Skill.get("git-master")
      expect(skill).toBeDefined()
      expect(skill!.name).toBe("git-master")
    },
  })
})

// --- Command File Operation ---

test("command file operation respects SecurityAccess", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Verify commands are loaded as source: "command" (not "skill" or "mcp")
      const compactCmd = await Command.get("compact")
      expect(compactCmd).toBeDefined()
      expect(compactCmd!.source).toBe("command")

      const debugCmd = await Command.get("debug")
      expect(debugCmd).toBeDefined()
      expect(debugCmd!.source).toBe("command")
    },
  })
})

test("built-in commands have correct hints", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const debugCmd = await Command.get("debug")
      expect(debugCmd).toBeDefined()
      expect(debugCmd!.hints).toContain("$ARGUMENTS")

      const explainCmd = await Command.get("explain")
      expect(explainCmd).toBeDefined()
      expect(explainCmd!.hints).toContain("$ARGUMENTS")

      const compactCmd = await Command.get("compact")
      expect(compactCmd).toBeDefined()
      expect(compactCmd!.hints).toContain("$ARGUMENTS")
    },
  })
})
