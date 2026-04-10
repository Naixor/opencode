import { A, useParams } from "@solidjs/router"
import { createResource, For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { ago, consensusTone, stateTone } from "./helpers"

type Row = {
  swarm_id: string
  goal_summary: string
  conductor_label: string
  status: string
  current_phase: string
  updated_at: number
  task_counts: {
    pending: number
    running: number
    blocked: number
    failed: number
    completed: number
  }
  discussion_counts: {
    active: number
    consensus: number
    no_consensus: number
  }
  needs_attention: boolean
  attention: string[]
}

const tabs = [
  ["all", "All"],
  ["running", "Running"],
  ["blocked", "Blocked"],
  ["failed", "Failed"],
  ["completed", "Completed"],
  ["deleted", "Deleted"],
] as const

export default function SwarmOverview() {
  const sdk = useSDK()
  const params = useParams()
  const [state, setState] = createStore({
    status: "all",
    attention: false,
  })

  const [rows, { refetch }] = createResource(
    () => ({ status: state.status, attention: state.attention }),
    async (input) => {
      const query = new URLSearchParams()
      if (input.status !== "all") query.set("status", input.status)
      if (input.attention) query.set("needs_attention", "true")
      if (input.status === "deleted") query.set("include_deleted", "true")
      const resp = await fetch(`${sdk.url}/swarm/admin?${query.toString()}`)
      if (!resp.ok) return [] as Row[]
      return (await resp.json()) as Row[]
    },
  )

  onMount(() => {
    const id = window.setInterval(() => refetch(), 5_000)
    onCleanup(() => window.clearInterval(id))
  })

  return (
    <div class="flex size-full flex-col gap-4 overflow-auto p-4">
      <div class="flex flex-col gap-3 rounded-xl border border-border-weak-base bg-background-stronger p-4">
        <div class="flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
          <div>
            <div class="text-12-medium uppercase tracking-[0.24em] text-text-weak">Swarm Admin</div>
            <h1 class="text-2xl font-semibold text-text-strong">Overview</h1>
          </div>
          <button
            class={`inline-flex w-fit items-center rounded-full border px-3 py-1 text-12-medium ${state.attention ? consensusTone("no_consensus") : "border-border-weak-base bg-surface-base text-text-base"}`}
            onClick={() => setState("attention", (value) => !value)}
          >
            Needs Attention
          </button>
        </div>
        <div class="flex flex-wrap gap-2">
          <For each={tabs}>
            {(tab) => (
              <button
                class={`rounded-full border px-3 py-1 text-12-medium ${state.status === tab[0] ? stateTone(tab[0]) : "border-border-weak-base bg-surface-base text-text-base"}`}
                onClick={() => setState("status", tab[0])}
              >
                {tab[1]}
              </button>
            )}
          </For>
        </div>
      </div>

      <Show when={rows.loading}>
        <div class="rounded-xl border border-border-weak-base bg-surface-base p-4 text-12-regular text-text-weak">
          Loading swarms...
        </div>
      </Show>

      <Show when={(rows() ?? []).length > 0} fallback={<Empty />}>
        <div class="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          <For each={rows()}>
            {(row) => (
              <A
                href={`/${params.dir}/swarm/${row.swarm_id}`}
                class={`group flex flex-col gap-4 rounded-2xl border p-4 transition-colors hover:border-border-interactive-base ${row.status === "blocked" || row.status === "failed" ? "bg-background-stronger" : "bg-surface-base"} ${stateTone(row.status)}`}
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="text-12-medium uppercase tracking-[0.22em] text-text-weak">{row.swarm_id}</div>
                    <div class="mt-1 text-16-medium text-text-strong">{row.goal_summary}</div>
                  </div>
                  <span class={`rounded-full border px-2 py-0.5 text-11-medium ${stateTone(row.status)}`}>
                    {row.status}
                  </span>
                </div>

                <div class="grid grid-cols-2 gap-3 text-12-regular text-text-base">
                  <Meta label="Conductor" value={row.conductor_label} />
                  <Meta label="Phase" value={row.current_phase} />
                  <Meta label="Updated" value={ago(row.updated_at)} />
                  <Meta label="Attention" value={row.needs_attention ? row.attention.join(", ") : "Clear"} />
                </div>

                <div class="grid gap-3 md:grid-cols-2">
                  <div class="rounded-xl border border-border-weak-base bg-background-base p-3">
                    <div class="text-11-medium uppercase tracking-[0.18em] text-text-weak">Tasks</div>
                    <div class="mt-2 grid grid-cols-3 gap-2 text-12-regular text-text-base">
                      <Stat label="Pending" value={row.task_counts.pending} />
                      <Stat label="Running" value={row.task_counts.running} />
                      <Stat label="Blocked" value={row.task_counts.blocked} />
                      <Stat label="Failed" value={row.task_counts.failed} />
                      <Stat label="Done" value={row.task_counts.completed} />
                    </div>
                  </div>
                  <div class="rounded-xl border border-border-weak-base bg-background-base p-3">
                    <div class="text-11-medium uppercase tracking-[0.18em] text-text-weak">Discussions</div>
                    <div class="mt-2 grid grid-cols-3 gap-2 text-12-regular text-text-base">
                      <Stat label="Active" value={row.discussion_counts.active} />
                      <Stat label="Consensus" value={row.discussion_counts.consensus} />
                      <Stat label="No Consensus" value={row.discussion_counts.no_consensus} />
                    </div>
                  </div>
                </div>
              </A>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function Meta(props: { label: string; value: string }) {
  return (
    <div class="min-w-0">
      <div class="text-11-medium uppercase tracking-[0.16em] text-text-weak">{props.label}</div>
      <div class="truncate text-13-regular text-text-base">{props.value}</div>
    </div>
  )
}

function Stat(props: { label: string; value: number }) {
  return (
    <div class="rounded-lg border border-border-weak-base bg-surface-base px-2 py-1.5">
      <div class="text-11-medium uppercase tracking-[0.16em] text-text-weak">{props.label}</div>
      <div class="text-14-medium text-text-strong">{props.value}</div>
    </div>
  )
}

function Empty() {
  return (
    <div class="rounded-2xl border border-dashed border-border-weak-base bg-surface-base px-6 py-12 text-center">
      <div class="text-16-medium text-text-strong">No matching swarms</div>
      <div class="mt-2 text-13-regular text-text-weak">Change a filter or launch a new swarm from the sidebar.</div>
    </div>
  )
}
