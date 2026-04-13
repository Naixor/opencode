import { A, useParams } from "@solidjs/router"
import { createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"

interface SwarmInfo {
  id: string
  goal: string
  status: string
  stage: string
  workers: Array<{ status: string }>
}

const colors: Record<string, string> = {
  active: "bg-emerald-500/20 text-emerald-300",
  blocked: "bg-amber-500/20 text-amber-200",
  paused: "bg-gray-500/20 text-gray-400",
  completed: "bg-green-500/10 text-green-500",
  failed: "bg-red-500/10 text-red-500",
  stopped: "bg-orange-500/10 text-orange-300",
}

export function SidebarSwarm() {
  const params = useParams()
  const sdk = useSDK()

  const [swarms, { refetch }] = createResource(async () => {
    const resp = await fetch(`${sdk.url}/swarm`).catch(() => null)
    if (!resp || !resp.ok) return []
    return (await resp.json()) as SwarmInfo[]
  })

  const [state, setState] = createStore({
    goal: "",
    open: false,
    pending: false,
    key: "",
  })

  async function launch() {
    const text = state.goal.trim()
    if (!text || state.pending) return
    const key = state.key || crypto.randomUUID()
    setState("pending", true)
    setState("key", key)
    const resp = await fetch(`${sdk.url}/swarm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: text, dedupe_key: key }),
    }).catch(() => {})
    setState("pending", false)
    if (!resp?.ok) {
      setState("key", "")
      return
    }
    setState("goal", "")
    setState("open", false)
    setState("key", "")
    refetch()
  }

  const active = () => (swarms() ?? []).filter((s) => !["completed", "failed", "stopped"].includes(s.status))
  const done = () => (swarms() ?? []).filter((s) => ["completed", "failed", "stopped"].includes(s.status))

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
          onClick={() => !state.pending && setState("open", !state.open)}
          aria-label="New Swarm"
        >
          +
        </button>
      </div>

      <Show when={state.open}>
        <div class="flex gap-1 px-1">
          <input
            class="flex-1 px-2 py-1 text-xs rounded bg-surface-base border border-border-weak-base focus:outline-none focus:border-border-interactive-base"
            placeholder="Goal..."
            value={state.goal}
            onInput={(e) => setState("goal", e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.repeat && launch()}
          />
          <button
            class="px-2 py-1 text-xs rounded bg-surface-interactive-base text-text-on-fill disabled:opacity-50"
            disabled={state.pending}
            onClick={launch}
          >
            {state.pending ? "..." : "Go"}
          </button>
        </div>
      </Show>

      <For each={active()}>
        {(s) => (
          <A
            href={`/${params.dir}/swarm/${s.id}/run`}
            class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-base-hover text-14-regular"
          >
            <span class={`px-1.5 py-0.5 rounded text-[10px] ${colors[s.status] ?? colors.paused}`}>{s.status}</span>
            <span class="truncate text-text-base flex-1 text-xs">{s.goal.slice(0, 40)}</span>
            <span class="text-[10px] text-text-weak">{s.stage}</span>
          </A>
        )}
      </For>

      <For each={done()}>
        {(s) => (
          <A
            href={`/${params.dir}/swarm/${s.id}/run`}
            class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-base-hover text-14-regular opacity-50"
          >
            <span class={`px-1.5 py-0.5 rounded text-[10px] ${colors[s.status] ?? colors.paused}`}>{s.status}</span>
            <span class="truncate text-text-base flex-1 text-xs">{s.goal.slice(0, 40)}</span>
          </A>
        )}
      </For>

      <Show when={(swarms() ?? []).length === 0 && !state.open}>
        <div class="px-2 text-xs text-text-weak">No swarms</div>
      </Show>
    </div>
  )
}
