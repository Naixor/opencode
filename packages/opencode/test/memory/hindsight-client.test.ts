import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { MemoryHindsightBank } from "../../src/memory/hindsight/bank"
import { tmpdir } from "../fixture/fixture"

await Log.init({ print: false })

type ServerOpts = {
  profile?: string
  port?: number
  host?: string
  readyTimeoutMs?: number
}

const calls = {
  server: [] as ServerOpts[],
  client: [] as { baseUrl: string }[],
  raw: [] as { baseUrl: string }[],
  start: 0,
  stop: 0,
  health: 0,
  retain: [] as Array<{ bank_id: string; content: string; document_id?: string }>,
  batch: [] as Array<{ bank_id: string; items: number; document_id?: string }>,
  recall: [] as Array<{ bank_id: string; query: string }>,
  doc: [] as Array<{ bank_id: string; document_id: string }>,
  docs: [] as Array<{ bank_id: string; q?: string | null }>,
  op: [] as Array<{ bank_id: string; operation_id: string }>,
  ops: [] as Array<{ bank_id: string; status?: string | null }>,
}

const flags = {
  start_ms: 0,
  health_ms: 0,
  call_ms: 0,
  start_fail: false,
  health_ok: true,
  retain_fail: false,
  doc_fail: false,
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

mock.module("@vectorize-io/hindsight-all", () => ({
  HindsightServer: class HindsightServer {
    opts: ServerOpts

    constructor(opts: ServerOpts = {}) {
      this.opts = opts
      calls.server.push({ ...opts })
    }

    async start() {
      calls.start++
      await wait(flags.start_ms)
      if (flags.start_fail) throw new Error("start failed")
    }

    async stop() {
      calls.stop++
    }

    async checkHealth() {
      calls.health++
      await wait(flags.health_ms)
      return flags.health_ok
    }
  },
}))

mock.module("@vectorize-io/hindsight-client", () => ({
  HindsightClient: class HindsightClient {
    opts: { baseUrl: string }

    constructor(opts: { baseUrl: string }) {
      this.opts = opts
      calls.client.push({ ...opts })
    }

    async retain(bank_id: string, content: string, opts?: { documentId?: string }) {
      calls.retain.push({ bank_id, content, document_id: opts?.documentId })
      await wait(flags.call_ms)
      if (flags.retain_fail) throw new Error("retain failed")
      return {
        success: true,
        bank_id,
        items_count: 1,
        async: false,
      }
    }

    async retainBatch(bank_id: string, items: Array<{ content: string }>, opts?: { documentId?: string }) {
      calls.batch.push({ bank_id, items: items.length, document_id: opts?.documentId })
      await wait(flags.call_ms)
      return {
        success: true,
        bank_id,
        items_count: items.length,
        async: false,
      }
    }

    async recall(bank_id: string, query: string) {
      calls.recall.push({ bank_id, query })
      await wait(flags.call_ms)
      return {
        results: [
          {
            id: "fact_1",
            text: "alpha",
            document_id: "doc_1",
            metadata: { memory_id: "memory_1" },
          },
        ],
      }
    }
  },
  createConfig(input: { baseUrl: string }) {
    return input
  },
  createClient(input: { baseUrl: string }) {
    calls.raw.push({ ...input })
    return { baseUrl: input.baseUrl }
  },
  sdk: {
    async getDocument(input: { path: { bank_id: string; document_id: string } }) {
      calls.doc.push(input.path)
      await wait(flags.call_ms)
      if (flags.doc_fail) return { error: { detail: "document failed" } }
      return {
        data: {
          id: input.path.document_id,
          bank_id: input.path.bank_id,
          original_text: "doc",
          content_hash: null,
          created_at: "2026-04-15T00:00:00Z",
          updated_at: "2026-04-15T00:00:00Z",
          memory_unit_count: 1,
          tags: ["memory"],
          document_metadata: { memory_id: "memory_1" },
        },
      }
    },
    async listDocuments(input: { path: { bank_id: string }; query?: { q?: string | null } }) {
      calls.docs.push({ bank_id: input.path.bank_id, q: input.query?.q })
      await wait(flags.call_ms)
      return {
        data: {
          items: [{ id: "doc_1" }],
          total: 1,
          limit: 10,
          offset: 0,
        },
      }
    },
    async getOperationStatus(input: { path: { bank_id: string; operation_id: string } }) {
      calls.op.push(input.path)
      await wait(flags.call_ms)
      return {
        data: {
          operation_id: input.path.operation_id,
          status: "completed",
          operation_type: "retain",
        },
      }
    },
    async listOperations(input: { path: { bank_id: string }; query?: { status?: string | null } }) {
      calls.ops.push({ bank_id: input.path.bank_id, status: input.query?.status })
      await wait(flags.call_ms)
      return {
        data: {
          bank_id: input.path.bank_id,
          total: 1,
          limit: 10,
          offset: 0,
          operations: [
            {
              id: "op_1",
              task_type: "retain",
              items_count: 1,
              created_at: "2026-04-15T00:00:00Z",
              status: "completed",
              error_message: null,
            },
          ],
        },
      }
    },
  },
}))

const { MemoryHindsightClient } = await import("../../src/memory/hindsight/client")

function cfg(input: { startup_timeout_ms: number; query_timeout_ms: number }) {
  return {
    enabled: true,
    mode: "embedded" as const,
    extract: true,
    recall: true,
    backfill: true,
    workspace_scope: "worktree" as const,
    context_max_items: 6,
    context_max_tokens: 1200,
    ...input,
  }
}

function reset() {
  calls.server.length = 0
  calls.client.length = 0
  calls.raw.length = 0
  calls.start = 0
  calls.stop = 0
  calls.health = 0
  calls.retain.length = 0
  calls.batch.length = 0
  calls.recall.length = 0
  calls.doc.length = 0
  calls.docs.length = 0
  calls.op.length = 0
  calls.ops.length = 0
  flags.start_ms = 0
  flags.health_ms = 0
  flags.call_ms = 0
  flags.start_fail = false
  flags.health_ok = true
  flags.retain_fail = false
  flags.doc_fail = false
}

beforeEach(() => {
  reset()
})

afterEach(async () => {
  await Instance.disposeAll()
})

describe("MemoryHindsightClient", () => {
  test("wraps retain, recall, and inspection calls through one worktree service", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 50 }),
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(
          await MemoryHindsightClient.retain({
            content: "alpha",
            document_id: "doc_1",
            metadata: { memory_id: "memory_1" },
            update_mode: "replace",
          }),
        ).toMatchObject({ success: true, items_count: 1 })
        expect(
          await MemoryHindsightClient.retainBatch({
            items: [{ content: "beta", document_id: "doc_2" }],
          }),
        ).toMatchObject({ success: true, items_count: 1 })
        expect(await MemoryHindsightClient.recall({ query: "alpha" })).toMatchObject({
          results: [{ id: "fact_1", document_id: "doc_1" }],
        })
        expect(await MemoryHindsightClient.getDocument({ document_id: "doc_1" })).toMatchObject({ id: "doc_1" })
        expect(await MemoryHindsightClient.listDocuments({ q: "doc" })).toMatchObject({ total: 1 })
        expect(await MemoryHindsightClient.getOperation({ operation_id: "op_1" })).toMatchObject({
          operation_id: "op_1",
          status: "completed",
        })
        expect(await MemoryHindsightClient.listOperations({ status: "completed" })).toMatchObject({ total: 1 })
      },
    })

    const bank_id = MemoryHindsightBank.bankId(tmp.path)
    expect(calls.start).toBe(1)
    expect(calls.health).toBe(1)
    expect(calls.retain[0]?.bank_id).toBe(bank_id)
    expect(calls.batch[0]?.bank_id).toBe(bank_id)
    expect(calls.recall[0]?.bank_id).toBe(bank_id)
    expect(calls.doc[0]?.bank_id).toBe(bank_id)
    expect(calls.ops[0]?.bank_id).toBe(bank_id)
    expect(calls.client[0]?.baseUrl).toBe(`http://127.0.0.1:${calls.server[0]?.port}`)
  })

  test("applies shared timeout and non-fatal failure handling", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: {
            ...cfg({ startup_timeout_ms: 50, query_timeout_ms: 5 }),
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        flags.call_ms = 25
        expect(await MemoryHindsightClient.recall({ query: "slow" })).toBeUndefined()
        flags.call_ms = 0
        flags.retain_fail = true
        expect(await MemoryHindsightClient.retain({ content: "alpha" })).toBeUndefined()
        flags.doc_fail = true
        expect(await MemoryHindsightClient.getDocument({ document_id: "doc_1" })).toBeUndefined()
      },
    })

    expect(calls.start).toBe(1)
    expect(calls.recall).toHaveLength(1)
    expect(calls.retain).toHaveLength(1)
    expect(calls.doc).toHaveLength(1)
  })
})
