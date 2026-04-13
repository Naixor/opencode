import { useParams } from "@solidjs/router"
import { createMemo, createResource, For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { ago, consensusTone, filterTasks, stateTone, taskTone } from "./helpers"

type Detail = {
  overview: {
    swarm_id: string
    status: string
    current_phase: string
    verify_status: string | null
    updated_at: number
    archived_at: number | null
    needs_attention: boolean
    attention: string[]
  }
  goal: string
  plan_summary: string
  verify_status: string | null
  risk_summary: string
  plan_empty: boolean
  plan_empty_copy: string
  last_decision_at: number | null
  actions: Array<{ id: string; time: number; kind: string; summary: string }>
  tasks: Array<{
    id: string
    summary: string
    type: string
    status: string
    blocked_by: string[]
    assignee: string | null
    created_at: number
    updated_at: number
    blocked_reason: string | null
  }>
  task_filters: {
    assignees: string[]
    statuses: string[]
    types: string[]
  }
  alignment: {
    contract: {
      goal: string
      scope: string
      constraints: string[]
      roles: Array<{
        role_id: string | null
        name: string
        purpose: string | null
        perspective: string | null
        default_when: string | null
      }>
      mode: "execute" | "discussion"
      assumptions: string[]
      risks: string[]
      discussion_reason: string | null
      created_at: number
    } | null
    selected_roles: Array<{
      role_id: string | null
      name: string
      purpose: string | null
      perspective: string | null
      default_when: string | null
    }>
    gate: {
      value: "G0" | "G1" | "G2" | "G3" | null
      reason: string | null
    }
    role_delta: {
      material: boolean
      roles: Array<{
        role_id: string | null
        name: string
        state: "unchanged" | "added" | "removed" | "modified"
        fields: Array<"purpose" | "perspective" | "default_when">
      }>
    }
    pending_confirmation: {
      kind: "run" | "role"
      gate: "G0" | "G1" | "G2" | "G3" | null
      reason: string | null
      roles: string[]
    } | null
    run_confirmation: {
      gate: "G0" | "G1" | "G2" | "G3"
      confirmed_at: number
      confirmed_by: string
    } | null
    summary: {
      goal: string
      scope: string
      constraints: string[]
      roles: string[]
      role_deltas: Array<{
        role_id: string | null
        name: string
        state: "unchanged" | "added" | "removed" | "modified"
        fields: Array<"purpose" | "perspective" | "default_when">
      }>
      assumptions: string[]
      next_phase: string
      ask: string | null
      created_at: number
    } | null
  }
  agents: Array<{
    id: string
    label: string
    session_id: string
    status: string
    task_count: number
    recent_activity_at: number | null
    current_task: string | null
    recent_progress: string | null
    reason: string | null
    task_ids: string[]
    discussion_channels: string[]
  }>
  discussions: Array<{
    id: string
    channel: string
    topic: string
    current_round: number
    max_rounds: number
    participants: string[]
    tally: { agree: number; disagree: number; modify: number; total: number }
    consensus_state: string
    conflict_summary: {
      supporters: Array<{ id: string; from: string; round: number }>
      objectors: Array<{ id: string; from: string; round: number }>
      modify: Array<{ id: string; from: string; round: number }>
      points: Array<{ text: string; refs: Array<{ id: string; from: string; round: number }> }>
    }
    raw: Array<{
      round: number
      entries: Array<{
        id: string
        from: string
        source: string
        label: string
        summary: string
        content: string
      }>
    }>
  }>
}

const tabs = ["conductor", "tasks", "agents", "discussions"] as const

export default function SwarmDashboard() {
  const params = useParams()
  const sdk = useSDK()
  const [state, setState] = createStore({
    tab: "conductor",
    confirm: "",
    assignee: "",
    status: "",
    type: "",
    open: {} as Record<string, boolean>,
  })

  const [data, { refetch }] = createResource(
    () => params.id,
    async (id) => {
      const resp = await fetch(`${sdk.url}/swarm/${id}/admin?include_deleted=true`)
      if (!resp.ok) return null
      return (await resp.json()) as Detail
    },
  )

  onMount(() => {
    const timer = window.setInterval(() => refetch(), 5_000)
    const source = new EventSource(`${sdk.url}/swarm/${params.id}/events`)
    let seq = 0
    source.onmessage = (ev) => {
      const data = JSON.parse(ev.data)
      const next = data.type === "snapshot" ? data.payload?.seq : data.payload?.transition?.seq
      if (typeof next !== "number") {
        refetch()
        return
      }
      if (next <= seq) return
      seq = next
      refetch()
    }
    onCleanup(() => {
      window.clearInterval(timer)
      source.close()
    })
  })

  const tasks = createMemo(() =>
    filterTasks(data()?.tasks ?? [], {
      assignee: state.assignee,
      status: state.status,
      type: state.type,
    }),
  )
  const queued = createMemo(() => (data()?.agents ?? []).filter((agent) => agent.status === "queued"))
  const activeAgents = createMemo(() => (data()?.agents ?? []).filter((agent) => agent.status !== "queued"))

  function jump(target: string) {
    requestAnimationFrame(() => {
      document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "center" })
    })
  }

  function jumpAgent(value: string | null) {
    if (!value) return
    const item = data()?.agents.find((agent) => agent.session_id === value || agent.label === value)
    if (!item) return
    setState("tab", "agents")
    jump(`agent-${item.id}`)
  }

  function jumpDiscussion(value: string) {
    setState("tab", "discussions")
    jump(`discussion-${value}`)
  }

  function jumpTask(value: string) {
    setState("tab", "tasks")
    jump(`task-${value}`)
  }

  function jumpRaw(channel: string, ref: string) {
    setState("tab", "discussions")
    setState("open", channel, true)
    jump(ref)
  }

  async function act(kind: "stop" | "archive" | "unarchive" | "purge") {
    await fetch(`${sdk.url}/swarm/${params.id}/${kind}`, { method: "POST" })
    setState("confirm", "")
    refetch()
  }

  const canStop = createMemo(() => {
    const value = data()?.overview.status
    return value === "active" || value === "blocked" || value === "paused"
  })

  const canArchive = createMemo(() => {
    const value = data()?.overview.status
    if (!value) return false
    return value !== "active" && value !== "blocked" && value !== "paused"
  })

  const canUnarchive = createMemo(() => Boolean(data()?.overview.archived_at))

  const canPurge = createMemo(() => Boolean(data()?.overview.archived_at))

  return (
    <div class="flex size-full flex-col gap-4 overflow-auto p-4">
      <Show when={data()} fallback={<Loading />}>
        {(item) => (
          <>
            <div class="rounded-2xl border border-border-weak-base bg-background-stronger p-4">
              <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div class="space-y-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <span
                      class={`rounded-full border px-2.5 py-1 text-11-medium uppercase tracking-[0.18em] ${stateTone(item().overview.status)}`}
                    >
                      {item().overview.status}
                    </span>
                    <span class="rounded-full border border-border-weak-base bg-surface-base px-2.5 py-1 text-11-medium uppercase tracking-[0.18em] text-text-weak">
                      {item().overview.current_phase}
                    </span>
                    <Show when={item().verify_status}>
                      <span class="rounded-full border border-border-weak-base bg-surface-base px-2.5 py-1 text-11-medium uppercase tracking-[0.18em] text-text-weak">
                        verify {item().verify_status}
                      </span>
                    </Show>
                    <Show when={item().overview.archived_at}>
                      <span
                        class={`rounded-full border px-2.5 py-1 text-11-medium uppercase tracking-[0.18em] ${stateTone("archived")}`}
                      >
                        archived
                      </span>
                    </Show>
                    <span class="text-12-regular text-text-weak">Updated {ago(item().overview.updated_at)}</span>
                  </div>
                  <div>
                    <div class="text-12-medium uppercase tracking-[0.22em] text-text-weak">
                      {item().overview.swarm_id}
                    </div>
                    <h1 class="mt-1 text-2xl font-semibold text-text-strong">{item().goal}</h1>
                  </div>
                  <Show when={item().overview.needs_attention}>
                    <div class="flex flex-wrap gap-2">
                      <For each={item().overview.attention}>
                        {(entry) => (
                          <span
                            class={`rounded-full border px-2.5 py-1 text-11-medium ${consensusTone(entry === "no_consensus" ? "no_consensus" : "partial_consensus")}`}
                          >
                            {entry.replaceAll("_", " ")}
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>

                <div class="flex flex-col items-start gap-2 xl:items-end">
                  <div class="flex flex-wrap gap-2">
                    <Show when={canStop()}>
                      <button
                        class="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-12-medium text-amber-200"
                        onClick={() => setState("confirm", "stop")}
                      >
                        Stop Swarm
                      </button>
                    </Show>
                    <Show when={canArchive() && !item().overview.archived_at}>
                      <button
                        class="rounded-full border border-zinc-500/30 bg-zinc-500/10 px-3 py-1.5 text-12-medium text-zinc-200"
                        onClick={() => setState("confirm", "archive")}
                      >
                        Archive Swarm
                      </button>
                    </Show>
                    <Show when={canUnarchive()}>
                      <button
                        class="rounded-full border border-zinc-500/30 bg-zinc-500/10 px-3 py-1.5 text-12-medium text-zinc-200"
                        onClick={() => setState("confirm", "unarchive")}
                      >
                        Unarchive
                      </button>
                    </Show>
                    <Show when={canPurge()}>
                      <button
                        class="rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-12-medium text-red-200"
                        onClick={() => setState("confirm", "purge")}
                      >
                        Purge Swarm
                      </button>
                    </Show>
                  </div>

                  <Show
                    when={
                      state.confirm === "stop" ||
                      state.confirm === "archive" ||
                      state.confirm === "unarchive" ||
                      state.confirm === "purge"
                    }
                  >
                    <div
                      role="dialog"
                      class="max-w-md rounded-2xl border border-border-weak-base bg-surface-base p-4 text-12-regular text-text-base"
                    >
                      <Show when={state.confirm === "stop"}>
                        <div class="space-y-3">
                          <div class="text-14-medium text-text-strong">Stop this swarm?</div>
                          <div>This stops Conductor and Worker execution and records the stop time.</div>
                          <div class="flex gap-2">
                            <button
                              class="rounded-full border border-border-weak-base px-3 py-1"
                              onClick={() => setState("confirm", "")}
                            >
                              Cancel
                            </button>
                            <button
                              class="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-amber-200"
                              onClick={() => act("stop")}
                            >
                              Confirm Stop
                            </button>
                          </div>
                        </div>
                      </Show>

                      <Show when={state.confirm === "archive"}>
                        <div class="space-y-3">
                          <div class="text-14-medium text-text-strong">Archive this swarm?</div>
                          <div>Archiving hides this swarm from default lists but keeps board records intact.</div>
                          <div class="flex gap-2">
                            <button
                              class="rounded-full border border-border-weak-base px-3 py-1"
                              onClick={() => setState("confirm", "")}
                            >
                              Cancel
                            </button>
                            <button
                              class="rounded-full border border-zinc-500/30 bg-zinc-500/10 px-3 py-1 text-zinc-200"
                              onClick={() => act("archive")}
                            >
                              Archive
                            </button>
                          </div>
                        </div>
                      </Show>

                      <Show when={state.confirm === "unarchive"}>
                        <div class="space-y-3">
                          <div class="text-14-medium text-text-strong">Restore this swarm?</div>
                          <div>
                            Unarchive returns the swarm to the default overview without changing lifecycle state.
                          </div>
                          <div class="flex gap-2">
                            <button
                              class="rounded-full border border-border-weak-base px-3 py-1"
                              onClick={() => setState("confirm", "")}
                            >
                              Cancel
                            </button>
                            <button
                              class="rounded-full border border-zinc-500/30 bg-zinc-500/10 px-3 py-1 text-zinc-200"
                              onClick={() => act("unarchive")}
                            >
                              Unarchive
                            </button>
                          </div>
                        </div>
                      </Show>

                      <Show when={state.confirm === "purge"}>
                        <div class="space-y-3">
                          <div class="text-14-medium text-text-strong">Purge this swarm?</div>
                          <div>Purging permanently removes the archived swarm data from disk.</div>
                          <div class="flex gap-2">
                            <button
                              class="rounded-full border border-border-weak-base px-3 py-1"
                              onClick={() => setState("confirm", "")}
                            >
                              Cancel
                            </button>
                            <button
                              class="rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-red-200"
                              onClick={() => act("purge")}
                            >
                              Purge Swarm
                            </button>
                          </div>
                        </div>
                      </Show>
                    </div>
                  </Show>
                </div>
              </div>
            </div>

            <div class="flex flex-wrap gap-2">
              <For each={tabs}>
                {(tab) => (
                  <button
                    class={`rounded-full border px-3 py-1.5 text-12-medium capitalize ${state.tab === tab ? stateTone(tab === "conductor" ? item().overview.status : "active") : "border-border-weak-base bg-surface-base text-text-base"}`}
                    onClick={() => setState("tab", tab)}
                  >
                    {tab}
                  </button>
                )}
              </For>
            </div>

            <Show when={state.tab === "conductor"}>
              <div class="space-y-4">
                <Show when={queued().length > 0}>
                  <section class="rounded-2xl border border-sky-500/30 bg-sky-500/10 p-4">
                    <div class="flex flex-col gap-2 xl:flex-row xl:items-start xl:justify-between">
                      <div>
                        <div class="text-11-medium uppercase tracking-[0.18em] text-sky-100">
                          Prepared Worker Roster
                        </div>
                        <div class="mt-2 max-w-3xl text-13-regular text-sky-50">
                          These workers are registered but not started yet. Review this roster before confirming the
                          first execution batch.
                        </div>
                      </div>
                      <div class="rounded-full border border-sky-400/30 bg-background-base px-3 py-1 text-11-medium uppercase tracking-[0.18em] text-sky-200">
                        {queued().length} queued
                      </div>
                    </div>
                    <div class="mt-4 grid gap-3 xl:grid-cols-2">
                      <For each={queued()}>
                        {(agent) => <AgentCard agent={agent} jumpTask={jumpTask} jumpDiscussion={jumpDiscussion} />}
                      </For>
                    </div>
                  </section>
                </Show>

                <section class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
                  <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                    <div>
                      <div class="text-11-medium uppercase tracking-[0.18em] text-text-weak">Alignment Panel</div>
                      <div class="mt-2 max-w-3xl text-13-regular text-text-base">{alignmentCopy(item().alignment)}</div>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      <Show when={item().alignment.gate.value}>
                        <span
                          class={`rounded-full border px-2.5 py-1 text-11-medium uppercase tracking-[0.18em] ${gateTone(item().alignment.gate.value)}`}
                        >
                          {item().alignment.gate.value}
                        </span>
                      </Show>
                      <Show when={item().alignment.contract}>
                        <span class="rounded-full border border-border-weak-base bg-background-base px-2.5 py-1 text-11-medium uppercase tracking-[0.18em] text-text-base">
                          {item().alignment.contract!.mode}
                        </span>
                      </Show>
                      <Show when={item().alignment.pending_confirmation}>
                        <span class="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-11-medium uppercase tracking-[0.18em] text-amber-100">
                          pending approval
                        </span>
                      </Show>
                    </div>
                  </div>

                  <Show
                    when={item().alignment.contract}
                    fallback={
                      <div class="mt-4">
                        <EmptyCopy text="No alignment contract has been recorded for this swarm yet." />
                      </div>
                    }
                  >
                    <div class="mt-4 grid gap-4 xl:grid-cols-2">
                      <Panel title="Gate Decision" text={gateDetail(item().alignment)} />
                      <Panel title="Run Contract" text={contractDetail(item().alignment)} />
                      <Panel title="Selected Roles" text={rolesDetail(item().alignment)} />
                      <Panel title="Role Delta Summary" text={deltaDetail(item().alignment)} />
                    </div>
                  </Show>
                </section>

                <div class="grid gap-4 xl:grid-cols-[1.3fr_0.9fr]">
                  <section class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
                    <div class="text-11-medium uppercase tracking-[0.18em] text-text-weak">Conductor Summary</div>
                    <Show when={!item().plan_empty} fallback={<EmptyCopy text={item().plan_empty_copy} />}>
                      <div class="mt-3 space-y-4">
                        <Panel title="Plan Summary" text={item().plan_summary} />
                        <Panel title="Risk Summary" text={item().risk_summary} />
                        <div class="rounded-xl border border-border-weak-base bg-background-base p-3">
                          <div class="text-11-medium uppercase tracking-[0.16em] text-text-weak">Last Decision</div>
                          <div class="mt-1 text-13-regular text-text-base">{ago(item().last_decision_at)}</div>
                        </div>
                      </div>
                    </Show>
                  </section>

                  <section class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
                    <div class="text-11-medium uppercase tracking-[0.18em] text-text-weak">Latest Actions</div>
                    <div class="mt-3 space-y-3">
                      <For each={item().actions}>
                        {(entry) => (
                          <div class="rounded-xl border border-border-weak-base bg-background-base p-3">
                            <div class="flex items-center justify-between gap-3">
                              <span
                                class={`rounded-full border px-2 py-0.5 text-11-medium ${stateTone(entry.kind === "stop" ? "stopped" : item().overview.status)}`}
                              >
                                {entry.kind}
                              </span>
                              <span class="text-11-regular text-text-weak">{ago(entry.time)}</span>
                            </div>
                            <div class="mt-2 text-13-regular text-text-base">{entry.summary}</div>
                          </div>
                        )}
                      </For>
                      <Show when={item().actions.length === 0}>
                        <EmptyCopy text="No structured conductor actions yet." />
                      </Show>
                    </div>
                  </section>
                </div>
              </div>
            </Show>

            <Show when={state.tab === "tasks"}>
              <section class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
                <div class="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div>
                    <div class="text-11-medium uppercase tracking-[0.18em] text-text-weak">Tasks</div>
                    <div class="text-13-regular text-text-base">
                      Inspect ownership, status, dependencies, and blocked reasons.
                    </div>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <Select
                      value={state.assignee}
                      onChange={(value) => setState("assignee", value)}
                      options={["", ...item().task_filters.assignees]}
                      label="Assignee"
                    />
                    <Select
                      value={state.status}
                      onChange={(value) => setState("status", value)}
                      options={["", ...item().task_filters.statuses]}
                      label="Status"
                    />
                    <Select
                      value={state.type}
                      onChange={(value) => setState("type", value)}
                      options={["", ...item().task_filters.types]}
                      label="Type"
                    />
                  </div>
                </div>
                <div class="mt-4 space-y-3">
                  <For each={tasks()}>
                    {(task) => (
                      <div
                        id={`task-${task.id}`}
                        class="rounded-xl border border-border-weak-base bg-background-base p-4"
                      >
                        <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                          <div class="min-w-0 flex-1">
                            <div class="flex flex-wrap items-center gap-2">
                              <span class="text-11-medium uppercase tracking-[0.18em] text-text-weak">{task.id}</span>
                              <span
                                class={`text-12-medium capitalize ${taskTone(task.status, Boolean(task.blocked_reason))}`}
                              >
                                {task.status.replaceAll("_", " ")}
                              </span>
                              <span class="rounded-full border border-border-weak-base px-2 py-0.5 text-11-medium text-text-base">
                                {task.type}
                              </span>
                            </div>
                            <div class="mt-2 text-14-medium text-text-strong">{task.summary}</div>
                            <div class="mt-2 flex flex-wrap gap-2 text-12-regular text-text-base">
                              <span>Created {ago(task.created_at)}</span>
                              <span>Updated {ago(task.updated_at)}</span>
                              <Show when={task.blocked_by.length > 0}>
                                <span>Blocked by {task.blocked_by.join(", ")}</span>
                              </Show>
                            </div>
                          </div>
                          <div class="flex flex-col items-start gap-2 xl:items-end">
                            <Show
                              when={task.assignee}
                              fallback={<span class="text-12-regular text-text-weak">unassigned</span>}
                            >
                              <button class="text-12-medium text-sky-200" onClick={() => jumpAgent(task.assignee)}>
                                {task.assignee}
                              </button>
                            </Show>
                            <Show when={task.blocked_reason}>
                              <div class="max-w-sm rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-12-regular text-amber-100">
                                {task.blocked_reason}
                              </div>
                            </Show>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                  <Show when={tasks().length === 0}>
                    <EmptyCopy text="No tasks match the current filters." />
                  </Show>
                </div>
              </section>
            </Show>

            <Show when={state.tab === "agents"}>
              <section class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
                <div class="text-11-medium uppercase tracking-[0.18em] text-text-weak">Agents</div>
                <div class="mt-4 space-y-3">
                  <Show when={queued().length > 0}>
                    <div class="space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div class="text-12-medium uppercase tracking-[0.18em] text-text-weak">Queued Roster</div>
                        <div class="text-12-regular text-text-weak">Registered, waiting for human confirmation</div>
                      </div>
                      <For each={queued()}>
                        {(agent) => <AgentCard agent={agent} jumpTask={jumpTask} jumpDiscussion={jumpDiscussion} />}
                      </For>
                    </div>
                  </Show>
                  <Show when={activeAgents().length > 0}>
                    <div class="space-y-3">
                      <div class="text-12-medium uppercase tracking-[0.18em] text-text-weak">Running And Completed</div>
                      <For each={activeAgents()}>
                        {(agent) => <AgentCard agent={agent} jumpTask={jumpTask} jumpDiscussion={jumpDiscussion} />}
                      </For>
                    </div>
                  </Show>
                  <Show when={item().agents.length === 0}>
                    <EmptyCopy text="No workers registered for this swarm yet." />
                  </Show>
                </div>
              </section>
            </Show>

            <Show when={state.tab === "discussions"}>
              <section class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
                <div class="text-11-medium uppercase tracking-[0.18em] text-text-weak">Discussions</div>
                <div class="mt-4 space-y-4">
                  <For each={item().discussions}>
                    {(disc) => (
                      <div
                        id={`discussion-${disc.channel}`}
                        class="rounded-xl border border-border-weak-base bg-background-base p-4"
                      >
                        <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                          <div class="space-y-2">
                            <div class="flex flex-wrap items-center gap-2">
                              <div class="text-14-medium text-text-strong">{disc.topic}</div>
                              <span
                                class={`rounded-full border px-2 py-0.5 text-11-medium ${consensusTone(disc.consensus_state)}`}
                              >
                                {disc.consensus_state.replaceAll("_", " ")}
                              </span>
                            </div>
                            <div class="text-12-regular text-text-base">
                              {disc.channel} · round {disc.current_round}/{disc.max_rounds}
                            </div>
                            <div class="text-12-regular text-text-base">
                              Participants: {disc.participants.join(", ") || "-"}
                            </div>
                            <div class="flex flex-wrap gap-2 text-12-regular text-text-base">
                              <span>Agree {disc.tally.agree}</span>
                              <span>Disagree {disc.tally.disagree}</span>
                              <span>Modify {disc.tally.modify}</span>
                            </div>
                          </div>
                          <button
                            class="rounded-full border border-border-weak-base px-3 py-1 text-12-medium text-text-base"
                            onClick={() => setState("open", disc.channel, (value) => !value)}
                          >
                            {state.open[disc.channel] ? "Hide Raw" : "Show Raw"}
                          </button>
                        </div>

                        <div class="mt-4 grid gap-3 xl:grid-cols-2">
                          <Summary
                            title="Supporters"
                            refs={disc.conflict_summary.supporters}
                            onJump={(ref) => jumpRaw(disc.channel, ref)}
                          />
                          <Summary
                            title="Objectors"
                            refs={disc.conflict_summary.objectors}
                            onJump={(ref) => jumpRaw(disc.channel, ref)}
                          />
                          <Summary
                            title="Modify"
                            refs={disc.conflict_summary.modify}
                            onJump={(ref) => jumpRaw(disc.channel, ref)}
                          />
                          <div class="rounded-xl border border-border-weak-base bg-surface-base p-3">
                            <div class="text-11-medium uppercase tracking-[0.16em] text-text-weak">
                              Main Disagreement
                            </div>
                            <div class="mt-2 space-y-2">
                              <For each={disc.conflict_summary.points}>
                                {(point) => (
                                  <div class="rounded-lg border border-border-weak-base bg-background-base px-3 py-2 text-12-regular text-text-base">
                                    <div>{point.text}</div>
                                    <div class="mt-2 flex flex-wrap gap-2">
                                      <For each={point.refs}>
                                        {(ref) => (
                                          <button
                                            class="rounded-full border border-border-weak-base px-2 py-0.5 text-11-medium text-sky-200"
                                            onClick={() => jumpRaw(disc.channel, ref.id)}
                                          >
                                            {ref.from} · round {ref.round}
                                          </button>
                                        )}
                                      </For>
                                    </div>
                                  </div>
                                )}
                              </For>
                              <Show when={disc.conflict_summary.points.length === 0}>
                                <div class="text-12-regular text-text-weak">No disagreement summary yet.</div>
                              </Show>
                            </div>
                          </div>
                        </div>

                        <Show when={state.open[disc.channel]}>
                          <div class="mt-4 space-y-3 border-t border-border-weak-base pt-4">
                            <For each={disc.raw}>
                              {(group) => (
                                <div class="space-y-2">
                                  <div class="text-11-medium uppercase tracking-[0.16em] text-text-weak">
                                    Round {group.round}
                                  </div>
                                  <For each={group.entries}>
                                    {(entry) => (
                                      <div
                                        id={entry.id}
                                        class="rounded-xl border border-border-weak-base bg-surface-base p-3"
                                      >
                                        <div class="flex flex-wrap items-center gap-2">
                                          <span
                                            class={`rounded-full border px-2 py-0.5 text-11-medium ${entry.source === "decision" ? consensusTone("consensus") : entry.source === "summary" ? consensusTone("partial_consensus") : stateTone("active")}`}
                                          >
                                            {entry.source}
                                          </span>
                                          <span class="text-12-medium text-text-base">{entry.label}</span>
                                          <span class="text-12-regular text-text-weak">{entry.from}</span>
                                        </div>
                                        <div class="mt-2 text-13-regular text-text-base">{entry.summary}</div>
                                        <pre class="mt-3 overflow-auto rounded-lg bg-background-stronger p-3 text-11-regular text-text-base">
                                          {entry.content}
                                        </pre>
                                      </div>
                                    )}
                                  </For>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                  <Show when={item().discussions.length === 0}>
                    <EmptyCopy text="No discussions tracked for this swarm." />
                  </Show>
                </div>
              </section>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}

function Select(props: { value: string; options: string[]; label: string; onChange: (value: string) => void }) {
  return (
    <label class="flex items-center gap-2 rounded-full border border-border-weak-base bg-background-base px-3 py-1.5 text-12-regular text-text-base">
      <span class="text-text-weak">{props.label}</span>
      <select
        class="bg-transparent text-text-base outline-none"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        <For each={props.options}>{(item) => <option value={item}>{item || "All"}</option>}</For>
      </select>
    </label>
  )
}

function Summary(props: {
  title: string
  refs: Array<{ id: string; from: string; round: number }>
  onJump: (ref: string) => void
}) {
  return (
    <div class="rounded-xl border border-border-weak-base bg-surface-base p-3">
      <div class="text-11-medium uppercase tracking-[0.16em] text-text-weak">{props.title}</div>
      <div class="mt-2 flex flex-wrap gap-2">
        <For each={props.refs}>
          {(ref) => (
            <button
              class="rounded-full border border-border-weak-base px-2 py-0.5 text-11-medium text-sky-200"
              onClick={() => props.onJump(ref.id)}
            >
              {ref.from} · round {ref.round}
            </button>
          )}
        </For>
        <Show when={props.refs.length === 0}>
          <span class="text-12-regular text-text-weak">None</span>
        </Show>
      </div>
    </div>
  )
}

function AgentCard(props: {
  agent: Detail["agents"][number]
  jumpTask: (value: string) => void
  jumpDiscussion: (value: string) => void
}) {
  return (
    <div id={`agent-${props.agent.id}`} class={`rounded-xl border p-4 ${stateTone(props.agent.status)}`}>
      <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div class="space-y-2">
          <div class="flex flex-wrap items-center gap-2">
            <div class="text-14-medium text-text-strong">{props.agent.label}</div>
            <span class={`rounded-full border px-2 py-0.5 text-11-medium ${stateTone(props.agent.status)}`}>
              {props.agent.status}
            </span>
          </div>
          <div class="text-12-regular text-text-base">{props.agent.session_id}</div>
          <div class="text-12-regular text-text-base">
            {props.agent.recent_activity_at
              ? `Recent activity ${ago(props.agent.recent_activity_at)}`
              : "No execution activity yet"}
          </div>
          <Show when={props.agent.recent_progress}>
            <div class="max-w-2xl text-13-regular text-text-base">{props.agent.recent_progress}</div>
          </Show>
          <Show when={props.agent.reason}>
            <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-12-regular text-amber-100">
              {props.agent.reason}
            </div>
          </Show>
        </div>
        <div class="flex flex-col items-start gap-2 xl:items-end">
          <div class="text-12-regular text-text-base">Tasks {props.agent.task_count}</div>
          <Show when={props.agent.current_task}>
            <button class="text-12-medium text-sky-200" onClick={() => props.jumpTask(props.agent.current_task!)}>
              {props.agent.current_task}
            </button>
          </Show>
          <Show when={props.agent.task_ids.length > 0}>
            <div class="flex flex-wrap justify-end gap-2">
              <For each={props.agent.task_ids}>
                {(task) => (
                  <button
                    class="rounded-full border border-border-weak-base px-2 py-0.5 text-11-medium text-text-base"
                    onClick={() => props.jumpTask(task)}
                  >
                    {task}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={props.agent.discussion_channels.length > 0}>
            <div class="flex flex-wrap justify-end gap-2">
              <For each={props.agent.discussion_channels}>
                {(channel) => (
                  <button
                    class="rounded-full border border-border-weak-base px-2 py-0.5 text-11-medium text-text-base"
                    onClick={() => props.jumpDiscussion(channel)}
                  >
                    {channel}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

function Panel(props: { title: string; text: string }) {
  return (
    <div class="rounded-xl border border-border-weak-base bg-background-base p-3">
      <div class="text-11-medium uppercase tracking-[0.16em] text-text-weak">{props.title}</div>
      <div class="mt-2 whitespace-pre-wrap text-13-regular text-text-base">{props.text}</div>
    </div>
  )
}

function gateTone(value: "G0" | "G1" | "G2" | "G3" | null) {
  if (value === "G0") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
  if (value === "G1") return "border-sky-500/30 bg-sky-500/10 text-sky-200"
  if (value === "G2") return "border-amber-500/30 bg-amber-500/10 text-amber-100"
  if (value === "G3") return "border-red-500/30 bg-red-500/10 text-red-200"
  return "border-border-weak-base bg-background-base text-text-base"
}

function alignmentCopy(align: Detail["alignment"]) {
  if (!align.gate.value) return "No alignment decision has been recorded for this swarm yet."
  if (align.pending_confirmation)
    return `Swarm paused at ${align.gate.value} until the current alignment checkpoint is approved.`
  if (align.gate.value === "G0")
    return "Routine work auto-ran at G0 because the current contract stayed low risk and aligned with the confirmed role set."
  if (align.gate.value === "G1")
    return "Swarm continued at G1 without blocking because the run needed visibility, not a fresh approval gate."
  if (align.run_confirmation)
    return `The current ${align.gate.value} contract was approved by ${align.run_confirmation.confirmed_by} and resumed without exposing worker prompts.`
  return `This swarm is currently operating under ${align.gate.value}.`
}

function gateDetail(align: Detail["alignment"]) {
  const lines = [`Gate: ${align.gate.value ?? "unknown"}`]
  if (align.gate.reason) lines.push(`Reason: ${align.gate.reason}`)
  if (align.pending_confirmation)
    lines.push(`Pause reason: ${align.pending_confirmation.reason ?? "Awaiting approval"}`)
  else if (align.summary) lines.push(`Next phase: ${align.summary.next_phase}`)
  if (align.run_confirmation) {
    lines.push(`Approved by: ${align.run_confirmation.confirmed_by}`)
    lines.push(`Approved: ${ago(align.run_confirmation.confirmed_at)}`)
  }
  return lines.join("\n")
}

function contractDetail(align: Detail["alignment"]) {
  if (!align.contract) return "No run contract recorded."
  const lines = [`Scope: ${align.contract.scope}`]
  if (align.contract.constraints.length > 0) lines.push(`Constraints: ${align.contract.constraints.join(", ")}`)
  if (align.summary?.assumptions.length) lines.push(`Assumptions: ${align.summary.assumptions.join(", ")}`)
  if (align.contract.risks.length > 0) lines.push(`Risks: ${align.contract.risks.join(", ")}`)
  if (align.contract.discussion_reason) lines.push(`Discussion reason: ${align.contract.discussion_reason}`)
  if (align.summary?.ask) lines.push(`Approval ask: ${align.summary.ask}`)
  return lines.join("\n")
}

function rolesDetail(align: Detail["alignment"]) {
  if (align.selected_roles.length === 0) return "No roles selected."
  return align.selected_roles
    .map((role) => {
      const lines = [role.name]
      if (role.purpose) lines.push(`purpose: ${role.purpose}`)
      if (role.perspective) lines.push(`perspective: ${role.perspective}`)
      if (role.default_when) lines.push(`default when: ${role.default_when}`)
      return lines.join(" - ")
    })
    .join("\n")
}

function deltaDetail(align: Detail["alignment"]) {
  const list = align.role_delta.roles.filter((role) => role.state !== "unchanged")
  if (list.length === 0) return "No material role deltas."
  return list
    .map((role) => `${role.name}: ${role.state}${role.fields.length ? ` (${role.fields.join(", ")})` : ""}`)
    .join("\n")
}

function EmptyCopy(props: { text: string }) {
  return (
    <div class="rounded-xl border border-dashed border-border-weak-base bg-background-base p-4 text-13-regular text-text-weak">
      {props.text}
    </div>
  )
}

function Loading() {
  return (
    <div class="rounded-2xl border border-border-weak-base bg-surface-base p-4 text-12-regular text-text-weak">
      Loading swarm...
    </div>
  )
}
