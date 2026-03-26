import { describe, test, expect } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { load, sections, injectSections } from "../../src/memory/prompt/loader"
import { render } from "../../src/memory/prompt/template"

describe("prompt integration", () => {
  describe("override/fallback chain", () => {
    test("custom recall.md overrides default", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const memdir = path.join(dir, "memory")
          await fs.mkdir(memdir, { recursive: true })
          await Bun.write(path.join(memdir, "recall.md"), "Custom recall: filter by project context only")
        },
      })

      const result = await load("recall", [tmp.path])
      expect(result).toBe("Custom recall: filter by project context only")
    })

    test("custom extract.md with CONVERSATION marker renders correctly", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const memdir = path.join(dir, "memory")
          await fs.mkdir(memdir, { recursive: true })
          await Bun.write(
            path.join(memdir, "extract.md"),
            [
              "# System",
              "",
              "Custom extraction system prompt",
              "",
              "# Analysis",
              "",
              "Extract from this conversation:",
              "<!-- INJECT:CONVERSATION -->",
            ].join("\n"),
          )
        },
      })

      const tpl = await load("extract", [tmp.path])
      const parts = sections(tpl)

      expect(parts.system).toBe("Custom extraction system prompt")
      expect(parts.analysis).toContain("<!-- INJECT:CONVERSATION -->")

      const rendered = render(parts.analysis, { CONVERSATION: "[user]: hello\n---\n[assistant]: hi" })
      expect(rendered).toContain("[user]: hello")
      expect(rendered).not.toContain("INJECT:CONVERSATION")
    })

    test("custom inject.md with MEMORY_ITEMS marker renders correctly", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const memdir = path.join(dir, "memory")
          await fs.mkdir(memdir, { recursive: true })
          await Bun.write(
            path.join(memdir, "inject.md"),
            [
              "# Memory Injection",
              "",
              "<custom-memory>",
              "<!-- INJECT:MEMORY_ITEMS -->",
              "</custom-memory>",
              "",
              "# Conflict Warning",
              "",
              "<custom-conflicts>",
              "<!-- INJECT:CONFLICT_ITEMS -->",
              "</custom-conflicts>",
            ].join("\n"),
          )
        },
      })

      const tpl = await load("inject", [tmp.path])
      const parts = injectSections(tpl)

      const items = "- [tool] Use Hono (framework)\n- [style] No semicolons"
      const rendered = render(parts.injection, { MEMORY_ITEMS: items })
      expect(rendered).toContain("<custom-memory>")
      expect(rendered).toContain("Use Hono")
      expect(rendered).toContain("No semicolons")

      const conflicts = "- Conflict between [a] and [b]: style mismatch"
      const conflictRendered = render(parts.conflict, { CONFLICT_ITEMS: conflicts })
      expect(conflictRendered).toContain("<custom-conflicts>")
      expect(conflictRendered).toContain("style mismatch")
    })

    test("fallback to default when no user file", async () => {
      const result = await load("recall", [])
      expect(result).toContain("memory-recall agent")
    })

    test("project-level overrides global-level", async () => {
      await using global = await tmpdir({
        init: async (dir) => {
          const memdir = path.join(dir, "memory")
          await fs.mkdir(memdir, { recursive: true })
          await Bun.write(path.join(memdir, "recall.md"), "global recall")
        },
      })
      await using project = await tmpdir({
        init: async (dir) => {
          const memdir = path.join(dir, "memory")
          await fs.mkdir(memdir, { recursive: true })
          await Bun.write(path.join(memdir, "recall.md"), "project recall")
        },
      })

      const result = await load("recall", [global.path, project.path])
      expect(result).toBe("project recall")
    })

    test("empty custom file falls back to default", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const memdir = path.join(dir, "memory")
          await fs.mkdir(memdir, { recursive: true })
          await Bun.write(path.join(memdir, "recall.md"), "")
        },
      })

      const result = await load("recall", [tmp.path])
      expect(result).toContain("memory-recall agent")
    })

    test("extract.md missing System heading falls back per-section", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const memdir = path.join(dir, "memory")
          await fs.mkdir(memdir, { recursive: true })
          await Bun.write(
            path.join(memdir, "extract.md"),
            ["# Analysis", "", "Custom analysis only", "<!-- INJECT:CONVERSATION -->"].join("\n"),
          )
        },
      })

      const tpl = await load("extract", [tmp.path])
      const parts = sections(tpl)

      // System should fallback to default
      expect(parts.system).toContain("memory extraction assistant")
      // Analysis should use custom content
      expect(parts.analysis).toContain("Custom analysis only")
    })

    test("extract.md missing Analysis heading falls back per-section", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const memdir = path.join(dir, "memory")
          await fs.mkdir(memdir, { recursive: true })
          await Bun.write(path.join(memdir, "extract.md"), ["# System", "", "Custom system only"].join("\n"))
        },
      })

      const tpl = await load("extract", [tmp.path])
      const parts = sections(tpl)

      // System should use custom content
      expect(parts.system).toBe("Custom system only")
      // Analysis should fallback to default
      expect(parts.analysis).toContain("Analyze the following")
    })
  })

  describe("template variable rendering end-to-end", () => {
    test("CONVERSATION variable with real message format", () => {
      const messages = [
        { role: "user", content: "We use Hono" },
        { role: "assistant", content: "Noted" },
      ]
      const formatted = messages.map((m) => `[${m.role}]: ${m.content}`).join("\n---\n")

      const tpl = "Analyze:\n<!-- INJECT:CONVERSATION -->\nEnd."
      const result = render(tpl, { CONVERSATION: formatted })
      expect(result).toContain("[user]: We use Hono")
      expect(result).toContain("[assistant]: Noted")
      expect(result).toContain("Analyze:")
      expect(result).toContain("End.")
    })

    test("MEMORY_ITEMS variable with real memory format", () => {
      const items = [
        "- [tool] Use Hono framework (framework, performance)",
        "- [style] No semicolons (code-style)",
      ].join("\n")

      const tpl = "<memory>\n<!-- INJECT:MEMORY_ITEMS -->\n</memory>"
      const result = render(tpl, { MEMORY_ITEMS: items })
      expect(result).toContain("Use Hono framework")
      expect(result).toContain("No semicolons")
      expect(result).toContain("<memory>")
    })
  })
})
