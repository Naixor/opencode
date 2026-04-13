import { describe, expect, test } from "bun:test"
import { doctorCount, doctorFromSandbox, doctorFromSecurity } from "../src/doctor"

describe("doctor helpers", () => {
  test("maps sandbox checks to unified items", () => {
    expect(
      doctorFromSandbox([
        { name: "Platform", status: "pass", message: "macOS" },
        { name: "SIP", status: "skip", message: "unknown", fix: "Check csrutil" },
        { name: "Exec", status: "fail", message: "missing", fix: "Restore tool" },
      ]),
    ).toEqual([
      { source: "sandbox", level: "info", message: "Platform: macOS" },
      { source: "sandbox", level: "warn", message: "SIP: unknown", fix: "Check csrutil" },
      { source: "sandbox", level: "error", message: "Exec: missing", fix: "Restore tool" },
    ])
  })

  test("maps security diagnostics to unified items", () => {
    expect(
      doctorFromSecurity([
        { level: "warn", category: "rules", message: "broad rule", fix: "Narrow it" },
        { level: "error", category: "config", message: "bad json" },
      ]),
    ).toEqual([
      { source: "security", level: "warn", message: "broad rule", fix: "Narrow it" },
      { source: "security", level: "error", message: "bad json" },
    ])
  })

  test("counts unified levels", () => {
    expect(
      doctorCount([
        { source: "sandbox", level: "info", message: "ok" },
        { source: "sandbox", level: "warn", message: "skip" },
        { source: "security", level: "error", message: "bad" },
        { source: "security", level: "error", message: "worse" },
      ]),
    ).toEqual({ error: 2, warn: 1, info: 1 })
  })
})
