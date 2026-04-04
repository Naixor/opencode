import { createResource, createSignal, createMemo, For, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { WorkerCard } from "./worker-card"
import { TaskGraph } from "./task-graph"
import { ActivityFeed } from "./activity-feed"
import { AttentionQueue } from "./attention-queue"
import { DiscussionThread } from "./discussion-thread"

export default function SwarmDashboard() {
  const params = useParams()
  const [swarm, { refetch }] = createResource(
    () => params.id,
    async (id) => {
      const resp = await fetch(`/swarm/${id}`)
      if (!resp.ok) return null
      return resp.json()
    },
  )

  const elapsed = () => {
    const s = swarm()
    if (!s) return ""
    const ms = (s.time.completed ?? Date.now()) - s.time.created
    const sec = Math.floor(ms / 1000)
    const min = Math.floor(sec / 60)
    if (min > 0) return `${min}m ${sec % 60}s`
    return `${sec}s`
  }

  const badge = (status: string) => {
    const colors: Record<string, string> = {
      planning: "bg-yellow-500/20 text-yellow-400",
      running: "bg-blue-500/20 text-blue-400",
      paused: "bg-gray-500/20 text-gray-400",
      completed: "bg-green-500/20 text-green-400",
      failed: "bg-red-500/20 text-red-400",
    }
    return colors[status] ?? "bg-gray-500/20 text-gray-400"
  }

  async function action(op: string) {
    await fetch(`/swarm/${params.id}/${op}`, { method: "POST" })
    refetch()
  }

  const [disc] = createResource(
    () => params.id,
    async (id) => {
      const resp = await fetch(`/swarm/${id}/discussion`).catch(() => null)
      if (!resp?.ok) return null
      return resp.json()
    },
  )

  const discussion = createMemo(() => disc()?.topic != null)

  const [msg, setMsg] = createSignal("")

  async function intervene() {
    const text = msg()
    if (!text) return
    await fetch(`/swarm/${params.id}/intervene`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    })
    setMsg("")
  }

  return (
    <div class="flex flex-col h-full p-4 gap-4 overflow-auto">
      <Show when={swarm()}>
        {(s) => (
          <>
            {/* Header */}
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <h1 class="text-lg font-semibold">{s().goal}</h1>
                <span class={`px-2 py-0.5 rounded text-xs font-medium ${badge(s().status)}`}>{s().status}</span>
                <span class="text-xs text-gray-500">{elapsed()}</span>
              </div>
              {/* Controls */}
              <div class="flex items-center gap-2">
                <button
                  class="px-3 py-1 text-xs rounded bg-yellow-600/20 text-yellow-400 disabled:opacity-30"
                  disabled={s().status !== "running"}
                  onClick={() => action("pause")}
                >
                  Pause
                </button>
                <button
                  class="px-3 py-1 text-xs rounded bg-blue-600/20 text-blue-400 disabled:opacity-30"
                  disabled={s().status !== "paused"}
                  onClick={() => action("resume")}
                >
                  Resume
                </button>
                <button
                  class="px-3 py-1 text-xs rounded bg-red-600/20 text-red-400 disabled:opacity-30"
                  disabled={s().status === "completed" || s().status === "failed"}
                  onClick={() => action("stop")}
                >
                  Stop
                </button>
              </div>
            </div>

            {/* Message input */}
            <div class="flex gap-2">
              <input
                class="flex-1 px-3 py-1.5 text-sm rounded bg-gray-800 border border-gray-700 focus:outline-none focus:border-blue-500"
                placeholder="Send message to Conductor..."
                value={msg()}
                onInput={(e) => setMsg(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && intervene()}
              />
              <button class="px-3 py-1.5 text-xs rounded bg-blue-600 text-white" onClick={intervene}>
                Send
              </button>
            </div>

            {/* Workers */}
            <div class="flex gap-3 overflow-x-auto">
              <For each={s().workers}>{(w: any) => <WorkerCard worker={w} />}</For>
            </div>

            {/* Main content */}
            <Show
              when={discussion()}
              fallback={
                <div class="grid grid-cols-2 gap-4 flex-1 min-h-0">
                  <TaskGraph tasks={s().tasks ?? []} />
                  <div class="flex flex-col gap-4">
                    <AttentionQueue swarmId={params.id ?? ""} />
                    <ActivityFeed swarmId={params.id ?? ""} />
                  </div>
                </div>
              }
            >
              <DiscussionThread swarmId={params.id ?? ""} />
            </Show>
          </>
        )}
      </Show>
      <Show when={!swarm()}>
        <div class="flex items-center justify-center h-full text-gray-500">Loading Swarm...</div>
      </Show>
    </div>
  )
}
