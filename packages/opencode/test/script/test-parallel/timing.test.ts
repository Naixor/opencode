import { describe, expect, test } from "bun:test"
import { tmpdir } from "os"
import { join } from "path"
import { readTiming, writeTiming } from "../../../script/test-parallel/timing"
import type { TimingData } from "../../../script/test-parallel/types"

const tmp = (name: string) => join(tmpdir(), `opencode-timing-test-${name}-${Date.now()}.json`)

// ── readTiming ─────────────────────────────────────────────────────────────

describe("readTiming", () => {
  test("returns empty object when file does not exist", async () => {
    expect(await readTiming("/nonexistent/path/timing.json")).toEqual({})
  })

  test("reads and parses valid timing file", async () => {
    const path = tmp("read-valid")
    const data: TimingData = { "test/foo.test.ts": { avg: 1234, runs: 3 } }
    await Bun.write(path, JSON.stringify(data))
    expect(await readTiming(path)).toEqual(data)
  })

  test("returns empty object for malformed JSON", async () => {
    const path = tmp("read-malformed")
    await Bun.write(path, "{ not valid json }")
    expect(await readTiming(path)).toEqual({})
  })
})

// ── writeTiming ────────────────────────────────────────────────────────────

describe("writeTiming", () => {
  test("creates new entry for a file with no prior history", async () => {
    const path = tmp("write-new")
    await writeTiming(path, {}, [{ file: "test/foo.test.ts", pass: 5, fail: 0, skip: 0, duration: 500 }])
    const written: TimingData = await Bun.file(path).json()
    expect(written["test/foo.test.ts"]).toEqual({ avg: 500, runs: 1 })
  })

  test("applies exponential moving average (0.7 new + 0.3 old) for existing entry", async () => {
    const path = tmp("write-ema")
    const existing: TimingData = { "test/foo.test.ts": { avg: 1000, runs: 5 } }
    await writeTiming(path, existing, [{ file: "test/foo.test.ts", pass: 5, fail: 0, skip: 0, duration: 500 }])
    const written: TimingData = await Bun.file(path).json()
    // 0.7 * 500 + 0.3 * 1000 = 350 + 300 = 650
    expect(written["test/foo.test.ts"].avg).toBeCloseTo(650)
    expect(written["test/foo.test.ts"].runs).toBe(6)
  })

  test("increments run count on each write", async () => {
    const path = tmp("write-runs")
    const existing: TimingData = { "test/bar.test.ts": { avg: 200, runs: 10 } }
    await writeTiming(path, existing, [{ file: "test/bar.test.ts", pass: 1, fail: 0, skip: 0, duration: 200 }])
    const written: TimingData = await Bun.file(path).json()
    expect(written["test/bar.test.ts"].runs).toBe(11)
  })

  test("only writes files present in results (omits files not in current run)", async () => {
    const path = tmp("write-drop")
    const existing: TimingData = {
      "test/old.test.ts": { avg: 200, runs: 1 },
      "test/kept.test.ts": { avg: 300, runs: 2 },
    }
    await writeTiming(path, existing, [{ file: "test/kept.test.ts", pass: 1, fail: 0, skip: 0, duration: 400 }])
    const written: TimingData = await Bun.file(path).json()
    expect(Object.keys(written)).not.toContain("test/old.test.ts")
    expect(Object.keys(written)).toContain("test/kept.test.ts")
  })

  test("writes valid JSON to disk", async () => {
    const path = tmp("write-json")
    await writeTiming(path, {}, [{ file: "test/x.test.ts", pass: 2, fail: 0, skip: 0, duration: 100 }])
    const raw = await Bun.file(path).text()
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})
