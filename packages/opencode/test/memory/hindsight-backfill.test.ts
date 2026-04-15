import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Memory } from "../../src/memory/memory"
import { MemoryHindsightBackfill } from "../../src/memory/hindsight/backfill"
import { MemoryHindsightClient } from "../../src/memory/hindsight/client"
import { MemoryHindsightMap } from "../../src/memory/hindsight/mapper"
import { MemoryHindsightRetain } from "../../src/memory/hindsight/retain"
import { MemoryHindsightState } from "../../src/memory/hindsight/state"
import { MemoryStorage } from "../../src/memory/storage"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

await Log.init({ print: false })

function cfg() {
  return {
    enabled: true,
    mode: "embedded" as const,
    extract: true,
    recall: true,
    backfill: true,
    workspace_scope: "worktree" as const,
    retain_limit: 2,
    context_max_items: 6,
    context_max_tokens: 1200,
  }
}

function item(i: number) {
  return Memory.Info.parse({
    id: `memory_${i}`,
    content: `Memory ${i}`,
    categories: ["pattern"],
    scope: "personal",
    status: "confirmed",
    tags: [`tag-${i}`],
    source: {
      sessionID: "sess_1",
      method: "manual",
    },
    citations: [],
    score: 1,
    baseScore: 1,
    useCount: 0,
    hitCount: 0,
    inject: false,
    createdAt: i,
    updatedAt: i,
  })
}

async function seed(list: Memory.Info[]) {
  await MemoryStorage.clear()
  return Promise.all(list.map((memory) => MemoryStorage.save(memory)))
}

beforeEach(() => {
  mock.restore()
})

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

describe("MemoryHindsightBackfill", () => {
  test("imports authoritative memories in stable replace-style batches", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: cfg(),
        },
      },
    })

    const list = [item(1), item(2), item(3)]
    const calls: Array<Parameters<typeof MemoryHindsightClient.retainBatch>[0]> = []
    spyOn(MemoryHindsightClient, "retainBatch").mockImplementation(async (input) => {
      calls.push(input)
      return {
        success: true,
        bank_id: "bank_1",
        items_count: input.items.length,
        async: false,
      }
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(list)

        expect(await MemoryHindsightBackfill.run()).toEqual({
          status: "completed",
          processed: 3,
          succeeded: 3,
          failed: 0,
          cursor: "memory_3",
        })
        expect(calls).toHaveLength(2)
        expect(calls[0]?.items).toMatchObject([
          {
            content: "Memory 1",
            document_id: MemoryHindsightMap.memoryDocumentId(list[0]!, tmp.path),
            metadata: MemoryHindsightMap.memoryMetadata(list[0]!, { root: tmp.path }),
            tags: MemoryHindsightMap.memoryTags(list[0]!),
            update_mode: "replace",
          },
          {
            content: "Memory 2",
            document_id: MemoryHindsightMap.memoryDocumentId(list[1]!, tmp.path),
            metadata: MemoryHindsightMap.memoryMetadata(list[1]!, { root: tmp.path }),
            tags: MemoryHindsightMap.memoryTags(list[1]!),
            update_mode: "replace",
          },
        ])
        expect(calls[1]?.items).toMatchObject([
          {
            content: "Memory 3",
            document_id: MemoryHindsightMap.memoryDocumentId(list[2]!, tmp.path),
            metadata: MemoryHindsightMap.memoryMetadata(list[2]!, { root: tmp.path }),
            tags: MemoryHindsightMap.memoryTags(list[2]!),
            update_mode: "replace",
          },
        ])

        expect(await MemoryHindsightState.load()).toMatchObject({
          backfill: {
            status: "completed",
            cursor: "memory_3",
            processed: 3,
            succeeded: 3,
            failed: 0,
            batch_size: 2,
          },
        })

        expect(await MemoryHindsightBackfill.run()).toEqual({
          status: "completed",
          processed: 3,
          succeeded: 3,
          failed: 0,
          cursor: "memory_3",
        })
        expect(calls).toHaveLength(2)
      },
    })
  })

  test("resumes from the saved cursor instead of re-importing earlier memories", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: cfg(),
        },
      },
    })

    const list = [item(1), item(2), item(3), item(4)]
    const calls: Array<Parameters<typeof MemoryHindsightClient.retainBatch>[0]> = []
    spyOn(MemoryHindsightClient, "retainBatch").mockImplementation(async (input) => {
      calls.push(input)
      return {
        success: true,
        bank_id: "bank_1",
        items_count: input.items.length,
        async: false,
      }
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(list)
        await MemoryHindsightState.save({
          version: 1,
          bank_id: "old_bank",
          workspace_hash: "old_hash",
          workspace_scope: "worktree",
          updated_at: 0,
          backfill: {
            status: "failed",
            mode: "auto",
            started_at: 1,
            updated_at: 0,
            cursor: "memory_2",
            last_memory_id: "memory_2",
            last_document_id: MemoryHindsightMap.memoryDocumentId(list[1]!, tmp.path),
            processed: 2,
            succeeded: 2,
            failed: 0,
            skipped: 0,
            batch_size: 2,
            operation_ids: [],
            failures: [],
          },
        })

        expect(await MemoryHindsightBackfill.run()).toEqual({
          status: "completed",
          processed: 4,
          succeeded: 4,
          failed: 0,
          cursor: "memory_4",
        })
        expect(calls).toHaveLength(1)
        expect(calls[0]?.items.map((item) => item.document_id)).toEqual([
          MemoryHindsightMap.memoryDocumentId(list[2]!, tmp.path),
          MemoryHindsightMap.memoryDocumentId(list[3]!, tmp.path),
        ])
      },
    })
  })

  test("falls back to per-memory retain, records failure, and resumes from the failed cursor", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: cfg(),
        },
      },
    })

    const list = [item(1), item(2), item(3)]
    spyOn(MemoryHindsightClient, "retainBatch").mockImplementation(async () => undefined)

    const one = spyOn(MemoryHindsightRetain, "memory")
    one.mockImplementationOnce(async (memory, root) => ({
      status: "retained",
      document_id: MemoryHindsightMap.memoryDocumentId(memory, root ?? tmp.path),
      result: {
        success: true,
        bank_id: "bank_1",
        items_count: 1,
        async: false,
      },
    }))
    one.mockImplementationOnce(async (memory, root) => ({
      status: "failed",
      document_id: MemoryHindsightMap.memoryDocumentId(memory, root ?? tmp.path),
      error: "boom",
    }))

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(list)

        expect(await MemoryHindsightBackfill.run()).toEqual({
          status: "failed",
          processed: 2,
          succeeded: 1,
          failed: 1,
          cursor: "memory_1",
        })
        expect(await MemoryHindsightState.load()).toMatchObject({
          backfill: {
            status: "failed",
            cursor: "memory_1",
            processed: 2,
            succeeded: 1,
            failed: 1,
            failures: [
              {
                memory_id: "memory_2",
                document_id: MemoryHindsightMap.memoryDocumentId(list[1]!, tmp.path),
                error: "boom",
              },
            ],
          },
        })

        one.mockReset()
        spyOn(MemoryHindsightClient, "retainBatch").mockImplementation(async (input) => ({
          success: true,
          bank_id: "bank_1",
          items_count: input.items.length,
          async: false,
        }))

        expect(await MemoryHindsightBackfill.run()).toEqual({
          status: "completed",
          processed: 4,
          succeeded: 3,
          failed: 1,
          cursor: "memory_3",
        })
      },
    })
  })
})
