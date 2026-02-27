#!/usr/bin/env bun

import { cpus } from "os"
import { resolve } from "path"
import { discoverFiles, buildQueue } from "./test-parallel/discover"
import { readTiming, writeTiming } from "./test-parallel/timing"
import { runAll } from "./test-parallel/runner"
import { printFileResult, printSummary, writeReport } from "./test-parallel/reporter"
import type { RunnerConfig } from "./test-parallel/types"

const args = process.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "Usage: bun run test:parallel [options]",
      "",
      "Options:",
      "  --workers, --max-workers N   Max concurrent workers (default: CPU count)",
      "  --pattern <glob>             Filter test files by glob pattern",
      "  --timeout N                  Per-file timeout in seconds (default: 120)",
      "  --reporter json|junit        Write test-results.json or test-results.xml",
      "  --shard N/M                  Run shard N of M (env: TEST_SHARD_INDEX/TEST_SHARD_TOTAL)",
      "  --silent                     Suppress per-file output",
      "  --verbose                    Enable verbose output",
      "  --stop-on-failure            Stop after first failing file",
      "  --help                       Print this usage and exit",
    ].join("\n"),
  )
  process.exit(0)
}

const getArg = (flag: string, alias?: string): string | undefined => {
  const idx = args.indexOf(flag)
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1]
  if (!alias) return undefined
  const ai = args.indexOf(alias)
  if (ai !== -1 && ai + 1 < args.length) return args[ai + 1]
  return undefined
}

const maxWorkers = parseInt(getArg("--workers", "--max-workers") ?? String(cpus().length), 10)
const timeout = parseInt(getArg("--timeout") ?? "120", 10)
const pattern = getArg("--pattern")
const rawReporter = getArg("--reporter")
const reporter = rawReporter === "json" || rawReporter === "junit" ? rawReporter : undefined
const silent = args.includes("--silent")
const verbose = args.includes("--verbose")
const stopOnFailure = args.includes("--stop-on-failure")

const rawShard =
  getArg("--shard") ??
  (process.env.TEST_SHARD_INDEX && process.env.TEST_SHARD_TOTAL
    ? `${process.env.TEST_SHARD_INDEX}/${process.env.TEST_SHARD_TOTAL}`
    : undefined)

const parseShard = (raw: string | undefined) => {
  if (!raw) return undefined
  const parts = raw.split("/")
  const index = parseInt(parts[0], 10)
  const total = parseInt(parts[1], 10)
  return Number.isNaN(index) || Number.isNaN(total) ? undefined : { index, total }
}

const shard = parseShard(rawShard)

const config: RunnerConfig = { maxWorkers, timeout, stopOnFailure, silent, verbose, pattern, reporter, shard }

const testDir = resolve(import.meta.dir, "../test")
const timingPath = resolve(import.meta.dir, "../.test-timing.json")
const reportsDir = resolve(import.meta.dir, "../test-results")

const timing = await readTiming(timingPath)
const files = discoverFiles(testDir, pattern)
const queue = buildQueue(files, timing)
const sharded = shard ? queue.filter((_, i) => i % shard.total === shard.index - 1) : queue

const wallStart = Date.now()
const results = await runAll(sharded, config, (result, index, total) => {
  printFileResult(result, index, total, config)
})
const wallTime = Date.now() - wallStart

printSummary(results, wallTime, config)
await writeTiming(timingPath, timing, results)
if (reporter) await writeReport(results, reporter, reportsDir)

const failed = results.filter((r) => r.fail > 0)
if (failed.length > 0) {
  const debugPath = resolve(import.meta.dir, "../.test-failures.json")
  await Bun.write(debugPath, JSON.stringify(failed, null, 2))
  console.log(`\nDebug dump: ${debugPath}`)
}

process.exit(failed.length > 0 ? 1 : 0)
