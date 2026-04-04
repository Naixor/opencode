import { createResource, For, Show, onCleanup, onMount } from "solid-js"

const COLORS: Record<string, string> = {
  proposal: "border-blue-500/50 text-blue-400",
  opinion: "border-gray-500/50 text-gray-300",
  objection: "border-orange-500/50 text-orange-400",
  consensus: "border-green-500/50 text-green-400",
}

const BADGES: Record<string, string> = {
  proposal: "bg-blue-500/20 text-blue-400",
  opinion: "bg-gray-500/20 text-gray-300",
  objection: "bg-orange-500/20 text-orange-400",
  consensus: "bg-green-500/20 text-green-400",
}

interface Signal {
  round: number
  from: string
  type: string
  summary: string
}

interface Participant {
  name: string
  spoken: boolean
}

interface DiscussionData {
  topic: string | null
  channel: string | null
  round: { current: number; max: number; complete: boolean } | null
  participants: Participant[]
  thread: Signal[]
  decision: string | null
}

function heading(round: number, max: number): string {
  if (round === 1) return `Round ${round}: Proposals`
  if (round >= max) return `Round ${round}: Consensus`
  return `Round ${round}: Responses`
}

export function DiscussionThread(props: { swarmId: string }) {
  const [data, { refetch }] = createResource(
    () => props.swarmId,
    async (id): Promise<DiscussionData> => {
      const resp = await fetch(`/swarm/${id}/discussion`)
      if (!resp.ok) return { topic: null, channel: null, round: null, participants: [], thread: [], decision: null }
      return resp.json()
    },
  )

  onMount(() => {
    const source = new EventSource(`/swarm/${props.swarmId}/events`)
    source.onmessage = () => refetch()
    onCleanup(() => source.close())
  })

  const rounds = () => {
    const d = data()
    if (!d?.thread.length) return []
    const max = d.round?.max ?? 3
    const grouped = new Map<number, Signal[]>()
    for (const s of d.thread) {
      const r = (s.round as number) ?? 1
      if (!grouped.has(r)) grouped.set(r, [])
      grouped.get(r)!.push(s)
    }
    return Array.from(grouped.entries())
      .sort(([a], [b]) => a - b)
      .map(([r, signals]) => ({ round: r, label: heading(r, max), signals }))
  }

  return (
    <div class="flex flex-col gap-3 p-3 rounded-lg bg-gray-900 border border-gray-800 overflow-auto flex-1 min-h-[200px]">
      <Show when={data()}>
        {(d) => (
          <>
            {/* Header */}
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-semibold text-white">{d().topic ?? "Discussion"}</h3>
              <Show when={d().round}>
                {(r) => (
                  <span class="text-xs text-gray-400">
                    Round {r().current}/{r().max}
                  </span>
                )}
              </Show>
            </div>

            {/* Participants */}
            <Show when={d().participants.length > 0}>
              <div class="flex gap-2 flex-wrap">
                <For each={d().participants}>
                  {(p) => (
                    <span
                      class={`px-2 py-0.5 rounded text-xs font-medium ${p.spoken ? "bg-green-500/20 text-green-400" : "bg-gray-700/50 text-gray-400"}`}
                    >
                      {p.name} {p.spoken ? "✓" : "⏳"}
                    </span>
                  )}
                </For>
              </div>
            </Show>

            {/* Thread by round */}
            <For each={rounds()}>
              {(group) => (
                <div class="flex flex-col gap-2">
                  <h4 class="text-xs font-semibold text-gray-400 uppercase">{group.label}</h4>
                  <For each={group.signals}>
                    {(s) => (
                      <div class={`border-l-2 pl-3 py-1 ${COLORS[s.type] ?? "border-gray-600 text-gray-300"}`}>
                        <div class="flex items-center gap-2">
                          <span
                            class={`px-1.5 py-0.5 rounded text-[10px] font-medium ${BADGES[s.type] ?? "bg-gray-600/20 text-gray-400"}`}
                          >
                            {s.type}
                          </span>
                          <span class="text-xs font-medium text-white">{s.from}</span>
                          <Show when={s.type === "consensus" && (s as any).position}>
                            <span class="text-[10px] text-gray-400">({(s as any).position})</span>
                          </Show>
                        </div>
                        <p class="text-xs mt-1 text-gray-300">{s.summary}</p>
                      </div>
                    )}
                  </For>
                  {/* Pending participants for current round */}
                  <Show when={d().round && group.round === d().round!.current && !d().round!.complete}>
                    <For each={d().participants.filter((p) => !p.spoken)}>
                      {(p) => (
                        <div class="border-l-2 border-gray-700 pl-3 py-1">
                          <span class="text-xs text-gray-500">⏳ {p.name} — waiting...</span>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              )}
            </For>

            {/* Decision */}
            <Show when={d().decision}>
              {(dec) => (
                <div class="border border-green-500/30 rounded-lg p-3 bg-green-500/5">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-green-400">✅</span>
                    <span class="text-xs font-semibold text-green-400">Decision</span>
                  </div>
                  <p class="text-xs text-gray-300">{dec()}</p>
                </div>
              )}
            </Show>

            {/* Empty state */}
            <Show when={!d().thread.length && !d().decision}>
              <div class="text-xs text-gray-500 text-center py-4">Discussion has not started yet</div>
            </Show>
          </>
        )}
      </Show>
      <Show when={!data()}>
        <div class="text-xs text-gray-500 text-center py-4">Loading discussion...</div>
      </Show>
    </div>
  )
}
