/**
 * US-031: ast_grep_search / ast_grep_replace security integration tests.
 *
 * Tests SecurityAccess and SecuritySegments integration with ast-grep tools.
 * SecurityAudit logging is verified in the unit test (test/tool/ast-grep.test.ts).
 */
import { describe, expect, test, afterEach, beforeEach } from "bun:test"
import path from "path"
import fs from "fs"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"
import { SecurityConfig } from "../../../src/security/config"
import { AstGrepSearchTool, AstGrepReplaceTool, AstGrepLoader } from "../../../src/tool/ast-grep"

const ctx = {
  sessionID: "test-security",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

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

async function loadSecurityConfig(dir: string, config: Record<string, unknown>) {
  const configPath = path.join(dir, ".opencode-security.json")
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  const gitDir = path.join(dir, ".git")
  if (!fs.existsSync(gitDir)) {
    fs.mkdirSync(gitDir)
  }
  await SecurityConfig.loadSecurityConfig(dir)
}

describe("ast_grep security integration", () => {
  beforeEach(() => {
    AstGrepLoader.load = () => Promise.resolve(createMockAstGrep() as any)
  })

  afterEach(() => {
    SecurityConfig.resetConfig()
  })

  test("ast_grep_search protected file -> denied", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "secret.js"), 'console.log("secret")\n')
      },
    })

    await loadSecurityConfig(tmp.path, {
      version: "1.0",
      roles: [{ name: "viewer", level: 1 }],
      rules: [
        {
          pattern: path.join(tmp.path, "secret.js"),
          type: "file",
          deniedOperations: ["read"],
          allowedRoles: [],
        },
      ],
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AstGrepSearchTool.init()
        const result = await tool.execute(
          { pattern: "console.log", lang: "javascript", paths: [tmp.path] },
          ctx,
        )
        expect(result.metadata.matches).toBe(0)
        expect(result.output).toBe("No matches found")
      },
    })
  })

  test("ast_grep_replace protected segment -> blocked, non-protected regions modifiable", async () => {
    const protectedContent = '// @security-start\nconsole.log("secret")\n// @security-end\nconsole.log("public")\n'

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mixed.js"), protectedContent)
      },
    })

    await loadSecurityConfig(tmp.path, {
      version: "1.0",
      segments: {
        markers: [
          {
            start: "@security-start",
            end: "@security-end",
            deniedOperations: ["write"],
            allowedRoles: [],
          },
        ],
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AstGrepReplaceTool.init()
        await tool.execute(
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
        // Non-protected region replaced
        expect(content).toContain("logger.info")
        // Protected region preserved
        expect(content).toContain("console.log")
      },
    })
  })

  test("ast_grep_replace non-protected region of file with protected segment -> only non-protected replaced", async () => {
    const mixedContent = [
      "const public1 = console.log('a')",
      "// @security-start",
      "const secret = console.log('secret')",
      "// @security-end",
      "const public2 = console.log('b')",
    ].join("\n") + "\n"

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mixed2.js"), mixedContent)
      },
    })

    await loadSecurityConfig(tmp.path, {
      version: "1.0",
      segments: {
        markers: [
          {
            start: "@security-start",
            end: "@security-end",
            deniedOperations: ["write"],
            allowedRoles: [],
          },
        ],
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AstGrepReplaceTool.init()
        await tool.execute(
          {
            pattern: "console.log",
            rewrite: "logger.info",
            lang: "javascript",
            paths: [tmp.path],
            dryRun: false,
          },
          ctx,
        )
        const content = await Bun.file(path.join(tmp.path, "mixed2.js")).text()
        // Two public console.log calls should be replaced
        const loggerInfoCount = (content.match(/logger\.info/g) || []).length
        expect(loggerInfoCount).toBe(2)
        // Protected console.log should remain
        expect(content).toContain("console.log")
      },
    })
  })
})
