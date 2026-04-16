import { expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Skill } from "../../src/skill"

const root = path.join(__dirname, "../../../..")

test("project TUI renderable review skill is discoverable", async () => {
  await Instance.provide({
    directory: root,
    fn: async () => {
      const skill = await Skill.get("tui-renderable-review")

      expect(skill).toBeDefined()
      expect(skill!.agent).toEqual(["momus"])
      expect(skill!.location).toContain(path.join(".opencode", "skills", "tui-renderable-review", "SKILL.md"))
      expect(skill!.content).toContain("packages/opencode/src/cli/cmd/tui/**/*.tsx")
    },
  })
})
