/**
 * US-031: interactive_bash security integration tests.
 *
 * Security checks (subcommand blocking, file path access control) must run
 * BEFORE the tmux availability check so that policy enforcement and audit
 * logging happen regardless of whether tmux is installed.
 */
import { describe, expect, test, afterEach, mock } from "bun:test"
import path from "path"
import fs from "fs"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"
import { SecurityConfig } from "../../../src/security/config"
import { SecurityAccess } from "../../../src/security/access"
import { InteractiveBashTool } from "../../../src/tool/interactive-bash"

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

async function loadSecurityConfig(dir: string, config: Record<string, unknown>) {
  const configPath = path.join(dir, ".opencode-security.json")
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  const gitDir = path.join(dir, ".git")
  if (!fs.existsSync(gitDir)) {
    fs.mkdirSync(gitDir)
  }
  SecurityAccess.setProjectRoot(dir)
  await SecurityConfig.loadSecurityConfig(dir)
}

describe("interactive_bash security integration", () => {
  afterEach(() => {
    SecurityConfig.resetConfig()
  })

  test("security check blocks protected file even when tmux is unavailable", async () => {
    await using tmp = await tmpdir({ git: true })
    const secretFile = path.join(tmp.path, "secrets.env")
    fs.writeFileSync(secretFile, "SECRET=abc")

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
        })

        const tool = await InteractiveBashTool.init()
        // Security check runs before tmux availability check,
        // so the file access is denied regardless of tmux being installed.
        const result = await tool.execute({ tmux_command: `new-window ${secretFile}` }, ctx)
        expect(result.metadata.blocked).toBe(true)
        expect(result.output).toContain("Security policy denied access")
      },
    })
  })

  test("blocked subcommand is rejected before tmux availability check", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await loadSecurityConfig(tmp.path, { version: "1.0" })

        const tool = await InteractiveBashTool.init()
        const result = await tool.execute({ tmux_command: "send-keys ls Enter" }, ctx)
        expect(result.metadata.blocked).toBe(true)
        expect(result.output).toContain("blocked for security reasons")
      },
    })
  })

  test("security check blocks when tmux IS available (mocked)", async () => {
    // Mock Bun.spawn so `which tmux` returns success
    const originalSpawn = Bun.spawn
    ;(Bun as any).spawn = (...args: any[]) => {
      const cmd = args[0]
      if (Array.isArray(cmd) && cmd[0] === "which" && cmd[1] === "tmux") {
        return {
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("/usr/bin/tmux\n"))
              controller.close()
            },
          }),
          stderr: new ReadableStream({
            start(c) {
              c.close()
            },
          }),
          exited: Promise.resolve(0),
        }
      }
      // For the actual tmux execution, return a failure (tmux not really installed)
      return {
        stdout: new ReadableStream({
          start(c) {
            c.close()
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("tmux: command not found\n"))
            controller.close()
          },
        }),
        exited: Promise.resolve(127),
      }
    }

    try {
      await using tmp = await tmpdir({ git: true })
      const secretFile = path.join(tmp.path, "secrets.env")
      fs.writeFileSync(secretFile, "SECRET=abc")

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
          })

          const tool = await InteractiveBashTool.init()
          const result = await tool.execute({ tmux_command: `new-window ${secretFile}` }, ctx)
          // Even with tmux "available", the security check blocks first
          expect(result.metadata.blocked).toBe(true)
          expect(result.output).toContain("Security policy denied access")
        },
      })
    } finally {
      ;(Bun as any).spawn = originalSpawn
    }
  })

  test("allowed file passes security check (tmux mocked)", async () => {
    const originalSpawn = Bun.spawn
    ;(Bun as any).spawn = (...args: any[]) => {
      const cmd = args[0]
      if (Array.isArray(cmd) && cmd[0] === "which" && cmd[1] === "tmux") {
        return {
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("/usr/bin/tmux\n"))
              controller.close()
            },
          }),
          stderr: new ReadableStream({
            start(c) {
              c.close()
            },
          }),
          exited: Promise.resolve(0),
        }
      }
      // tmux execution — returns an error since not really installed, but that's fine
      // The point is that security check passed and we reached tmux execution
      return {
        stdout: new ReadableStream({
          start(c) {
            c.close()
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("no server running\n"))
            controller.close()
          },
        }),
        exited: Promise.resolve(1),
      }
    }

    try {
      await using tmp = await tmpdir({ git: true })
      const safeFile = path.join(tmp.path, "readme.txt")
      fs.writeFileSync(safeFile, "hello")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await loadSecurityConfig(tmp.path, {
            version: "1.0",
            rules: [
              {
                pattern: `${tmp.path}/secrets/**`,
                type: "directory",
                deniedOperations: ["read"],
                allowedRoles: [],
              },
            ],
          })

          const tool = await InteractiveBashTool.init()
          // readme.txt is NOT protected — security check passes, reaches tmux execution
          const result = await tool.execute({ tmux_command: `new-window ${safeFile}` }, ctx)
          expect(result.metadata.blocked).toBeUndefined()
          // tmux fails because it's not really running, but we got past security
          expect(result.metadata.error).toBe(true)
          expect(result.metadata.exitCode).toBe(1)
        },
      })
    } finally {
      ;(Bun as any).spawn = originalSpawn
    }
  })
})
