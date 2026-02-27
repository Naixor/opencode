import { describe, expect, test } from "bun:test"
import { resolve } from "path"
import { discoverFiles, buildQueue } from "../../../script/test-parallel/discover"
import type { TimingData } from "../../../script/test-parallel/types"

const testDir = resolve(import.meta.dir, "../..")

// ── discoverFiles ──────────────────────────────────────────────────────────

describe("discoverFiles", () => {
  test("returns only .test.ts files", () => {
    const files = discoverFiles(testDir)
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((f) => f.endsWith(".test.ts"))).toBe(true)
  })

  test("returns absolute paths", () => {
    const files = discoverFiles(testDir)
    expect(files.every((f) => f.startsWith("/"))).toBe(true)
  })

  test("pattern filter limits results", () => {
    const all = discoverFiles(testDir)
    const filtered = discoverFiles(testDir, "**/bun.test.ts")
    expect(filtered.length).toBeGreaterThanOrEqual(1)
    expect(filtered.length).toBeLessThan(all.length)
    expect(filtered.every((f) => f.endsWith("bun.test.ts"))).toBe(true)
  })

  test("non-matching pattern returns empty array", () => {
    expect(discoverFiles(testDir, "**/zzz-nonexistent-xyz.test.ts")).toEqual([])
  })
})

// ── buildQueue ─────────────────────────────────────────────────────────────

describe("buildQueue", () => {
  test("places timed files before untimed files", () => {
    const files = ["/a.test.ts", "/b.test.ts", "/c.test.ts"]
    const timing: TimingData = { "/c.test.ts": { avg: 500, runs: 1 } }
    const queue = buildQueue(files, timing)
    expect(queue[0]).toBe("/c.test.ts")
  })

  test("sorts timed files by avg desc (slowest first = LPT order)", () => {
    const files = ["/a.test.ts", "/b.test.ts", "/c.test.ts"]
    const timing: TimingData = {
      "/a.test.ts": { avg: 100, runs: 1 },
      "/b.test.ts": { avg: 300, runs: 1 },
      "/c.test.ts": { avg: 200, runs: 1 },
    }
    const queue = buildQueue(files, timing)
    expect(queue[0]).toBe("/b.test.ts")
    expect(queue[1]).toBe("/c.test.ts")
    expect(queue[2]).toBe("/a.test.ts")
  })

  test("sorts untimed files alphabetically", () => {
    const files = ["/z.test.ts", "/a.test.ts", "/m.test.ts"]
    const queue = buildQueue(files, {})
    expect(queue[0]).toBe("/a.test.ts")
    expect(queue[1]).toBe("/m.test.ts")
    expect(queue[2]).toBe("/z.test.ts")
  })

  test("handles empty files array", () => {
    expect(buildQueue([], {})).toEqual([])
  })

  test("returns all files unchanged when timing is empty", () => {
    const files = ["/x.test.ts", "/y.test.ts"]
    expect(buildQueue(files, {}).sort()).toEqual(files.sort())
  })
})
