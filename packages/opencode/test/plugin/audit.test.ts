import { describe, test, expect, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { PluginAudit } from "@/plugin/audit"

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"))
}

describe("PluginAudit", () => {
  describe("audit", () => {
    test("returns no findings for empty directory", async () => {
      const dir = mktmp()
      const result = await PluginAudit.audit(dir)
      expect(result.findings).toHaveLength(0)
      expect(result.hasCritical).toBe(false)
      fs.rmSync(dir, { recursive: true, force: true })
    })

    test("detects eval() as critical", async () => {
      const dir = mktmp()
      fs.writeFileSync(path.join(dir, "bad.ts"), 'const result = eval("1 + 2")\n')
      const result = await PluginAudit.audit(dir)
      expect(result.hasCritical).toBe(true)
      expect(result.summary.critical).toBeGreaterThan(0)
      const finding = result.findings.find((f) => f.description.includes("eval"))
      expect(finding).toBeDefined()
      expect(finding!.severity).toBe("critical")
      fs.rmSync(dir, { recursive: true, force: true })
    })

    test("detects new Function() as critical", async () => {
      const dir = mktmp()
      fs.writeFileSync(path.join(dir, "bad.ts"), 'const fn = new Function("return 1")\n')
      const result = await PluginAudit.audit(dir)
      expect(result.hasCritical).toBe(true)
      const finding = result.findings.find((f) => f.description.includes("new Function"))
      expect(finding).toBeDefined()
      fs.rmSync(dir, { recursive: true, force: true })
    })

    test("detects fs.readFileSync as medium", async () => {
      const dir = mktmp()
      fs.writeFileSync(path.join(dir, "io.ts"), 'import fs from "fs"\nfs.readFileSync("file.txt")\n')
      const result = await PluginAudit.audit(dir)
      expect(result.hasCritical).toBe(false)
      expect(result.summary.medium).toBeGreaterThan(0)
      const finding = result.findings.find((f) => f.description.includes("readFileSync"))
      expect(finding).toBeDefined()
      expect(finding!.severity).toBe("medium")
      fs.rmSync(dir, { recursive: true, force: true })
    })

    test("hasCritical is false when only medium findings", async () => {
      const dir = mktmp()
      fs.writeFileSync(path.join(dir, "io.ts"), 'import fs from "fs"\nfs.readFileSync("file.txt")\n')
      const result = await PluginAudit.audit(dir)
      expect(result.hasCritical).toBe(false)
      fs.rmSync(dir, { recursive: true, force: true })
    })

    test("skips node_modules", async () => {
      const dir = mktmp()
      const nm = path.join(dir, "node_modules", "pkg")
      fs.mkdirSync(nm, { recursive: true })
      fs.writeFileSync(path.join(nm, "bad.ts"), 'eval("danger")\n')
      const result = await PluginAudit.audit(dir)
      expect(result.findings).toHaveLength(0)
      fs.rmSync(dir, { recursive: true, force: true })
    })
  })

  describe("format", () => {
    test("returns 'No security findings detected.' for empty results", () => {
      const result: PluginAudit.AuditResult = {
        findings: [],
        summary: { critical: 0, high: 0, medium: 0, low: 0 },
        hasCritical: false,
      }
      expect(PluginAudit.format(result)).toBe("No security findings detected.")
    })

    test("includes severity headers for findings", () => {
      const result: PluginAudit.AuditResult = {
        findings: [{ severity: "critical", pattern: "eval", file: "bad.ts", line: 1, description: "eval() detected" }],
        summary: { critical: 1, high: 0, medium: 0, low: 0 },
        hasCritical: true,
      }
      const formatted = PluginAudit.format(result)
      expect(formatted).toContain("[CRITICAL]")
      expect(formatted).toContain("bad.ts:1")
    })
  })
})
