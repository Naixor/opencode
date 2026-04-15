import { describe, expect, test } from "bun:test"
import { MemoryHindsightBank } from "../../src/memory/hindsight/bank"
import { MemoryHindsightMap } from "../../src/memory/hindsight/mapper"

const root = "/tmp/opencode/worktree"

describe("MemoryHindsightMap", () => {
  test("builds deterministic bank and document ids", () => {
    const hash = MemoryHindsightBank.worktreeHash(root)
    expect(MemoryHindsightBank.bankId(root)).toBe(`opencode:${hash}`)
    expect(MemoryHindsightMap.memoryDocumentId({ id: "memory_1" }, root)).toBe(`mem:${hash}:memory_1`)
    expect(MemoryHindsightMap.sessionDocumentId({ session_id: "sess_1", start: 10, end: 20 }, root)).toBe(
      `sess:${hash}:sess_1:10:20`,
    )
    expect(MemoryHindsightMap.observationDocumentId({ session_id: "sess_1", hash: "abc123" }, root)).toBe(
      `obs:${hash}:sess_1:abc123`,
    )
  })

  test("normalizes tags and metadata to stable strings", () => {
    expect(
      MemoryHindsightMap.memoryMetadata(
        {
          id: "memory_1",
          scope: "personal",
          status: "confirmed",
          createdAt: 10,
          updatedAt: 20,
          source: { sessionID: "sess_1", method: "manual" },
        },
        { root },
      ),
    ).toEqual({
      workspace_id: MemoryHindsightBank.worktreeHash(root),
      project_root: root,
      session_id: "sess_1",
      memory_id: "memory_1",
      source_kind: "memory",
      scope: "personal",
      status: "confirmed",
      created_at: "10",
      updated_at: "20",
    })
    expect(
      MemoryHindsightMap.sessionMetadata(
        {
          session_id: "sess_1",
          start: 10,
          end: 20,
          created_at: 30,
          updated_at: 40,
        },
        root,
      ),
    ).toEqual({
      workspace_id: MemoryHindsightBank.worktreeHash(root),
      project_root: root,
      session_id: "sess_1",
      source_kind: "session_slice",
      slice_start: "10",
      slice_end: "20",
      created_at: "30",
      updated_at: "40",
    })
    expect(
      MemoryHindsightMap.memoryTags({
        scope: "personal",
        status: "confirmed",
        categories: ["style", "style", "tool"],
        tags: ["Needs Review", "needs-review", "  Bun APIs  "],
      }),
    ).toEqual([
      "category:style",
      "category:tool",
      "memory",
      "scope:personal",
      "status:confirmed",
      "tag:bun-apis",
      "tag:needs-review",
    ])
    expect(MemoryHindsightMap.sessionTags({ tags: [" recent context ", "Recent Context"] })).toEqual([
      "session_slice",
      "tag:recent-context",
    ])
  })

  test("prefers reversible mem document ids during resolve", () => {
    const hash = MemoryHindsightBank.worktreeHash(root)
    expect(
      MemoryHindsightMap.resolve(
        {
          document_id: `mem:${hash}:memory_1`,
          metadata: { memory_id: "memory_2" },
        },
        root,
      ),
    ).toEqual({
      kind: "mem",
      memory_id: "memory_1",
      document_id: `mem:${hash}:memory_1`,
      direct: true,
      reason: "document_id",
    })
  })

  test("falls back to metadata when document ids are not reversible", () => {
    expect(
      MemoryHindsightMap.resolve(
        {
          document_id: "external-doc",
          metadata: { memory_id: "memory_9", workspace_id: MemoryHindsightBank.worktreeHash(root) },
        },
        root,
      ),
    ).toEqual({
      kind: "mem",
      memory_id: "memory_9",
      document_id: "external-doc",
      direct: true,
      reason: "metadata",
    })
  })

  test("rejects cross-worktree hits and keeps sess or obs hits indirect", () => {
    const other = "/tmp/opencode/other"
    const hash = MemoryHindsightBank.worktreeHash(other)
    expect(MemoryHindsightMap.resolve({ document_id: `mem:${hash}:memory_1` }, root)).toEqual({
      kind: "mem",
      document_id: `mem:${hash}:memory_1`,
      direct: false,
      reason: "cross_worktree",
    })
    expect(
      MemoryHindsightMap.resolve(
        {
          document_id: `sess:${MemoryHindsightBank.worktreeHash(root)}:sess_1:0:10`,
        },
        root,
      ),
    ).toEqual({
      kind: "sess",
      document_id: `sess:${MemoryHindsightBank.worktreeHash(root)}:sess_1:0:10`,
      direct: false,
      reason: "document_id",
    })
  })
})
