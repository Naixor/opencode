import path from "path"
import { Log } from "../util/log"

export namespace PluginAudit {
  const log = Log.create({ service: "plugin-audit" })

  type Severity = "critical" | "high" | "medium" | "low"

  export interface Finding {
    severity: Severity
    pattern: string
    file: string
    line: number
    description: string
  }

  export interface AuditResult {
    findings: Finding[]
    summary: Record<Severity, number>
    hasCritical: boolean
  }

  const PATTERNS: { pattern: RegExp; severity: Severity; description: string }[] = [
    {
      pattern: /globalThis\.constructor\.constructor/,
      severity: "critical",
      description: "Prototype pollution / code injection via globalThis.constructor.constructor",
    },
    {
      pattern: /Function\s*\(\s*['"]return this['"]\s*\)/,
      severity: "critical",
      description: "Code injection via Function('return this')",
    },
    { pattern: /\beval\s*\(/, severity: "critical", description: "Code injection via eval()" },
    { pattern: /new\s+Function\s*\(/, severity: "critical", description: "Code injection via new Function()" },

    { pattern: /['"`]\/etc\//, severity: "high", description: "Hardcoded sensitive path: /etc/" },
    { pattern: /['"`]~\/\.ssh\//, severity: "high", description: "Hardcoded sensitive path: ~/.ssh/" },
    { pattern: /['"`][^'"]*\.env['"`]/, severity: "high", description: "Hardcoded sensitive path: .env file" },
    { pattern: /\bimport\s*\(\s*[^'"]/, severity: "high", description: "Dynamic import with variable argument" },
    { pattern: /\brequire\s*\(\s*[^'"]/, severity: "high", description: "Dynamic require with variable argument" },

    { pattern: /\bfs\.readFileSync\b/, severity: "medium", description: "Direct filesystem read via fs.readFileSync" },
    { pattern: /\bfs\.readFile\b/, severity: "medium", description: "Direct filesystem read via fs.readFile" },
    { pattern: /\bBun\.file\s*\(/, severity: "medium", description: "Direct filesystem access via Bun.file()" },
    { pattern: /\bBun\.write\s*\(/, severity: "medium", description: "Direct filesystem write via Bun.write()" },
    { pattern: /\bBun\.serve\s*\(/, severity: "medium", description: "Network server via Bun.serve()" },
    { pattern: /\bBun\.spawn\s*\(/, severity: "medium", description: "Process spawn via Bun.spawn()" },
    { pattern: /\bchild_process\b/, severity: "medium", description: "Process spawn via child_process module" },
    { pattern: /require\s*\(\s*['"]net['"]\s*\)/, severity: "medium", description: "Network access via net module" },
    { pattern: /require\s*\(\s*['"]http['"]\s*\)/, severity: "medium", description: "Network access via http module" },
    {
      pattern: /require\s*\(\s*['"]https['"]\s*\)/,
      severity: "medium",
      description: "Network access via https module",
    },
  ]

  async function scanFile(filePath: string): Promise<Finding[]> {
    const content = await Bun.file(filePath).text()
    const lines = content.split("\n")
    const findings: Finding[] = []

    for (const { pattern, severity, description } of PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          findings.push({ severity, pattern: pattern.source, file: filePath, line: i + 1, description })
        }
      }
    }

    return findings
  }

  export async function audit(target: string): Promise<AuditResult> {
    const resolved = path.resolve(target)
    const glob = new Bun.Glob("**/*.{js,ts,mjs,cjs,mts,cts}")
    const findings: Finding[] = []

    for await (const file of glob.scan({ cwd: resolved, absolute: true })) {
      if (file.includes("node_modules")) continue
      const results = await scanFile(file)
      findings.push(...results)
    }

    const summary: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const f of findings) summary[f.severity]++

    return { findings, summary, hasCritical: summary.critical > 0 }
  }

  export function format(result: AuditResult): string {
    if (result.findings.length === 0) return "No security findings detected."

    const lines: string[] = ["Plugin Security Audit Report", ""]
    const bySeverity = {
      critical: [] as Finding[],
      high: [] as Finding[],
      medium: [] as Finding[],
      low: [] as Finding[],
    }
    for (const f of result.findings) bySeverity[f.severity].push(f)

    for (const severity of ["critical", "high", "medium", "low"] as Severity[]) {
      const items = bySeverity[severity]
      if (items.length === 0) continue
      lines.push(`[${severity.toUpperCase()}] (${items.length} finding(s))`)
      for (const f of items) {
        lines.push(`  ${f.file}:${f.line} — ${f.description}`)
      }
      lines.push("")
    }

    lines.push(
      `Summary: ${result.summary.critical} critical, ${result.summary.high} high, ${result.summary.medium} medium, ${result.summary.low} low`,
    )
    return lines.join("\n")
  }
}
