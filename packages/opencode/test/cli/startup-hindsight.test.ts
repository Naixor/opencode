import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

const calls = {
  listen: 0,
  ui: 0,
}

let port = 4096
let host = "127.0.0.1"
let wait = 0
let ui:
  | {
      url: string
      api_url: string
      bank_id: string
    }
  | undefined = {
  url: "http://127.0.0.1:9999",
  api_url: "http://127.0.0.1:40123",
  bank_id: "opencode:test",
}

mock.module("open", () => ({
  default: async () => ({}),
}))

mock.module("../../src/cli/network", () => ({
  withNetworkOptions: (yargs: unknown) => yargs,
  resolveNetworkOptions: async () => ({
    hostname: host,
    port,
    mdns: false,
    mdnsDomain: "opencode.local",
    cors: false,
  }),
}))

mock.module("../../src/server/server", () => ({
  Server: {
    listen: () => {
      calls.listen++
      return {
        port,
        hostname: host,
        url: new URL(`http://${host}:${port}`),
        stop: async () => {},
      }
    },
  },
}))

mock.module("../../src/memory/hindsight/ui", () => ({
  MemoryHindsightUI: {
    start: async () => {
      calls.ui++
      if (wait) await Bun.sleep(wait)
      return ui
    },
  },
}))

const { startManager } = await import("../../src/cli/cmd/manager")
const { startServe } = await import("../../src/cli/cmd/serve")
const { ManagerState } = await import("../../src/server/manager-state")

describe("startup hindsight", () => {
  beforeEach(() => {
    calls.listen = 0
    calls.ui = 0
    port = 4096
    host = "127.0.0.1"
    wait = 0
    ui = {
      url: "http://127.0.0.1:9999",
      api_url: "http://127.0.0.1:40123",
      bank_id: "opencode:test",
    }
    ManagerState.register([])
  })

  afterEach(() => {
    ManagerState.register([])
  })

  test("manager startup registers hindsight service asynchronously", async () => {
    const result = await startManager({})

    expect(calls.listen).toBe(1)
    expect(calls.ui).toBe(1)
    expect(result.ui).toBeUndefined()
    expect(result.services.some((item) => item.name === "Hindsight")).toBe(false)
    await Bun.sleep(0)
    expect(ManagerState.list().some((item) => item.id === "hindsight" && item.url === "http://127.0.0.1:9999")).toBe(
      true,
    )
  })

  test("manager startup does not block on hindsight ui", async () => {
    wait = 50

    const at = Date.now()
    const result = await startManager({})

    expect(Date.now() - at).toBeLessThan(50)
    expect(calls.listen).toBe(1)
    expect(calls.ui).toBe(1)
    expect(result.ui).toBeUndefined()
    expect(result.services.some((item) => item.name === "Hindsight")).toBe(false)
    expect(ManagerState.list().some((item) => item.id === "hindsight")).toBe(false)
    await Bun.sleep(60)
    expect(ManagerState.list().some((item) => item.id === "hindsight" && item.url === "http://127.0.0.1:9999")).toBe(
      true,
    )
  })

  test("manager startup skips hindsight service when ui is unavailable", async () => {
    ui = undefined

    const result = await startManager({})

    expect(calls.listen).toBe(1)
    expect(calls.ui).toBe(1)
    expect(result.ui).toBeUndefined()
    expect(result.services.some((item) => item.name === "Hindsight")).toBe(false)
    await Bun.sleep(0)
    expect(ManagerState.list().some((item) => item.id === "hindsight")).toBe(false)
  })

  test("serve startup starts hindsight ui", async () => {
    const result = await startServe({}, false)

    expect(calls.listen).toBe(1)
    expect(calls.ui).toBe(1)
    expect(result.port).toBe(4096)
    expect(result.ui?.url).toBe("http://127.0.0.1:9999")
    expect(result.token).toBeNull()
  })

  test("serve auto startup skips hindsight ui", async () => {
    const result = await startServe({}, true)

    expect(calls.listen).toBe(1)
    expect(calls.ui).toBe(0)
    expect(result.port).toBe(4096)
    expect(result.ui).toBeUndefined()
    expect(result.token).toBeNull()
  })
})
