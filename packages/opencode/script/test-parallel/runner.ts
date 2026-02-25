import type { RunnerConfig, WorkerResult } from "./types"

const num = (text: string, pattern: RegExp) => {
  const m = text.match(pattern)
  return m ? parseInt(m[1], 10) : 0
}

export const parseOutput = (stderr: string): { pass: number; fail: number; skip: number } => ({
  pass: num(stderr, /(\d+)\s+pass/),
  fail: num(stderr, /(\d+)\s+fail/),
  skip: num(stderr, /(\d+)\s+skip/),
})

const spawnWorker = (file: string, config: RunnerConfig) => {
  const start = Date.now()
  const proc = Bun.spawn(["bun", "test", file], {
    stdout: "pipe",
    stderr: "pipe",
  })

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

    const stderr = proc.stderr ? await new Response(proc.stderr).text().catch(() => "") : ""
    const counts = parseOutput(stderr)

    return { file, ...counts, duration, ...(counts.fail > 0 ? { error: stderr } : {}) }
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
