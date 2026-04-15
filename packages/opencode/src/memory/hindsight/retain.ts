import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Memory } from "../memory"
import { MemoryHindsightClient } from "./client"
import { MemoryHindsightMap } from "./mapper"

export namespace MemoryHindsightRetain {
  const log = Log.create({ service: "memory.hindsight.retain" })

  type Retain = Exclude<Awaited<ReturnType<typeof MemoryHindsightClient.retain>>, undefined>
  type Status = "retained" | "disabled" | "failed"

  export interface Slice {
    session_id: string
    start: number
    end: number
    content: string
    created_at?: number
    updated_at?: number
    tags?: string[]
  }

  export interface Result {
    status: Status
    document_id: string
    result?: Retain
    error?: string
  }

  function text(err: unknown) {
    return err instanceof Error ? err.message : String(err)
  }

  function fail(memory: Memory.Info, document_id: string, err: unknown): Result {
    const error = text(err)
    log.warn("hindsight memory retain failed", {
      error,
      document_id,
      memory_id: memory.id,
    })
    return {
      status: "failed",
      document_id,
      error,
    }
  }

  function failSlice(input: Slice, document_id: string, err: unknown): Result {
    const error = text(err)
    log.warn("hindsight session retain failed", {
      error,
      document_id,
      session_id: input.session_id,
      start: input.start,
      end: input.end,
    })
    return {
      status: "failed",
      document_id,
      error,
    }
  }

  export async function memory(memory: Memory.Info, root = Instance.worktree): Promise<Result> {
    const cfg = await Config.get()
    const document_id = MemoryHindsightMap.memoryDocumentId(memory, root)
    if (!cfg.memory?.hindsight.enabled) {
      return {
        status: "disabled",
        document_id,
      }
    }
    return MemoryHindsightClient.retain({
      content: memory.content,
      timestamp: new Date(memory.updatedAt).toISOString(),
      metadata: MemoryHindsightMap.memoryMetadata(memory, { root }),
      document_id,
      tags: MemoryHindsightMap.memoryTags(memory),
      update_mode: "replace",
    })
      .then((result) => {
        if (!result) return fail(memory, document_id, "retain returned no result")
        return {
          status: "retained" as const,
          document_id,
          result,
        }
      })
      .catch((err) => fail(memory, document_id, err))
  }

  export async function session(input: Slice, root = Instance.worktree): Promise<Result> {
    const cfg = await Config.get()
    const document_id = MemoryHindsightMap.sessionDocumentId(input, root)
    if (!cfg.memory?.hindsight.enabled) {
      return {
        status: "disabled",
        document_id,
      }
    }
    return MemoryHindsightClient.retain({
      content: input.content,
      timestamp: input.updated_at === undefined ? undefined : new Date(input.updated_at).toISOString(),
      metadata: MemoryHindsightMap.sessionMetadata(input, root),
      document_id,
      tags: MemoryHindsightMap.sessionTags({ tags: input.tags }),
      update_mode: "replace",
    })
      .then((result) => {
        if (!result) return failSlice(input, document_id, "retain returned no result")
        return {
          status: "retained" as const,
          document_id,
          result,
        }
      })
      .catch((err) => failSlice(input, document_id, err))
  }
}
