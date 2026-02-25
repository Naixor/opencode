import { join } from "path"
import { tmpdir } from "os"
import { unlink } from "fs/promises"
import type { RunnerConfig, WorkerResult } from "./types"

const tryParse = (s: string) => Promise.resolve(s).then(JSON.parse).catch(() => null)

const parseOutput = async (stdout: string): Promise<{ pass: number; fail: number; skip: number }> => {
  const lines = stdout.trim().split("\n").filter(Boolean)
  const parsed = await Promise.all(lines.map(tryParse))

  const summary = [...parsed].reverse().find((p) => p !== null && typeof p.passed === "number")
  if (summary) return { pass: summary.passed ?? 0, fail: summary.failed ?? 0, skip: summary.skipped ?? 0 }

  const altSummary = [...parsed].reverse().find((p) => p !== null && typeof p.pass === "number")
  if (altSummary) return { pass: altSummary.pass ?? 0, fail: altSummary.fail ?? 0, skip: altSummary.skip ?? 0 }

  return { pass: 0, fail: 0, skip: 0 }
}

const spawnWorker = (file: string, config: RunnerConfig) => {
  const start = Date.now()
  const proc = Bun.spawn(["bun", "test", "--reporter", "json", file], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const tmpPath = join(tmpdir(), `worker-${proc.pid}.json`)

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
    if (timedOut) return { file, pass: 0, fail: 1, skip: 0, duration, error: `Timeout after ${config.timeout}s` }

    const stdout = proc.stdout ? await new Response(proc.stdout).text().catch(() => "") : ""
    await Bun.write(tmpPath, stdout).catch(() => undefined)
    const counts = await parseOutput(stdout)
    await unlink(tmpPath).catch(() => undefined)

    return { file, ...counts, duration, ...(counts.fail > 0 ? { error: stdout } : {}) }
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
