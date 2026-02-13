import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"
import {
  parseBaseline,
  readBaseline,
  writeBaseline,
  generateDiff,
  type Baseline,
} from "../../../../script/omo-diff"

const BASELINE_PATH = path.resolve(import.meta.dir, "../../../../packages/opencode/.omo-baseline.json")

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omo-baseline-test-"))
}

describe("omo-baseline.json", () => {
  describe("baseline file schema validation", () => {
    test("actual .omo-baseline.json exists and parses correctly", () => {
      expect(fs.existsSync(BASELINE_PATH)).toBe(true)
      const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"))
      const baseline = parseBaseline(raw)

      expect(typeof baseline.version).toBe("string")
      expect(baseline.version.length).toBeGreaterThan(0)
      expect(typeof baseline.date).toBe("string")
      expect(baseline.date.length).toBeGreaterThan(0)
      expect(typeof baseline.tools).toBe("object")
      expect(typeof baseline.hooks).toBe("object")
      expect(typeof baseline.agents).toBe("object")
      expect(typeof baseline.notes).toBe("string")
    })

    test("baseline tools have valid status values", () => {
      const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"))
      const baseline = parseBaseline(raw)
      const validStatuses = ["internalized", "skipped", "partial"]

      for (const [name, status] of Object.entries(baseline.tools)) {
        expect(validStatuses).toContain(status)
      }
      expect(Object.keys(baseline.tools).length).toBeGreaterThan(0)
    })

    test("baseline hooks have valid status values", () => {
      const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"))
      const baseline = parseBaseline(raw)
      const validStatuses = ["internalized", "skipped", "partial"]

      for (const [name, status] of Object.entries(baseline.hooks)) {
        expect(validStatuses).toContain(status)
      }
      expect(Object.keys(baseline.hooks).length).toBeGreaterThan(0)
    })

    test("baseline agents have valid status values", () => {
      const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"))
      const baseline = parseBaseline(raw)
      const validStatuses = ["internalized", "optional", "skipped"]

      for (const [name, status] of Object.entries(baseline.agents)) {
        expect(validStatuses).toContain(status)
      }
      expect(Object.keys(baseline.agents).length).toBeGreaterThan(0)
    })

    test("baseline contains expected internalized tools", () => {
      const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"))
      const baseline = parseBaseline(raw)

      expect(baseline.tools["glob"]).toBe("internalized")
      expect(baseline.tools["grep"]).toBe("internalized")
      expect(baseline.tools["ast-grep"]).toBe("internalized")
      expect(baseline.tools["delegate-task"]).toBe("internalized")
      expect(baseline.tools["look-at"]).toBe("internalized")
      expect(baseline.tools["interactive-bash"]).toBe("internalized")
    })

    test("baseline contains expected agents with correct statuses", () => {
      const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"))
      const baseline = parseBaseline(raw)

      expect(baseline.agents["sisyphus"]).toBe("internalized")
      expect(baseline.agents["omo-explore"]).toBe("internalized")
      expect(baseline.agents["oracle"]).toBe("internalized")
      expect(baseline.agents["hephaestus"]).toBe("optional")
      expect(baseline.agents["prometheus"]).toBe("optional")
    })
  })

  describe("diff tool reads baseline", () => {
    test("readBaseline reads the actual baseline file correctly", () => {
      const baseline = readBaseline(BASELINE_PATH)

      expect(baseline.version).toBe("0.0.0")
      expect(baseline.date).toBe("2026-02-14")
      expect(Object.keys(baseline.tools).length).toBeGreaterThan(5)
      expect(Object.keys(baseline.hooks).length).toBeGreaterThan(10)
      expect(Object.keys(baseline.agents).length).toBeGreaterThan(5)
      expect(baseline.notes.length).toBeGreaterThan(0)
    })

    test("generateDiff uses baseline data for categorization", () => {
      const baseline = readBaseline(BASELINE_PATH)
      const scanned = {
        tools: ["glob", "brand-new-tool"],
        hooks: ["edit-error-recovery", "brand-new-hook"],
        agents: ["sisyphus", "brand-new-agent"],
        configFiles: [],
        dependencies: {},
      }
      const report = generateDiff(baseline, scanned, "99.0.0")

      const globChange = report.sections.tools.find((c) => c.name === "glob")
      expect(globChange).toBeDefined()
      expect(globChange!.category).toBe("review needed")

      const newTool = report.sections.tools.find((c) => c.name === "brand-new-tool")
      expect(newTool).toBeDefined()
      expect(newTool!.category).toBe("backport recommended")

      const hookChange = report.sections.hooks.find((c) => c.name === "edit-error-recovery")
      expect(hookChange).toBeDefined()
      expect(hookChange!.category).toBe("review needed")

      const newHook = report.sections.hooks.find((c) => c.name === "brand-new-hook")
      expect(newHook).toBeDefined()
      expect(newHook!.category).toBe("backport recommended")
    })
  })

  describe("diff tool updates baseline", () => {
    test("writeBaseline updates version after comparison", () => {
      const dir = makeTmpDir()
      const tmpBaseline = path.join(dir, ".omo-baseline.json")

      const baseline = readBaseline(BASELINE_PATH)
      expect(baseline.version).toBe("0.0.0")

      baseline.version = "5.0.0"
      baseline.date = "2026-03-01"
      writeBaseline(tmpBaseline, baseline)

      const updated = readBaseline(tmpBaseline)
      expect(updated.version).toBe("5.0.0")
      expect(updated.date).toBe("2026-03-01")
      expect(Object.keys(updated.tools).length).toBe(Object.keys(baseline.tools).length)
      expect(Object.keys(updated.hooks).length).toBe(Object.keys(baseline.hooks).length)
      expect(Object.keys(updated.agents).length).toBe(Object.keys(baseline.agents).length)

      fs.rmSync(dir, { recursive: true, force: true })
    })

    test("update preserves all existing component mappings", () => {
      const dir = makeTmpDir()
      const tmpBaseline = path.join(dir, ".omo-baseline.json")

      const baseline = readBaseline(BASELINE_PATH)
      const originalTools = { ...baseline.tools }
      const originalHooks = { ...baseline.hooks }
      const originalAgents = { ...baseline.agents }

      baseline.version = "10.0.0"
      writeBaseline(tmpBaseline, baseline)

      const updated = readBaseline(tmpBaseline)
      expect(updated.tools).toEqual(originalTools)
      expect(updated.hooks).toEqual(originalHooks)
      expect(updated.agents).toEqual(originalAgents)

      fs.rmSync(dir, { recursive: true, force: true })
    })
  })

  describe("baseline with missing fields", () => {
    test("missing tools/hooks/agents -> defaults applied", () => {
      const baseline = parseBaseline({ version: "1.0.0", date: "2026-01-01" })
      expect(baseline.version).toBe("1.0.0")
      expect(baseline.tools).toEqual({})
      expect(baseline.hooks).toEqual({})
      expect(baseline.agents).toEqual({})
      expect(baseline.notes).toBe("")
    })

    test("missing version -> default 0.0.0", () => {
      const baseline = parseBaseline({ tools: { glob: "internalized" } })
      expect(baseline.version).toBe("0.0.0")
      expect(baseline.tools.glob).toBe("internalized")
    })

    test("read partial baseline file -> defaults applied for missing", () => {
      const dir = makeTmpDir()
      const tmpBaseline = path.join(dir, ".omo-baseline.json")
      fs.writeFileSync(tmpBaseline, JSON.stringify({ version: "2.0.0" }))

      const baseline = readBaseline(tmpBaseline)
      expect(baseline.version).toBe("2.0.0")
      expect(baseline.tools).toEqual({})
      expect(baseline.hooks).toEqual({})
      expect(baseline.agents).toEqual({})
      expect(baseline.notes).toBe("")

      fs.rmSync(dir, { recursive: true, force: true })
    })
  })
})
