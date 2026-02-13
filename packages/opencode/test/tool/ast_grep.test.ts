import { describe, test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"

describe("AstGrepSearchTool", () => {
  test("finds patterns in JavaScript files", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Bun.write(
          path.join(tmp.path, "test.js"),
          `
console.log("hello")
console.log("world")
const x = 1
`.trim(),
        )

        const { findInFiles } = await import("@ast-grep/napi")
        const results: { file: string; text: string }[] = []
        await findInFiles(
          "javascript",
          {
            paths: [tmp.path],
            matcher: { rule: { pattern: "console.log($MSG)" } },
          },
          (_err: any, nodes: any[]) => {
            for (const node of nodes) {
              results.push({ file: node.getRoot().filename(), text: node.text() })
            }
          },
        )

        expect(results.length).toBe(2)
        expect(results[0].text).toContain("console.log")
      },
    })
  })

  test("finds patterns in TypeScript files", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Bun.write(
          path.join(tmp.path, "test.ts"),
          `
function add(a: number, b: number): number {
  return a + b
}
function multiply(x: number, y: number): number {
  return x * y
}
`.trim(),
        )

        const { findInFiles } = await import("@ast-grep/napi")
        const results: string[] = []
        await findInFiles(
          "typescript",
          {
            paths: [tmp.path],
            matcher: { rule: { pattern: "function $NAME($$$): number { $$$ }" } },
          },
          (_err: any, nodes: any[]) => {
            for (const node of nodes) results.push(node.text())
          },
        )

        expect(results.length).toBe(2)
      },
    })
  })
})

describe("AstGrepReplaceTool", () => {
  test("applies transformation in dry-run mode", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = `console.log("hello")\nconsole.log("world")\n`
        await Bun.write(path.join(tmp.path, "test.js"), source)

        const { parse } = await import("@ast-grep/napi")
        const ast = parse("javascript", source)
        const root = ast.root()
        const matches = root.findAll("console.log($MSG)")
        expect(matches.length).toBe(2)

        const edits = matches.map((m: any) => m.replace("logger.info($MSG)"))
        edits.sort((a: any, b: any) => b.startPos - a.startPos)
        const newSource = root.commitEdits(edits)

        expect(newSource).toContain("logger.info")
        expect(newSource).not.toContain("console.log")
      },
    })
  })

  test("applies transformation in live mode (writes files)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "test.js")
        await Bun.write(filePath, `console.log("hello")\n`)

        const { parse } = await import("@ast-grep/napi")
        const source = await Bun.file(filePath).text()
        const ast = parse("javascript", source)
        const root = ast.root()
        const matches = root.findAll("console.log($MSG)")
        const edits = matches.map((m: any) => m.replace("logger.info($MSG)"))
        edits.sort((a: any, b: any) => b.startPos - a.startPos)
        const newSource = root.commitEdits(edits)

        await Bun.write(filePath, newSource)
        const written = await Bun.file(filePath).text()
        expect(written).toContain("logger.info")
      },
    })
  })
})
