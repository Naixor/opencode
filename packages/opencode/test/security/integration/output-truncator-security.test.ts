/**
 * US-031: tool-output-truncator security marker preservation integration test.
 */
import { describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"
import { HookChain } from "../../../src/session/hooks"
import { OutputManagementHooks } from "../../../src/session/hooks/output-management"

describe("tool-output-truncator security marker preservation", () => {
  test("tool-output-truncator preserves [REDACTED: Security Protected] markers", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        HookChain.reset()
        OutputManagementHooks.register()

        // Create output where the marker is beyond the truncation point
        const prefix = "x".repeat(50 * 1024 + 100) // Over 50KB
        const marker = "[REDACTED: Security Protected]"
        const output = prefix + "\n" + marker + "\nmore data after marker"

        const hookCtx: HookChain.PostToolContext = {
          sessionID: "s1",
          toolName: "bash",
          agent: "build",
          result: {
            output,
            title: "test",
            metadata: {},
          },
          args: {},
        }

        await HookChain.execute("post-tool", hookCtx)

        // Output should be truncated but marker preserved
        expect(hookCtx.result.output.length).toBeLessThan(output.length)
        expect(hookCtx.result.output).toContain(marker)
      },
    })
  })
})
