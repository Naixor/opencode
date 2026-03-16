import crypto from "crypto"
import z from "zod"
import fsp from "fs/promises"
import path from "path"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { Global } from "@/global"
import { TIMEOUT } from "./lifecycle"
import { setOwnerState } from "./owner"

const log = Log.create({ service: "client" })

export namespace Client {
  export type Role = "owner" | "observer"

  export interface Entry {
    directory: string
    connectedAt: number
    reconnectToken: string
    role: Role
    type: string
    remoteIP: string
  }

  const clients = new Map<string, Entry>()
  let owner: string | null = null

  export const Event = {
    Connected: BusEvent.define(
      "client.connected",
      z.object({
        clientID: z.string(),
        role: z.enum(["owner", "observer"]),
        type: z.string(),
        remoteIP: z.string(),
      }),
    ),
    Disconnected: BusEvent.define(
      "client.disconnected",
      z.object({
        clientID: z.string(),
      }),
    ),
    OwnerChanged: BusEvent.define(
      "instance.owner.changed",
      z.object({
        ownerClientID: z.string().nullable(),
      }),
    ),
    TakeoverAvailable: BusEvent.define(
      "takeover.available",
      z.object({
        available: z.boolean(),
      }),
    ),
    Typing: BusEvent.define(
      "session.typing",
      z.object({
        sessionID: z.string(),
        clientID: z.string(),
      }),
    ),
  }

  /** Register a new client. First client becomes owner. Returns clientID and reconnectToken. */
  export function add(opts: { directory: string; type: string; remoteIP: string }): {
    clientID: string
    reconnectToken: string
    role: Role
    ownerClientID: string | null
  } {
    const clientID = crypto.randomUUID()
    const reconnectToken = crypto.randomUUID()
    const role: Role = owner === null ? "owner" : "observer"
    if (role === "owner") {
      owner = clientID
      setOwnerState(clientID)
    }

    clients.set(clientID, {
      directory: opts.directory,
      connectedAt: Date.now(),
      reconnectToken,
      role,
      type: opts.type,
      remoteIP: opts.remoteIP,
    })

    log.info("client added", { clientID, role, type: opts.type })

    Bus.publish(Event.Connected, {
      clientID,
      role,
      type: opts.type,
      remoteIP: opts.remoteIP,
    })

    return { clientID, reconnectToken, role, ownerClientID: owner }
  }

  const graceTimers = new Map<string, Timer>()

  /** Start a grace period for a disconnected client. If no reconnect within TIMEOUT, fully remove. */
  export function disconnect(clientID: string) {
    const entry = clients.get(clientID)
    if (!entry) return

    log.info("client disconnected, starting grace period", { clientID, timeout: TIMEOUT })

    // Start grace period timer
    const timer = setTimeout(() => {
      graceTimers.delete(clientID)
      remove(clientID)
    }, TIMEOUT)
    graceTimers.set(clientID, timer)
  }

  /** Cancel grace period for a reconnecting client. */
  export function cancelGrace(clientID: string) {
    const timer = graceTimers.get(clientID)
    if (timer) {
      clearTimeout(timer)
      graceTimers.delete(clientID)
    }
  }

  /** Fully remove a client (after grace period or immediate). */
  export function remove(clientID: string) {
    cancelGrace(clientID)
    const entry = clients.get(clientID)
    if (!entry) return
    clients.delete(clientID)

    log.info("client removed", { clientID })

    Bus.publish(Event.Disconnected, { clientID })

    // If owner left and no clients remain, reset owner
    if (owner === clientID) {
      owner = null
      setOwnerState(null)
    }
  }

  /** Get a client entry by ID. */
  export function get(clientID: string): Entry | undefined {
    return clients.get(clientID)
  }

  /** Get all clients. */
  export function all(): Map<string, Entry> {
    return clients
  }

  /** Get the current owner client ID. */
  export function ownerID(): string | null {
    return owner
  }

  const ownerFile = path.join(Global.Path.data, "owner.json")

  /** Persist owner clientID to disk for server restart recovery. */
  async function persistOwner(clientID: string | null) {
    if (clientID) {
      await fsp.writeFile(ownerFile, JSON.stringify({ clientID })).catch(() => {})
    } else {
      await fsp.unlink(ownerFile).catch(() => {})
    }
  }

  /** Read persisted owner clientID. */
  export async function loadPersistedOwner(): Promise<string | null> {
    try {
      const raw = await fsp.readFile(ownerFile, "utf-8")
      const data = JSON.parse(raw)
      return data.clientID ?? null
    } catch {
      return null
    }
  }

  /** Set owner (for takeover). */
  export function setOwner(clientID: string | null) {
    owner = clientID
    setOwnerState(clientID)
    if (clientID) {
      const entry = clients.get(clientID)
      if (entry) entry.role = "owner"
    }
    // Reset all other clients to observer
    for (const [id, entry] of clients) {
      if (id !== clientID) entry.role = "observer"
    }
    persistOwner(clientID)
    Bus.publish(Event.OwnerChanged, { ownerClientID: clientID })
  }

  /** Check if a client exists. */
  export function has(clientID: string): boolean {
    return clients.has(clientID)
  }

  /** Update reconnect token for a client. */
  export function setReconnectToken(clientID: string, token: string) {
    const entry = clients.get(clientID)
    if (entry) entry.reconnectToken = token
  }

  /** Find client by reconnect token. */
  export function findByReconnectToken(token: string): string | undefined {
    for (const [id, entry] of clients) {
      if (entry.reconnectToken === token) return id
    }
    return undefined
  }

  /** Count of connected clients. */
  export function count(): number {
    return clients.size
  }

  // Owner activity tracking
  let lastReport = 0
  let lastActive = 0
  let lastTakeover = 0

  /** Record takeover time for cooldown tracking. */
  export function recordTakeover() {
    lastTakeover = Date.now()
  }

  /** Check if in cooldown period. */
  export function inCooldown(): boolean {
    return Date.now() - lastTakeover < TIMEOUT
  }

  /** Get time remaining in cooldown. */
  export function cooldownRemaining(): number {
    return Math.max(0, TIMEOUT - (Date.now() - lastTakeover))
  }

  /** Record an owner activity report. */
  export function activity(active: boolean) {
    lastReport = Date.now()
    if (active) lastActive = Date.now()
  }

  /** Get last activity report timestamp. */
  export function lastReportTime(): number {
    return lastReport
  }

  /** Get last active report timestamp. */
  export function lastActiveTime(): number {
    return lastActive
  }
}
