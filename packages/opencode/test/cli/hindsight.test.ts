import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import path from "path"
import { BunProc } from "../../src/bun"
import {
  loadHindsightInspect,
  loadHindsightUi,
  HindsightCommand,
  HindsightUiCommand,
} from "../../src/cli/cmd/debug/hindsight"
import { MemoryHindsightBank } from "../../src/memory/hindsight/bank"
import { MemoryHindsightService } from "../../src/memory/hindsight/service"
import { MemoryHindsightState } from "../../src/memory/hindsight/state"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

function api() {
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
  const fn = Object.assign((input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.endsWith("/version")) {
      return json({ version: "0.5.1" })
    }
    if (url.endsWith("/v1/default/banks")) {
      return json([])
    }
    return json({ error: "unexpected" }, 500)
  }, globalThis.fetch)
  spyOn(globalThis, "fetch").mockImplementation(fn)
}

describe("HindsightCommand", () => {
  test("reports enabled inspect data without creating sidecar state", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            memory: {
              hindsight: {
                enabled: true,
                mode: "embedded",
                extract: true,
                recall: true,
                backfill: true,
                workspace_scope: "worktree",
                context_max_items: 6,
                context_max_tokens: 1200,
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = MemoryHindsightState.filepath()
        expect(await Bun.file(file).exists()).toBe(false)

        const result = await loadHindsightInspect()

        expect(result.config).toEqual({
          enabled: true,
          mode: "embedded",
          extract: true,
          recall: true,
          backfill: true,
          auto_start: true,
          workspace_scope: "worktree",
          llm_provider: undefined,
          llm_model: undefined,
          llm_base_url: undefined,
        })
        expect(result.bank).toEqual({
          id: MemoryHindsightBank.bankId(tmp.path),
          workspace_hash: MemoryHindsightBank.worktreeHash(tmp.path),
          workspace_scope: "worktree",
          root: tmp.path,
        })
        expect(result.service.status).toBe("stopped")
        expect(result.state.exists).toBe(false)
        expect(result.state.path).toBe(file)
        expect(result.state.backfill.status).toBe("idle")
        expect(await Bun.file(file).exists()).toBe(false)
      },
    })
  })

  test("surfaces current service and backfill state", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            memory: {
              hindsight: {
                enabled: true,
                mode: "embedded",
                extract: true,
                recall: true,
                backfill: true,
                workspace_scope: "worktree",
                context_max_items: 6,
                context_max_tokens: 1200,
                llm_provider: "openai",
                llm_model: "gpt-5.4-responses",
                llm_base_url: "https://api.openai.test/v1",
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const now = Date.now()
        await MemoryHindsightState.save({
          version: 1,
          bank_id: MemoryHindsightBank.bankId(tmp.path),
          workspace_hash: MemoryHindsightBank.worktreeHash(tmp.path),
          workspace_scope: "worktree",
          updated_at: 0,
          backfill: {
            status: "failed",
            mode: "auto",
            started_at: now,
            updated_at: 0,
            completed_at: now,
            cursor: "mem_3",
            last_memory_id: "mem_3",
            last_document_id: "mem:abc",
            processed: 3,
            succeeded: 2,
            failed: 1,
            skipped: 0,
            batch_size: 25,
            operation_ids: ["op_1"],
            failures: [{ memory_id: "mem_3", document_id: "mem:abc", error: "timeout", at: now }],
          },
        })
        spyOn(MemoryHindsightService, "get").mockResolvedValue({
          status: "degraded",
          root: tmp.path,
          bank_id: MemoryHindsightBank.bankId(tmp.path),
          profile: `opencode-${MemoryHindsightBank.worktreeHash(tmp.path)}`,
          base_url: "http://127.0.0.1:40123",
          port: 40123,
          error: "timeout",
        })

        const result = await loadHindsightInspect()

        expect(result.service.status).toBe("degraded")
        expect(result.service.error).toBe("timeout")
        expect(result.state.exists).toBe(true)
        expect(result.state.backfill).toMatchObject({
          status: "failed",
          cursor: "mem_3",
          processed: 3,
          succeeded: 2,
          failed: 1,
          operation_ids: ["op_1"],
        })
        expect(result.config.llm_provider).toBe("openai")
        expect(result.config.llm_model).toBe("gpt-5.4-responses")
        expect(result.config.llm_base_url).toBe("https://api.openai.test/v1")
      },
    })
  })

  test("exports the debug subcommand", () => {
    expect(HindsightCommand.command).toBe("hindsight")
    expect(HindsightUiCommand.command).toBe("ui")
  })

  test("builds control plane launch info from the ready service", async () => {
    api()
    const ready = spyOn(MemoryHindsightService, "readyUi").mockResolvedValue({
      status: "ready",
      root: "/tmp/project",
      bank_id: "opencode:test",
      profile: "opencode-test",
      base_url: "http://127.0.0.1:40123",
      port: 40123,
      client: {} as never,
    })
    spyOn(BunProc, "install").mockResolvedValue("/tmp/hindsight-control-plane")

    const result = await loadHindsightUi({
      port: 9999,
      hostname: "0.0.0.0",
    })

    expect(result.dir).toBe("/tmp/hindsight-control-plane")
    expect(result.api_url).toBe("http://127.0.0.1:40123")
    expect(result.url).toBe("http://127.0.0.1:9999")
    expect(ready).toHaveBeenCalledTimes(1)
    expect(BunProc.install).toHaveBeenCalledWith("@vectorize-io/hindsight-control-plane", "0.5.1")
    expect(result.cmd).toEqual([
      Bun.which("node")!,
      path.join("/tmp/hindsight-control-plane", "bin", "cli.js"),
      "--port",
      "9999",
      "--hostname",
      "0.0.0.0",
      "--api-url",
      "http://127.0.0.1:40123",
    ])
  })

  test("uses loopback address for curl-friendly url", async () => {
    api()
    spyOn(MemoryHindsightService, "readyUi").mockResolvedValue({
      status: "ready",
      root: "/tmp/project",
      bank_id: "opencode:test",
      profile: "opencode-test",
      base_url: "http://127.0.0.1:40123",
      port: 40123,
      client: {} as never,
    })
    spyOn(BunProc, "install").mockResolvedValue("/tmp/hindsight-control-plane")

    const result = await loadHindsightUi({
      port: 9999,
      hostname: "127.0.0.1",
    })

    expect(result.url).toBe("http://127.0.0.1:9999")
  })

  test("formats ipv6 loopback url", async () => {
    api()
    spyOn(MemoryHindsightService, "readyUi").mockResolvedValue({
      status: "ready",
      root: "/tmp/project",
      bank_id: "opencode:test",
      profile: "opencode-test",
      base_url: "http://127.0.0.1:40123",
      port: 40123,
      client: {} as never,
    })
    spyOn(BunProc, "install").mockResolvedValue("/tmp/hindsight-control-plane")

    const result = await loadHindsightUi({
      port: 9999,
      hostname: "::",
    })

    expect(result.url).toBe("http://[::1]:9999")
  })

  test("fails when hindsight is unavailable for the control plane", async () => {
    spyOn(MemoryHindsightService, "readyUi").mockResolvedValue(undefined)
    spyOn(MemoryHindsightService, "get").mockResolvedValue({
      status: "disabled",
      root: "/tmp/project",
      bank_id: "opencode:test",
      profile: "opencode-test",
      base_url: "http://127.0.0.1:40123",
      port: 40123,
    })

    await expect(loadHindsightUi({})).rejects.toThrow("Hindsight is not ready")
  })

  test("surfaces degraded hindsight startup errors for the control plane", async () => {
    spyOn(MemoryHindsightService, "readyUi").mockResolvedValue(undefined)
    spyOn(MemoryHindsightService, "get").mockResolvedValue({
      status: "degraded",
      root: "/tmp/project",
      bank_id: "opencode:test",
      profile: "opencode-test",
      base_url: "http://127.0.0.1:40123",
      port: 40123,
      error: "daemon.start failed with code 2",
    })

    await expect(loadHindsightUi({})).rejects.toThrow("Hindsight failed to start: daemon.start failed with code 2")
  })

  test("fails when the hindsight dataplane probe fails", async () => {
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
    const fn = Object.assign((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith("/version")) {
        return json({ detail: "down" }, 500)
      }
      if (url.endsWith("/v1/default/banks")) {
        return json([])
      }
      return json({ error: "unexpected" }, 500)
    }, globalThis.fetch)
    spyOn(globalThis, "fetch").mockImplementation(fn)
    spyOn(MemoryHindsightService, "readyUi").mockResolvedValue({
      status: "ready",
      root: "/tmp/project",
      bank_id: "opencode:test",
      profile: "opencode-test",
      base_url: "http://127.0.0.1:40123",
      port: 40123,
      client: {} as never,
    })
    spyOn(BunProc, "install").mockResolvedValue("/tmp/hindsight-control-plane")

    await expect(loadHindsightUi({})).rejects.toThrow("/version")
    await expect(loadHindsightUi({})).rejects.toThrow("HTTP 500")
  })

  test("does not restart hindsight ui mode when install fails", async () => {
    const ready = spyOn(MemoryHindsightService, "readyUi")
    spyOn(BunProc, "install").mockRejectedValue(new Error("install failed"))

    await expect(loadHindsightUi({})).rejects.toThrow("install failed")
    expect(ready).not.toHaveBeenCalled()
  })
})
