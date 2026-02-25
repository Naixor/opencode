import { describe, expect, test } from "bun:test"
import { resolve } from "path"
import { parseOutput, runWorker } from "../../../script/test-parallel/runner"
import type { RunnerConfig } from "../../../script/test-parallel/types"

const baseConfig: RunnerConfig = { maxWorkers: 1, timeout: 30, stopOnFailure: false, silent: true, verbose: false }

// ── parseOutput ────────────────────────────────────────────────────────────

describe("parseOutput", () => {
  test("parses standard bun test stderr output", () => {
    const stderr = [
      "bun test v1.3.8 (b64edcb4)",
      "",
      " 3 pass",
      " 0 fail",
      " 15 expect() calls",
      "Ran 3 tests across 1 file. [49.00ms]",
    ].join("\n")
    expect(parseOutput(stderr)).toEqual({ pass: 3, fail: 0, skip: 0 })
  })

  test("parses non-zero fail count", () => {
    const stderr = " 5 pass\n 2 fail\n 0 skip"
    expect(parseOutput(stderr)).toEqual({ pass: 5, fail: 2, skip: 0 })
  })

  test("parses non-zero skip count", () => {
    const stderr = " 10 pass\n 0 fail\n 3 skip"
    expect(parseOutput(stderr)).toEqual({ pass: 10, fail: 0, skip: 3 })
  })

  test("returns zeros for empty string", () => {
    expect(parseOutput("")).toEqual({ pass: 0, fail: 0, skip: 0 })
  })

  test("returns zeros for unsupported-reporter error (regression: --reporter json was invalid)", () => {
    // bun test --reporter json used to produce this error, leaving counts at 0/0/0
    const stderr = "error: unsupported reporter format 'json'. Available options: 'junit' (for XML test results), 'dots'"
    expect(parseOutput(stderr)).toEqual({ pass: 0, fail: 0, skip: 0 })
  })

  test("handles large numbers", () => {
    const stderr = " 1234 pass\n 56 fail\n 78 skip"
    expect(parseOutput(stderr)).toEqual({ pass: 1234, fail: 56, skip: 78 })
  })
})

// ── runWorker (integration) ────────────────────────────────────────────────

describe("runWorker", () => {
  const stableFile = resolve(import.meta.dir, "../../bun.test.ts")

  test("returns positive pass count for a known-passing file", async () => {
    const result = await runWorker(stableFile, baseConfig)
    expect(result.pass).toBeGreaterThan(0)
    expect(result.fail).toBe(0)
  }, 30_000)

  test("sets result.file to the input path", async () => {
    const result = await runWorker(stableFile, baseConfig)
    expect(result.file).toBe(stableFile)
  }, 30_000)

  test("records positive duration in milliseconds", async () => {
    const result = await runWorker(stableFile, baseConfig)
    expect(result.duration).toBeGreaterThan(0)
  }, 30_000)

  test("produces non-zero total (proves stderr is read, not stdout)", async () => {
    // Before the fix, bun only writes the summary to stderr.
    // If stdout were read, pass+fail+skip would always be 0.
    const result = await runWorker(stableFile, baseConfig)
    expect(result.pass + result.fail + result.skip).toBeGreaterThan(0)
  }, 30_000)

  test("marks timed-out worker as fail=1 with Timeout error", async () => {
    const result = await runWorker(stableFile, { ...baseConfig, timeout: 0.001 })
    expect(result.fail).toBe(1)
    expect(result.error).toMatch(/Timeout/)
  }, 10_000)

  test("attaches error text only when fail > 0", async () => {
    const passing = await runWorker(stableFile, baseConfig)
    expect(passing.error).toBeUndefined()
  }, 30_000)
})
