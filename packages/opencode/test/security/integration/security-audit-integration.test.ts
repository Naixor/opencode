/**
 * US-034: SecurityAudit receives events for all security denials.
 *
 * Verifies that SecurityAudit.logSecurityEvent is called and audit log entries
 * are written for denied operations across all new OMO tools and components.
 *
 * Note: look_at and skill_mcp audit tests are in their respective unit test files
 * (test/tool/look-at.test.ts, test/tool/skill-mcp.test.ts) to avoid Bun mock.module
 * contamination. This file tests components that use real SecurityConfig.
 */
import { describe, expect, test, afterEach, beforeEach } from "bun:test"
import path from "path"
import fs from "fs"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"
import { SecurityConfig } from "../../../src/security/config"
import { AstGrepSearchTool, AstGrepReplaceTool, AstGrepLoader } from "../../../src/tool/ast-grep"
import { InteractiveBashTool } from "../../../src/tool/interactive-bash"

const ctx = {
  sessionID: "test-audit",
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

function readAuditLog(logPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) return []
  const content = fs.readFileSync(logPath, "utf-8").trim()
  if (!content) return []
  return content.split("\n").map((line) => JSON.parse(line))
}

async function waitForAuditFlush(ms = 200): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe("SecurityAudit integration - audit log entries for denials", () => {
  beforeEach(() => {
    AstGrepLoader.load = () => Promise.resolve(createMockAstGrep() as any)
  })

  afterEach(() => {
    SecurityConfig.resetConfig()
  })

  test("ast_grep_search denied -> audit log entry written", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "secret.js"), 'console.log("secret")\n')
      },
    })

    const auditLogPath = path.join(tmp.path, "test-audit.log")

    await loadSecurityConfig(tmp.path, {
      version: "1.0",
      rules: [
        {
          pattern: path.join(tmp.path, "secret.js"),
          type: "file",
          deniedOperations: ["read"],
          allowedRoles: [],
        },
      ],
      logging: {
        path: auditLogPath,
        level: "normal",
        maxSizeMB: 10,
        retentionDays: 30,
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AstGrepSearchTool.init()
        await tool.execute(
          { pattern: "console.log", lang: "javascript", paths: [tmp.path] },
          ctx,
        )

        await waitForAuditFlush()

        const entries = readAuditLog(auditLogPath)
        const deniedEntries = entries.filter((e) => e.result === "denied")
        expect(deniedEntries.length).toBeGreaterThanOrEqual(1)

        const secretDenied = deniedEntries.find(
          (e) => typeof e.path === "string" && e.path.includes("secret.js"),
        )
        expect(secretDenied).toBeDefined()
        expect(secretDenied!.operation).toBe("read")
        expect(secretDenied!.result).toBe("denied")
      },
    })
  })

  test("ast_grep_replace denied segment -> audit log entry written", async () => {
    const protectedContent = '// @security-start\nconsole.log("secret")\n// @security-end\nconsole.log("public")\n'

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mixed.js"), protectedContent)
      },
    })

    const auditLogPath = path.join(tmp.path, "test-audit.log")

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
      logging: {
        path: auditLogPath,
        level: "normal",
        maxSizeMB: 10,
        retentionDays: 30,
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

        await waitForAuditFlush()

        const entries = readAuditLog(auditLogPath)
        const deniedEntries = entries.filter((e) => e.result === "denied")
        expect(deniedEntries.length).toBeGreaterThanOrEqual(1)

        const segmentDenied = deniedEntries.find(
          (e) => typeof e.path === "string" && e.path.includes("mixed.js"),
        )
        expect(segmentDenied).toBeDefined()
        expect(segmentDenied!.operation).toBe("write")
      },
    })
  })

  test("interactive_bash denied -> audit log entry written", async () => {
    await using tmp = await tmpdir({ git: true })
    const secretFile = path.join(tmp.path, "secrets.env")
    fs.writeFileSync(secretFile, "SECRET=abc")

    const auditLogPath = path.join(tmp.path, "test-audit.log")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await loadSecurityConfig(tmp.path, {
          version: "1.0",
          rules: [
            {
              pattern: `${tmp.path}/secrets.env`,
              type: "file",
              deniedOperations: ["read"],
              allowedRoles: [],
            },
          ],
          logging: {
            path: auditLogPath,
            level: "normal",
            maxSizeMB: 10,
            retentionDays: 30,
          },
        })

        const tool = await InteractiveBashTool.init()
        await tool.execute({ tmux_command: `new-window ${secretFile}` }, ctx)

        await waitForAuditFlush()

        const entries = readAuditLog(auditLogPath)
        const deniedEntries = entries.filter((e) => e.result === "denied")
        expect(deniedEntries.length).toBeGreaterThanOrEqual(1)

        const secretDenied = deniedEntries.find(
          (e) => typeof e.path === "string" && e.path.includes("secrets.env"),
        )
        expect(secretDenied).toBeDefined()
        expect(secretDenied!.operation).toBe("read")
      },
    })
  })

  test("multiple denied operations -> all audit entries present", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "alpha.js"), 'console.log("alpha")\n')
        await Bun.write(path.join(dir, "beta.js"), 'console.log("beta")\n')
      },
    })

    const auditLogPath = path.join(tmp.path, "test-audit.log")

    await loadSecurityConfig(tmp.path, {
      version: "1.0",
      rules: [
        {
          pattern: path.join(tmp.path, "alpha.js"),
          type: "file",
          deniedOperations: ["read"],
          allowedRoles: [],
        },
        {
          pattern: path.join(tmp.path, "beta.js"),
          type: "file",
          deniedOperations: ["read"],
          allowedRoles: [],
        },
      ],
      logging: {
        path: auditLogPath,
        level: "normal",
        maxSizeMB: 10,
        retentionDays: 30,
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AstGrepSearchTool.init()
        await tool.execute(
          { pattern: "console.log", lang: "javascript", paths: [tmp.path] },
          ctx,
        )

        await waitForAuditFlush()

        const entries = readAuditLog(auditLogPath)
        const deniedEntries = entries.filter((e) => e.result === "denied")

        // Both alpha.js and beta.js should have denied entries
        const alphaDenied = deniedEntries.find(
          (e) => typeof e.path === "string" && e.path.includes("alpha.js"),
        )
        const betaDenied = deniedEntries.find(
          (e) => typeof e.path === "string" && e.path.includes("beta.js"),
        )
        expect(alphaDenied).toBeDefined()
        expect(betaDenied).toBeDefined()
      },
    })
  })

  test("audit log entry has correct schema fields", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "private.js"), 'console.log("private")\n')
      },
    })

    const auditLogPath = path.join(tmp.path, "test-audit.log")

    await loadSecurityConfig(tmp.path, {
      version: "1.0",
      rules: [
        {
          pattern: path.join(tmp.path, "private.js"),
          type: "file",
          deniedOperations: ["read"],
          allowedRoles: [],
        },
      ],
      logging: {
        path: auditLogPath,
        level: "normal",
        maxSizeMB: 10,
        retentionDays: 30,
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AstGrepSearchTool.init()
        await tool.execute(
          { pattern: "console.log", lang: "javascript", paths: [tmp.path] },
          ctx,
        )

        await waitForAuditFlush()

        const entries = readAuditLog(auditLogPath)
        const deniedEntry = entries.find(
          (e) => e.result === "denied" && typeof e.path === "string" && e.path.includes("private.js"),
        )
        expect(deniedEntry).toBeDefined()

        // Verify AuditLogEntry schema fields
        expect(deniedEntry!.timestamp).toBeDefined()
        expect(typeof deniedEntry!.timestamp).toBe("string")
        expect(deniedEntry!.role).toBeDefined()
        expect(deniedEntry!.operation).toBe("read")
        expect(deniedEntry!.path).toBeDefined()
        expect(deniedEntry!.result).toBe("denied")
      },
    })
  })
})
