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
    updated_at: number
    needs_attention: boolean
    attention: string[]
  }
  goal: string
  plan_summary: string
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
    source.onmessage = () => refetch()
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

  async function act(kind: "stop" | "delete") {
    await fetch(`${sdk.url}/swarm/${params.id}/${kind}`, { method: "POST" })
    setState("confirm", "")
    refetch()
  }

  const canStop = createMemo(() => {
    const value = data()?.overview.status
    return value === "running" || value === "blocked"
  })

  const canDelete = createMemo(() => {
    const value = data()?.overview.status
    if (!value) return false
    if (value === "deleted") return false
    return value !== "running" && value !== "blocked" && value !== "planning" && value !== "paused"
  })

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
                    <Show when={canDelete()}>
                      <button
                        class="rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-12-medium text-red-200"
                        onClick={() =>
                          setState("confirm", state.confirm === "delete-ready" ? "delete-ready" : "delete")
                        }
                      >
                        Delete Swarm
                      </button>
                    </Show>
                  </div>

                  <Show
                    when={state.confirm === "stop" || state.confirm === "delete" || state.confirm === "delete-ready"}
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

                      <Show when={state.confirm === "delete"}>
                        <div class="space-y-3">
                          <div class="text-14-medium text-text-strong">Delete this swarm from default lists?</div>
                          <div>Safe delete keeps board, artifact, signal, and discussion records intact.</div>
                          <div class="flex gap-2">
                            <button
                              class="rounded-full border border-border-weak-base px-3 py-1"
                              onClick={() => setState("confirm", "")}
                            >
                              Cancel
                            </button>
                            <button
                              class="rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-red-200"
                              onClick={() => setState("confirm", "delete-ready")}
                            >
                              I understand
                            </button>
                          </div>
                        </div>
                      </Show>

                      <Show when={state.confirm === "delete-ready"}>
                        <div class="space-y-3">
                          <div class="text-14-medium text-text-strong">Final confirmation</div>
                          <div>
                            After delete, this swarm disappears from the default overview and only shows in the deleted
                            filter.
                          </div>
                          <div class="flex gap-2">
                            <button
                              class="rounded-full border border-border-weak-base px-3 py-1"
                              onClick={() => setState("confirm", "")}
                            >
                              Cancel
                            </button>
                            <button
                              class="rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-red-200"
                              onClick={() => act("delete")}
                            >
                              Delete Swarm
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
                    class={`rounded-full border px-3 py-1.5 text-12-medium capitalize ${state.tab === tab ? stateTone(tab === "conductor" ? item().overview.status : "running") : "border-border-weak-base bg-surface-base text-text-base"}`}
                    onClick={() => setState("tab", tab)}
                  >
                    {tab}
                  </button>
                )}
              </For>
            </div>

            <Show when={state.tab === "conductor"}>
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
                  <For each={item().agents}>
                    {(agent) => (
                      <div
                        id={`agent-${agent.id}`}
                        class={`rounded-xl border p-4 ${stateTone(agent.status === "active" ? "running" : agent.status)}`}
                      >
                        <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                          <div class="space-y-2">
                            <div class="flex flex-wrap items-center gap-2">
                              <div class="text-14-medium text-text-strong">{agent.label}</div>
                              <span
                                class={`rounded-full border px-2 py-0.5 text-11-medium ${stateTone(agent.status === "active" ? "running" : agent.status)}`}
                              >
                                {agent.status}
                              </span>
                            </div>
                            <div class="text-12-regular text-text-base">{agent.session_id}</div>
                            <div class="text-12-regular text-text-base">
                              Recent activity {ago(agent.recent_activity_at)}
                            </div>
                            <Show when={agent.recent_progress}>
                              <div class="max-w-2xl text-13-regular text-text-base">{agent.recent_progress}</div>
                            </Show>
                            <Show when={agent.reason}>
                              <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-12-regular text-amber-100">
                                {agent.reason}
                              </div>
                            </Show>
                          </div>
                          <div class="flex flex-col items-start gap-2 xl:items-end">
                            <div class="text-12-regular text-text-base">Tasks {agent.task_count}</div>
                            <Show when={agent.current_task}>
                              <button class="text-12-medium text-sky-200" onClick={() => jumpTask(agent.current_task!)}>
                                {agent.current_task}
                              </button>
                            </Show>
                            <Show when={agent.task_ids.length > 0}>
                              <div class="flex flex-wrap justify-end gap-2">
                                <For each={agent.task_ids}>
                                  {(task) => (
                                    <button
                                      class="rounded-full border border-border-weak-base px-2 py-0.5 text-11-medium text-text-base"
                                      onClick={() => jumpTask(task)}
                                    >
                                      {task}
                                    </button>
                                  )}
                                </For>
                              </div>
                            </Show>
                            <Show when={agent.discussion_channels.length > 0}>
                              <div class="flex flex-wrap justify-end gap-2">
                                <For each={agent.discussion_channels}>
                                  {(channel) => (
                                    <button
                                      class="rounded-full border border-border-weak-base px-2 py-0.5 text-11-medium text-text-base"
                                      onClick={() => jumpDiscussion(channel)}
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
                    )}
                  </For>
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
                                            class={`rounded-full border px-2 py-0.5 text-11-medium ${entry.source === "decision" ? consensusTone("consensus") : entry.source === "summary" ? consensusTone("partial_consensus") : stateTone("running")}`}
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

function Panel(props: { title: string; text: string }) {
  return (
    <div class="rounded-xl border border-border-weak-base bg-background-base p-3">
      <div class="text-11-medium uppercase tracking-[0.16em] text-text-weak">{props.title}</div>
      <div class="mt-2 whitespace-pre-wrap text-13-regular text-text-base">{props.text}</div>
    </div>
  )
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
