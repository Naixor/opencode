import z from "zod"
import type { WorkflowContext } from "../workflows"

type Base = z.infer<typeof opencode.args>
type Ctx = WorkflowContext
type Node = "prepare" | "plan" | "implement" | "done" | "failed"
type State = {
  goal: string
  prd_file: string
  log_dir: string
  stage: Node
  plan: { done: boolean; log_dir?: string }
  implement: { done: boolean; log_dir?: string }
  updated_at: string
}

const args = opencode.args.transform((input: Base) => {
  let notify: string | undefined
  let max = 20
  const goal: string[] = []

  for (let i = 0; i < input.argv.length; i++) {
    const item = input.argv[i]
    if (item === "--notify" && input.argv[i + 1]) {
      notify = input.argv[i + 1]
      i += 1
      continue
    }
    if (item.startsWith("--notify=")) {
      notify = item.slice("--notify=".length)
      continue
    }
    if (item === "--max-rounds" && input.argv[i + 1]) {
      max = clamp(input.argv[i + 1])
      i += 1
      continue
    }
    if (item.startsWith("--max-rounds=")) {
      max = clamp(item.slice("--max-rounds=".length))
      continue
    }
    goal.push(item)
  }

  return {
    ...input,
    notify,
    max_rounds: max,
    goal: goal.join(" ").trim(),
    plan_argv: input.argv,
  }
})

export default opencode.workflow({
  description: "Chain plan and implement into one resumable feature workflow",
  input: args,
  async run(ctx: Ctx, input: z.infer<typeof args>) {
    if (!input.goal) {
      return {
        title: "Feature workflow",
        output: "Usage: `/workflow feature <goal> [--notify <chat_id|user_id>] [--max-rounds 3-5]`",
      }
    }

    const key = slug(input.goal)
    const file = `tasks/prds/prd-${key}.md`
    const dir = join(".workflows", "logs", `feature-${key}`)
    const prog = track(input.goal)
    const state = (await load(ctx, dir, input.goal, file)) ?? init(input.goal, file, dir)

    try {
      await ctx.status({
        title: state.stage === "implement" ? "Resume feature" : "Start feature",
        metadata: meta(state),
        progress: prog.move("prepare", {
          summary:
            state.stage === "implement"
              ? `Resume feature workflow for ${input.goal}`
              : `Start feature workflow for ${input.goal}`,
        }),
      })

      if (!(await planned(ctx, state))) {
        state.stage = "plan"
        await save(ctx, state)
        await ctx.status({
          title: "Plan feature",
          metadata: meta(state),
          progress: prog.move("plan", { summary: `Plan feature goal: ${input.goal}` }),
        })
        const out = await ctx.workflow({
          name: "plan",
          argv: input.plan_argv,
          files: input.files,
        })
        state.plan = {
          done: true,
          log_dir: text(out.metadata?.log_dir) ?? state.plan?.log_dir,
        }
        state.prd_file = text(out.metadata?.file) ?? state.prd_file
        state.stage = "implement"
        await save(ctx, state)
      }

      if (await finished(ctx, state)) {
        state.implement = {
          done: true,
          log_dir: state.implement?.log_dir,
        }
        state.stage = "done"
        await save(ctx, state)
        await ctx.status({
          title: "Feature done",
          metadata: meta(state),
          progress: prog.move("done", { summary: `Feature workflow already completed for ${input.goal}` }),
        })
        return done(state, true)
      }

      state.stage = "implement"
      await save(ctx, state)
      await ctx.status({
        title: state.implement?.log_dir ? "Resume implement" : "Implement feature",
        metadata: meta(state),
        progress: prog.move("implement", {
          summary: state.implement?.log_dir
            ? `Resume implementation from ${state.prd_file}`
            : `Implement feature from ${state.prd_file}`,
        }),
      })
      const out = await ctx.workflow({
        name: "implement",
        raw: state.prd_file,
        argv: [state.prd_file],
      })
      state.implement = {
        done: await finished(ctx, state),
        log_dir: text(out.metadata?.log_dir) ?? state.implement?.log_dir,
      }
      state.stage = state.implement.done ? "done" : "implement"
      await save(ctx, state)

      if (!state.implement.done) {
        await ctx.status({
          title: "Feature paused",
          metadata: meta(state),
          progress: prog.wait("implement", {
            summary: `Implement workflow paused; rerun /workflow feature ${input.goal} to resume`,
          }),
        })
        return {
          title: "Feature workflow",
          output: [
            `Goal: ${state.goal}`,
            `PRD file: ${state.prd_file}`,
            `Feature log dir: ${state.log_dir}`,
            state.plan?.log_dir ? `Plan log dir: ${state.plan.log_dir}` : undefined,
            state.implement?.log_dir ? `Implement log dir: ${state.implement.log_dir}` : undefined,
            "Implementation is not finished yet.",
            `Rerun: /workflow feature ${state.goal}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          metadata: meta(state),
        }
      }

      await ctx.status({
        title: "Feature done",
        metadata: meta(state),
        progress: prog.move("done", { summary: `Completed feature workflow for ${input.goal}` }),
      })
      return done(state, false)
    } catch (err) {
      state.stage = "failed"
      await save(ctx, state)
      await ctx.status({
        title: "Feature failed",
        metadata: meta(state),
        progress: prog.move("failed", {
          summary: err instanceof Error && err.message ? err.message : String(err),
        }),
      })
      throw err
    }
  },
})

function init(goal: string, file: string, dir: string): State {
  return {
    goal,
    prd_file: file,
    log_dir: dir,
    stage: "prepare" as const,
    plan: { done: false as const, log_dir: undefined as string | undefined },
    implement: { done: false as const, log_dir: undefined as string | undefined },
    updated_at: stamp(),
  }
}

async function load(ctx: Pick<Ctx, "worktree">, dir: string, goal: string, file: string): Promise<State | undefined> {
  const raw = await readjson(ctx, join(dir, "run.json"))
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return
  if (raw.goal !== goal) return
  return {
    goal,
    prd_file: text(raw.prd_file) ?? file,
    log_dir: text(raw.log_dir) ?? dir,
    stage: stage(raw.stage),
    plan: part(raw.plan),
    implement: part(raw.implement),
    updated_at: text(raw.updated_at) ?? stamp(),
  }
}

async function save(ctx: Pick<Ctx, "write">, state: State) {
  state.updated_at = stamp()
  await ctx.write({ file: join(state.log_dir, "run.json"), content: JSON.stringify(state, null, 2) })
}

function part(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { done: false, log_dir: undefined as string | undefined }
  const item = input as Record<string, unknown>
  return {
    done: item.done === true,
    log_dir: text(item.log_dir),
  }
}

function stage(input: unknown) {
  if (input === "plan" || input === "implement" || input === "done" || input === "failed") return input
  return "prepare" as const
}

async function planned(ctx: Pick<Ctx, "worktree">, state: State) {
  if (state.plan.done) return true
  return exists(ctx, state.prd_file)
}

async function finished(ctx: Pick<Ctx, "worktree">, state: State) {
  const data = await backlog(ctx, state.prd_file)
  if (!data) return false
  return data.userStories.length > 0 && data.userStories.every((item) => item.passes)
}

async function backlog(ctx: Pick<Ctx, "worktree">, file: string) {
  const raw = await readjson(ctx, "tasks/prd.json")
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return
  if (text(raw.sourcePrdFile) !== file) return
  const list = Array.isArray(raw.userStories) ? raw.userStories : []
  return {
    userStories: list
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .map((item) => item as Record<string, unknown>)
      .filter((item) => typeof item.id === "string" && typeof item.passes === "boolean")
      .map((item) => ({ id: item.id as string, passes: item.passes as boolean })),
  }
}

async function exists(ctx: Pick<Ctx, "worktree">, file: string) {
  return Bun.file(abs(ctx, file)).exists()
}

async function readjson(ctx: Pick<Ctx, "worktree">, file: string) {
  const item = Bun.file(abs(ctx, file))
  if (!(await item.exists())) return
  const text = await item.text()
  if (!text.trim()) return
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return
  }
}

function meta(state: State) {
  return {
    goal: state.goal,
    prd_file: state.prd_file,
    feature_log_dir: state.log_dir,
    stage: state.stage,
    ...(state.plan?.log_dir ? { plan_log_dir: state.plan.log_dir } : {}),
    ...(state.implement?.log_dir ? { implement_log_dir: state.implement.log_dir } : {}),
  }
}

function done(state: State, reused: boolean) {
  return {
    title: "Feature workflow",
    output: [
      reused ? `Reused completed feature for: ${state.goal}` : `Completed feature for: ${state.goal}`,
      `PRD file: ${state.prd_file}`,
      `Feature log dir: ${state.log_dir}`,
      state.plan?.log_dir ? `Plan log dir: ${state.plan.log_dir}` : undefined,
      state.implement?.log_dir ? `Implement log dir: ${state.implement.log_dir}` : undefined,
    ]
      .filter(Boolean)
      .join("\n\n"),
    metadata: meta(state),
  }
}

function text(input: unknown) {
  return typeof input === "string" && input.trim() ? input : undefined
}

function abs(ctx: Pick<Ctx, "worktree">, file: string) {
  return file.startsWith("/") ? file : join(ctx.worktree, file)
}

function join(...parts: string[]) {
  return parts.filter(Boolean).join("/").replace(/\\/g, "/").replace(/\/+/g, "/")
}

function clamp(input: string) {
  const val = Number.parseInt(input, 10)
  if (!Number.isFinite(val)) return 5
  return Math.max(3, Math.min(5, val))
}

function slug(input: string) {
  const out = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return out || "feature"
}

function stamp() {
  return new Date().toISOString()
}

function track(name: string) {
  const start = stamp()
  const flow = [
    { id: "prepare", kind: "task", label: "Prepare feature", next: ["plan", "implement", "done"] },
    { id: "plan", kind: "task", label: "Plan feature", next: ["implement", "failed"] },
    { id: "implement", kind: "task", label: "Implement feature", next: ["done", "failed"] },
    { id: "done", kind: "terminal", label: "Done" },
    { id: "failed", kind: "terminal", label: "Failed" },
  ] as const
  const runs = [] as Array<Record<string, unknown>>
  const trans = [] as Array<Record<string, unknown>>
  const seen = { prepare: 0, plan: 0, implement: 0, done: 0, failed: 0 }
  let node: Node | undefined
  let run: string | undefined
  let state: "running" | "waiting" | "failed" | "done" = "running"
  let note = `Start feature workflow for ${name}`

  function row(id?: string) {
    if (!id) return
    return runs.find((item) => item.id === id)
  }

  function sync(time: string, next?: Node, status?: unknown) {
    if (next) node = next
    const to =
      next === "done"
        ? "done"
        : next === "failed" || status === "failed"
          ? "failed"
          : status === "waiting"
            ? "waiting"
            : "running"
    if (state === to) return
    trans.push({
      id: `workflow:${to}:${trans.length}`,
      seq: trans.length,
      timestamp: time,
      level: "workflow",
      target_id: "workflow",
      from_state: state,
      to_state: to,
    })
    state = to
  }

  function close(id: string | undefined, status: "completed" | "failed", time: string, summary?: string) {
    const item = row(id)
    if (!item || item.ended_at) return
    const from = item.status
    item.status = status
    item.ended_at = time
    if (summary) {
      item.summary = summary
      item.reason = summary
    }
    trans.push({
      id: `${item.id}:${status}:${trans.length}`,
      seq: trans.length,
      timestamp: time,
      level: "step",
      target_id: item.step_id,
      run_id: item.id,
      from_state: from,
      to_state: status,
      ...(summary ? { reason: summary } : {}),
    })
  }

  function enter(next: Node, summary: string) {
    const time = stamp()
    seen[next] += 1
    const id = `${next}-${seen[next]}`
    const status = next === "done" ? "completed" : next === "failed" ? "failed" : "active"
    runs.push({
      id,
      seq: runs.length,
      step_id: next,
      status,
      summary,
      reason: summary,
      started_at: time,
      ...(status === "completed" || status === "failed" ? { ended_at: time } : {}),
    })
    trans.push({
      id: `${id}:start`,
      seq: trans.length,
      timestamp: time,
      level: "step",
      target_id: next,
      run_id: id,
      to_state: status,
      reason: summary,
    })
    return { id, time }
  }

  function snapshot(time: string) {
    const item = row(run)
    return structuredClone({
      version: "workflow-progress.v2",
      workflow: {
        status: state,
        name,
        label: "Feature workflow",
        summary: note,
        started_at: start,
        ...(state === "done" || state === "failed" ? { ended_at: time } : {}),
      },
      phase: {
        status: node === "done" ? "completed" : node === "failed" ? "failed" : "active",
        key: node,
        label: flow.find((item) => item.id === node)?.label ?? "Feature workflow",
        summary: note,
      },
      machine: {
        id: name,
        key: name,
        label: "Feature workflow",
        root_step_id: "prepare",
        ...(node ? { active_step_id: node } : {}),
        ...(run ? { active_run_id: run } : {}),
        started_at: start,
        updated_at: time,
      },
      step_definitions: flow,
      step_runs: runs,
      transitions: trans,
      participants: [],
    } as const)
  }

  function move(next: Node, input: { summary: string }) {
    note = input.summary
    const time = stamp()
    close(run, next === "failed" ? "failed" : "completed", time)
    const item = enter(next, input.summary)
    run = item.id
    sync(item.time, next, row(item.id)?.status)
    return snapshot(item.time)
  }

  function wait(next: Node, input: { summary: string }) {
    note = input.summary
    const time = stamp()
    close(run, "completed", time)
    const item = enter(next, input.summary)
    const cur = row(item.id)
    if (cur) {
      cur.status = "waiting"
      cur.reason = input.summary
      cur.summary = input.summary
      trans.push({
        id: `${item.id}:waiting:${trans.length}`,
        seq: trans.length,
        timestamp: time,
        level: "step",
        target_id: next,
        run_id: item.id,
        from_state: "active",
        to_state: "waiting",
        reason: input.summary,
      })
    }
    run = item.id
    sync(item.time, next, row(item.id)?.status)
    return snapshot(item.time)
  }

  return { move, wait }
}
