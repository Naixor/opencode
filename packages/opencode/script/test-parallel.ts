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
      "  --timeout N                  Per-file timeout in seconds (default: 60)",
      "  --reporter json|junit        Write test-results.json or test-results.xml",
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
const timeout = parseInt(getArg("--timeout") ?? "60", 10)
const pattern = getArg("--pattern")
const rawReporter = getArg("--reporter")
const reporter = rawReporter === "json" || rawReporter === "junit" ? rawReporter : undefined
const silent = args.includes("--silent")
const verbose = args.includes("--verbose")
const stopOnFailure = args.includes("--stop-on-failure")

const config: RunnerConfig = { maxWorkers, timeout, stopOnFailure, silent, verbose, pattern, reporter }

const testDir = resolve(import.meta.dir, "../test")
const timingPath = resolve(import.meta.dir, "../.test-timing.json")
const reportsDir = resolve(import.meta.dir, "../test-results")

const timing = await readTiming(timingPath)
const files = discoverFiles(testDir, pattern)
const queue = buildQueue(files, timing)

const wallStart = Date.now()
const results = await runAll(queue, config, (result, index, total) => {
  printFileResult(result, index, total, config)
})
const wallTime = Date.now() - wallStart

printSummary(results, wallTime, config)
await writeTiming(timingPath, timing, results)
if (reporter) await writeReport(results, reporter, reportsDir)

process.exit(results.some((r) => r.fail > 0) ? 1 : 0)
