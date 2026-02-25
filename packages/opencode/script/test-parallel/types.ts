export interface WorkerResult {
  file: string
  pass: number
  fail: number
  skip: number
  duration: number
  error?: string
}

export interface TimingEntry {
  avg: number
  runs: number
}

export type TimingData = Record<string, TimingEntry>

export interface RunnerConfig {
  maxWorkers: number
  timeout: number
  stopOnFailure: boolean
  silent: boolean
  verbose: boolean
  pattern?: string
  reporter?: "json" | "junit"
  shard?: { index: number; total: number }
}
