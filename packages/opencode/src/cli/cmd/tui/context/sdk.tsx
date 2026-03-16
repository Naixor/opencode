import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createSignal, onCleanup, onMount } from "solid-js"

export type ConnectionState = {
  clientID: string | null
  reconnectToken: string | null
  role: "owner" | "observer" | null
  ownerClientID: string | null
  timeout: number
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: { url: string; directory?: string; fetch?: typeof fetch; headers?: RequestInit["headers"] }) => {
    const abort = new AbortController()
    const sdk = createOpencodeClient({
      baseUrl: props.url,
      signal: abort.signal,
      directory: props.directory,
      fetch: props.fetch,
      headers: props.headers,
    })

    const emitter = createGlobalEmitter<{
      [key in Event["type"]]: Extract<Event, { type: key }>
    }>()

    const [connection, setConnection] = createSignal<ConnectionState>({
      clientID: null,
      reconnectToken: null,
      role: null,
      ownerClientID: null,
      timeout: 60_000,
    })

    let queue: Event[] = []
    let timer: Timer | undefined
    let last = 0

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      batch(() => {
        for (const event of events) {
          emitter.emit(event.type, event)
        }
      })
    }

    const handle = (event: Event) => {
      // Intercept server.connected to extract clientID and role info
      if (event.type === "server.connected") {
        const props = event.properties as Record<string, unknown>
        if (props.clientID) {
          setConnection({
            clientID: props.clientID as string,
            reconnectToken: props.reconnectToken as string,
            role: props.role as "owner" | "observer",
            ownerClientID: props.ownerClientID as string | null,
            timeout: (props.timeout as number) ?? 60_000,
          })
        }
      }

      // Update role when ownership changes (e.g. takeover)
      // Event type exists at runtime via BusEvent registry but not in SDK generated types
      const raw = event as { type: string; properties: Record<string, unknown> }
      if (raw.type === "instance.owner.changed") {
        const prev = connection()
        if (prev.clientID) {
          setConnection({
            ...prev,
            ownerClientID: raw.properties.ownerClientID as string | null,
            role: prev.clientID === raw.properties.ownerClientID ? "owner" : "observer",
          })
        }
      }

      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    onMount(async () => {
      while (true) {
        if (abort.signal.aborted) break
        const events = await sdk.event
          .subscribe(
            {},
            {
              signal: abort.signal,
            },
          )
          .catch(() => undefined)

        if (!events) {
          await new Promise((r) => setTimeout(r, 3000))
          continue
        }

        for await (const event of events.stream) {
          handle(event)
        }

        if (timer) clearTimeout(timer)
        if (queue.length > 0) {
          flush()
        }
      }
    })

    onCleanup(() => {
      abort.abort()
      if (timer) clearTimeout(timer)
    })

    return {
      client: sdk,
      event: emitter,
      url: props.url,
      fetch: props.fetch ?? globalThis.fetch,
      connection,
    }
  },
})
