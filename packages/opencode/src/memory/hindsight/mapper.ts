import { Memory } from "@/memory/memory"
import { MemoryHindsightBank } from "./bank"

export namespace MemoryHindsightMap {
  type Kind = "mem" | "sess" | "obs"
  type Reason = "document_id" | "metadata" | "cross_worktree" | "unresolved"

  export interface SessionInput {
    session_id: string
    start: number
    end: number
  }

  export interface ObservationInput {
    session_id: string
    hash: string
  }

  export interface SliceInput extends SessionInput {
    created_at?: number
    updated_at?: number
  }

  export interface Hit {
    document_id?: string | null
    metadata?: Record<string, unknown> | null
  }

  export interface Resolve {
    kind?: Kind
    memory_id?: string
    document_id?: string
    direct: boolean
    reason: Reason
  }

  function split(id: string): { kind: Kind; hash: string; rest: string[] } | undefined {
    const [kind, hash, ...rest] = id.split(":")
    if (kind !== "mem" && kind !== "sess" && kind !== "obs") return
    if (!hash || rest.length === 0 || rest.some((item) => item.length === 0)) return
    return { kind, hash, rest }
  }

  export function memoryDocumentId(memory: Pick<Memory.Info, "id">, root: string) {
    return `mem:${MemoryHindsightBank.worktreeHash(root)}:${memory.id}`
  }

  export function sessionDocumentId(input: SessionInput, root: string) {
    return `sess:${MemoryHindsightBank.worktreeHash(root)}:${input.session_id}:${input.start}:${input.end}`
  }

  export function observationDocumentId(input: ObservationInput, root: string) {
    return `obs:${MemoryHindsightBank.worktreeHash(root)}:${input.session_id}:${input.hash}`
  }

  export function memoryMetadata(
    memory: Pick<Memory.Info, "id" | "scope" | "status" | "createdAt" | "updatedAt" | "source">,
    input: { root: string },
  ) {
    return {
      workspace_id: MemoryHindsightBank.worktreeHash(input.root),
      project_root: input.root,
      session_id: memory.source.sessionID,
      memory_id: memory.id,
      source_kind: "memory",
      scope: memory.scope,
      status: memory.status,
      created_at: String(memory.createdAt),
      updated_at: String(memory.updatedAt),
    }
  }

  export function memoryTags(memory: Pick<Memory.Info, "scope" | "status" | "categories" | "tags">) {
    return MemoryHindsightBank.tags({
      kind: "memory",
      scope: memory.scope,
      status: memory.status,
      categories: memory.categories,
      tags: memory.tags,
    })
  }

  export function sessionMetadata(input: SliceInput, root: string) {
    return {
      workspace_id: MemoryHindsightBank.worktreeHash(root),
      project_root: root,
      session_id: input.session_id,
      source_kind: "session_slice",
      slice_start: String(input.start),
      slice_end: String(input.end),
      ...(input.created_at === undefined ? {} : { created_at: String(input.created_at) }),
      ...(input.updated_at === undefined ? {} : { updated_at: String(input.updated_at) }),
    }
  }

  export function sessionTags(input: { tags?: string[] } = {}) {
    return MemoryHindsightBank.tags({
      kind: "session_slice",
      tags: input.tags,
    })
  }

  export function resolve(hit: Hit, root: string): Resolve {
    const expected = MemoryHindsightBank.worktreeHash(root)
    const doc = hit.document_id ?? undefined
    const parsed = doc ? split(doc) : undefined
    if (parsed && parsed.hash !== expected) {
      return {
        kind: parsed.kind,
        document_id: doc,
        direct: false,
        reason: "cross_worktree",
      }
    }
    if (parsed?.kind === "mem") {
      return {
        kind: "mem",
        memory_id: parsed.rest.join(":"),
        document_id: doc,
        direct: true,
        reason: "document_id",
      }
    }
    if (parsed) {
      return {
        kind: parsed.kind,
        document_id: doc,
        direct: false,
        reason: "document_id",
      }
    }
    const hash = typeof hit.metadata?.workspace_id === "string" ? hit.metadata.workspace_id : undefined
    if (hash && hash !== expected) {
      return {
        document_id: doc,
        direct: false,
        reason: "cross_worktree",
      }
    }
    const id = typeof hit.metadata?.memory_id === "string" ? hit.metadata.memory_id.trim() : ""
    if (id) {
      return {
        kind: "mem",
        memory_id: id,
        document_id: doc,
        direct: true,
        reason: "metadata",
      }
    }
    return {
      document_id: doc,
      direct: false,
      reason: "unresolved",
    }
  }
}
