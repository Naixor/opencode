import { join } from "path"
import { mkdir } from "fs/promises"
import type { RunnerConfig, WorkerResult } from "./types"

export const printFileResult = (result: WorkerResult, index: number, total: number, config: RunnerConfig): void => {
  if (config.silent) return

  const icon = result.fail > 0 ? "✗" : "✓"
  const duration = (result.duration / 1000).toFixed(1)
  console.log(`[${index}/${total}] ${icon} ${result.file} (${result.pass} pass, ${result.fail} fail, ${result.skip} skip, ${duration}s)`)

  if (result.fail > 0 && result.error) console.log(result.error)
}

export const printSummary = (results: WorkerResult[], wallTime: number, config: RunnerConfig): void => {
  if (config.silent) return

  const totalPass = results.reduce((sum, r) => sum + r.pass, 0)
  const totalFail = results.reduce((sum, r) => sum + r.fail, 0)
  const totalSkip = results.reduce((sum, r) => sum + r.skip, 0)
  const serialTime = results.reduce((sum, r) => sum + r.duration, 0)
  const speedup = wallTime > 0 ? (serialTime / wallTime).toFixed(2) : "N/A"
  const failed = results.filter((r) => r.fail > 0)

  console.log("")
  console.log("─".repeat(60))
  console.log(`Files:   ${results.length}`)
  console.log(`Pass:    ${totalPass}`)
  console.log(`Fail:    ${totalFail}`)
  console.log(`Skip:    ${totalSkip}`)
  console.log(`Wall:    ${(wallTime / 1000).toFixed(2)}s`)
  console.log(`Serial:  ${(serialTime / 1000).toFixed(2)}s`)
  console.log(`Speedup: ${speedup}x`)

  if (failed.length === 0) return

  console.log("")
  console.log("Failed files:")
  failed.forEach((r) => console.log(`  ✗ ${r.file} (${r.fail} fail)`))
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const toJunit = (results: WorkerResult[]): string => {
  const suites = results
    .map((r) => {
      const time = (r.duration / 1000).toFixed(3)
      const failure =
        r.fail > 0 ? `\n      <failure message="Test failures">${r.error ? escapeXml(r.error) : ""}</failure>` : ""
      return (
        `  <testsuite name="${escapeXml(r.file)}" tests="${r.pass + r.fail + r.skip}" failures="${r.fail}" skipped="${r.skip}" time="${time}">\n` +
        `    <testcase name="${escapeXml(r.file)}" time="${time}">${failure}</testcase>\n` +
        `  </testsuite>`
      )
    })
    .join("\n")

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites}\n</testsuites>\n`
}

export const writeReport = async (results: WorkerResult[], format: "json" | "junit", outDir: string): Promise<void> => {
  await mkdir(outDir, { recursive: true }).catch(() => undefined)

  if (format === "json") {
    await Bun.write(join(outDir, "test-results.json"), JSON.stringify(results, null, 2))
    return
  }

  await Bun.write(join(outDir, "test-results.xml"), toJunit(results))
}
