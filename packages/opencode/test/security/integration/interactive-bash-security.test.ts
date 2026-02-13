/**
 * US-031: interactive_bash security integration tests.
 */
import { describe, expect, test, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"
import { SecurityConfig } from "../../../src/security/config"
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
  await SecurityConfig.loadSecurityConfig(dir)
}

describe("interactive_bash security integration", () => {
  afterEach(() => {
    SecurityConfig.resetConfig()
  })

  test("interactive_bash protected file -> BashScanner blocks", async () => {
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
        // new-window with a file path triggers direct path extraction
        const result = await tool.execute({ tmux_command: `new-window ${secretFile}` }, ctx)
        expect(result.metadata.blocked).toBe(true)
        expect(result.output).toContain("Security policy denied access")
      },
    })
  })
})
