import type { SwarmDeliveryDetailResponse } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { A, useParams } from "@solidjs/router"
import { createMemo, createResource, For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { ago, stateTone, taskTone } from "./helpers"

type Detail = SwarmDeliveryDetailResponse
type Step = Detail["decisions"][number]
type Ask = Detail["questions"][number]

export default function SwarmRun() {
  const params = useParams()
  const sdk = useSDK()
  const [state, setState] = createStore({ busy: "" })

  const [data, { refetch }] = createResource(
    () => params.id,
    async (id) => {
      const resp = await sdk.client.swarm.delivery.detail({ id }).catch(() => null)
      const data = resp?.data
      if (!data || !Array.isArray(data.items) || !Array.isArray(data.blockers) || !Array.isArray(data.state))
        return null
      return data
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

  const item = createMemo(() => {
    const info = data()
    if (!info?.current_item_id) return null
    return info.items.find((entry) => entry.id === info.current_item_id) ?? null
  })

  const rows = createMemo(() => data()?.state ?? [])
  const queue = createMemo(() => data()?.decisions.filter(confirmOpen) ?? [])
  const open = createMemo(() => data()?.questions.filter((entry) => askOpen(entry.status)) ?? [])
  const trail = createMemo(() => [...(data()?.audit ?? [])].reverse())

  const fail = (err: unknown) => {
    const text = err instanceof Error ? err.message : String(err)
    showToast({ title: "Request failed", description: text })
  }

  const act = async (id: string, run: () => Promise<unknown>) => {
    if (state.busy) return
    setState("busy", id)
    try {
      await run()
      await refetch()
    } catch (err) {
      fail(err)
    } finally {
      setState("busy", "")
    }
  }

  const confirm = (id: string, answer: "confirm" | "reject") =>
    void act(`confirm:${id}:${answer}`, () =>
      sdk.client.swarm.delivery.confirmAssignment({
        id: params.id ?? "",
        decision_id: id,
        answer,
        decided_by: "user",
        decided_at: Date.now(),
      }),
    )

  const answer = (id: string, option: string) =>
    void act(`answer:${id}:${option}`, () =>
      sdk.client.swarm.delivery.answerQuestion({ id: params.id ?? "", question_id: id, option }),
    )

  const defer = (id: string) =>
    void act(`defer:${id}`, () => sdk.client.swarm.delivery.deferQuestion({ id: params.id ?? "", question_id: id }))

  const cancel = (id: string) =>
    void act(`cancel:${id}`, () => sdk.client.swarm.delivery.cancelQuestion({ id: params.id ?? "", question_id: id }))

  return (
    <div class="flex size-full flex-col gap-4 overflow-auto p-4">
      <div class="rounded-2xl border border-border-weak-base bg-background-stronger p-4">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div class="space-y-3">
            <div class="flex flex-wrap items-center gap-2 text-12-medium">
              <A
                href={`/${params.dir}/swarm`}
                class="rounded-full border border-border-weak-base px-3 py-1 text-text-base"
              >
                All Swarms
              </A>
              <A
                href={`/${params.dir}/swarm/${params.id}`}
                class="rounded-full border border-border-weak-base px-3 py-1 text-text-base"
              >
                Admin View
              </A>
            </div>
            <div>
              <div class="text-12-medium uppercase tracking-[0.24em] text-text-weak">Swarm Run</div>
              <h1 class="mt-1 text-2xl font-semibold text-text-strong">Delivery Overview</h1>
            </div>
            <div class="max-w-3xl text-13-regular text-text-base">
              Inspect the authoritative run phase, gate result, blockers, and work-item state without reopening the
              session body.
            </div>
          </div>
          <Show when={data()?.run}>
            {(run) => (
              <div class="rounded-2xl border border-border-weak-base bg-surface-base px-4 py-3 text-12-regular text-text-base">
                <div class="text-11-medium uppercase tracking-[0.16em] text-text-weak">Run</div>
                <div class="mt-2 text-14-medium text-text-strong">{run().id}</div>
                <div class="mt-1 text-text-base">Owner session {run().owner_session_id}</div>
                <div class="mt-2 text-text-weak">Updated {ago(run().updated_at)}</div>
              </div>
            )}
          </Show>
        </div>
      </div>

      <Show when={data.loading}>
        <Loading text="Loading delivery run..." />
      </Show>

      <Show when={data()} fallback={<Empty text="No delivery run is recorded for this swarm yet." />}>
        {(info) => (
          <>
            <section class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
              <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div class="space-y-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <span
                      class={`rounded-full border px-2.5 py-1 text-11-medium uppercase tracking-[0.18em] ${stateTone(info().run.status)}`}
                    >
                      {info().run.status}
                    </span>
                    <span class="rounded-full border border-border-weak-base bg-background-base px-2.5 py-1 text-11-medium uppercase tracking-[0.18em] text-text-base">
                      {info().run.phase}
                    </span>
                    <span
                      class={`rounded-full border px-2.5 py-1 text-11-medium uppercase tracking-[0.18em] ${gateTone(info().gate.status)}`}
                    >
                      gate {info().gate.status}
                    </span>
                    <Show when={info().current_item_id}>
                      <span class="rounded-full border border-border-weak-base bg-background-base px-2.5 py-1 text-11-medium uppercase tracking-[0.18em] text-text-base">
                        current {info().current_item_id}
                      </span>
                    </Show>
                  </div>
                  <div>
                    <div class="text-12-medium uppercase tracking-[0.22em] text-text-weak">{info().run.id}</div>
                    <h2 class="mt-1 text-2xl font-semibold text-text-strong">{info().run.goal}</h2>
                  </div>
                  <div class="text-13-regular text-text-base">{gateCopy(info())}</div>
                </div>

                <div class="grid gap-3 md:grid-cols-3 xl:w-[38rem]">
                  <Card title="Current Focus" text={itemCopy(item())} />
                  <Card title="Gate Result" text={gateDetail(info())} />
                  <Card title="Small MR" text={mrCopy(info())} />
                </div>
              </div>
            </section>

            <section class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
              <div class="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                <div>
                  <div class="text-11-medium uppercase tracking-[0.18em] text-text-weak">At A Glance</div>
                  <div class="text-13-regular text-text-base">
                    See the next approval, latest ship signal, and newest audit update without scanning every panel.
                  </div>
                </div>
                <div class="text-12-regular text-text-weak">{trail().length} audit events recorded</div>
              </div>
              <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <Card title="Pending Confirmations" text={queueCopy(queue(), open())} />
                <Card title="Current Blocker" text={blockerCopy(info())} />
                <Card title="Ship Result" text={shipCopy(rows())} />
                <Card title="Latest Audit" text={trailCopy(trail()[0] ?? null)} />
              </div>
            </section>

            <section class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <div class="text-11-medium uppercase tracking-[0.18em] text-text-weak">Blockers</div>
                  <div class="text-13-regular text-text-base">Current gate blockers and delivery pauses.</div>
                </div>
                <span class="rounded-full border border-border-weak-base bg-background-base px-2.5 py-1 text-11-medium uppercase tracking-[0.18em] text-text-base">
                  {info().blockers?.length ?? 0}
                </span>
              </div>
              <Show
                when={(info().blockers?.length ?? 0) > 0}
                fallback={<Empty text="No active blockers. The run can continue when the current gate opens." />}
              >
                <div class="mt-4 grid gap-3 xl:grid-cols-2">
                  <For each={info().blockers ?? []}>
                    {(item) => (
                      <div class={`rounded-xl border p-4 ${blockTone(item.kind)}`}>
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="rounded-full border border-current/20 px-2 py-0.5 text-11-medium uppercase tracking-[0.16em]">
                            {item.kind.replaceAll("_", " ")}
                          </span>
                          <span class="text-12-regular opacity-80">{item.id}</span>
                          <Show when={item.status}>
                            <span class="text-12-medium opacity-80">{item.status}</span>
                          </Show>
                        </div>
                        <div class="mt-3 text-14-medium text-text-strong">{item.summary}</div>
                        <Show when={item.affects?.length}>
                          <div class="mt-2 text-12-regular text-text-base">Affects {item.affects?.join(", ")}</div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </section>

            <section class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <div class="text-11-medium uppercase tracking-[0.18em] text-text-weak">Decisions</div>
                  <div class="text-13-regular text-text-base">
                    Review major changes, inspect the latest decision log, and resolve pending confirmations.
                  </div>
                </div>
                <span class="rounded-full border border-border-weak-base bg-background-base px-2.5 py-1 text-11-medium uppercase tracking-[0.18em] text-text-base">
                  {info().decisions.length}
                </span>
              </div>
              <Show
                when={info().decisions.length > 0}
                fallback={<Empty text="No delivery decisions are recorded for this run yet." />}
              >
                <div class="mt-4 grid gap-3 xl:grid-cols-2">
                  <For each={info().decisions}>
                    {(step) => {
                      const ask = link(info(), step.related_question_id)
                      const meta = note(ask?.context ?? step.input_context)
                      const open = confirmOpen(step)
                      return (
                        <div class="rounded-xl border border-border-weak-base bg-background-base p-4">
                          <div class="flex flex-wrap items-center gap-2">
                            <span
                              class={`rounded-full border px-2 py-0.5 text-11-medium uppercase tracking-[0.16em] ${decisionTone(step.status)}`}
                            >
                              {step.status}
                            </span>
                            <span class="rounded-full border border-border-weak-base px-2 py-0.5 text-11-medium text-text-base">
                              {step.kind.replaceAll("_", " ")}
                            </span>
                            <Show when={step.requires_user_confirmation}>
                              <span class="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-11-medium text-amber-100">
                                needs confirmation
                              </span>
                            </Show>
                          </div>
                          <div class="mt-3 text-15-medium text-text-strong">{step.summary}</div>
                          <div class="mt-2 text-12-regular text-text-base">
                            Source {step.source} · Applies to {step.applies_to.join(", ") || "none"}
                          </div>
                          <Show when={open}>
                            <div class="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-12-regular text-amber-100">
                              Pending user confirmation is blocking this decision path.
                            </div>
                          </Show>

                          <div class="mt-4 grid gap-3 md:grid-cols-2">
                            <Card title="Decision Scope" text={stepCopy(step, meta)} />
                            <Card title="Latest Action" text={latestCopy(step)} />
                          </div>

                          <Show when={meta.impact.length > 0}>
                            <div class="mt-4">
                              <div class="text-11-medium uppercase tracking-[0.16em] text-text-weak">Impact</div>
                              <div class="mt-2 flex flex-wrap gap-2">
                                <For each={meta.impact}>
                                  {(item) => (
                                    <span class="rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-11-medium text-sky-100">
                                      {item}
                                    </span>
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>

                          <Show when={step.actions.length > 0}>
                            <div class="mt-4 space-y-2">
                              <div class="text-11-medium uppercase tracking-[0.16em] text-text-weak">Action Log</div>
                              <For each={[...step.actions].reverse()}>
                                {(item) => (
                                  <div class="rounded-xl border border-border-weak-base bg-surface-base px-3 py-2 text-12-regular text-text-base">
                                    <div class="flex flex-wrap items-center gap-2 text-11-medium uppercase tracking-[0.14em] text-text-weak">
                                      <span>{item.kind}</span>
                                      <span>{item.role}</span>
                                      <Show when={item.outcome}>
                                        <span>{item.outcome}</span>
                                      </Show>
                                      <span>{ago(item.created_at)}</span>
                                    </div>
                                    <Show when={actionCopy(item.context)}>
                                      {(text) => <div class="mt-2 text-12-regular text-text-base">{text()}</div>}
                                    </Show>
                                  </div>
                                )}
                              </For>
                            </div>
                          </Show>

                          <Show when={open}>
                            <div class="mt-4 flex flex-wrap gap-2">
                              <ActButton
                                label={state.busy === `confirm:${step.id}:confirm` ? "Confirming..." : "Confirm change"}
                                disabled={Boolean(state.busy)}
                                onClick={() => confirm(step.id, "confirm")}
                              />
                              <ActButton
                                tone="danger"
                                label={state.busy === `confirm:${step.id}:reject` ? "Rejecting..." : "Reject change"}
                                disabled={Boolean(state.busy)}
                                onClick={() => confirm(step.id, "reject")}
                              />
                            </div>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </section>

            <section class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <div class="text-11-medium uppercase tracking-[0.18em] text-text-weak">Open Questions</div>
                  <div class="text-13-regular text-text-base">
                    Inspect recommendations, impact, and current status, then answer, defer, or cancel active questions.
                  </div>
                </div>
                <span class="rounded-full border border-border-weak-base bg-background-base px-2.5 py-1 text-11-medium uppercase tracking-[0.18em] text-text-base">
                  {info().questions.length}
                </span>
              </div>
              <Show
                when={info().questions.length > 0}
                fallback={<Empty text="No delivery questions are open for this run right now." />}
              >
                <div class="mt-4 grid gap-3 xl:grid-cols-2">
                  <For each={info().questions}>
                    {(ask) => {
                      const step = follow(info(), ask.related_decision_id)
                      const meta = note(ask.context)
                      const open = askOpen(ask.status)
                      const confirmable = Boolean(step && confirmOpen(step))
                      return (
                        <div class="rounded-xl border border-border-weak-base bg-background-base p-4">
                          <div class="flex flex-wrap items-center gap-2">
                            <span
                              class={`rounded-full border px-2 py-0.5 text-11-medium uppercase tracking-[0.16em] ${questionTone(ask.status)}`}
                            >
                              {ask.status.replaceAll("_", " ")}
                            </span>
                            <Show when={ask.blocking}>
                              <span class="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-11-medium text-amber-100">
                                blocking
                              </span>
                            </Show>
                            <Show when={ask.recommended_option}>
                              <span class="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-11-medium text-emerald-100">
                                recommend {ask.recommended_option}
                              </span>
                            </Show>
                          </div>

                          <div class="mt-3 text-15-medium text-text-strong">{ask.title}</div>
                          <div class="mt-2 text-12-regular text-text-base">
                            Raised by {ask.raised_by} · Affects {ask.affects.join(", ") || "none"}
                          </div>

                          <div class="mt-4 grid gap-3 md:grid-cols-2">
                            <Card title="Question Context" text={askCopy(ask, meta, step)} />
                            <Card title="Linked Decision" text={decisionRef(step)} />
                          </div>

                          <Show when={meta.impact.length > 0}>
                            <div class="mt-4">
                              <div class="text-11-medium uppercase tracking-[0.16em] text-text-weak">Impact</div>
                              <div class="mt-2 flex flex-wrap gap-2">
                                <For each={meta.impact}>
                                  {(item) => (
                                    <span class="rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-11-medium text-sky-100">
                                      {item}
                                    </span>
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>

                          <Show when={ask.options.length > 0}>
                            <div class="mt-4">
                              <div class="text-11-medium uppercase tracking-[0.16em] text-text-weak">Options</div>
                              <div class="mt-2 flex flex-wrap gap-2">
                                <For each={ask.options}>
                                  {(item) => (
                                    <span
                                      class={`rounded-full border px-2.5 py-1 text-11-medium ${item === ask.recommended_option ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100" : "border-border-weak-base bg-surface-base text-text-base"}`}
                                    >
                                      {item}
                                    </span>
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>

                          <Show when={confirmable && step}>
                            {(item) => (
                              <div class="mt-4 flex flex-wrap gap-2">
                                <ActButton
                                  label={
                                    state.busy === `confirm:${item().id}:confirm` ? "Confirming..." : "Confirm change"
                                  }
                                  disabled={Boolean(state.busy)}
                                  onClick={() => confirm(item().id, "confirm")}
                                />
                                <ActButton
                                  tone="danger"
                                  label={
                                    state.busy === `confirm:${item().id}:reject` ? "Rejecting..." : "Reject change"
                                  }
                                  disabled={Boolean(state.busy)}
                                  onClick={() => confirm(item().id, "reject")}
                                />
                              </div>
                            )}
                          </Show>

                          <Show when={!confirmable && open}>
                            <div class="mt-4 flex flex-wrap gap-2">
                              <For each={ask.options}>
                                {(item) => (
                                  <ActButton
                                    tone={item === ask.recommended_option ? "primary" : "muted"}
                                    label={
                                      state.busy === `answer:${ask.id}:${item}`
                                        ? `Answering ${item}...`
                                        : `Answer ${item}`
                                    }
                                    disabled={Boolean(state.busy)}
                                    onClick={() => answer(ask.id, item)}
                                  />
                                )}
                              </For>
                              <ActButton
                                tone="muted"
                                label={state.busy === `defer:${ask.id}` ? "Deferring..." : "Defer"}
                                disabled={Boolean(state.busy)}
                                onClick={() => defer(ask.id)}
                              />
                              <ActButton
                                tone="danger"
                                label={state.busy === `cancel:${ask.id}` ? "Cancelling..." : "Cancel"}
                                disabled={Boolean(state.busy)}
                                onClick={() => cancel(ask.id)}
                              />
                            </div>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </section>

            <section class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
              <div class="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                <div>
                  <div class="text-11-medium uppercase tracking-[0.18em] text-text-weak">Work Items</div>
                  <div class="text-13-regular text-text-base">
                    Each item reflects the authoritative delivery state, gate status, dependencies, and verification
                    snapshot.
                  </div>
                </div>
                <div class="text-12-regular text-text-weak">{rows().length} tracked items</div>
              </div>
              <div class="mt-4 space-y-3">
                <For each={rows()}>
                  {(row) => (
                    <div
                      class={`rounded-xl border p-4 ${row.item.id === info().current_item_id ? "border-sky-500/30 bg-sky-500/10" : "border-border-weak-base bg-background-base"}`}
                    >
                      <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                        <div class="min-w-0 flex-1 space-y-3">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="text-11-medium uppercase tracking-[0.18em] text-text-weak">{row.item.id}</span>
                            <span
                              class={`text-12-medium capitalize ${taskTone(row.item.status, row.item.gate.status === "blocked")}`}
                            >
                              {row.item.status.replaceAll("_", " ")}
                            </span>
                            <span class="rounded-full border border-border-weak-base px-2 py-0.5 text-11-medium text-text-base">
                              {row.item.phase_gate}
                            </span>
                            <span
                              class={`rounded-full border px-2 py-0.5 text-11-medium ${gateTone(row.item.gate.status)}`}
                            >
                              gate {row.item.gate.status}
                            </span>
                            <Show when={row.item.id === info().current_item_id}>
                              <span class="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-11-medium text-sky-200">
                                current
                              </span>
                            </Show>
                          </div>
                          <div>
                            <div class="text-15-medium text-text-strong">{row.item.title}</div>
                            <div class="mt-2 flex flex-wrap gap-2 text-12-regular text-text-base">
                              <span>Owner {row.item.owner_role_id}</span>
                              <Show when={row.item.blocked_by.length > 0}>
                                <span>Blocked by {row.item.blocked_by.join(", ")}</span>
                              </Show>
                              <span>Scope {scopeCopy(row.item.scope)}</span>
                              <Show when={row.verified}>
                                <span class="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-11-medium text-emerald-100">
                                  verified
                                </span>
                              </Show>
                              <Show when={row.committed}>
                                <span class="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-11-medium text-sky-100">
                                  committed
                                </span>
                              </Show>
                            </div>
                          </div>
                          <Show when={row.item.gate.reason}>
                            <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-12-regular text-amber-100">
                              {row.item.gate.reason}
                            </div>
                          </Show>
                        </div>

                        <div class="grid gap-3 md:grid-cols-2 xl:min-w-[40rem] xl:grid-cols-4">
                          <Card title="Verification" text={proofCopy(row.item.verification)} />
                          <Card title="Commit" text={commitCopy(row.commit ?? row.item.commit)} />
                          <Card title="Checkpoint" text={checkpointCopy(row.item)} />
                          <Card title="Delivery State" text={stateCopy(row)} />
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </section>

            <section class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
              <div class="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                <div>
                  <div class="text-11-medium uppercase tracking-[0.18em] text-text-weak">Audit History</div>
                  <div class="text-13-regular text-text-base">
                    Follow phase changes, verification proof, commit writeback, and delivery decisions in one timeline.
                  </div>
                </div>
                <div class="text-12-regular text-text-weak">Newest first</div>
              </div>
              <Show
                when={trail().length > 0}
                fallback={<Empty text="No audit history is recorded for this run yet." />}
              >
                <div class="mt-4 space-y-3">
                  <For each={trail()}>
                    {(item) => (
                      <div class={`rounded-xl border p-4 ${auditTone(item.kind)}`}>
                        <div class="flex flex-wrap items-center gap-2 text-11-medium uppercase tracking-[0.16em]">
                          <span class="rounded-full border border-current/20 px-2 py-0.5">{item.kind}</span>
                          <span>{ago(item.created_at)}</span>
                        </div>
                        <div class="mt-3 text-14-medium text-text-strong">{auditTitle(item)}</div>
                        <div class="mt-2 whitespace-pre-wrap text-12-regular text-text-base">{auditCopy(item)}</div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </section>
          </>
        )}
      </Show>
    </div>
  )
}

function Card(props: { title: string; text: string }) {
  return (
    <div class="rounded-xl border border-border-weak-base bg-background-base p-3">
      <div class="text-11-medium uppercase tracking-[0.16em] text-text-weak">{props.title}</div>
      <div class="mt-2 whitespace-pre-wrap text-12-regular text-text-base">{props.text}</div>
    </div>
  )
}

function Empty(props: { text: string }) {
  return (
    <div class="rounded-2xl border border-dashed border-border-weak-base bg-surface-base p-4 text-13-regular text-text-weak">
      {props.text}
    </div>
  )
}

function Loading(props: { text: string }) {
  return (
    <div class="rounded-2xl border border-border-weak-base bg-surface-base p-4 text-12-regular text-text-weak">
      {props.text}
    </div>
  )
}

function ActButton(props: {
  label: string
  disabled?: boolean
  tone?: "primary" | "muted" | "danger"
  onClick: () => void
}) {
  return (
    <button
      class={`rounded-full border px-3 py-1 text-12-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${buttonTone(props.tone ?? "primary")}`}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  )
}

function gateTone(value: Detail["gate"]["status"]) {
  if (value === "ready") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
  if (value === "blocked") return "border-amber-500/30 bg-amber-500/10 text-amber-100"
  return "border-border-weak-base bg-background-base text-text-base"
}

function decisionTone(value: Step["status"]) {
  if (value === "decided") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
  if (value === "proposed") return "border-amber-500/30 bg-amber-500/10 text-amber-100"
  if (value === "cancelled") return "border-red-500/30 bg-red-500/10 text-red-100"
  return "border-border-weak-base bg-background-base text-text-base"
}

function questionTone(value: Ask["status"]) {
  if (value === "resolved") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
  if (value === "cancelled") return "border-red-500/30 bg-red-500/10 text-red-100"
  if (value === "deferred") return "border-sky-500/30 bg-sky-500/10 text-sky-100"
  return "border-amber-500/30 bg-amber-500/10 text-amber-100"
}

function buttonTone(value: "primary" | "muted" | "danger") {
  if (value === "danger") return "border-red-500/30 bg-red-500/10 text-red-100 hover:border-red-400/50"
  if (value === "muted")
    return "border-border-weak-base bg-surface-base text-text-base hover:border-border-interactive-base"
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-100 hover:border-emerald-400/50"
}

function blockTone(value: Detail["blockers"][number]["kind"]) {
  if (value === "small_mr") return "border-red-500/30 bg-red-500/10 text-red-100"
  if (value === "question") return "border-amber-500/30 bg-amber-500/10 text-amber-100"
  if (value === "decision") return "border-sky-500/30 bg-sky-500/10 text-sky-100"
  return "border-zinc-500/30 bg-zinc-500/10 text-zinc-100"
}

function gateCopy(data: Detail) {
  if (data.gate.status === "blocked")
    return data.gate.reason ?? "This run is paused until the current blocker is cleared."
  if (data.gate.status === "ready")
    return "The current phase gate is satisfied and the next delivery step can continue."
  return "The run is staged and waiting for the next gate evaluation."
}

function gateDetail(data: Detail) {
  const list = [`Status: ${data.gate.status}`]
  if (data.gate.reason) list.push(`Reason: ${data.gate.reason}`)
  if (data.gate.enter?.length) list.push(`Enter: ${data.gate.enter.join(", ")}`)
  if (data.gate.exit?.length) list.push(`Exit: ${data.gate.exit.join(", ")}`)
  if (data.gate.fallback) list.push(`Fallback: ${data.gate.fallback}`)
  return list.join("\n")
}

function itemCopy(item: Detail["items"][number] | null) {
  if (!item) return "No current work item is selected."
  const list = [item.title, `Status: ${item.status.replaceAll("_", " ")}`]
  list.push(`Owner: ${item.owner_role_id}`)
  if (item.gate.reason) list.push(`Gate: ${item.gate.reason}`)
  return list.join("\n")
}

function mrCopy(data: Detail) {
  const list = [`Status: ${data.small_mr.status}`]
  if (data.small_mr.reason) list.push(`Reason: ${data.small_mr.reason}`)
  if (data.small_mr.active?.length) list.push(`Active: ${data.small_mr.active.join(", ")}`)
  return list.join("\n")
}

function scopeCopy(list: string[]) {
  if (list.length === 0) return "unscoped"
  if (list.length === 1) return list[0]
  return `${list.length} paths`
}

function proofCopy(data: Detail["items"][number]["verification"]) {
  const list = [`Status: ${data.status.replaceAll("_", " ")}`]
  if (data.commands?.length) list.push(`Commands: ${data.commands.join(", ")}`)
  if (data.result) list.push(`Result: ${short(data.result)}`)
  if (data.updated_at) list.push(`Updated: ${ago(data.updated_at)}`)
  return list.join("\n")
}

function checkpointCopy(item: Detail["items"][number]) {
  const list = [
    `Last phase: ${item.checkpoint.last_successful_phase ?? "-"}`,
    `Produced: ${item.checkpoint.produced_files?.length ?? 0}`,
    `Pending: ${item.checkpoint.pending_actions?.length ?? 0}`,
  ]
  if (item.failure) list.push(`Failure: ${short(item.failure.result)}`)
  return list.join("\n")
}

function stateCopy(row: Detail["state"][number]) {
  const list = [`Verified: ${row.verified ? "yes" : "no"}`, `Committed: ${row.committed ? "yes" : "no"}`]
  if (row.completed) list.push("Complete: yes")
  if (!row.completed) list.push("Complete: no")
  if (row.proof?.status) list.push(`Proof: ${row.proof.status.replaceAll("_", " ")}`)
  return list.join("\n")
}

function queueCopy(queue: Step[], open: Ask[]) {
  const asks = open.filter((item) => item.blocking)
  const list = [`Decisions: ${queue.length}`, `Questions: ${asks.length}`]
  const first = queue[0]
  if (first) list.push(`Next: ${short(first.summary, 90)}`)
  if (!first && asks[0]) list.push(`Next: ${short(asks[0].title, 90)}`)
  if (queue.length === 0 && asks.length === 0) list.push("Nothing is waiting on approval.")
  return list.join("\n")
}

function blockerCopy(data: Detail) {
  const item = data.blockers[0]
  if (!item) return "No active blocker."
  const list = [item.summary, `Kind: ${item.kind.replaceAll("_", " ")}`]
  if (item.status) list.push(`Status: ${item.status}`)
  return list.join("\n")
}

function shipCopy(rows: Detail["state"]) {
  const commit = rows.find((row) => row.commit)
  if (commit?.commit)
    return [
      `Commit: ${commit.commit.hash ?? commit.commit.message ?? "recorded"}`,
      `Proof: ${commit.commit.proof.status.replaceAll("_", " ")}`,
      `At: ${ago(commit.commit.recorded_at)}`,
    ].join("\n")
  const proof = rows.find((row) => row.proof?.status === "passed")
  if (proof?.proof)
    return [
      `Verification: ${proof.item.title}`,
      `Status: ${proof.proof.status.replaceAll("_", " ")}`,
      `Updated: ${proof.proof.updated_at ? ago(proof.proof.updated_at) : "waiting"}`,
    ].join("\n")
  return "No verification or commit result has been recorded yet."
}

function trailCopy(item: Detail["audit"][number] | null) {
  if (!item) return "No audit event recorded yet."
  return [`${auditTitle(item)}`, `Kind: ${item.kind}`, `At: ${ago(item.created_at)}`].join("\n")
}

function link(data: Detail, id: string | null) {
  if (!id) return null
  return data.questions.find((item) => item.id === id) ?? null
}

function follow(data: Detail, id: string | null) {
  if (!id) return null
  return data.decisions.find((item) => item.id === id) ?? null
}

function note(value: string | null | undefined) {
  const text = clean(value)
  if (!text) return { reason: "", impact: [] as string[], text: "" }
  if (!text.startsWith("{")) return { reason: "", impact: [] as string[], text }
  try {
    const row = JSON.parse(text) as { reason?: unknown; impact?: unknown }
    return {
      reason: typeof row.reason === "string" ? clean(row.reason) : "",
      impact: Array.isArray(row.impact)
        ? row.impact.filter((item): item is string => typeof item === "string" && clean(item).length > 0)
        : [],
      text,
    }
  } catch {
    return { reason: "", impact: [] as string[], text }
  }
}

function stepCopy(step: Step, meta: ReturnType<typeof note>) {
  const list = [`Kind: ${step.kind}`, `Source: ${step.source}`]
  if (step.participants.length > 0) list.push(`Participants: ${step.participants.join(", ")}`)
  if (step.candidate_outcomes.length > 0) list.push(`Outcomes: ${step.candidate_outcomes.join(", ")}`)
  if (meta.reason) list.push(`Reason: ${meta.reason}`)
  if (!meta.reason && clean(step.input_context)) list.push(`Context: ${short(clean(step.input_context), 180)}`)
  if (step.decided_by) list.push(`Decided by: ${step.decided_by}`)
  if (step.decided_at) list.push(`Updated: ${ago(step.decided_at)}`)
  return list.join("\n")
}

function latestCopy(step: Step) {
  const item = step.actions.at(-1)
  if (!item) return "No decision actions recorded."
  const meta = note(item.context)
  const list = [`${item.kind} by ${item.role}`, `At: ${ago(item.created_at)}`]
  if (item.outcome) list.push(`Outcome: ${item.outcome}`)
  if (meta.reason) list.push(`Reason: ${meta.reason}`)
  if (!meta.reason && clean(item.context)) list.push(short(clean(item.context), 160))
  return list.join("\n")
}

function askCopy(ask: Ask, meta: ReturnType<typeof note>, step: Step | null) {
  const list = [] as string[]
  if (meta.reason) list.push(meta.reason)
  if (!meta.reason && clean(ask.context)) list.push(short(clean(ask.context), 180))
  if (ask.recommended_option) list.push(`Recommended: ${ask.recommended_option}`)
  if (step) list.push(`Decision: ${step.status}`)
  if (ask.deadline_policy) list.push(`Deadline: ${ask.deadline_policy}`)
  return list.join("\n") || "No question context recorded."
}

function decisionRef(step: Step | null) {
  if (!step) return "No linked decision."
  const list = [`${step.summary}`, `Status: ${step.status}`]
  if (step.requires_user_confirmation) list.push("Confirmation: required")
  if (step.related_question_id) list.push(`Question: ${step.related_question_id}`)
  return list.join("\n")
}

function actionCopy(value: string | null | undefined) {
  const meta = note(value)
  if (meta.reason) return meta.reason
  const text = clean(value)
  if (!text) return ""
  return short(text, 200)
}

function confirmOpen(step: Step) {
  return step.requires_user_confirmation && step.status === "proposed"
}

function askOpen(value: Ask["status"]) {
  return value === "open" || value === "waiting_user" || value === "deferred"
}

function clean(value: string | null | undefined) {
  return value?.trim() ?? ""
}

function short(value: string, max = 120) {
  if (value.length <= max) return value
  return `${value.slice(0, max - 3)}...`
}

function commitCopy(item: Detail["state"][number]["commit"] | Detail["items"][number]["commit"]) {
  if (!item) return "No local commit recorded."
  const list = [`Status: ${item.status ?? "recorded"}`]
  list.push(`Proof: ${item.proof.status.replaceAll("_", " ")}`)
  if (item.hash) list.push(`Hash: ${item.hash}`)
  if (!item.hash && item.message) list.push(`Message: ${short(item.message, 80)}`)
  list.push(`Recorded: ${ago(item.recorded_at)}`)
  if (item.staged_scope.length > 0) list.push(`Scope: ${scopeCopy(item.staged_scope)}`)
  return list.join("\n")
}

function auditTone(value: Detail["audit"][number]["kind"]) {
  if (value === "commit") return "border-sky-500/30 bg-sky-500/10 text-sky-100"
  if (value === "verification") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
  if (value === "decision" || value === "question") return "border-amber-500/30 bg-amber-500/10 text-amber-100"
  if (value === "retrospective") return "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-100"
  return "border-border-weak-base bg-background-base text-text-base"
}

function auditTitle(item: Detail["audit"][number]) {
  if (item.kind === "phase") return `${item.phase} phase ${item.status}`
  if (item.kind === "assignment") return item.summary
  if (item.kind === "decision") return item.summary
  if (item.kind === "question") return item.summary
  if (item.kind === "verification")
    return `${item.item_id} verification ${item.verification.status.replaceAll("_", " ")}`
  if (item.kind === "commit") return `${item.item_id} local commit recorded`
  return item.summary
}

function auditCopy(item: Detail["audit"][number]) {
  if (item.kind === "phase") {
    const list = [`Status: ${item.status}`, `Gate: ${item.gate.status}`]
    if (item.gate.reason) list.push(`Reason: ${item.gate.reason}`)
    return list.join("\n")
  }
  if (item.kind === "assignment") {
    const list = [] as string[]
    if (item.item_ids?.length) list.push(`Items: ${item.item_ids.join(", ")}`)
    if (item.role_ids?.length) list.push(`Roles: ${item.role_ids.join(", ")}`)
    return list.join("\n") || "Assignment update recorded."
  }
  if (item.kind === "decision") {
    const list = [`Status: ${item.status}`]
    if (item.outcome) list.push(`Outcome: ${item.outcome}`)
    if (item.applies_to?.length) list.push(`Affects: ${item.applies_to.join(", ")}`)
    return list.join("\n")
  }
  if (item.kind === "question") {
    const list = [`Status: ${item.status}`, `Blocking: ${item.blocking ? "yes" : "no"}`]
    if (item.affects?.length) list.push(`Affects: ${item.affects.join(", ")}`)
    return list.join("\n")
  }
  if (item.kind === "verification") {
    const list = [`Phase: ${item.phase}`, `Status: ${item.verification.status.replaceAll("_", " ")}`]
    if (item.verification.result) list.push(`Result: ${short(item.verification.result, 140)}`)
    return list.join("\n")
  }
  if (item.kind === "commit") {
    const list = [`Proof: ${item.commit.proof.status.replaceAll("_", " ")}`]
    if (item.commit.hash) list.push(`Hash: ${item.commit.hash}`)
    if (!item.commit.hash && item.commit.message) list.push(`Message: ${short(item.commit.message, 120)}`)
    if (item.commit.staged_scope.length > 0) list.push(`Scope: ${scopeCopy(item.commit.staged_scope)}`)
    return list.join("\n")
  }
  const list = [`Outcome: ${item.outcome}`]
  if (item.memory_ids?.length) list.push(`Memories: ${item.memory_ids.length}`)
  return list.join("\n")
}
