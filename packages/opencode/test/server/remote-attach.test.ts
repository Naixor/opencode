import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Client } from "../../src/server/client"
import { AuthToken } from "../../src/server/auth-token"
import { Lifecycle, TIMEOUT } from "../../src/server/lifecycle"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// Helper to parse SSE event data from a ReadableStream chunk
function parseSSE(text: string): Array<{ type: string; properties: Record<string, unknown> }> {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data:"))
    .map((chunk) => {
      const raw = chunk.replace(/^data:\s*/, "")
      return JSON.parse(raw)
    })
}

// Helper to collect SSE events until a condition is met or timeout
async function collectSSE(
  response: Response,
  opts: { until?: (evt: { type: string }) => boolean; max?: number; timeout?: number } = {},
): Promise<Array<{ type: string; properties: Record<string, unknown> }>> {
  const events: Array<{ type: string; properties: Record<string, unknown> }> = []
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const limit = opts.max ?? 20
  const ms = opts.timeout ?? 2000

  const deadline = Date.now() + ms
  while (events.length < limit && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), ms)),
    ])
    if (done || !value) break
    const parsed = parseSSE(decoder.decode(value, { stream: true }))
    for (const evt of parsed) {
      events.push(evt)
      if (opts.until?.(evt)) {
        reader.cancel()
        return events
      }
    }
  }
  reader.cancel()
  return events
}

let server: ReturnType<typeof Server.listen>
const base = () => `http://localhost:${server.port}`

// Reset Client module state between tests
function resetClients() {
  // Remove all tracked clients
  for (const [id] of Client.all()) {
    Client.cancelGrace(id)
    Client.remove(id)
  }
}

beforeAll(() => {
  AuthToken.set(null) // No auth for tests
  server = Server.listen({ port: 0, hostname: "localhost" })
})

afterEach(() => {
  resetClients()
})

afterAll(() => {
  server.stop(true)
})

// ──────────────────────────────────────────────
// Client Registration & Identity
// ──────────────────────────────────────────────
describe("Client registration", () => {
  test("add() returns clientID, reconnectToken, role, ownerClientID", () => {
    const result = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    expect(result.clientID).toBeTruthy()
    expect(result.reconnectToken).toBeTruthy()
    expect(result.role).toBe("owner") // first client becomes owner
    expect(result.ownerClientID).toBe(result.clientID)
  })

  test("first client becomes owner, second becomes observer", () => {
    const first = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    const second = Client.add({ directory: "/tmp", type: "tui", remoteIP: "192.168.1.2" })
    expect(first.role).toBe("owner")
    expect(second.role).toBe("observer")
    expect(second.ownerClientID).toBe(first.clientID)
  })

  test("get() returns entry by clientID", () => {
    const result = Client.add({ directory: "/tmp/project", type: "cli", remoteIP: "10.0.0.1" })
    const entry = Client.get(result.clientID)
    expect(entry).toBeDefined()
    expect(entry!.directory).toBe("/tmp/project")
    expect(entry!.type).toBe("cli")
    expect(entry!.remoteIP).toBe("10.0.0.1")
    expect(entry!.role).toBe("owner")
  })

  test("has() returns true for registered client", () => {
    const result = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    expect(Client.has(result.clientID)).toBe(true)
    expect(Client.has("nonexistent")).toBe(false)
  })

  test("count() tracks number of clients", () => {
    expect(Client.count()).toBe(0)
    Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    expect(Client.count()).toBe(1)
    Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.2" })
    expect(Client.count()).toBe(2)
  })

  test("all() returns all clients", () => {
    Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    Client.add({ directory: "/tmp", type: "cli", remoteIP: "127.0.0.2" })
    expect(Client.all().size).toBe(2)
  })
})

// ──────────────────────────────────────────────
// Reconnect Token
// ──────────────────────────────────────────────
describe("Reconnect token", () => {
  test("findByReconnectToken() locates client", () => {
    const result = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    const found = Client.findByReconnectToken(result.reconnectToken)
    expect(found).toBe(result.clientID)
  })

  test("findByReconnectToken() returns undefined for invalid token", () => {
    Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    expect(Client.findByReconnectToken("invalid-token")).toBeUndefined()
  })

  test("setReconnectToken() updates token", () => {
    const result = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    const old = result.reconnectToken
    Client.setReconnectToken(result.clientID, "new-token-123")
    expect(Client.findByReconnectToken(old)).toBeUndefined()
    expect(Client.findByReconnectToken("new-token-123")).toBe(result.clientID)
  })

  test("used token is invalidated after reconnect", () => {
    const result = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    const token = result.reconnectToken

    // Simulate reconnect: find by token, cancel grace, issue new token
    const found = Client.findByReconnectToken(token)
    expect(found).toBe(result.clientID)
    Client.setReconnectToken(result.clientID, "new-token-after-reconnect")

    // Old token should no longer work
    expect(Client.findByReconnectToken(token)).toBeUndefined()
    // New token works
    expect(Client.findByReconnectToken("new-token-after-reconnect")).toBe(result.clientID)
  })
})

// ──────────────────────────────────────────────
// Grace Period & Disconnect
// ──────────────────────────────────────────────
describe("Grace period", () => {
  test("disconnect starts grace period, cancelGrace cancels it", () => {
    const result = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    Client.disconnect(result.clientID)
    // Client still exists during grace period
    expect(Client.has(result.clientID)).toBe(true)

    // Cancel grace (simulating reconnect)
    Client.cancelGrace(result.clientID)
    // Client still exists
    expect(Client.has(result.clientID)).toBe(true)
  })

  test("remove() immediately clears client", () => {
    const result = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    Client.remove(result.clientID)
    expect(Client.has(result.clientID)).toBe(false)
    expect(Client.count()).toBe(0)
  })

  test("owner removal resets ownerID to null", () => {
    const result = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    expect(Client.ownerID()).toBe(result.clientID)
    Client.remove(result.clientID)
    expect(Client.ownerID()).toBeNull()
  })

  test("next client after owner removal becomes owner", () => {
    const first = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    Client.remove(first.clientID)
    const second = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.2" })
    expect(second.role).toBe("owner")
    expect(Client.ownerID()).toBe(second.clientID)
  })
})

// ──────────────────────────────────────────────
// Ownership Model
// ──────────────────────────────────────────────
describe("Ownership model", () => {
  test("setOwner transfers ownership", () => {
    const first = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    const second = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.2" })

    expect(Client.ownerID()).toBe(first.clientID)
    Client.setOwner(second.clientID)
    expect(Client.ownerID()).toBe(second.clientID)

    // Roles updated
    expect(Client.get(first.clientID)!.role).toBe("observer")
    expect(Client.get(second.clientID)!.role).toBe("owner")
  })

  test("setOwner(null) resets ownership", () => {
    Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    Client.setOwner(null)
    expect(Client.ownerID()).toBeNull()
  })
})

// ──────────────────────────────────────────────
// Activity & Takeover
// ──────────────────────────────────────────────
describe("Activity tracking", () => {
  test("activity() updates lastReportTime and lastActiveTime", () => {
    Client.activity(true)
    expect(Client.lastReportTime()).toBeGreaterThan(0)
    expect(Client.lastActiveTime()).toBeGreaterThan(0)
  })

  test("activity(false) only updates lastReportTime", () => {
    // Reset by directly checking values change
    const before = Client.lastActiveTime()
    // Tiny delay to ensure different timestamps
    Client.activity(false)
    // lastReport updates, lastActive stays the same
    expect(Client.lastReportTime()).toBeGreaterThan(0)
    expect(Client.lastActiveTime()).toBe(before)
  })
})

describe("Takeover cooldown", () => {
  test("recordTakeover() starts cooldown", () => {
    Client.recordTakeover()
    expect(Client.inCooldown()).toBe(true)
    expect(Client.cooldownRemaining()).toBeGreaterThan(0)
    expect(Client.cooldownRemaining()).toBeLessThanOrEqual(TIMEOUT)
  })
})

// ──────────────────────────────────────────────
// HTTP API: /clients
// ──────────────────────────────────────────────
describe("GET /clients", () => {
  test("returns empty list when no clients", async () => {
    const res = await fetch(`${base()}/clients`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.clients).toEqual([])
    expect(body.ownerClientID).toBeNull()
  })

  test("returns connected clients with roles", async () => {
    const first = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    const second = Client.add({ directory: "/tmp", type: "cli", remoteIP: "10.0.0.1" })

    const res = await fetch(`${base()}/clients`)
    const body = await res.json()

    expect(body.ownerClientID).toBe(first.clientID)
    expect(body.clients).toHaveLength(2)

    const owner = body.clients.find((c: any) => c.clientID === first.clientID)
    const observer = body.clients.find((c: any) => c.clientID === second.clientID)

    expect(owner.role).toBe("owner")
    expect(owner.type).toBe("tui")
    expect(observer.role).toBe("observer")
    expect(observer.type).toBe("cli")
    expect(owner.duration).toBeGreaterThanOrEqual(0)
  })

  test("takeoverAvailable reflects state", async () => {
    Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    // Owner just connected, activity not reported yet — lastReportTime is 0 → condition won't fire
    Client.activity(true) // report activity so conditions are fresh

    const res = await fetch(`${base()}/clients`)
    const body = await res.json()
    // Owner is active, no takeover
    expect(body.takeoverAvailable).toBe(false)
  })
})

// ──────────────────────────────────────────────
// HTTP API: /instance/activity
// ──────────────────────────────────────────────
describe("POST /instance/activity", () => {
  test("owner can report activity", async () => {
    const reg = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    const res = await fetch(`${base()}/instance/activity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenCode-Client-ID": reg.clientID,
      },
      body: JSON.stringify({ active: true }),
    })
    expect(res.status).toBe(200)
  })

  test("non-owner gets 403", async () => {
    Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    const observer = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.2" })
    const res = await fetch(`${base()}/instance/activity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenCode-Client-ID": observer.clientID,
      },
      body: JSON.stringify({ active: true }),
    })
    expect(res.status).toBe(403)
  })
})

// ──────────────────────────────────────────────
// HTTP API: /instance/takeover
// ──────────────────────────────────────────────
describe("POST /instance/takeover", () => {
  test("fails without client ID", async () => {
    const res = await fetch(`${base()}/instance/takeover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test("takeover succeeds when owner is null", async () => {
    const reg = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    // Remove owner so ownerID becomes null
    Client.remove(reg.clientID)
    expect(Client.ownerID()).toBeNull()

    const newClient = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.2" })
    // newClient is now owner since no one was registered
    // But let's test the takeover path directly: force another client to be observer
    const observer = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.3" })

    // Remove owner again
    Client.remove(newClient.clientID)
    expect(Client.ownerID()).toBeNull()

    const res = await fetch(`${base()}/instance/takeover`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenCode-Client-ID": observer.clientID,
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ownerClientID).toBe(observer.clientID)
  })

  test("takeover fails when owner is active (409)", async () => {
    const owner = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    const observer = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.2" })
    Client.activity(true) // Owner is active

    const res = await fetch(`${base()}/instance/takeover`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenCode-Client-ID": observer.clientID,
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.reason).toBe("owner_active")
    expect(body.ownerClientID).toBe(owner.clientID)
  })
})

// ──────────────────────────────────────────────
// HTTP API: /session/:sessionID/typing
// ──────────────────────────────────────────────
describe("POST /session/:sessionID/typing", () => {
  test("owner can send typing event", async () => {
    const reg = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    const res = await fetch(`${base()}/session/test-session/typing`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenCode-Client-ID": reg.clientID,
      },
    })
    expect(res.status).toBe(200)
  })

  test("non-owner gets 403", async () => {
    Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    const observer = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.2" })
    const res = await fetch(`${base()}/session/test-session/typing`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenCode-Client-ID": observer.clientID,
      },
    })
    expect(res.status).toBe(403)
  })

  test("no client ID gets 403", async () => {
    const res = await fetch(`${base()}/session/test-session/typing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
    expect(res.status).toBe(403)
  })
})

// ──────────────────────────────────────────────
// HTTP API: /attach-info
// ──────────────────────────────────────────────
describe("GET /attach-info", () => {
  test("returns url and command", async () => {
    const res = await fetch(`${base()}/attach-info`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toBeTruthy()
    expect(body.command).toContain("opencode attach")
  })
})

// ──────────────────────────────────────────────
// Auth Token
// ──────────────────────────────────────────────
describe("AuthToken", () => {
  afterEach(() => {
    AuthToken.set(null) // Reset for other tests
  })

  test("validate returns true when no token set", () => {
    AuthToken.set(null)
    expect(AuthToken.validate(undefined)).toBe(true)
    expect(AuthToken.validate("anything")).toBe(true)
  })

  test("validate rejects missing header when token is set", () => {
    AuthToken.set("secret-token")
    expect(AuthToken.validate(undefined)).toBe(false)
  })

  test("validate rejects wrong token", () => {
    AuthToken.set("secret-token")
    expect(AuthToken.validate("Bearer wrong")).toBe(false)
  })

  test("validate accepts correct token", () => {
    AuthToken.set("secret-token")
    expect(AuthToken.validate("Bearer secret-token")).toBe(true)
  })

  test("validate rejects non-Bearer scheme", () => {
    AuthToken.set("secret-token")
    expect(AuthToken.validate("Basic secret-token")).toBe(false)
  })

  test("loopback correctly identifies localhost variants", () => {
    expect(AuthToken.loopback("localhost")).toBe(true)
    expect(AuthToken.loopback("127.0.0.1")).toBe(true)
    expect(AuthToken.loopback("::1")).toBe(true)
    expect(AuthToken.loopback("0.0.0.0")).toBe(false)
    expect(AuthToken.loopback("192.168.1.1")).toBe(false)
  })

  test("generate produces unique UUIDs", () => {
    const a = AuthToken.generate()
    const b = AuthToken.generate()
    expect(a).not.toBe(b)
    // UUID format
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

describe("Auth token middleware", () => {
  test("rejects requests when auth token is set and not provided", async () => {
    AuthToken.set("test-auth-token")
    const res = await fetch(`${base()}/clients`)
    expect(res.status).toBe(401)
    AuthToken.set(null)
  })

  test("accepts requests with correct Bearer token", async () => {
    AuthToken.set("test-auth-token")
    const res = await fetch(`${base()}/clients`, {
      headers: { Authorization: "Bearer test-auth-token" },
    })
    expect(res.status).toBe(200)
    AuthToken.set(null)
  })
})

// ──────────────────────────────────────────────
// ClientID middleware for write operations
// ──────────────────────────────────────────────
describe("ClientID middleware", () => {
  test("write with unknown clientID gets 403", async () => {
    const res = await fetch(`${base()}/instance/activity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenCode-Client-ID": "nonexistent-client-id",
      },
      body: JSON.stringify({ active: true }),
    })
    expect(res.status).toBe(403)
  })

  test("GET requests work without clientID", async () => {
    const res = await fetch(`${base()}/clients`)
    expect(res.status).toBe(200)
  })
})

// ──────────────────────────────────────────────
// Lockfile module
// ──────────────────────────────────────────────
describe("Lockfile", () => {
  // Lockfile tests use the module directly
  const { Lockfile } = require("../../src/server/lockfile") as typeof import("../../src/server/lockfile")

  test("create and read lock file", async () => {
    const dir = `/tmp/opencode-test-lockfile-${Date.now()}`
    const data = { pid: process.pid, port: 12345, token: null, createdAt: Date.now() }

    const created = await Lockfile.create(dir, data)
    expect(created).toBe(true)

    const read = await Lockfile.read(dir)
    expect(read).toBeDefined()
    expect(read!.pid).toBe(process.pid)
    expect(read!.port).toBe(12345)

    await Lockfile.remove(dir)
  })

  test("create fails when lock file exists", async () => {
    const dir = `/tmp/opencode-test-lockfile-dup-${Date.now()}`
    const data = { pid: process.pid, port: 12345, token: null, createdAt: Date.now() }

    const first = await Lockfile.create(dir, data)
    expect(first).toBe(true)

    const second = await Lockfile.create(dir, data)
    expect(second).toBe(false)

    await Lockfile.remove(dir)
  })

  test("acquire returns data for alive process", async () => {
    const dir = `/tmp/opencode-test-lockfile-acquire-${Date.now()}`
    const data = { pid: process.pid, port: 12345, token: null, createdAt: Date.now() }

    await Lockfile.create(dir, data)
    const acquired = await Lockfile.acquire(dir)
    expect(acquired).toBeDefined()
    expect(acquired!.pid).toBe(process.pid)

    await Lockfile.remove(dir)
  })

  test("acquire cleans stale lock (dead PID)", async () => {
    const dir = `/tmp/opencode-test-lockfile-stale-${Date.now()}`
    // Use a very high PID unlikely to be running
    const data = { pid: 999999999, port: 12345, token: null, createdAt: Date.now() }

    await Lockfile.create(dir, data)
    const acquired = await Lockfile.acquire(dir)
    // Should return undefined after cleaning stale lock
    expect(acquired).toBeUndefined()
  })

  test("read returns undefined for missing file", async () => {
    const result = await Lockfile.read("/tmp/nonexistent-lockfile-dir-" + Date.now())
    expect(result).toBeUndefined()
  })
})

// ──────────────────────────────────────────────
// Lifecycle module
// ──────────────────────────────────────────────
describe("Lifecycle", () => {
  test("connect/disconnect tracks count", () => {
    const initial = Lifecycle.count()
    Lifecycle.connect()
    expect(Lifecycle.count()).toBe(initial + 1)
    Lifecycle.disconnect()
    expect(Lifecycle.count()).toBe(initial)
  })

  test("disconnect does not go below 0", () => {
    Lifecycle.disconnect()
    Lifecycle.disconnect()
    expect(Lifecycle.count()).toBeGreaterThanOrEqual(0)
  })
})

// ──────────────────────────────────────────────
// SSE /event endpoint integration
// ──────────────────────────────────────────────
describe("SSE /event", () => {
  test("returns server.connected event with client registration", async () => {
    const res = await fetch(`${base()}/event`, {
      headers: {
        Accept: "text/event-stream",
        "X-OpenCode-Client-Type": "tui",
      },
    })
    expect(res.status).toBe(200)

    const events = await collectSSE(res, {
      until: (e) => e.type === "server.connected",
      timeout: 3000,
    })

    const connected = events.find((e) => e.type === "server.connected")
    expect(connected).toBeDefined()
    expect(connected!.properties.clientID).toBeTruthy()
    expect(connected!.properties.reconnectToken).toBeTruthy()
    expect(connected!.properties.role).toBe("owner") // first client
    expect(connected!.properties.timeout).toBe(TIMEOUT)
  })

  test("second SSE connection gets observer role", async () => {
    // First connection
    const res1 = await fetch(`${base()}/event`, {
      headers: { Accept: "text/event-stream", "X-OpenCode-Client-Type": "tui" },
    })
    const events1 = await collectSSE(res1, {
      until: (e) => e.type === "server.connected",
      timeout: 3000,
    })
    const first = events1.find((e) => e.type === "server.connected")!

    // Second connection
    const res2 = await fetch(`${base()}/event`, {
      headers: { Accept: "text/event-stream", "X-OpenCode-Client-Type": "cli" },
    })
    const events2 = await collectSSE(res2, {
      until: (e) => e.type === "server.connected",
      timeout: 3000,
    })
    const second = events2.find((e) => e.type === "server.connected")!

    expect(first.properties.role).toBe("owner")
    expect(second.properties.role).toBe("observer")
    expect(second.properties.ownerClientID).toBe(first.properties.clientID)
  })

  test("reconnect with valid token restores identity", async () => {
    // First connection to get a token
    const res1 = await fetch(`${base()}/event`, {
      headers: { Accept: "text/event-stream", "X-OpenCode-Client-Type": "tui" },
    })
    const events1 = await collectSSE(res1, {
      until: (e) => e.type === "server.connected",
      timeout: 3000,
    })
    const first = events1.find((e) => e.type === "server.connected")!
    const token = first.properties.reconnectToken as string
    const clientID = first.properties.clientID as string

    // Reconnect with token
    const res2 = await fetch(`${base()}/event`, {
      headers: {
        Accept: "text/event-stream",
        "X-OpenCode-Client-Type": "tui",
        "X-OpenCode-Reconnect-Token": token,
      },
    })
    const events2 = await collectSSE(res2, {
      until: (e) => e.type === "server.connected",
      timeout: 3000,
    })
    const reconnected = events2.find((e) => e.type === "server.connected")!

    // Should get same clientID back
    expect(reconnected.properties.clientID).toBe(clientID)
    expect(reconnected.properties.role).toBe("owner")
    // But new reconnectToken
    expect(reconnected.properties.reconnectToken).not.toBe(token)
  })

  test("reconnect with invalid token gets new identity as observer", async () => {
    // Create an owner first
    const owner = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })

    // Try reconnect with bad token — should get new client as observer
    const res = await fetch(`${base()}/event`, {
      headers: {
        Accept: "text/event-stream",
        "X-OpenCode-Client-Type": "tui",
        "X-OpenCode-Reconnect-Token": "invalid-token",
      },
    })
    const events = await collectSSE(res, {
      until: (e) => e.type === "server.connected",
      timeout: 3000,
    })
    const connected = events.find((e) => e.type === "server.connected")!

    expect(connected.properties.clientID).not.toBe(owner.clientID)
    expect(connected.properties.role).toBe("observer")
  })
})

// ──────────────────────────────────────────────
// assertCanWrite (Session.LockedError)
// ──────────────────────────────────────────────
describe("assertCanWrite", () => {
  const { SessionPrompt } = require("../../src/session/prompt") as typeof import("../../src/session/prompt")
  const { Session } = require("../../src/session") as typeof import("../../src/session")

  test("allows write when no owner set", () => {
    Client.setOwner(null)
    // Should not throw
    expect(() => SessionPrompt.assertCanWrite("test-session")).not.toThrow()
  })

  test("allows write for owner", () => {
    const reg = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    expect(() => SessionPrompt.assertCanWrite("test-session", reg.clientID)).not.toThrow()
  })

  test("throws LockedError for non-owner", () => {
    const owner = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.2" })
    const observer = Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.3" })

    try {
      SessionPrompt.assertCanWrite("test-session", observer.clientID)
      expect(true).toBe(false) // should not reach here
    } catch (err: any) {
      expect(err).toBeInstanceOf(Session.LockedError)
      expect(err.ownerClientID).toBe(owner.clientID)
    }
  })

  test("allows write without clientID (internal/child session)", () => {
    Client.add({ directory: "/tmp", type: "tui", remoteIP: "127.0.0.1" })
    // No clientID means internal call — should be allowed
    expect(() => SessionPrompt.assertCanWrite("test-session")).not.toThrow()
  })
})

// ──────────────────────────────────────────────
// TIMEOUT constant
// ──────────────────────────────────────────────
describe("TIMEOUT constant", () => {
  test("is 60 seconds", () => {
    expect(TIMEOUT).toBe(60_000)
  })
})
