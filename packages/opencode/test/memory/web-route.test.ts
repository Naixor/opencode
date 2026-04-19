import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { MemoryRoutes } from "../../src/memory/web/api"

function app() {
  return new Hono().route("/memory", MemoryRoutes())
}

describe("memory web route", () => {
  test("serves app html with dynamic hindsight link and unavailable state", async () => {
    const res = await app().request("/memory/app")

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('window.ocManagerServices = fetch("/manager/services")')
    expect(body).toContain('setHindsight(services.find((s) => s.id === "hindsight"))')
    expect(body).toContain("Open the Hindsight UI registered with manager")
    expect(body).toContain("Hindsight unavailable")
    expect(body).not.toContain('url.port = "9999"')
  })
})
