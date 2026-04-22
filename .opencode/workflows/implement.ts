import path from "path"
import z from "zod"
import type { TaskInput, WorkflowContext } from "../workflows"

const story = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    acceptanceCriteria: z.array(z.string()),
    priority: z.number().int(),
    passes: z.boolean(),
    notes: z.string(),
  })
  .strict()

const plan = z
  .object({
    project: z.string(),
    branchName: z.string(),
    sourcePrdFile: z.string().optional(),
    description: z.string(),
    userStories: z.array(story),
  })
  .strict()

const split = z
  .object({
    role: z.string(),
    ok: z.boolean(),
    summary: z.string(),
    issues: z.array(z.string()),
  })
  .strict()

const splitcompat = z
  .object({
    role: z.string(),
    ok: z.boolean().optional(),
    approve: z.boolean().optional(),
    summary: z.string(),
    issues: z.array(z.string()),
  })
  .strict()
  .transform((input) => ({
    role: input.role,
    ok: input.ok ?? input.approve ?? false,
    summary: input.summary,
    issues: input.issues,
  }))

const review = z
  .object({
    role: z.string(),
    approve: z.boolean(),
    summary: z.string(),
    issues: z.array(z.string()),
  })
  .strict()

const reviewcompat = z
  .object({
    role: z.string(),
    approve: z.boolean().optional(),
    ok: z.boolean().optional(),
    summary: z.string(),
    issues: z.array(z.string()),
  })
  .strict()
  .transform((input) => ({
    role: input.role,
    ok: input.ok ?? input.approve ?? false,
    summary: input.summary,
    issues: input.issues,
  }))

const branch = z
  .object({
    ok: z.literal(true),
    branch: z.string(),
    summary: z.string(),
  })
  .strict()

const commit = z
  .object({
    ok: z.literal(true),
    commit: z.string(),
    summary: z.string(),
  })
  .strict()

const role = {
  conv: "general",
  impl: "sisyphus",
  architect: "oracle",
  qa: "momus",
  fe: "momus",
  test: "test-runner",
} as const

type Ctx = WorkflowContext
type Job = TaskInput
type Plan = z.infer<typeof plan>
type Story = z.infer<typeof story>
type Split = z.infer<typeof split>
type Review = z.infer<typeof review>

export default opencode.workflow({
  description: "Run a PRD-to-implementation loop with split review, coding, QA, and retrospective logs",
  async run(ctx: Ctx, input: z.infer<typeof opencode.args>) {
    const src = await load(ctx, input)
    if (!src) {
      return {
        title: "Implement workflow",
        output: [
          "Usage: `/workflow implement <path-to-prd.md>`",
          "You can also pass inline markdown or attach one markdown file with a local path.",
        ].join("\n"),
      }
    }

    const dir = logdir(src)
    const file = "tasks/prd.json"
    const prev = await reuse(ctx, src, file, dir)
    const log = await loadlog(ctx, src, file, dir, !!prev)

    await ctx.status({
      title: "Initialize roles",
      metadata: { source: src.file, prd_file: file, log_dir: dir, roles: role },
    })
    await save(ctx, join(dir, "source-prd.md"), src.body)
    await save(ctx, join(dir, "roles.json"), JSON.stringify(role, null, 2))

    let data: Plan = prev ?? (await draft(ctx, src, dir, log))
    if (prev) {
      await ctx.status({
        title: "Reuse backlog",
        metadata: { source: src.file, prd_file: file, stories: prev.userStories.length },
      })
      await save(ctx, join(dir, "reuse-prd.json"), JSON.stringify(prev, null, 2))
    }

    if (!pick(data)) {
      await save(ctx, join(dir, "run.json"), JSON.stringify(log, null, 2))
      return {
        title: "Implement workflow",
        output: [
          prev ? `Reused existing backlog for: ${src.file}` : undefined,
          `Source PRD: ${src.file}`,
          `Backlog: ${file}`,
          `Stories completed: ${data.userStories.filter((item) => item.passes).length}/${data.userStories.length}`,
          "Nothing left to implement.",
          `Log dir: ${dir}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        metadata: {
          source: src.file,
          prd_file: file,
          log_dir: dir,
          reused_backlog: !!prev,
          stories: data.userStories.length,
        },
      }
    }

    const sw = await gitbranch(ctx, src, file, data, dir)
    log.branch = sw

    while (true) {
      const item = pick(data)
      if (!item) break
      const out = await runstory(ctx, src, file, data, item, dir)
      log.stories.push(out.log)
      await save(ctx, join(dir, `story-${item.id}.json`), JSON.stringify(out.log, null, 2))
      if (out.paused) {
        log.paused = out.paused
        await save(ctx, join(dir, "run.json"), JSON.stringify(log, null, 2))
        return {
          title: "Implement workflow",
          output: [
            `Source PRD: ${src.file}`,
            `Backlog: ${file}`,
            `Stories completed: ${data.userStories.filter((item) => item.passes).length}/${data.userStories.length}`,
            `Paused on: ${out.paused.story}`,
            `Reason: review repair limit reached after ${out.paused.round} round(s)`,
            out.paused.issues.length > 0 ? `Open issues: ${clip(out.paused.issues.join(" | "))}` : undefined,
            `Log dir: ${dir}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          metadata: {
            source: src.file,
            prd_file: file,
            log_dir: dir,
            stories: data.userStories.length,
            paused_story: out.paused.story,
          },
        }
      }
      data = mark(data, item.id, out.note) as Plan
      await writeplan(ctx, file, data)
    }

    const verify = await finish(ctx, data, dir)
    log.final_verify = verify.log
    log.retrospective = verify.retro
    await save(ctx, join(dir, "retrospective.md"), verify.retro)
    await save(ctx, join(dir, "run.json"), JSON.stringify(log, null, 2))

    return {
      title: "Implement workflow",
      output: [
        prev ? `Reused existing backlog for: ${src.file}` : undefined,
        `Source PRD: ${src.file}`,
        `Backlog: ${file}`,
        `Stories completed: ${data.userStories.filter((item) => item.passes).length}/${data.userStories.length}`,
        `Log dir: ${dir}`,
        verify.retro ? ["Retrospective:", verify.retro].join("\n\n") : undefined,
      ]
        .filter(Boolean)
        .join("\n\n"),
      metadata: {
        source: src.file,
        prd_file: file,
        log_dir: dir,
        reused_backlog: !!prev,
        stories: data.userStories.length,
      },
    }
  },
})

async function draft(ctx: Ctx, src: { file: string; body: string }, dir: string, log: Record<string, unknown>) {
  const feed: string[] = []

  for (let i = 1; i <= 5; i++) {
    await ctx.status({
      title: `Convert PRD ${i}`,
      metadata: { round: i, source: src.file },
    })

    const conv = await json(
      ctx,
      {
        description: `Convert PRD ${i}`,
        prompt: convprompt(src, feed),
        subagent: role.conv,
        category: "deep",
        load_skills: ["ralph"],
      },
      plan,
      `Convert PRD ${i}`,
    )
    const fail = planissues(conv.data, src.file)
    if (fail.length > 0) {
      feed.push(fail.join("\n"))
      await save(ctx, join(dir, `convert-${i}-raw.md`), conv.text)
      continue
    }

    const data = fixplan(conv.data, src.file)
    await writeplan(ctx, "tasks/prd.json", data)
    await save(ctx, join(dir, `convert-${i}-raw.md`), conv.text)
    await save(ctx, join(dir, `convert-${i}-prd.json`), JSON.stringify(data, null, 2))

    await ctx.status({
      title: `Review split ${i}`,
      metadata: { round: i, stories: data.userStories.length },
    })

    const rows = await Promise.all([
      json(
        ctx,
        {
          description: `Architect split check ${i}`,
          prompt: splitprompt("Architect", src, data),
          subagent: role.architect,
          category: "deep",
        },
        splitcompat,
        `Architect split check ${i}`,
      ),
      json(
        ctx,
        {
          description: `QA split check ${i}`,
          prompt: splitprompt("QA", src, data),
          subagent: role.qa,
          category: "deep",
        },
        splitcompat,
        `QA split check ${i}`,
      ),
      json(
        ctx,
        {
          description: `FE split check ${i}`,
          prompt: splitprompt("FE", src, data),
          subagent: role.fe,
          category: "deep",
        },
        splitcompat,
        `FE split check ${i}`,
      ),
    ])
    const reviews = rows.map((item) => item.data)
    const bad = reviews.filter((item) => !item.ok || item.issues.length > 0)
    const row = {
      round: i,
      feedback: [...feed],
      reviews,
      blocked: bad.length > 2,
    }
    ;(log.split_rounds as Array<Record<string, unknown>>).push(row)
    await save(ctx, join(dir, `split-review-${i}.json`), JSON.stringify(row, null, 2))

    if (bad.length > 2) {
      feed.push(render(bad))
      continue
    }

    return data
  }

  throw new Error("Split review rejected the PRD breakdown in all retry rounds")
}

async function runstory(
  ctx: Ctx,
  src: { file: string; body: string },
  file: string,
  data: Plan,
  item: Story,
  dir: string,
) {
  const out = {
    story: item.id,
    title: item.title,
    rounds: [] as Array<Record<string, unknown>>,
    decisions: [] as Array<Record<string, unknown>>,
    unresolved: [] as string[],
    commit: null as null | Record<string, unknown>,
  }
  let handoff = ""
  let fix = ""

  for (let i = 1; ; i++) {
    await ctx.status({
      title: `${item.id} work ${i}`,
      metadata: { story: item.id, round: i },
    })

    const job = await ctx.task({
      description: i === 1 ? `${item.id} implement` : `${item.id} fix ${i - 1}`,
      prompt: workprompt(src, file, data, item, fix, i, handoff),
      subagent: role.impl,
      category: "deep",
    })
    handoff = job.text.trim()
    await save(ctx, join(dir, `${item.id}-work-${i}.md`), job.text)

    await ctx.status({
      title: `${item.id} review ${i}`,
      metadata: { story: item.id, round: i },
    })

    const rows = await Promise.all([
      json(
        ctx,
        {
          description: `${item.id} architect review ${i}`,
          prompt: reviewprompt("Architect", src.file, file, item, i, handoff),
          subagent: role.architect,
          category: "deep",
        },
        reviewcompat,
        `${item.id} architect review ${i}`,
      ),
      json(
        ctx,
        {
          description: `${item.id} QA review ${i}`,
          prompt: reviewprompt("QA", src.file, file, item, i, handoff),
          subagent: role.qa,
          category: "deep",
        },
        reviewcompat,
        `${item.id} QA review ${i}`,
      ),
      json(
        ctx,
        {
          description: `${item.id} FE review ${i}`,
          prompt: reviewprompt("FE", src.file, file, item, i, handoff),
          subagent: role.fe,
          category: "deep",
        },
        reviewcompat,
        `${item.id} FE review ${i}`,
      ),
      ctx.task({
        description: `${item.id} tests ${i}`,
        prompt: testprompt(src.file, file, item, i),
        subagent: role.test,
        category: "deep",
      }),
    ])

    const reviews = [rows[0].data, rows[1].data, rows[2].data]
    const tests = rows[3].text.trim()
    const review_issues = reviewissues(reviews)
    const notes = issues(review_issues, tests)
    const row = {
      round: i,
      work: clip(job.text),
      reviews,
      review_issues,
      test_failures: tests,
      issues: notes,
    }
    out.rounds.push(row)
    await save(ctx, join(dir, `${item.id}-review-${i}.json`), JSON.stringify(row, null, 2))

    if (review_issues.length === 0 && !tests) {
      const done = await commitstory(ctx, src, file, data, item, dir)
      out.commit = done
      return {
        log: out,
        note: note(job.text, i, done.commit),
      }
    }

    if (i > 6 && !tests) {
      out.unresolved = review_issues
      out.decisions.push({
        round: i,
        answer: "Pass with unresolved review issues after clean test-runner result",
        issues: review_issues,
      })
      const done = await commitstory(ctx, src, file, data, item, dir, review_issues)
      out.commit = done
      return {
        log: out,
        note: note(job.text, i, done.commit, review_issues),
      }
    }

    fix = fixprompt(item, review_issues, tests)
    if (!tests || i % 6 !== 0) continue

    const ask = await ctx.ask({
      questions: [
        {
          header: item.id,
          question: [
            `Story ${item.id} still has review or verification issues after ${i} repair round(s).`,
            "Choose whether to keep repairing now or stop the workflow for manual follow-up.",
          ].join("\n\n"),
          options: [
            { label: "Continue fixing (Recommended)", description: "Run another repair batch" },
            { label: "Stop workflow", description: "Pause with the story unresolved" },
          ],
        },
      ],
    })
    const answer = ask.answers[0]?.[0] ?? "Continue fixing (Recommended)"
    out.decisions.push({ round: i, answer, issues: notes })
    if (answer.startsWith("Continue")) continue

    return {
      log: out,
      paused: {
        story: item.id,
        round: i,
        issues: notes,
      },
    }
  }
}

async function finish(ctx: Ctx, data: Plan, dir: string) {
  let sid: string | undefined
  const log: Array<Record<string, unknown>> = []

  for (let i = 1; i <= 5; i++) {
    await ctx.status({
      title: `Final verify ${i}`,
      metadata: { round: i, stories: data.userStories.length },
    })

    const test = await ctx.task({
      description: `Final test run ${i}`,
      prompt: finalprompt("tasks/prd.json", data.sourcePrdFile ?? "inline-prd.md", data, i),
      subagent: role.test,
      category: "deep",
    })
    const fail = test.text.trim()
    const row: Record<string, unknown> = {
      round: i,
      failures: fail,
    }
    log.push(row)
    await save(ctx, join(dir, `final-test-${i}.txt`), fail)

    if (!fail) break

    const fix = await ctx.task({
      description: `Final fix ${i}`,
      prompt: finalfix("tasks/prd.json", data.sourcePrdFile ?? "inline-prd.md", data, fail),
      subagent: role.impl,
      category: "deep",
      session_id: sid,
    })
    sid = fix.session_id
    row.fix = clip(fix.text)
    await save(ctx, join(dir, `final-fix-${i}.md`), fix.text)
  }

  const rest = await ctx.task({
    description: "Implementation retrospective",
    prompt: retroprompt("tasks/prd.json", data.sourcePrdFile ?? "inline-prd.md", data, log),
    subagent: role.impl,
    category: "deep",
    session_id: sid,
  })

  return {
    log,
    retro: rest.text.trim(),
  }
}

async function load(ctx: Ctx, input: z.infer<typeof opencode.args>) {
  const raw = input.raw.trim()
  if (raw) {
    if (looks(raw)) return { file: "inline-prd.md", body: raw }
    const file = abs(ctx, raw)
    const src = Bun.file(file)
    if (!(await src.exists())) throw new Error(`PRD file not found: ${raw}`)
    return { file: show(ctx.worktree, file), body: await src.text() }
  }

  const item = input.files.find((file: Ctx["files"][number]) => ismd(file))
  if (!item) return
  const name = item.source?.path
  if (!name) return
  const file = abs(ctx, name)
  const src = Bun.file(file)
  if (!(await src.exists())) throw new Error(`Attached PRD file not found: ${name}`)
  return { file: show(ctx.worktree, file), body: await src.text() }
}

async function reuse(ctx: Pick<Ctx, "directory" | "worktree">, src: { file: string }, file: string, dir: string) {
  if (src.file === "inline-prd.md") return

  const live = await readplan(ctx, file, src.file)
  if (live) return live

  const saved = await readplan(ctx, join(dir, "reuse-prd.json"), src.file)
  if (saved) return saved

  for (let i = 5; i >= 1; i--) {
    const item = await readplan(ctx, join(dir, `convert-${i}-prd.json`), src.file)
    if (item) return item
  }
}

async function readplan(ctx: Pick<Ctx, "directory" | "worktree">, file: string, src: string) {
  const raw = await readjson(ctx, file)
  if (!raw) return
  const out = plan.safeParse(raw)
  if (!out.success) return
  if (!same(ctx, src, out.data.sourcePrdFile)) return
  return fixplan(out.data, src, false)
}

async function loadlog(ctx: Pick<Ctx, "directory">, src: { file: string }, file: string, dir: string, reused: boolean) {
  const raw = await readjson(ctx, join(dir, "run.json"))
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return initlog(src.file, file, dir, reused)
  if (raw.source !== src.file) return initlog(src.file, file, dir, reused)

  return {
    source: src.file,
    prd_file: file,
    log_dir: dir,
    reused,
    roles: role,
    branch: raw.branch && typeof raw.branch === "object" ? raw.branch : null,
    split_rounds: Array.isArray(raw.split_rounds) ? raw.split_rounds : [],
    stories: Array.isArray(raw.stories) ? raw.stories : [],
    final_verify: Array.isArray(raw.final_verify) ? raw.final_verify : [],
    paused: null,
    retrospective: typeof raw.retrospective === "string" ? raw.retrospective : "",
  }
}

function initlog(source: string, file: string, dir: string, reused: boolean) {
  return {
    source,
    prd_file: file,
    log_dir: dir,
    reused,
    roles: role,
    branch: null as null | Record<string, unknown>,
    split_rounds: [] as Array<Record<string, unknown>>,
    stories: [] as Array<Record<string, unknown>>,
    final_verify: [] as Array<Record<string, unknown>>,
    paused: null as null | Record<string, unknown>,
    retrospective: "",
  }
}

async function readjson(ctx: Pick<Ctx, "directory">, file: string) {
  const item = Bun.file(abs(ctx, file))
  if (!(await item.exists())) return

  const text = await item.text()
  if (!text.trim()) return

  try {
    return JSON.parse(text)
  } catch {
    return
  }
}

function convprompt(src: { file: string; body: string }, feed: string[]) {
  return [
    "Use the injected ralph skill to convert the PRD markdown into Ralph prd.json.",
    "Return strict JSON only.",
    `Set \`sourcePrdFile\` to \`${src.file}\`.`,
    "Keep stories small enough for one focused implementation pass.",
    "Keep dependency order strict: lower-level work before dependent work.",
    "Acceptance criteria must stay concrete and verifiable.",
    feed.length > 0
      ? `Previous split objections to resolve:\n${feed.join("\n\n")}`
      : "Previous split objections: none.",
    "",
    "PRD markdown:",
    src.body,
  ].join("\n")
}

function splitprompt(name: string, src: { file: string; body: string }, data: Plan) {
  return [
    `You are the ${name} reviewer for task breakdown quality.`,
    `Review the Ralph backlog generated from \`${src.file}\`.`,
    focus(name, true),
    "Mark `ok` true only when the split is implementation-ready.",
    `Source PRD path: \`${src.file}\``,
    "Backlog path: `tasks/prd.json`.",
    `Current progress: ${progress(data)}`,
    "Read the source PRD and `tasks/prd.json` on demand. Do not ask for the whole backlog again.",
    "Return strict JSON only.",
    'Use exactly this shape: {"role":"' + name + '","ok":true,"summary":"...","issues":["..."]}',
  ].join("\n")
}

function workprompt(
  src: { file: string; body: string },
  file: string,
  data: Plan,
  item: Story,
  fix: string,
  round: number,
  handoff: string,
) {
  return [
    "You are Sisyphus implementing one story from the generated backlog.",
    `Source PRD path: \`${src.file}\``,
    `Backlog path: \`${file}\``,
    `Target branch: \`${data.branchName}\``,
    `Current progress: ${progress(data, item.id)}`,
    "Only implement the current story.",
    "Read the source PRD and `tasks/prd.json` only if you need more detail.",
    "Do not edit `tasks/prd.json`; the workflow updates pass state itself.",
    "Make focused code changes, run the smallest relevant verification, and summarize what changed.",
    fix
      ? [
          "This is a repair round.",
          "You may resolve reviewer issues either by code changes or by a necessary justification that the same reviewer can accept on the next round.",
          "You must fix every failing testcase, typecheck error, build error, or other test-runner failure listed below.",
        ].join(" ")
      : "This is the first implementation pass for the story.",
    "",
    `Review round: ${round}`,
    "Current story:",
    JSON.stringify(item, null, 2),
    handoff ? ["", "Previous round handoff:", handoff].join("\n") : "",
    fix ? ["", "Required fixes:", fix].join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function reviewprompt(name: string, src: string, file: string, item: Story, round: number, handoff: string) {
  return [
    `You are the ${name} reviewer for the current story implementation.`,
    focus(name, false),
    `Source PRD path: \`${src}\``,
    `Backlog path: \`${file}\``,
    "Read the source PRD and `tasks/prd.json` only if you need more detail.",
    "Inspect the current workspace changes for this story and report only actionable review items.",
    "If the implementer gives a necessary reason for not changing something and you agree, approve with no issue instead of forcing a fix.",
    "If the story is fine for your role, return `approve: true` with an empty `issues` list.",
    "Return strict JSON only.",
    'Use exactly this shape: {"role":"' + name + '","approve":true,"summary":"...","issues":["..."]}',
    "",
    `Review round: ${round}`,
    handoff ? ["Implementer summary:", handoff, ""].join("\n") : "",
    "Story:",
    JSON.stringify(item, null, 2),
  ].join("\n")
}

function testprompt(src: string, file: string, item: Story, round: number) {
  return [
    "Run the relevant verification for the current story changes.",
    "Follow repository testing instructions.",
    `Source PRD path: \`${src}\``,
    `Backlog path: \`${file}\``,
    "Read the source PRD and `tasks/prd.json` only if you need more detail.",
    "Return only failing testcases, typecheck errors, build errors, or other verification failures.",
    "Return an empty response when everything needed for this story is clean.",
    "",
    `Review round: ${round}`,
    "Story:",
    JSON.stringify(item, null, 2),
  ].join("\n")
}

function finalprompt(file: string, src: string, data: Plan, round: number) {
  return [
    "Rerun the full relevant verification for the current change set.",
    "Follow repository testing instructions.",
    `Source PRD path: \`${src}\``,
    `Backlog path: \`${file}\``,
    `Current progress: ${progress(data)}`,
    "Read the source PRD and `tasks/prd.json` only if you need more detail.",
    "Return only failing testcases, typecheck errors, build errors, or other verification failures.",
    "Return an empty response when the workspace is clean.",
    "",
    `Final verify round: ${round}`,
  ].join("\n")
}

function finalfix(file: string, src: string, data: Plan, fail: string) {
  return [
    "Fix every remaining verification failure in the workspace.",
    `Source PRD path: \`${src}\``,
    `Backlog path: \`${file}\``,
    `Current progress: ${progress(data)}`,
    "Read the source PRD and `tasks/prd.json` only if you need more detail.",
    "Do not edit `tasks/prd.json` unless the workflow asks for it later.",
    "Run the smallest relevant verification before you finish and summarize what changed.",
    "",
    "Verification failures:",
    fail,
  ].join("\n")
}

function retroprompt(file: string, src: string, data: Plan, log: Array<Record<string, unknown>>) {
  return [
    "Write a concise implementation retrospective in markdown.",
    "Cover completed scope, recurring review or test issues, and practical follow-ups.",
    "Keep it brief and specific.",
    `Source PRD path: \`${src}\``,
    `Backlog path: \`${file}\``,
    `Final progress: ${progress(data)}`,
    "",
    "Final verify log:",
    JSON.stringify(log, null, 2),
  ].join("\n")
}

function fixprompt(item: Story, notes: string[], tests: string) {
  return [
    `Repair story ${item.id} (${item.title}).`,
    [
      "Address every test-runner failure before finishing.",
      "Reviewer issues can be fixed in code or answered with a necessary justification that the same reviewer can accept next round.",
    ].join(" "),
    notes.length > 0 ? `Review findings: ${notes.join(" | ")}` : "Review findings: none.",
    tests ? ["", "Failing testcases or verification errors:", tests].join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function fixplan(data: Plan, file: string, reset = true) {
  return {
    ...data,
    sourcePrdFile: data.sourcePrdFile ?? file,
    branchName: /^ralph\/[a-z0-9-]+$/.test(data.branchName) ? data.branchName : `ralph/${slug(file, file)}`,
    userStories: data.userStories.map((item) => ({
      ...item,
      acceptanceCriteria: item.acceptanceCriteria.includes("Typecheck passes")
        ? item.acceptanceCriteria
        : [...item.acceptanceCriteria, "Typecheck passes"],
      passes: reset ? false : item.passes,
      notes: reset ? "" : item.notes,
    })),
  } as Plan & { sourcePrdFile: string }
}

function planissues(data: Plan, file: string) {
  const out: string[] = []
  if (!/^ralph\/[a-z0-9-]+$/.test(data.branchName)) out.push("branchName must match `ralph/<kebab-case>`")
  if ((data.sourcePrdFile ?? file) !== file) out.push(`sourcePrdFile must equal \`${file}\``)
  if (data.userStories.some((item) => !item.acceptanceCriteria.includes("Typecheck passes"))) {
    out.push("every story must include `Typecheck passes`")
  }
  if (data.userStories.some((item) => item.passes !== false)) out.push("must set passes to false during conversion")
  if (data.userStories.some((item) => item.notes !== ""))
    out.push("must set notes to an empty string during conversion")
  return out
}

function same(ctx: Pick<Ctx, "directory" | "worktree">, left: string, right?: string) {
  if (!right) return false
  if (left === right) return true
  return show(ctx.worktree, abs(ctx, left)) === show(ctx.worktree, abs(ctx, right))
}

async function writeplan(ctx: Pick<Ctx, "write">, file: string, data: Plan) {
  await save(ctx, file, JSON.stringify(data, null, 2))
}

function pick(data: Plan) {
  return data.userStories.toSorted((a, b) => a.priority - b.priority).find((item) => !item.passes)
}

function mark(data: Plan, id: string, notes: string) {
  return {
    ...data,
    userStories: data.userStories.map((item) => {
      if (item.id !== id) return item
      return {
        ...item,
        passes: true,
        notes,
      }
    }),
  }
}

function reviewissues(reviews: Review[]) {
  return reviews.flatMap((item) => item.issues.map((note) => `${item.role}: ${note}`))
}

function issues(reviews: string[], tests: string) {
  const out = [...reviews]
  if (!tests) return out
  return [...out, `Tests: ${tests}`]
}

function note(text: string, round: number, commit?: string, unresolved: string[] = []) {
  const body = clip(text)
  return [
    `Completed by implement workflow after ${round} review round(s).`,
    commit ? `Commit: ${commit}.` : "",
    unresolved.length > 0
      ? `Accepted unresolved review issues after clean test-runner: ${clip(unresolved.join(" | "))}.`
      : "",
    body,
  ]
    .filter(Boolean)
    .join(" ")
}

function render(items: Split[]) {
  return items
    .map((item) => [item.role, item.summary, ...item.issues.map((note) => `- ${note}`)].filter(Boolean).join("\n"))
    .join("\n\n")
}

function focus(name: string, split: boolean) {
  if (name === "Architect") {
    return split
      ? "Focus on story size, dependency order, and architecture boundaries."
      : "Focus on correctness of architecture, boundaries, and integration risk."
  }
  if (name === "QA") {
    return split
      ? "Focus on missing acceptance criteria, verifiability, and risky gaps."
      : "Focus on regressions, edge cases, and missing verification."
  }
  return split
    ? "Focus on whether frontend-facing work is split clearly enough for implementation and browser verification when needed."
    : "Focus on frontend behavior, UX regressions, and browser-verifiable gaps. If the story has no UI impact, approve with no issues."
}

function looks(input: string) {
  return input.includes("\n") || input.startsWith("#")
}

function ismd(file: Ctx["files"][number]) {
  if (file.filename?.toLowerCase().endsWith(".md")) return true
  return file.mime.includes("markdown") || file.mime.startsWith("text/")
}

function clip(input: string) {
  return input.replace(/\s+/g, " ").trim().slice(0, 400)
}

function parse(input: string) {
  const raw = input.trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fence) return JSON.parse(fence)
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start !== -1 && end !== -1 && end > start) return JSON.parse(raw.slice(start, end + 1))
  return JSON.parse(raw)
}

async function json<T extends z.ZodTypeAny>(ctx: Pick<Ctx, "task">, input: Job, schema: T, label: string) {
  let text = ""
  let err = ""

  for (let i = 1; i <= 3; i++) {
    const prompt =
      i === 1
        ? input.prompt
        : [
            input.prompt,
            "",
            `Previous output for ${label} could not be parsed.`,
            `Error: ${err}`,
            "Return strict JSON only.",
            "Previous output:",
            text,
          ].join("\n")
    text = (await ctx.task({ ...input, prompt })).text
    try {
      const raw = parse(text)
      const out = schema.safeParse(raw)
      if (out.success) return { data: out.data, text }
      err = out.error.issues.map((item) => `${item.path.join(".") || "root"}: ${item.message}`).join("\n")
    } catch (cause) {
      err = cause instanceof Error ? cause.message : String(cause)
    }
  }

  throw new Error(`${label} did not return valid JSON after 3 attempts: ${err}`)
}

async function save(ctx: Pick<Ctx, "write">, file: string, body: string) {
  await ctx.write({ file, content: body })
}

function abs(ctx: Pick<Ctx, "directory">, file: string) {
  if (path.isAbsolute(file)) return file
  return path.resolve(ctx.directory, file)
}

function show(root: string, file: string) {
  const rel = path.relative(root, file)
  if (!rel.startsWith("..") && rel !== "") return rel
  return file
}

function slug(file: string, body: string) {
  const name = title(body) || path.basename(file, path.extname(file))
  const out = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return out || "implement"
}

function logdir(src: { file: string; body: string }) {
  const key = src.file === "inline-prd.md" ? slug(src.file, src.body) : stem(src.file)
  return join(".workflows", "logs", `implement-${key}`)
}

function stem(file: string) {
  const out = file
    .toLowerCase()
    .replace(/\.[^.\\/]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return out || slug(file, "")
}

function title(body: string) {
  return body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "))
    ?.slice(2)
    .trim()
}

function progress(data: Plan, cur?: string) {
  const done = data.userStories.filter((item) => item.passes)
  const now = cur ? data.userStories.find((item) => item.id === cur) : undefined
  const left = data.userStories.filter((item) => !item.passes && item.id !== cur)
  return [
    `${done.length}/${data.userStories.length} stories completed.`,
    `Completed: ${done.map((item) => item.id).join(", ") || "none"}.`,
    now ? `Current: ${now.id}.` : "",
    `Remaining: ${left.map((item) => item.id).join(", ") || "none"}.`,
  ]
    .filter(Boolean)
    .join(" ")
}

function branchprompt(src: { file: string }, file: string, data: Plan) {
  return [
    `Switch the repository to branch \`${data.branchName}\`.`,
    `Source PRD path: \`${src.file}\``,
    `Backlog path: \`${file}\``,
    "Create the branch if it does not exist locally. If it exists, switch to it.",
    "Do not make code changes in this step.",
    "Return strict JSON only.",
    `Use exactly this shape: {"ok":true,"branch":"${data.branchName}","summary":"..."}`,
  ].join("\n")
}

function commitprompt(src: { file: string }, file: string, data: Plan, item: Story, notes: string[]) {
  return [
    `Commit the completed work for story ${item.id} (${item.title}).`,
    `Source PRD path: \`${src.file}\``,
    `Backlog path: \`${file}\``,
    `Target branch: \`${data.branchName}\``,
    "Read the source PRD and `tasks/prd.json` only if you need more detail.",
    "Stage only changes needed for this story. Do not include unrelated workspace changes.",
    notes.length > 0
      ? `Accepted unresolved reviewer notes: ${notes.join(" | ")}`
      : "Accepted unresolved reviewer notes: none.",
    "Create one git commit now.",
    "Return strict JSON only.",
    'Use exactly this shape: {"ok":true,"commit":"<hash>","summary":"<what and why>"}',
  ].join("\n")
}

async function gitbranch(
  ctx: Pick<Ctx, "status" | "task" | "write">,
  src: { file: string },
  file: string,
  data: Plan,
  dir: string,
) {
  await ctx.status({
    title: "Switch branch",
    metadata: { branch: data.branchName },
  })
  const out = await json(
    ctx,
    {
      description: `Switch branch ${data.branchName}`,
      prompt: branchprompt(src, file, data),
      subagent: role.impl,
      category: "deep",
    },
    branch,
    `Switch branch ${data.branchName}`,
  )
  await save(ctx, join(dir, "branch.json"), JSON.stringify(out.data, null, 2))
  return out.data
}

async function commitstory(
  ctx: Pick<Ctx, "status" | "task" | "write">,
  src: { file: string },
  file: string,
  data: Plan,
  item: Story,
  dir: string,
  notes: string[] = [],
) {
  await ctx.status({
    title: `${item.id} commit`,
    metadata: { story: item.id, branch: data.branchName },
  })
  const out = await json(
    ctx,
    {
      description: `${item.id} commit`,
      prompt: commitprompt(src, file, data, item, notes),
      subagent: role.impl,
      category: "deep",
    },
    commit,
    `${item.id} commit`,
  )
  await save(ctx, join(dir, `${item.id}-commit.json`), JSON.stringify(out.data, null, 2))
  return out.data
}

function join(...parts: string[]) {
  return parts.filter(Boolean).join("/").replace(/\\/g, "/").replace(/\/+/g, "/")
}
