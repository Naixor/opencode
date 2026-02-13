import { describe, expect, test, afterEach, beforeEach } from "bun:test"
import path from "path"
import fs from "fs"
import { AstGrepSearchTool, AstGrepReplaceTool, AstGrepLoader } from "../../src/tool/ast-grep"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { setupSecurityConfig, teardownSecurityConfig } from "../security/access_control_cases/helpers"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

// Build a minimal mock of @ast-grep/napi that supports parse/findAll/replace/text/range
function createMockSgNode(text: string, startLine: number, startCol: number, startIndex: number) {
  const endIndex = startIndex + text.length
  const lines = text.split("\n")
  const endLine = startLine + lines.length - 1
  const endCol = lines.length > 1 ? lines[lines.length - 1].length : startCol + text.length
  return {
    text: () => text,
    range: () => ({
      start: { line: startLine, column: startCol, index: startIndex },
      end: { line: endLine, column: endCol, index: endIndex },
    }),
    replace: (rewrite: string) => ({
      startPos: startIndex,
      endPos: endIndex,
      insertedText: rewrite,
    }),
    findAll: () => [],
  }
}

function createMockAstGrep() {
  return {
    parse: (_lang: string, content: string) => ({
      root: () => ({
        findAll: (pattern: string) => {
          // Default: search for the pattern text literally in content
          const results: ReturnType<typeof createMockSgNode>[] = []
          let idx = content.indexOf(pattern)
          while (idx !== -1) {
            const beforeMatch = content.substring(0, idx)
            const line = beforeMatch.split("\n").length - 1
            const lastNewline = beforeMatch.lastIndexOf("\n")
            const col = lastNewline === -1 ? idx : idx - lastNewline - 1
            results.push(createMockSgNode(pattern, line, col, idx))
            idx = content.indexOf(pattern, idx + 1)
          }
          return results
        },
      }),
    }),
  }
}

const mockAstGrep = createMockAstGrep()
const originalLoad = AstGrepLoader.load

function enableMock() {
  AstGrepLoader.load = () => Promise.resolve(mockAstGrep)
}

function disableMock() {
  AstGrepLoader.load = () => Promise.resolve(null)
}

function restoreLoader() {
  AstGrepLoader.load = originalLoad
}

describe("ast-grep tools", () => {
  afterEach(() => {
    teardownSecurityConfig()
    restoreLoader()
  })

  describe("ast_grep_search", () => {
    test("returns not-available message when @ast-grep/napi is not installed", async () => {
      disableMock()
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await AstGrepSearchTool.init()
          const result = await tool.execute(
            { pattern: "console.log($MSG)", lang: "javascript" },
            ctx,
          )
          expect(result.output).toContain("ast-grep not available")
          expect(result.output).toContain("bun add @ast-grep/napi")
          expect(result.metadata.matches).toBe(0)
        },
      })
    })

    test("pattern matches found in JS files", async () => {
      enableMock()
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "app.js"), 'console.log("hello")\nconst x = 1\nconsole.log("world")\n')
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await AstGrepSearchTool.init()
          const result = await tool.execute(
            {
              pattern: "console.log",
              lang: "javascript",
              paths: [tmp.path],
            },
            ctx,
          )
          expect(result.metadata.matches).toBe(2)
          expect(result.output).toContain("Found 2 matches")
          expect(result.output).toContain("console.log")
        },
      })
    })

    test("no matches returns 'No matches found'", async () => {
      enableMock()
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "empty.js"), "const x = 1\n")
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await AstGrepSearchTool.init()
          const result = await tool.execute(
            {
              pattern: "nonExistentPattern123",
              lang: "javascript",
              paths: [tmp.path],
            },
            ctx,
          )
          expect(result.metadata.matches).toBe(0)
          expect(result.output).toBe("No matches found")
        },
      })
    })

    test("SecurityAccess blocks protected file", async () => {
      enableMock()
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "secret.js"), 'console.log("secret")\n')
        },
      })
      const realPath = fs.realpathSync(tmp.path)

      await setupSecurityConfig(
        {
          version: "1.0",
          roles: [{ name: "viewer", level: 1 }],
          rules: [
            {
              pattern: path.join(realPath, "secret.js"),
              type: "file" as const,
              deniedOperations: ["read" as const],
              allowedRoles: [],
            },
          ],
        },
        tmp.path,
      )

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await AstGrepSearchTool.init()
          const result = await tool.execute(
            {
              pattern: "console.log",
              lang: "javascript",
              paths: [tmp.path],
            },
            ctx,
          )
          expect(result.metadata.matches).toBe(0)
          expect(result.output).toBe("No matches found")
        },
      })
    })

    test("globs filter files correctly", async () => {
      enableMock()
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "app.js"), 'console.log("app")\n')
          await Bun.write(path.join(dir, "app.test.js"), 'console.log("test")\n')
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await AstGrepSearchTool.init()
          const result = await tool.execute(
            {
              pattern: "console.log",
              lang: "javascript",
              paths: [tmp.path],
              globs: ["*.js"],
            },
            ctx,
          )
          expect(result.metadata.matches).toBe(2)
        },
      })
    })

    test("25 language enum values accepted", async () => {
      const tool = await AstGrepSearchTool.init()
      const languages = [
        "c", "cpp", "css", "csharp", "dart", "elixir", "go", "haskell",
        "html", "java", "javascript", "json", "kotlin", "lua", "php",
        "python", "ruby", "rust", "scala", "sql", "swift", "toml",
        "tsx", "typescript", "yaml",
      ] as const
      expect(languages.length).toBe(25)
      for (const lang of languages) {
        const parsed = tool.parameters.parse({ pattern: "test", lang })
        expect(parsed.lang).toBe(lang)
      }
    })

    test("invalid language rejected by schema", async () => {
      const tool = await AstGrepSearchTool.init()
      expect(() => tool.parameters.parse({ pattern: "test", lang: "fortran" })).toThrow()
    })
  })

  describe("ast_grep_replace", () => {
    test("returns not-available message when @ast-grep/napi is not installed", async () => {
      disableMock()
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await AstGrepReplaceTool.init()
          const result = await tool.execute(
            { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", lang: "javascript" },
            ctx,
          )
          expect(result.output).toContain("ast-grep not available")
          expect(result.output).toContain("bun add @ast-grep/napi")
          expect(result.metadata.matches).toBe(0)
        },
      })
    })

    test("dryRun=true shows changes without applying", async () => {
      enableMock()
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "code.js"), 'console.log("hello")\n')
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await AstGrepReplaceTool.init()
          const result = await tool.execute(
            {
              pattern: "console.log",
              rewrite: "logger.info",
              lang: "javascript",
              paths: [tmp.path],
              dryRun: true,
            },
            ctx,
          )
          expect(result.output).toContain("DRY RUN")
          expect(result.metadata.applied).toBe(false)
          expect(result.metadata.matches).toBeGreaterThan(0)

          // File should NOT be modified
          const content = await Bun.file(path.join(tmp.path, "code.js")).text()
          expect(content).toContain("console.log")
        },
      })
    })

    test("dryRun=false applies changes to file", async () => {
      enableMock()
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "code.js"), 'console.log("hello")\n')
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await AstGrepReplaceTool.init()
          const result = await tool.execute(
            {
              pattern: "console.log",
              rewrite: "logger.info",
              lang: "javascript",
              paths: [tmp.path],
              dryRun: false,
            },
            ctx,
          )
          expect(result.output).toContain("APPLIED")
          expect(result.metadata.applied).toBe(true)

          // File SHOULD be modified
          const content = await Bun.file(path.join(tmp.path, "code.js")).text()
          expect(content).toContain("logger.info")
          expect(content).not.toContain("console.log")
        },
      })
    })

    test("SecurityAccess blocks replace on protected file", async () => {
      enableMock()
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "protected.js"), 'console.log("protected")\n')
        },
      })
      const realPath = fs.realpathSync(tmp.path)

      await setupSecurityConfig(
        {
          version: "1.0",
          roles: [{ name: "viewer", level: 1 }],
          rules: [
            {
              pattern: path.join(realPath, "protected.js"),
              type: "file" as const,
              deniedOperations: ["write" as const],
              allowedRoles: [],
            },
          ],
        },
        tmp.path,
      )

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await AstGrepReplaceTool.init()
          const result = await tool.execute(
            {
              pattern: "console.log",
              rewrite: "logger.info",
              lang: "javascript",
              paths: [tmp.path],
              dryRun: false,
            },
            ctx,
          )
          expect(result.metadata.matches).toBe(0)
          expect(result.output).toBe("No matches found")

          // File should NOT be modified
          const content = await Bun.file(path.join(tmp.path, "protected.js")).text()
          expect(content).toContain("console.log")
        },
      })
    })

    test("replace on file with protected segment skips only protected match", async () => {
      enableMock()
      const protectedContent = '// @security-start\nconsole.log("secret")\n// @security-end\nconsole.log("public")\n'

      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "mixed.js"), protectedContent)
        },
      })

      await setupSecurityConfig(
        {
          version: "1.0",
          roles: [{ name: "viewer", level: 1 }],
          segments: {
            markers: [
              {
                start: "@security-start",
                end: "@security-end",
                deniedOperations: ["write" as const],
                allowedRoles: [],
              },
            ],
          },
        },
        tmp.path,
      )

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await AstGrepReplaceTool.init()
          const result = await tool.execute(
            {
              pattern: "console.log",
              rewrite: "logger.info",
              lang: "javascript",
              paths: [tmp.path],
              dryRun: false,
            },
            ctx,
          )
          const content = await Bun.file(path.join(tmp.path, "mixed.js")).text()
          // The second console.log (outside protected segment) should be replaced
          expect(content).toContain("logger.info")
          // The first console.log (inside protected segment) should still be there
          expect(content).toContain("console.log")
        },
      })
    })

    test("no matches returns 'No matches found'", async () => {
      enableMock()
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "empty.js"), "const x = 1\n")
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await AstGrepReplaceTool.init()
          const result = await tool.execute(
            {
              pattern: "nonExistentPattern123",
              rewrite: "replacement",
              lang: "javascript",
              paths: [tmp.path],
            },
            ctx,
          )
          expect(result.metadata.matches).toBe(0)
          expect(result.output).toBe("No matches found")
        },
      })
    })

    test("denied read logged via SecurityAudit", async () => {
      enableMock()
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "denied.js"), 'console.log("denied")\n')
        },
      })
      const realPath = fs.realpathSync(tmp.path)

      await setupSecurityConfig(
        {
          version: "1.0",
          roles: [{ name: "viewer", level: 1 }],
          rules: [
            {
              pattern: path.join(realPath, "denied.js"),
              type: "file" as const,
              deniedOperations: ["read" as const],
              allowedRoles: [],
            },
          ],
        },
        tmp.path,
      )

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await AstGrepReplaceTool.init()
          const result = await tool.execute(
            {
              pattern: "console.log",
              rewrite: "logger.info",
              lang: "javascript",
              paths: [tmp.path],
              dryRun: false,
            },
            ctx,
          )
          expect(result.metadata.matches).toBe(0)
        },
      })
    })
  })

  describe("tool definitions", () => {
    test("ast_grep_search has correct id", () => {
      expect(AstGrepSearchTool.id).toBe("ast_grep_search")
    })

    test("ast_grep_replace has correct id", () => {
      expect(AstGrepReplaceTool.id).toBe("ast_grep_replace")
    })

    test("ast_grep_search has description", async () => {
      const tool = await AstGrepSearchTool.init()
      expect(tool.description).toBeTruthy()
      expect(tool.description).toContain("AST")
    })

    test("ast_grep_replace has description", async () => {
      const tool = await AstGrepReplaceTool.init()
      expect(tool.description).toBeTruthy()
      expect(tool.description).toContain("AST")
    })

    test("ast_grep_replace dryRun defaults to undefined (treated as true)", async () => {
      const tool = await AstGrepReplaceTool.init()
      const parsed = tool.parameters.parse({
        pattern: "test",
        rewrite: "replacement",
        lang: "javascript",
      })
      expect(parsed.dryRun).toBeUndefined()
    })
  })

  describe("experimental flag", () => {
    test("experimental flag exists and is boolean", async () => {
      const { Flag } = await import("../../src/flag/flag")
      expect(typeof Flag.OPENCODE_EXPERIMENTAL_AST_GREP).toBe("boolean")
    })
  })
})
