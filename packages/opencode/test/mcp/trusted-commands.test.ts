import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { EventEmitter } from "events"

const calls: Array<{ command: string; args: string[] }> = []

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdio {
    stderr = new EventEmitter()
    pid = 1

    constructor(opts: { command: string; args: string[] }) {
      calls.push({ command: opts.command, args: opts.args })
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    transport?: unknown

    async connect(transport: unknown) {
      this.transport = transport
    }

    async listTools() {
      return { tools: [] }
    }

    setNotificationHandler() {}

    async close() {}
  },
}))

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {},
}))

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {},
}))

mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class MockUnauthorizedError extends Error {},
}))

const { MCP } = await import("../../src/mcp/index")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")
const { SecurityConfig } = await import("../../src/security/config")
const { SecurityAccess } = await import("../../src/security/access")
const { resetSandbox, setActiveSandbox } = await import("../../src/sandbox")

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  resetSandbox()
  SecurityConfig.resetConfig()
})

async function secure(dir: string, cmds?: string[]) {
  await Bun.write(
    `${dir}/.opencode-security.json`,
    JSON.stringify(
      {
        version: "1.0",
        trusted_commands: cmds,
        mcp: {
          defaultPolicy: "enforced",
          servers: {},
        },
      },
      null,
      2,
    ),
  )
  SecurityAccess.setProjectRoot(dir)
  await SecurityConfig.loadSecurityConfig(dir, { forceWalk: true })
}

test("trusted local MCP command skips sandbox wrapping", async () => {
  await using tmp = await tmpdir({ git: true })
  await secure(tmp.path, ["bitsky"])
  setActiveSandbox(
    {
      wrap(command) {
        return ["sandbox-exec", "-f", "policy.sb", ...command]
      },
      async isAvailable() {
        return true
      },
      async generatePolicy() {
        return ""
      },
    },
    "active",
  )

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await MCP.add("bitsky", { type: "local", command: ["bitsky", "mcp"] })
      expect(calls[0]?.command).toBe("bitsky")
      expect(calls[0]?.args).toEqual(["mcp"])
    },
  })
})

test("untrusted local MCP command stays sandboxed", async () => {
  await using tmp = await tmpdir({ git: true })
  await secure(tmp.path, ["other"])
  setActiveSandbox(
    {
      wrap(command) {
        return ["sandbox-exec", "-f", "policy.sb", ...command]
      },
      async isAvailable() {
        return true
      },
      async generatePolicy() {
        return ""
      },
    },
    "active",
  )

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await MCP.add("bitsky", { type: "local", command: ["bitsky", "mcp"] })
      expect(calls[0]?.command).toBe("sandbox-exec")
      expect(calls[0]?.args).toEqual(["-f", "policy.sb", "bitsky", "mcp"])
    },
  })
})
