import { resolve } from "path"
import type { RunnerConfig, WorkerResult } from "./types"

const num = (text: string, pattern: RegExp) => {
  const m = text.match(pattern)
  return m ? parseInt(m[1], 10) : 0
}

export const parseOutput = (stderr: string): { pass: number; fail: number; skip: number } => ({
  pass: num(stderr, /(\d+)\s+pass\b/),
  fail: num(stderr, /(\d+)\s+fail\b/),
  skip: num(stderr, /(\d+)\s+skip\b/),
})

// Package root: script/test-parallel/ → script/ → package root
const PKG_ROOT = resolve(import.meta.dir, "../..")

// Per-test timeout passed explicitly so it applies regardless of whether bunfig.toml is found.
// 120 s matches the file-level timeout — individual tests should never exceed this even under
// very heavy parallel load (Config.get, git init, 20-way parallelism, etc.).
const PER_TEST_TIMEOUT_MS = 120_000

const spawnWorker = (file: string, config: RunnerConfig) => {
  const start = Date.now()
  const proc = Bun.spawn(["bun", "test", "--timeout", String(PER_TEST_TIMEOUT_MS), file], {
    cwd: PKG_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })

  // Drain both streams immediately so the subprocess never blocks on a full
  // pipe buffer, and so the data is available regardless of when we read it.
  const stdoutPromise = new Response(proc.stdout).text().catch(() => "")
  const stderrPromise = new Response(proc.stderr).text().catch(() => "")

  const resultPromise: Promise<WorkerResult> = Promise.race([
    proc.exited.then(() => false as const),
    new Promise<true>((resolve) =>
      setTimeout(() => {
        proc.kill()
        resolve(true)
      }, config.timeout * 1000),
    ),
  ]).then(async (timedOut) => {
    const duration = Date.now() - start
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    if (timedOut) return { file, pass: 0, fail: 1, skip: 0, duration, error: `Timeout after ${config.timeout}s\n${[stdout.trim(), stderr.trim()].filter(Boolean).join("\n")}` }

    // Bun writes the banner to stdout and all test output (details + summary) to stderr.
    const counts = parseOutput(stderr)
    const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")

    // Debug: dump raw streams to /tmp when a failure is detected so we can
    // inspect exactly what bun wrote regardless of terminal display issues.
    if (counts.fail > 0) {
      const slug = file.replace(/[^a-z0-9]/gi, "_").slice(-60)
      const base = `/tmp/bun-test-fail-${slug}-${Date.now()}`
      await Promise.all([
        Bun.write(`${base}.stdout.txt`, stdout),
        Bun.write(`${base}.stderr.txt`, stderr),
        Bun.write(`${base}.counts.json`, JSON.stringify({ counts, combined_len: combined.length }, null, 2)),
      ])
      process.stderr.write(`[debug] fail dump → ${base}.{stdout,stderr,counts}.txt\n`)
    }

    return { file, ...counts, duration, ...(counts.fail > 0 ? { error: combined } : {}) }
  })

  return { resultPromise, kill: () => proc.kill() }
}

export const runWorker = (file: string, config: RunnerConfig): Promise<WorkerResult> =>
  spawnWorker(file, config).resultPromise

export const runAll = async (
  files: string[],
  config: RunnerConfig,
  onComplete: (r: WorkerResult, index: number, total: number) => void,
): Promise<WorkerResult[]> => {
  const total = files.length
  const results: WorkerResult[] = []
  const activeFns = new Set<() => void>()
  const queue = [...files]
  const stopped = { value: false }

  const killActive = () => activeFns.forEach((kill) => kill())

  const runNext = async (): Promise<void> => {
    while (queue.length > 0 && !stopped.value) {
      const file = queue.shift()!
      const { resultPromise, kill } = spawnWorker(file, config)
      activeFns.add(kill)
      const result = await resultPromise
      activeFns.delete(kill)

      if (stopped.value) return

      results.push(result)
      onComplete(result, results.length, total)

      if (config.stopOnFailure && result.fail > 0) {
        stopped.value = true
        killActive()
        return
      }
    }
  }

  const workerCount = Math.min(config.maxWorkers, total)
  if (workerCount > 0) await Promise.all(Array.from({ length: workerCount }, () => runNext()))

  return results
}
