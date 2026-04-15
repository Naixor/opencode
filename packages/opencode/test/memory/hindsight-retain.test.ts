import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Memory } from "../../src/memory/memory"
import { MemoryHindsightClient } from "../../src/memory/hindsight/client"
import { MemoryHindsightMap } from "../../src/memory/hindsight/mapper"
import { MemoryHindsightRetain } from "../../src/memory/hindsight/retain"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

await Log.init({ print: false })

function cfg(enabled = true) {
  return {
    enabled,
    mode: "embedded" as const,
    extract: true,
    recall: true,
    backfill: true,
    workspace_scope: "worktree" as const,
    context_max_items: 6,
    context_max_tokens: 1200,
  }
}

function item() {
  return Memory.Info.parse({
    id: "memory_1",
    content: "Prefer Bun APIs when they fit the task.",
    categories: ["style", "tool"],
    scope: "personal",
    status: "confirmed",
    tags: ["bun", "Bun APIs"],
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
    createdAt: 10,
    updatedAt: 20,
  })
}

function slice() {
  return {
    session_id: "sess_1",
    start: 0,
    end: 2,
    content: "[user]: Keep Hono for APIs\n---\n[assistant]: Okay.",
    created_at: 10,
    updated_at: 20,
    tags: ["recent context"],
  }
}

beforeEach(() => {
  mock.restore()
})

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

describe("MemoryHindsightRetain", () => {
  test("maps authoritative memories into replace-style retain calls", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: cfg(true),
        },
      },
    })

    const calls: Array<Parameters<typeof MemoryHindsightClient.retain>[0]> = []
    spyOn(MemoryHindsightClient, "retain").mockImplementation(async (input) => {
      calls.push(input)
      return {
        success: true,
        bank_id: "bank_1",
        items_count: 1,
        async: false,
      }
    })

    const result = await Instance.provide({
      directory: tmp.path,
      fn: () => MemoryHindsightRetain.memory(item()),
    })

    expect(result.status).toBe("retained")
    expect(result.document_id).toBe(MemoryHindsightMap.memoryDocumentId(item(), tmp.path))
    expect(calls).toEqual([
      {
        content: item().content,
        timestamp: new Date(item().updatedAt).toISOString(),
        metadata: MemoryHindsightMap.memoryMetadata(item(), { root: tmp.path }),
        document_id: MemoryHindsightMap.memoryDocumentId(item(), tmp.path),
        tags: MemoryHindsightMap.memoryTags(item()),
        update_mode: "replace",
      },
    ])
  })

  test("returns a non-fatal failure when retain cannot persist the document", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: cfg(true),
        },
      },
    })

    const calls: Array<Parameters<typeof MemoryHindsightClient.retain>[0]> = []
    spyOn(MemoryHindsightClient, "retain").mockImplementation(async (input) => {
      calls.push(input)
      return undefined
    })

    const result = await Instance.provide({
      directory: tmp.path,
      fn: () => MemoryHindsightRetain.memory(item()),
    })

    expect(result).toEqual({
      status: "failed",
      document_id: MemoryHindsightMap.memoryDocumentId(item(), tmp.path),
      error: "retain returned no result",
    })
    expect(calls).toHaveLength(1)
  })

  test("skips retain calls when hindsight is disabled", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: cfg(false),
        },
      },
    })

    const spy = spyOn(MemoryHindsightClient, "retain").mockImplementation(async () => {
      throw new Error("should not run")
    })

    const result = await Instance.provide({
      directory: tmp.path,
      fn: () => MemoryHindsightRetain.memory(item()),
    })

    expect(result).toEqual({
      status: "disabled",
      document_id: MemoryHindsightMap.memoryDocumentId(item(), tmp.path),
    })
    expect(spy).not.toHaveBeenCalled()
  })

  test("maps session slices into replace-style retain calls", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: cfg(true),
        },
      },
    })

    const calls: Array<Parameters<typeof MemoryHindsightClient.retain>[0]> = []
    spyOn(MemoryHindsightClient, "retain").mockImplementation(async (input) => {
      calls.push(input)
      return {
        success: true,
        bank_id: "bank_1",
        items_count: 1,
        async: false,
      }
    })

    const result = await Instance.provide({
      directory: tmp.path,
      fn: () => MemoryHindsightRetain.session(slice()),
    })

    expect(result.status).toBe("retained")
    expect(result.document_id).toBe(MemoryHindsightMap.sessionDocumentId(slice(), tmp.path))
    expect(calls).toEqual([
      {
        content: slice().content,
        timestamp: new Date(slice().updated_at).toISOString(),
        metadata: MemoryHindsightMap.sessionMetadata(slice(), tmp.path),
        document_id: MemoryHindsightMap.sessionDocumentId(slice(), tmp.path),
        tags: MemoryHindsightMap.sessionTags({ tags: slice().tags }),
        update_mode: "replace",
      },
    ])
  })
})
