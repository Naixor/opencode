import { minimatch } from "minimatch"
import type { TimingData } from "./types"

export const discoverFiles = (root: string, pattern?: string): string[] => {
  const glob = new Bun.Glob("**/*.test.ts")
  const files = [...glob.scanSync({ cwd: root, absolute: true })]
  if (!pattern) return files
  return files.filter((f) => minimatch(f, pattern))
}

export const buildQueue = (files: string[], timing: TimingData): string[] => {
  const timed = files.filter((f) => timing[f] !== undefined)
  const untimed = files.filter((f) => timing[f] === undefined)
  timed.sort((a, b) => timing[b].avg - timing[a].avg)
  untimed.sort()
  return [...timed, ...untimed]
}
