import type { TimingData, WorkerResult } from "./types"

export const readTiming = (path: string): Promise<TimingData> =>
  Bun.file(path)
    .json()
    .catch(() => ({}) as TimingData)

export const writeTiming = async (path: string, existing: TimingData, results: WorkerResult[]): Promise<void> => {
  const updated: TimingData = Object.fromEntries(
    results.map((result) => {
      const prev = existing[result.file]
      const entry = prev
        ? { avg: 0.7 * result.duration + 0.3 * prev.avg, runs: prev.runs + 1 }
        : { avg: result.duration, runs: 1 }
      return [result.file, entry]
    }),
  )
  await Bun.write(path, JSON.stringify(updated, null, 2))
}
