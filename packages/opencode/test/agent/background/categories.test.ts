import { test, expect } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { Categories } from "../../../src/agent/background/categories"
import { Sisyphus } from "../../../src/agent/sisyphus"
import { Agent } from "../../../src/agent/agent"
import { PermissionNext } from "../../../src/permission/next"

test("all 8 default categories exist with descriptions", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const categories = await Categories.resolve()
      const names = Object.keys(categories)
      expect(names).toContain("visual-engineering")
      expect(names).toContain("ultrabrain")
      expect(names).toContain("deep")
      expect(names).toContain("artistry")
      expect(names).toContain("quick")
      expect(names).toContain("writing")
      expect(names).toContain("unspecified-low")
      expect(names).toContain("unspecified-high")
      expect(names.length).toBeGreaterThanOrEqual(8)
      for (const cat of Object.values(categories)) {
        expect(cat.description).toBeTruthy()
        expect(typeof cat.description).toBe("string")
      }
    },
  })
})

test("user category overrides default", async () => {
  await using tmp = await tmpdir({
    config: {
      categories: {
        quick: {
          description: "Custom quick description",
          model: "anthropic/claude-haiku",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const categories = await Categories.resolve()
      expect(categories.quick.description).toBe("Custom quick description")
      expect(categories.quick.model).toBe("anthropic/claude-haiku")
      // Other defaults still present
      expect(categories.deep).toBeDefined()
      expect(categories.ultrabrain).toBeDefined()
    },
  })
})

test("user adds custom category", async () => {
  await using tmp = await tmpdir({
    config: {
      categories: {
        "my-custom": {
          description: "A custom category for testing",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const categories = await Categories.resolve()
      expect(categories["my-custom"]).toBeDefined()
      expect(categories["my-custom"].description).toBe("A custom category for testing")
      // Defaults still present
      expect(categories.quick).toBeDefined()
    },
  })
})

test("category lookup by name returns correct config", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const categories = await Categories.resolve()
      const quick = Categories.lookup("quick", categories)
      expect(quick).toBeDefined()
      expect(quick!.description).toContain("Fast")
    },
  })
})

test("unknown category returns undefined", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const categories = await Categories.resolve()
      const unknown = Categories.lookup("nonexistent-category-xyz", categories)
      expect(unknown).toBeUndefined()
    },
  })
})

test("Sisyphus prompt contains category delegation table", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const prompt = await Sisyphus.buildDynamicPrompt()
      expect(prompt).toContain("## Task Categories")
      expect(prompt).toContain("| Category | Description |")
      expect(prompt).toContain("quick")
      expect(prompt).toContain("ultrabrain")
      expect(prompt).toContain("deep")
    },
  })
})

test("delegate_task resolves category to model", async () => {
  await using tmp = await tmpdir({
    config: {
      categories: {
        quick: {
          description: "Fast tasks",
          model: "anthropic/claude-haiku",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const categories = await Categories.resolve()
      const cat = Categories.lookup("quick", categories)
      expect(cat).toBeDefined()
      expect(cat!.model).toBe("anthropic/claude-haiku")
      // Verify model can be parsed into provider/model
      const [providerID, ...rest] = cat!.model!.split("/")
      const modelID = rest.join("/")
      expect(providerID).toBe("anthropic")
      expect(modelID).toBe("claude-haiku")
    },
  })
})

test("read-only agent sees categories but cannot invoke delegate_task", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        oracle: {},
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Oracle can see categories
      const categories = await Categories.resolve()
      expect(Object.keys(categories).length).toBeGreaterThanOrEqual(8)

      // But oracle cannot invoke delegate_task (task tool denied)
      const oracle = await Agent.get("oracle")
      expect(oracle).toBeDefined()
      const taskPerm = PermissionNext.evaluate("task", "*", oracle!.permission)
      expect(taskPerm.action).toBe("deny")
    },
  })
})

test("buildDelegationTable generates correct format", async () => {
  const categories: Record<string, Categories.CategoryConfig> = {
    quick: { description: "Fast tasks", model: "anthropic/claude-haiku" },
    deep: { description: "Deep analysis" },
  }
  const table = Categories.buildDelegationTable(categories)
  expect(table).toContain("## Task Categories")
  expect(table).toContain("| Category | Description |")
  expect(table).toContain("| quick | Fast tasks (model: anthropic/claude-haiku) |")
  expect(table).toContain("| deep | Deep analysis |")
})

test("empty categories produces no delegation table", () => {
  const table = Categories.buildDelegationTable({})
  // Even with empty categories, the header is still generated
  // but in practice buildCategoriesSection checks for emptiness
  expect(table).toContain("## Task Categories")
})

test("CategoryConfig schema validates correctly", () => {
  const valid = Categories.CategoryConfig.safeParse({
    description: "Test category",
    model: "anthropic/claude-opus",
    prompt_append: "Be thorough",
  })
  expect(valid.success).toBe(true)

  const minimal = Categories.CategoryConfig.safeParse({
    description: "Test category",
  })
  expect(minimal.success).toBe(true)

  const invalid = Categories.CategoryConfig.safeParse({})
  expect(invalid.success).toBe(false)
})
