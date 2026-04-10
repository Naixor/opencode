import { A, useParams } from "@solidjs/router"
import { createResource, createSignal, For, Show } from "solid-js"
import { useSDK } from "@/context/sdk"

interface SwarmInfo {
  id: string
  goal: string
  status: string
  workers: Array<{ status: string }>
}

const colors: Record<string, string> = {
  planning: "bg-yellow-500/20 text-yellow-400",
  running: "bg-blue-500/20 text-blue-400",
  paused: "bg-gray-500/20 text-gray-400",
  completed: "bg-green-500/10 text-green-500",
  failed: "bg-red-500/10 text-red-500",
}

export function SidebarSwarm() {
  const params = useParams()
  const sdk = useSDK()

  const [swarms, { refetch }] = createResource(async () => {
    const resp = await fetch(`${sdk.url}/swarm`).catch(() => null)
    if (!resp || !resp.ok) return []
    return (await resp.json()) as SwarmInfo[]
  })

  const [goal, setGoal] = createSignal("")
  const [open, setOpen] = createSignal(false)

  async function launch() {
    const text = goal()
    if (!text) return
    await fetch(`${sdk.url}/swarm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: text }),
    }).catch(() => {})
    setGoal("")
    setOpen(false)
    refetch()
  }

  const active = () => (swarms() ?? []).filter((s) => s.status !== "completed" && s.status !== "failed")
  const done = () => (swarms() ?? []).filter((s) => s.status === "completed" || s.status === "failed")

  return (
    <div class="flex flex-col gap-1 px-2 py-2 border-b border-border-weak-base">
      <div class="flex items-center justify-between px-2">
        <A
          href={`/${params.dir}/swarm`}
          class="text-12-medium text-text-base uppercase tracking-wider hover:text-text-strong"
        >
          Swarms
        </A>
        <button
          class="text-icon-base hover:text-text-strong text-xs"
          onClick={() => setOpen(!open())}
          aria-label="New Swarm"
        >
          +
        </button>
      </div>

      <Show when={open()}>
        <div class="flex gap-1 px-1">
          <input
            class="flex-1 px-2 py-1 text-xs rounded bg-surface-base border border-border-weak-base focus:outline-none focus:border-border-interactive-base"
            placeholder="Goal..."
            value={goal()}
            onInput={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && launch()}
          />
          <button class="px-2 py-1 text-xs rounded bg-surface-interactive-base text-text-on-fill" onClick={launch}>
            Go
          </button>
        </div>
      </Show>

      <For each={active()}>
        {(s) => (
          <A
            href={`/${params.dir}/swarm/${s.id}`}
            class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-base-hover text-14-regular"
          >
            <span class={`px-1.5 py-0.5 rounded text-[10px] ${colors[s.status] ?? colors.paused}`}>{s.status}</span>
            <span class="truncate text-text-base flex-1 text-xs">{s.goal.slice(0, 40)}</span>
            <span class="text-[10px] text-text-weak">{s.workers.length}w</span>
          </A>
        )}
      </For>

      <For each={done()}>
        {(s) => (
          <A
            href={`/${params.dir}/swarm/${s.id}`}
            class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-base-hover text-14-regular opacity-50"
          >
            <span class={`px-1.5 py-0.5 rounded text-[10px] ${colors[s.status] ?? colors.paused}`}>{s.status}</span>
            <span class="truncate text-text-base flex-1 text-xs">{s.goal.slice(0, 40)}</span>
          </A>
        )}
      </For>

      <Show when={(swarms() ?? []).length === 0 && !open()}>
        <div class="px-2 text-xs text-text-weak">No swarms</div>
      </Show>
    </div>
  )
}
