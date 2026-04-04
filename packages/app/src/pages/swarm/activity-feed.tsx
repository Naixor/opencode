import { createSignal, For, onCleanup, onMount } from "solid-js"

interface FeedEntry {
  time: string
  text: string
  color?: string
}

const DISCUSSION_COLORS: Record<string, string> = {
  proposal: "text-blue-400",
  opinion: "text-gray-300",
  objection: "text-orange-400",
  consensus: "text-green-400",
}

function formatSignal(s: {
  from: string
  type: string
  payload: Record<string, unknown>
}): FeedEntry & { color?: string } {
  const dtype = DISCUSSION_COLORS[s.type]
  if (dtype) {
    const summary = (s.payload.summary as string) ?? JSON.stringify(s.payload).slice(0, 80)
    const prefix = s.payload.round ? `R${s.payload.round}: ` : ""
    const badge = s.type === "consensus" && s.payload.position ? ` (${s.payload.position})` : ""
    return {
      time: "",
      text: `${prefix}[${s.from}] ${s.type.charAt(0).toUpperCase() + s.type.slice(1)}: ${summary}${badge}`,
      color: dtype,
    }
  }
  return {
    time: "",
    text: `${s.from}: ${s.type} — ${JSON.stringify(s.payload).slice(0, 80)}`,
  }
}

export function ActivityFeed(props: { swarmId: string }) {
  const [entries, setEntries] = createSignal<FeedEntry[]>([])
  let ref: HTMLDivElement | undefined

  onMount(() => {
    const source = new EventSource(`/swarm/${props.swarmId}/events`)
    source.onmessage = (ev) => {
      const data = JSON.parse(ev.data)
      const time = new Date(data.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      let entry: FeedEntry = { time, text: data.type }
      if (data.payload?.signal) {
        const formatted = formatSignal(data.payload.signal)
        entry = { ...formatted, time }
      }
      if (data.payload?.task) {
        const t = data.payload.task
        entry = { time, text: `Task ${t.subject} → ${t.status}` }
      }
      setEntries((prev) => [...prev.slice(-49), entry])
      ref?.scrollTo({ top: ref.scrollHeight, behavior: "smooth" })
    }
    onCleanup(() => source.close())
  })

  return (
    <div
      ref={ref}
      class="flex flex-col gap-1 p-3 rounded-lg bg-gray-900 border border-gray-800 overflow-auto flex-1 min-h-[120px] max-h-[300px]"
    >
      <h3 class="text-xs font-semibold text-gray-400 uppercase sticky top-0 bg-gray-900">Activity Feed</h3>
      <For each={entries()}>
        {(e) => (
          <div class={`text-xs ${e.color ?? "text-gray-300"}`}>
            <span class="text-gray-500 mr-2">{e.time}</span>
            {e.text}
          </div>
        )}
      </For>
      {entries().length === 0 && <div class="text-xs text-gray-500">No activity yet</div>}
    </div>
  )
}
