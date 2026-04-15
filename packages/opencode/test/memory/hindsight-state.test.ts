import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "../../src/global"
import { MemoryHindsightBank } from "../../src/memory/hindsight/bank"
import { MemoryHindsightState } from "../../src/memory/hindsight/state"
import { MemoryStorage } from "../../src/memory/storage"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("MemoryHindsightState", () => {
  test("stores structured per-worktree sidecar state next to personal memory data", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const now = Date.now()
        const saved = await MemoryHindsightState.save({
          version: 1,
          bank_id: MemoryHindsightBank.bankId(tmp.path),
          workspace_hash: MemoryHindsightBank.worktreeHash(tmp.path),
          workspace_scope: "worktree",
          updated_at: 0,
          backfill: {
            status: "running",
            mode: "auto",
            started_at: now,
            updated_at: 0,
            cursor: "mem_2",
            last_memory_id: "mem_2",
            last_document_id: "mem:doc:2",
            processed: 2,
            succeeded: 1,
            failed: 1,
            skipped: 0,
            batch_size: 25,
            operation_ids: ["op_1", "op_2"],
            failures: [{ memory_id: "mem_2", document_id: "mem:doc:2", error: "timeout", at: now }],
          },
        })

        const file = path.join(Global.Path.data, "memory", encodeURIComponent(tmp.path), "hindsight.json")
        expect(MemoryHindsightState.filepath()).toBe(file)
        expect(await Bun.file(file).exists()).toBe(true)
        expect(saved.updated_at).toBeGreaterThan(0)
        expect(saved.backfill.updated_at).toBe(saved.updated_at)
        expect(await MemoryHindsightState.load()).toMatchObject({
          version: 1,
          bank_id: MemoryHindsightBank.bankId(tmp.path),
          workspace_hash: MemoryHindsightBank.worktreeHash(tmp.path),
          workspace_scope: "worktree",
          backfill: {
            status: "running",
            cursor: "mem_2",
            processed: 2,
            succeeded: 1,
            failed: 1,
            operation_ids: ["op_1", "op_2"],
            failures: [{ memory_id: "mem_2", document_id: "mem:doc:2", error: "timeout" }],
          },
        })
      },
    })
  })

  test("keeps hindsight state out of personal.json and trims failure samples", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await MemoryStorage.clear()
        const failures = Array.from({ length: 105 }, (_, i) => ({
          memory_id: `mem_${i}`,
          document_id: `mem:doc:${i}`,
          error: `err_${i}`,
          at: i,
        }))

        const state = await MemoryHindsightState.mutate((item) => ({
          ...item,
          backfill: {
            ...item.backfill,
            status: "failed",
            processed: 105,
            failed: 105,
            failures,
          },
        }))

        expect(state.backfill.failures).toHaveLength(100)
        expect(state.backfill.failures[0]?.memory_id).toBe("mem_5")
        expect(state.backfill.failures.at(-1)?.memory_id).toBe("mem_104")

        const file = path.join(Global.Path.data, "memory", encodeURIComponent(tmp.path), "personal.json")
        expect(await Bun.file(file).json()).toEqual({ memories: {}, meta: {} })
      },
    })
  })
})
