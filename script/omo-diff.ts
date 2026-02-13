#!/usr/bin/env bun

/**
 * OMO Upstream Diff Reporting Tool
 *
 * Fetches the latest oh-my-opencode package from npm, compares against the
 * local baseline (.omo-baseline.json), and generates a structured diff report.
 *
 * Usage: bun run script/omo-diff.ts [--update-baseline]
 */

import path from "path"
import fs from "fs"
import os from "os"

// ─── Types ───────────────────────────────────────────────────────────

export type BaselineToolStatus = "internalized" | "skipped" | "partial"
export type BaselineAgentStatus = "internalized" | "optional" | "skipped"
export type BaselineHookStatus = "internalized" | "skipped" | "partial"

export interface Baseline {
  version: string
  date: string
  tools: Record<string, BaselineToolStatus>
  hooks: Record<string, BaselineHookStatus>
  agents: Record<string, BaselineAgentStatus>
  notes: string
}

export type ChangeCategory = "backport recommended" | "review needed" | "skip (diverged)"

export interface DiffChange {
  name: string
  type: "tool" | "hook" | "agent" | "config" | "dependency"
  status: "new" | "modified" | "removed"
  category: ChangeCategory
  details: string
  affectedFiles: string[]
}

export interface DiffReport {
  baselineVersion: string
  latestVersion: string
  date: string
  changes: DiffChange[]
  sections: {
    tools: DiffChange[]
    hooks: DiffChange[]
    agents: DiffChange[]
    config: DiffChange[]
    dependencies: DiffChange[]
  }
}

// ─── Baseline Defaults ──────────────────────────────────────────────

const BASELINE_DEFAULTS: Baseline = {
  version: "0.0.0",
  date: "",
  tools: {},
  hooks: {},
  agents: {},
  notes: "",
}

/**
 * Parse and validate a baseline object, applying defaults for missing fields.
 */
export function parseBaseline(raw: unknown): Baseline {
  if (!raw || typeof raw !== "object") return { ...BASELINE_DEFAULTS }
  const obj = raw as Record<string, unknown>
  return {
    version: typeof obj.version === "string" ? obj.version : BASELINE_DEFAULTS.version,
    date: typeof obj.date === "string" ? obj.date : BASELINE_DEFAULTS.date,
    tools: (typeof obj.tools === "object" && obj.tools !== null ? obj.tools : {}) as Record<string, BaselineToolStatus>,
    hooks: (typeof obj.hooks === "object" && obj.hooks !== null ? obj.hooks : {}) as Record<string, BaselineHookStatus>,
    agents: (typeof obj.agents === "object" && obj.agents !== null ? obj.agents : {}) as Record<string, BaselineAgentStatus>,
    notes: typeof obj.notes === "string" ? obj.notes : BASELINE_DEFAULTS.notes,
  }
}

// ─── Impact Mapping ──────────────────────────────────────────────────

const TOOL_IMPACT_MAP: Record<string, string[]> = {
  glob: ["packages/opencode/src/tool/glob.ts"],
  grep: ["packages/opencode/src/tool/grep.ts"],
  lsp: ["packages/opencode/src/tool/lsp.ts", "packages/opencode/src/tool/lsp-tools.ts", "packages/opencode/src/tool/lsp-tools-extended.ts"],
  "ast-grep": ["packages/opencode/src/tool/ast-grep.ts"],
  "delegate-task": ["packages/opencode/src/tool/delegate-task.ts"],
  "look-at": ["packages/opencode/src/tool/look-at.ts"],
  "skill-mcp": ["packages/opencode/src/tool/skill-mcp.ts"],
  "interactive-bash": ["packages/opencode/src/tool/interactive-bash.ts"],
  task: ["packages/opencode/src/tool/task.ts", "packages/opencode/src/tool/delegate-task.ts"],
}

const HOOK_IMPACT_MAP: Record<string, string[]> = {
  "edit-error-recovery": ["packages/opencode/src/session/hooks/error-recovery.ts"],
  "context-window-limit-recovery": ["packages/opencode/src/session/hooks/error-recovery.ts"],
  "delegate-task-retry": ["packages/opencode/src/session/hooks/error-recovery.ts"],
  "iterative-error-recovery": ["packages/opencode/src/session/hooks/error-recovery.ts"],
  "tool-output-truncator": ["packages/opencode/src/session/hooks/output-management.ts"],
  "grep-output-truncator": ["packages/opencode/src/session/hooks/output-management.ts"],
  "context-window-monitor": ["packages/opencode/src/session/hooks/output-management.ts"],
  "preemptive-compaction": ["packages/opencode/src/session/hooks/output-management.ts"],
  "directory-agents-injector": ["packages/opencode/src/session/hooks/context-injection.ts"],
  "directory-readme-injector": ["packages/opencode/src/session/hooks/context-injection.ts"],
  "rules-injector": ["packages/opencode/src/session/hooks/context-injection.ts"],
  "keyword-detector": ["packages/opencode/src/session/hooks/detection-checking.ts"],
  "comment-checker": ["packages/opencode/src/session/hooks/detection-checking.ts"],
  "think-mode": ["packages/opencode/src/session/hooks/llm-parameters.ts"],
  "anthropic-effort": ["packages/opencode/src/session/hooks/llm-parameters.ts"],
}

const AGENT_IMPACT_MAP: Record<string, string[]> = {
  sisyphus: ["packages/opencode/src/agent/sisyphus.ts", "packages/opencode/src/agent/prompt/sisyphus.txt"],
  "omo-explore": ["packages/opencode/src/agent/agent.ts", "packages/opencode/src/agent/prompt/omo-explore.txt"],
  oracle: ["packages/opencode/src/agent/agent.ts", "packages/opencode/src/agent/prompt/oracle.txt"],
  hephaestus: ["packages/opencode/src/agent/optional/index.ts", "packages/opencode/src/agent/prompt/hephaestus.txt"],
  prometheus: ["packages/opencode/src/agent/optional/index.ts", "packages/opencode/src/agent/prompt/prometheus.txt"],
  atlas: ["packages/opencode/src/agent/optional/index.ts", "packages/opencode/src/agent/prompt/atlas.txt"],
  librarian: ["packages/opencode/src/agent/optional/index.ts", "packages/opencode/src/agent/prompt/librarian.txt"],
  metis: ["packages/opencode/src/agent/optional/index.ts", "packages/opencode/src/agent/prompt/metis.txt"],
  momus: ["packages/opencode/src/agent/optional/index.ts", "packages/opencode/src/agent/prompt/momus.txt"],
  "multimodal-looker": ["packages/opencode/src/agent/optional/index.ts", "packages/opencode/src/agent/prompt/multimodal-looker.txt"],
  "sisyphus-junior": ["packages/opencode/src/agent/optional/index.ts", "packages/opencode/src/agent/prompt/sisyphus-junior.txt"],
}

// ─── Core Functions ──────────────────────────────────────────────────

/**
 * Fetch latest version info from npm registry.
 */
export async function fetchNpmVersion(packageName: string): Promise<{ version: string; tarball: string }> {
  const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`)
  if (!response.ok) throw new Error(`npm registry error: ${response.status} ${response.statusText}`)
  const data = (await response.json()) as Record<string, unknown>
  const version = data.version as string
  const dist = data.dist as Record<string, string>
  return { version, tarball: dist.tarball }
}

/**
 * Download and extract a tarball to a temp directory.
 * Returns the path to the extracted package directory.
 */
export async function downloadAndExtract(tarballUrl: string): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-diff-"))
  const tarballPath = path.join(tmpDir, "package.tgz")

  const response = await fetch(tarballUrl)
  if (!response.ok) throw new Error(`Failed to download tarball: ${response.status}`)
  const buffer = await response.arrayBuffer()
  await Bun.write(tarballPath, buffer)

  const proc = Bun.spawn(["tar", "xzf", tarballPath, "-C", tmpDir], {
    stdout: "ignore",
    stderr: "pipe",
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`Failed to extract tarball: ${stderr}`)
  }

  return path.join(tmpDir, "package")
}

/**
 * Read the baseline file, applying defaults for missing fields.
 */
export function readBaseline(baselinePath: string): Baseline {
  if (!fs.existsSync(baselinePath)) return parseBaseline({})
  const raw = JSON.parse(fs.readFileSync(baselinePath, "utf-8"))
  return parseBaseline(raw)
}

/**
 * Write the baseline file.
 */
export function writeBaseline(baselinePath: string, baseline: Baseline): void {
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n")
}

/**
 * Scan an extracted OMO package directory for tools, hooks, agents, config, and dependencies.
 */
export function scanPackage(packageDir: string): {
  tools: string[]
  hooks: string[]
  agents: string[]
  configFiles: string[]
  dependencies: Record<string, string>
} {
  const tools: string[] = []
  const hooks: string[] = []
  const agents: string[] = []
  const configFiles: string[] = []
  const dependencies: Record<string, string> = {}

  const srcDir = path.join(packageDir, "src")
  if (!fs.existsSync(srcDir)) return { tools, hooks, agents, configFiles, dependencies }

  // Scan tools
  const toolsDir = path.join(srcDir, "tools")
  if (fs.existsSync(toolsDir)) {
    for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) tools.push(entry.name)
    }
  }

  // Scan hooks
  const hooksDir = path.join(srcDir, "hooks")
  if (fs.existsSync(hooksDir)) {
    for (const entry of fs.readdirSync(hooksDir, { withFileTypes: true })) {
      if (entry.isDirectory()) hooks.push(entry.name)
    }
  }

  // Scan agents
  const agentsDir = path.join(srcDir, "agents")
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      const name = entry.isDirectory() ? entry.name : entry.name.replace(/\.[^.]+$/, "")
      if (!agents.includes(name)) agents.push(name)
    }
  }

  // Scan config
  const configDir = path.join(srcDir, "config")
  if (fs.existsSync(configDir)) {
    for (const entry of fs.readdirSync(configDir, { recursive: true })) {
      const entryStr = String(entry)
      if (entryStr.endsWith(".ts") || entryStr.endsWith(".js")) configFiles.push(entryStr)
    }
  }

  // Read package.json dependencies
  const pkgJson = path.join(packageDir, "package.json")
  if (fs.existsSync(pkgJson)) {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8"))
    if (pkg.dependencies) Object.assign(dependencies, pkg.dependencies)
    if (pkg.peerDependencies) Object.assign(dependencies, pkg.peerDependencies)
  }

  return { tools, hooks, agents, configFiles, dependencies }
}

/**
 * Determine the change category for a component.
 */
export function categorizeChange(
  name: string,
  type: "tool" | "hook" | "agent" | "config" | "dependency",
  status: "new" | "modified" | "removed",
  baseline: Baseline,
): ChangeCategory {
  if (status === "new") return "backport recommended"

  if (type === "tool" && baseline.tools[name] === "internalized") return "review needed"
  if (type === "hook" && baseline.hooks[name] === "internalized") return "review needed"
  if (type === "agent" && baseline.agents[name] === "internalized") return "review needed"
  if (type === "agent" && baseline.agents[name] === "optional") return "review needed"

  if (type === "tool" && baseline.tools[name] === "skipped") return "skip (diverged)"
  if (type === "hook" && baseline.hooks[name] === "skipped") return "skip (diverged)"
  if (type === "agent" && baseline.agents[name] === "skipped") return "skip (diverged)"

  if (type === "config" || type === "dependency") return "review needed"

  return "review needed"
}

/**
 * Get affected opencode files for a component.
 */
export function getAffectedFiles(name: string, type: "tool" | "hook" | "agent" | "config" | "dependency"): string[] {
  if (type === "tool") return TOOL_IMPACT_MAP[name] ?? [`packages/opencode/src/tool/${name}.ts`]
  if (type === "hook") return HOOK_IMPACT_MAP[name] ?? [`packages/opencode/src/session/hooks/`]
  if (type === "agent") return AGENT_IMPACT_MAP[name] ?? [`packages/opencode/src/agent/`]
  if (type === "config") return ["packages/opencode/src/config/config.ts"]
  if (type === "dependency") return ["packages/opencode/package.json"]
  return []
}

/**
 * Generate diff between baseline and scanned package.
 */
export function generateDiff(
  baseline: Baseline,
  scanned: ReturnType<typeof scanPackage>,
  latestVersion: string,
): DiffReport {
  const changes: DiffChange[] = []

  // Compare tools
  for (const tool of scanned.tools) {
    const status = baseline.tools[tool] ? "modified" : "new"
    changes.push({
      name: tool,
      type: "tool",
      status,
      category: categorizeChange(tool, "tool", status, baseline),
      details: status === "new"
        ? `New tool '${tool}' found in OMO ${latestVersion}`
        : `Tool '${tool}' may have changes in OMO ${latestVersion}`,
      affectedFiles: getAffectedFiles(tool, "tool"),
    })
  }

  // Compare hooks
  for (const hook of scanned.hooks) {
    const status = baseline.hooks[hook] ? "modified" : "new"
    changes.push({
      name: hook,
      type: "hook",
      status,
      category: categorizeChange(hook, "hook", status, baseline),
      details: status === "new"
        ? `New hook '${hook}' found in OMO ${latestVersion}`
        : `Hook '${hook}' may have changes in OMO ${latestVersion}`,
      affectedFiles: getAffectedFiles(hook, "hook"),
    })
  }

  // Compare agents
  for (const agent of scanned.agents) {
    const status = baseline.agents[agent] ? "modified" : "new"
    changes.push({
      name: agent,
      type: "agent",
      status,
      category: categorizeChange(agent, "agent", status, baseline),
      details: status === "new"
        ? `New agent '${agent}' found in OMO ${latestVersion}`
        : `Agent '${agent}' may have changes in OMO ${latestVersion}`,
      affectedFiles: getAffectedFiles(agent, "agent"),
    })
  }

  // Config files
  for (const configFile of scanned.configFiles) {
    changes.push({
      name: configFile,
      type: "config",
      status: "modified",
      category: "review needed",
      details: `Config file '${configFile}' present in OMO ${latestVersion}`,
      affectedFiles: getAffectedFiles(configFile, "config"),
    })
  }

  // Dependencies
  for (const [dep, version] of Object.entries(scanned.dependencies)) {
    changes.push({
      name: dep,
      type: "dependency",
      status: "modified",
      category: "review needed",
      details: `Dependency '${dep}@${version}' in OMO ${latestVersion}`,
      affectedFiles: getAffectedFiles(dep, "dependency"),
    })
  }

  return {
    baselineVersion: baseline.version,
    latestVersion,
    date: new Date().toISOString().split("T")[0]!,
    changes,
    sections: {
      tools: changes.filter((c) => c.type === "tool"),
      hooks: changes.filter((c) => c.type === "hook"),
      agents: changes.filter((c) => c.type === "agent"),
      config: changes.filter((c) => c.type === "config"),
      dependencies: changes.filter((c) => c.type === "dependency"),
    },
  }
}

/**
 * Format a diff report as markdown.
 */
export function formatReport(report: DiffReport): string {
  const lines: string[] = []

  lines.push(`# OMO Upstream Diff Report`)
  lines.push("")
  lines.push(`- **Baseline version:** ${report.baselineVersion}`)
  lines.push(`- **Latest version:** ${report.latestVersion}`)
  lines.push(`- **Date:** ${report.date}`)
  lines.push("")

  if (report.changes.length === 0) {
    lines.push("## No Changes Detected")
    lines.push("")
    lines.push("The latest OMO version matches the baseline. No action required.")
    return lines.join("\n")
  }

  lines.push(`## Summary`)
  lines.push("")
  lines.push(`Total changes: ${report.changes.length}`)
  lines.push(`- Backport recommended: ${report.changes.filter((c) => c.category === "backport recommended").length}`)
  lines.push(`- Review needed: ${report.changes.filter((c) => c.category === "review needed").length}`)
  lines.push(`- Skip (diverged): ${report.changes.filter((c) => c.category === "skip (diverged)").length}`)
  lines.push("")

  const sections: [string, DiffChange[]][] = [
    ["Tools", report.sections.tools],
    ["Hooks", report.sections.hooks],
    ["Agents", report.sections.agents],
    ["Config Schema", report.sections.config],
    ["Dependencies", report.sections.dependencies],
  ]

  for (const [title, items] of sections) {
    if (items.length === 0) continue
    lines.push(`## ${title}`)
    lines.push("")
    lines.push("| Name | Status | Category | Details |")
    lines.push("|------|--------|----------|---------|")
    for (const item of items) {
      lines.push(`| ${item.name} | ${item.status} | ${item.category} | ${item.details} |`)
    }
    lines.push("")

    const withImpact = items.filter((i) => i.affectedFiles.length > 0)
    if (withImpact.length > 0) {
      lines.push("### Impact Analysis")
      lines.push("")
      for (const item of withImpact) {
        lines.push(`**${item.name}:**`)
        for (const file of item.affectedFiles) {
          lines.push(`- \`${file}\``)
        }
        lines.push("")
      }
    }
  }

  return lines.join("\n")
}

// ─── Main ─────────────────────────────────────────────────────────────

const OMO_PACKAGE = "oh-my-opencode"
const BASELINE_PATH = path.resolve(import.meta.dir, "../packages/opencode/.omo-baseline.json")
const REPORT_DIR = path.resolve(import.meta.dir, "../tasks")

async function main() {
  const updateBaseline = process.argv.includes("--update-baseline")

  console.log(`Fetching latest ${OMO_PACKAGE} from npm...`)
  const { version, tarball } = await fetchNpmVersion(OMO_PACKAGE)
  console.log(`Latest version: ${version}`)

  const baseline = readBaseline(BASELINE_PATH)
  console.log(`Baseline version: ${baseline.version}`)

  if (version === baseline.version) {
    console.log("\nNo version change detected. Generating report anyway...")
  }

  console.log(`\nDownloading tarball: ${tarball}`)
  const packageDir = await downloadAndExtract(tarball)
  console.log(`Extracted to: ${packageDir}`)

  console.log("\nScanning package...")
  const scanned = scanPackage(packageDir)
  console.log(`Found: ${scanned.tools.length} tools, ${scanned.hooks.length} hooks, ${scanned.agents.length} agents`)

  const report = generateDiff(baseline, scanned, version)
  const markdown = formatReport(report)

  const reportPath = path.join(REPORT_DIR, `omo-diff-report-${version}.md`)
  fs.mkdirSync(REPORT_DIR, { recursive: true })
  fs.writeFileSync(reportPath, markdown + "\n")
  console.log(`\nReport written to: ${reportPath}`)

  if (updateBaseline) {
    baseline.version = version
    baseline.date = new Date().toISOString().split("T")[0]!
    writeBaseline(BASELINE_PATH, baseline)
    console.log(`Baseline updated to version ${version}`)
  }

  // Cleanup temp dir
  fs.rmSync(path.dirname(packageDir), { recursive: true, force: true })

  console.log("\nDone!")
  process.exit(0)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message)
    process.exit(1)
  })
}
