export namespace StartupTrace {
  export interface Phase {
    phase: string
    duration_ms: number
    children?: Phase[]
  }

  const processStart = performance.timeOrigin

  const stack: Phase[][] = [[]]
  const starts = new Map<string, number>()
  let enabled = false

  export function enable() {
    enabled = true
  }

  export function isEnabled() {
    return enabled
  }

  export function begin(phase: string) {
    starts.set(phase, performance.now())
    stack.push([])
  }

  export function end(phase: string) {
    const start = starts.get(phase)
    if (start === undefined) return
    starts.delete(phase)
    const children = stack.pop()!
    const entry: Phase = {
      phase,
      duration_ms: Math.round(performance.now() - start),
    }
    if (children.length > 0) entry.children = children
    stack[stack.length - 1].push(entry)
  }

  export async function measure<T>(phase: string, fn: () => T | Promise<T>): Promise<T> {
    begin(phase)
    const result = await fn()
    end(phase)
    return result
  }

  export function record(phase: string, duration_ms: number) {
    stack[stack.length - 1].push({ phase, duration_ms: Math.round(duration_ms) })
  }

  export function output() {
    if (!enabled) return
    const total_ms = Math.round(performance.now())
    const phases = stack[0]
    const trace = {
      total_ms,
      process_start: new Date(processStart).toISOString(),
      phases,
    }
    process.stderr.write(JSON.stringify(trace, null, 2) + "\n")
  }
}
