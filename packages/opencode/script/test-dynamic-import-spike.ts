#!/usr/bin/env bun
/**
 * US-012: AI SDK lazy loading spike
 *
 * Tests whether Bun compile mode supports dynamic import() for AI SDK providers.
 * Patterns tested:
 *   1. Static string dynamic import: import("@ai-sdk/anthropic")
 *   2. Map-based registry with computed keys: registry[key]()
 *   3. Variable-based dynamic import: import(variable)
 *   4. Import caching: second import of same module
 *
 * FINDINGS (verified 2026-02-13):
 *   - Pattern 1 (static string): WORKS in both interpreted and compiled mode
 *   - Pattern 2 (map registry):  WORKS in both — bundler statically analyzes arrow functions with import() literals
 *   - Pattern 3 (computed var):  FAILS in compiled mode — bundler cannot resolve non-literal import() specifiers
 *   - Pattern 4 (caching):       WORKS — subsequent import() of same module returns cached reference (~0ms)
 *
 * RECOMMENDATION for US-013:
 *   Use the Map-based registry pattern (Pattern 2) with static string import() inside arrow functions.
 *   Do NOT use variable-computed import paths — they fail in Bun compile mode.
 *
 * Usage:
 *   cd packages/opencode && bun run script/test-dynamic-import-spike.ts            # interpreted mode
 *   cd /tmp && bun build --compile <repo>/packages/opencode/script/test-dynamic-import-spike.ts --outfile /tmp/spike-test && /tmp/spike-test  # compiled mode
 */

const results: Array<{
  pattern: string
  success: boolean
  error?: string
  hasCreateFunction: boolean
  duration_ms: number
}> = []

// Pattern 1: Static string dynamic import
async function testStaticStringImport() {
  const start = performance.now()
  const mod = await import("@ai-sdk/anthropic").catch((e: Error) => ({ error: e.message }))
  const duration = performance.now() - start
  const hasCreate = "createAnthropic" in mod
  results.push({
    pattern: "static-string: import('@ai-sdk/anthropic')",
    success: hasCreate,
    error: "error" in mod ? mod.error : undefined,
    hasCreateFunction: hasCreate,
    duration_ms: Math.round(duration * 100) / 100,
  })
}

// Pattern 2: Map-based registry with lazy factory functions
async function testMapBasedRegistry() {
  const registry: Record<string, () => Promise<any>> = {
    "@ai-sdk/anthropic": () => import("@ai-sdk/anthropic"),
    "@ai-sdk/openai": () => import("@ai-sdk/openai"),
    "@ai-sdk/google": () => import("@ai-sdk/google"),
  }

  for (const [key, loader] of Object.entries(registry)) {
    const start = performance.now()
    const mod = await loader().catch((e: Error) => ({ error: e.message }))
    const duration = performance.now() - start

    const expectedFn =
      key === "@ai-sdk/anthropic" ? "createAnthropic" : key === "@ai-sdk/openai" ? "createOpenAI" : "createGoogleGenerativeAI"

    const hasCreate = expectedFn in mod
    results.push({
      pattern: `map-registry: registry["${key}"]()`,
      success: hasCreate,
      error: "error" in mod ? mod.error : undefined,
      hasCreateFunction: hasCreate,
      duration_ms: Math.round(duration * 100) / 100,
    })
  }
}

// Pattern 3: Computed/variable-based dynamic import
async function testComputedImport() {
  const packages = ["@ai-sdk/anthropic", "@ai-sdk/openai", "@ai-sdk/xai"]

  for (const pkg of packages) {
    const start = performance.now()
    const mod = await import(pkg).catch((e: Error) => ({ error: e.message }))
    const duration = performance.now() - start

    const hasExports = Object.keys(mod).length > 0 && !("error" in mod)
    results.push({
      pattern: `computed-variable: import(pkg) where pkg="${pkg}"`,
      success: hasExports,
      error: "error" in mod ? mod.error : undefined,
      hasCreateFunction: hasExports,
      duration_ms: Math.round(duration * 100) / 100,
    })
  }
}

// Pattern 4: Second import of same module (cache verification)
async function testImportCaching() {
  const start1 = performance.now()
  const mod1 = await import("@ai-sdk/anthropic").catch((e: Error) => ({ error: e.message }))
  const duration1 = performance.now() - start1

  const start2 = performance.now()
  const mod2 = await import("@ai-sdk/anthropic").catch((e: Error) => ({ error: e.message }))
  const duration2 = performance.now() - start2

  const success = "createAnthropic" in mod1 && "createAnthropic" in mod2
  results.push({
    pattern: `import-caching: first=${Math.round(duration1 * 100) / 100}ms, second=${Math.round(duration2 * 100) / 100}ms`,
    success,
    error: "error" in mod1 ? (mod1 as any).error : undefined,
    hasCreateFunction: success,
    duration_ms: Math.round(duration2 * 100) / 100,
  })
}

async function main() {
  const isCompiled = process.execPath !== process.argv[0] || !process.argv[1]
  const mode = isCompiled ? "compiled" : "interpreted"
  console.log(`\n=== Bun Dynamic Import Spike Test (${mode} mode) ===\n`)

  await testStaticStringImport()
  await testMapBasedRegistry()
  await testComputedImport()
  await testImportCaching()

  console.log("Results:")
  console.log("--------")
  for (const r of results) {
    const status = r.success ? "PASS" : "FAIL"
    console.log(`  [${status}] ${r.pattern} (${r.duration_ms}ms)`)
    if (r.error) console.log(`         Error: ${r.error}`)
  }

  const allPassed = results.every((r) => r.success)
  console.log(`\nOverall: ${allPassed ? "ALL PATTERNS WORK" : "SOME PATTERNS FAILED"}`)
  console.log(`Total patterns tested: ${results.length}`)
  console.log(`Passed: ${results.filter((r) => r.success).length}`)
  console.log(`Failed: ${results.filter((r) => !r.success).length}`)

  if (!allPassed) {
    console.log("\nFailed patterns:")
    for (const r of results.filter((r) => !r.success)) {
      console.log(`  - ${r.pattern}: ${r.error ?? "unknown error"}`)
    }
  }

  // Output structured JSON for programmatic consumption
  console.log("\n--- JSON OUTPUT ---")
  console.log(JSON.stringify({ mode, results, allPassed }, null, 2))
}

main()
