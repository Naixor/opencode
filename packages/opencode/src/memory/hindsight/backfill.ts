import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Memory } from "../memory"
import { MemoryHindsightBank } from "./bank"
import { MemoryHindsightClient } from "./client"
import { MemoryHindsightMap } from "./mapper"
import { MemoryHindsightRetain } from "./retain"
import { MemoryHindsightState } from "./state"

export namespace MemoryHindsightBackfill {
  const log = Log.create({ service: "memory.hindsight.backfill" })

  type Batch = Exclude<Awaited<ReturnType<typeof MemoryHindsightClient.retainBatch>>, undefined>

  export interface Result {
    status: "disabled" | "completed" | "failed"
    processed: number
    succeeded: number
    failed: number
    cursor?: string
  }

  function size(cfg: Awaited<ReturnType<typeof Config.get>>) {
    return cfg.memory?.hindsight.retain_limit ?? 50
  }

  function sort(list: Memory.Info[]) {
    return list.slice().sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  function rest(list: Memory.Info[], cursor?: string) {
    if (!cursor) return list
    const at = list.findIndex((item) => item.id === cursor)
    if (at === -1) return list
    return list.slice(at + 1)
  }

  function chunk(list: Memory.Info[], n: number) {
    return Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n)).filter(
      (item) => item.length > 0,
    )
  }

  function item(memory: Memory.Info, root: string) {
    return {
      content: memory.content,
      timestamp: new Date(memory.updatedAt).toISOString(),
      context: memory.source.contextSnapshot,
      metadata: MemoryHindsightMap.memoryMetadata(memory, { root }),
      document_id: MemoryHindsightMap.memoryDocumentId(memory, root),
      tags: MemoryHindsightMap.memoryTags(memory),
      update_mode: "replace" as const,
    }
  }

  function ops(input: Batch) {
    const raw = input as Record<string, unknown>
    const list = Array.isArray(raw.operation_ids)
      ? raw.operation_ids.filter((item): item is string => typeof item === "string")
      : []
    const one = typeof raw.operation_id === "string" ? [raw.operation_id] : []
    return [...one, ...list].filter((item, i, all) => all.indexOf(item) === i)
  }

  async function start(root: string, n: number) {
    return MemoryHindsightState.mutate(
      (state) => ({
        ...state,
        bank_id: MemoryHindsightBank.bankId(root),
        workspace_hash: MemoryHindsightBank.worktreeHash(root),
        workspace_scope: "worktree",
        backfill: {
          ...state.backfill,
          status: "running",
          started_at: state.backfill.started_at ?? Date.now(),
          completed_at: undefined,
          batch_size: n,
          operation_ids: [],
        },
      }),
      root,
    )
  }

  async function pass(list: Memory.Info[], root: string, n: number, more: string[] = []) {
    const last = list.at(-1)
    if (!last) return MemoryHindsightState.load(root)
    return MemoryHindsightState.mutate(
      (state) => ({
        ...state,
        backfill: {
          ...state.backfill,
          status: "running",
          cursor: last.id,
          last_memory_id: last.id,
          last_document_id: MemoryHindsightMap.memoryDocumentId(last, root),
          processed: state.backfill.processed + list.length,
          succeeded: state.backfill.succeeded + list.length,
          batch_size: n,
          operation_ids: [...state.backfill.operation_ids, ...more].filter((item, i, all) => all.indexOf(item) === i),
        },
      }),
      root,
    )
  }

  async function fail(memory: Memory.Info, root: string, n: number, error: string) {
    return MemoryHindsightState.mutate(
      (state) => ({
        ...state,
        backfill: {
          ...state.backfill,
          status: "failed",
          processed: state.backfill.processed + 1,
          failed: state.backfill.failed + 1,
          batch_size: n,
          operation_ids: [],
          failures: [
            ...state.backfill.failures,
            {
              memory_id: memory.id,
              document_id: MemoryHindsightMap.memoryDocumentId(memory, root),
              error,
              at: Date.now(),
            },
          ],
        },
      }),
      root,
    )
  }

  async function done(root: string, n: number) {
    return MemoryHindsightState.mutate(
      (state) => ({
        ...state,
        backfill: {
          ...state.backfill,
          status: "completed",
          completed_at: Date.now(),
          batch_size: n,
          operation_ids: [],
        },
      }),
      root,
    )
  }

  function view(state: MemoryHindsightState.Info, status: Result["status"]): Result {
    return {
      status,
      processed: state.backfill.processed,
      succeeded: state.backfill.succeeded,
      failed: state.backfill.failed,
      cursor: state.backfill.cursor,
    }
  }

  export async function run(root = Instance.worktree): Promise<Result> {
    const cfg = await Config.get()
    if (!cfg.memory?.hindsight.enabled || !cfg.memory.hindsight.backfill) {
      const state = await MemoryHindsightState.load(root)
      return view(state, "disabled")
    }

    const n = size(cfg)
    const state = await start(root, n)
    const list = rest(sort(await Memory.list()), state.backfill.cursor)
    if (list.length === 0) return done(root, n).then((item) => view(item, "completed"))

    for (const part of chunk(list, n)) {
      const batch = await MemoryHindsightClient.retainBatch({ items: part.map((memory) => item(memory, root)) })
      if (batch) {
        log.info("hindsight backfill batch retained", {
          count: part.length,
          cursor: part.at(-1)?.id,
          root,
        })
        await pass(part, root, n, ops(batch))
        continue
      }

      for (const memory of part) {
        const result = await MemoryHindsightRetain.memory(memory, root)
        if (result.status === "retained") {
          await pass([memory], root, n)
          continue
        }
        log.warn("hindsight backfill failed", {
          memory_id: memory.id,
          document_id: result.document_id,
          root,
          error: result.error,
        })
        return fail(memory, root, n, result.error ?? "retain returned no result").then((item) => view(item, "failed"))
      }
    }

    return done(root, n).then((item) => view(item, "completed"))
  }
}
