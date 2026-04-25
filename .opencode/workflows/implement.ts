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

const work = z
  .object({
    summary: z.string(),
    files: z.array(z.string()).default([]),
    verify: z.string().default(""),
    compactions: z.number().int().min(0).default(0),
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
type Work = z.infer<typeof work>
type Reviewer = "Architect" | "QA" | "FE"
type Node =
  | "convert"
  | "select"
  | "implement"
  | "fix"
  | "review"
  | "review_architect"
  | "review_qa"
  | "review_fe"
  | "review_test"
  | "final_verify"
  | "final_fix"
  | "retrospective"
  | "done"
  | "failed"
type Sessions = {
  impl?: string
  review?: Partial<Record<Reviewer, string>>
}

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
    const prog = track(ctx.name, src.file)
    try {
      const prev = await reuse(ctx, src, file, dir)
      const log = await loadlog(ctx, src, file, dir, !!prev)

      await ctx.status({
        title: "Initialize roles",
        metadata: { source: src.file, prd_file: file, log_dir: dir, roles: role },
      })
      await save(ctx, join(dir, "source-prd.md"), src.body)
      await save(ctx, join(dir, "roles.json"), JSON.stringify(role, null, 2))

      let data: Plan = prev ?? (await draft(ctx, src, dir, log, prog))
      if (prev) {
        await ctx.status({
          title: "Reuse backlog",
          metadata: { source: src.file, prd_file: file, stories: prev.userStories.length },
          progress: prog.move("convert", { summary: `Reuse existing backlog from ${file}` }),
        })
        await save(ctx, join(dir, "reuse-prd.json"), JSON.stringify(prev, null, 2))
      }

      if (!pick(data)) {
        await ctx.status({
          title: "Workflow done",
          metadata: { source: src.file, prd_file: file, log_dir: dir, stories: data.userStories.length },
          progress: prog.move("done", { summary: "No stories left to implement" }),
        })
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
        await ctx.status({
          title: `Select ${item.id}`,
          metadata: { story: item.id, title: item.title, branch: data.branchName },
          progress: prog.move("select", { summary: `${item.id}: ${item.title}` }),
        })
        const out = await runstory(ctx, src, file, data, item, dir, prog, resumestory(log, item))
        log.stories = mergestories(log.stories, out.log)
        log.paused = out.paused ?? null
        await save(ctx, join(dir, `story-${item.id}.json`), JSON.stringify(out.log, null, 2))
        if (out.paused) {
          await ctx.status({
            title: `Pause ${out.paused.story}`,
            metadata: { story: out.paused.story, round: out.paused.round, branch: data.branchName },
            progress: prog.move("failed", {
              summary: `${out.paused.story}: review repair limit reached after ${out.paused.round} round(s)`,
            }),
          })
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
        await save(ctx, join(dir, "run.json"), JSON.stringify(log, null, 2))
      }

      const verify = await finish(ctx, data, dir, prog)
      log.final_verify = verify.log
      log.retrospective = verify.retro
      await save(ctx, join(dir, "retrospective.md"), verify.retro)
      await ctx.status({
        title: "Workflow done",
        metadata: { source: src.file, prd_file: file, log_dir: dir, stories: data.userStories.length },
        progress: prog.move("done", {
          summary: `Completed ${data.userStories.length}/${data.userStories.length} stories`,
        }),
      })
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
    } catch (err) {
      await ctx.status({
        title: "Workflow failed",
        metadata: { source: src.file, prd_file: file, log_dir: dir },
        progress: prog.move("failed", {
          summary: err instanceof Error && err.message ? err.message : String(err),
        }),
      })
      throw err
    }
  },
})

async function draft(
  ctx: Ctx,
  src: { file: string; body: string },
  dir: string,
  log: Record<string, unknown>,
  prog: ReturnType<typeof track>,
) {
  const feed: string[] = []

  for (let i = 1; i <= 5; i++) {
    await ctx.status({
      title: `Convert PRD ${i}`,
      metadata: { round: i, source: src.file },
      progress: prog.move("convert", { summary: `Convert backlog from ${src.file}` }),
    })

    const conv = await json(
      ctx,
      {
        description: `Convert PRD ${i}`,
        prompt: convprompt(src, feed),
        subagent: role.conv,
        category: "quick",
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
      progress: prog.move("convert", { summary: `Review converted backlog with ${data.userStories.length} stories` }),
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
          category: "medium",
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
          category: "medium",
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
  prog: ReturnType<typeof track>,
  resume?: {
    log: {
      story: string
      title: string
      rounds: Array<Record<string, unknown>>
      decisions: Array<Record<string, unknown>>
      unresolved: string[]
      commit: null | Record<string, unknown>
      sessions?: {
        impl?: string
        review?: Partial<Record<"Architect" | "QA" | "FE", string>>
      }
    }
    round: number
    handoff: string
    fix: string
    guide: string
    sessions?: {
      impl?: string
      review?: Partial<Record<"Architect" | "QA" | "FE", string>>
    }
  },
) {
  const out = resume?.log ?? initstory(item)
  let handoff = resume?.handoff ?? ""
  let fix = resume?.fix ?? ""
  let guide = resume?.guide ?? ""
  let impl = resume?.sessions?.impl ?? out.sessions?.impl
  const reviewids = {
    Architect: resume?.sessions?.review?.Architect ?? out.sessions?.review?.Architect,
    QA: resume?.sessions?.review?.QA ?? out.sessions?.review?.QA,
    FE: resume?.sessions?.review?.FE ?? out.sessions?.review?.FE,
  }

  for (let i = resume?.round ?? 1; ; i++) {
    const start = Date.now()
    const step = i === 1 ? "implement" : "fix"
    await ctx.status({
      title: `${item.id} work ${i}`,
      metadata: { story: item.id, round: i },
      progress: prog.move(step, {
        summary: i === 1 ? `${item.id}: ${item.title}` : `Repair ${item.id}: ${item.title}`,
        round: i,
      }),
    })

    const desc = i === 1 ? `${item.id} implement` : `${item.id} fix ${i - 1}`
    const job: { value: { session_id: string; text: string }; ms: number } = await timed(() =>
      ctx.task({
        description: desc,
        prompt: workprompt(src, file, data, item, fix, i, handoff, guide),
        subagent: role.impl,
        category: "deep",
        ...(impl ? { session_id: impl } : {}),
      }),
    )
    impl = i > 1 && (await rotates(ctx, job.value.session_id)) ? undefined : job.value.session_id
    handoff = job.value.text.trim()
    out.sessions = {
      impl,
      review: compactreview(reviewids),
    }
    await save(ctx, join(dir, `${item.id}-work-${i}.md`), job.value.text)

    const files = uniq(await changed(ctx, job.value.session_id))
    const names = reviewers(files)
    await ctx.status({
      title: `${item.id} review ${i}`,
      metadata: { story: item.id, round: i, reviewers: names, files },
      progress: prog.review({
        summary: `${item.id}: ${names.join(", ")} review gate`,
        round: i,
        reviewers: names,
      }),
    })

    const rows = await Promise.all(
      names.map((name) =>
        timed<{
          data: { role: string; ok: boolean; summary: string; issues: string[] }
          text: string
          session_id: string
        }>(() =>
          jsontask(
            ctx,
            {
              description: `${item.id} ${name} review ${i}`,
              prompt: reviewprompt(name, src.file, file, item, i, handoff, files),
              subagent: reviewagent(name),
              category: reviewcat(name),
              ...(reviewids[name] ? { session_id: reviewids[name] } : {}),
            },
            reviewcompat,
            `${item.id} ${name} review ${i}`,
          ),
        ),
      ),
    )
    const test = await timed<{ text: string; fail: string; session_id: string }>(() =>
      verifytask(
        ctx,
        {
          description: `${item.id} tests ${i}`,
          prompt: testprompt(src.file, file, item, i, files),
          subagent: role.test,
          category: "deep",
        },
        `${item.id} tests ${i}`,
      ),
    )
    const reviews = rows.map((item, idx) => {
      reviewids[names[idx]!] = item.value.session_id
      return item.value.data
    })
    const tests = test.value.fail
    const review_issues = reviewissues(reviews)
    const notes = issues(review_issues, tests)
    const row = {
      round: i,
      work: clip(handoff),
      files,
      reviewers: names,
      reviews,
      review_issues,
      test_output: test.value.text,
      test_failures: tests,
      issues: notes,
      timing: {
        total_ms: Date.now() - start,
        work_ms: job.ms,
        review_ms: rows.reduce((sum, item) => sum + item.ms, 0),
        test_ms: test.ms,
        review: rows.map((item, idx) => ({ role: names[idx], ms: item.ms })),
      },
    }
    out.rounds.push(row)
    out.sessions = {
      impl,
      review: compactreview(reviewids),
    }
    await ctx.status({
      title: `${item.id} review ${i} results`,
      metadata: {
        story: item.id,
        round: i,
        reviewers: names,
        issues: notes.length,
        test_failures: tests ? 1 : 0,
      },
      progress: prog.reviewdone({
        summary:
          notes.length === 0
            ? `${item.id}: review gate passed`
            : `${item.id}: review gate found ${notes.length} issue${notes.length === 1 ? "" : "s"}`,
        round: i,
        reviews,
        tests,
      }),
    })
    await save(ctx, join(dir, `${item.id}-review-${i}.json`), JSON.stringify(row, null, 2))

    if (review_issues.length === 0 && !tests) {
      const done = await commitstory(ctx, src, file, data, item, dir)
      out.commit = done
      return {
        log: out,
        note: note(handoff, i, done.commit),
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
        note: note(handoff, i, done.commit, review_issues),
      }
    }

    fix = fixprompt(item, review_issues, tests, guide, files)
    if (i % 5 !== 0) continue

    const ask = await ctx.ask({
      questions: [
        {
          header: item.id,
          question: [
            `Story ${item.id} still has review or verification issues after ${i} repair round(s).`,
            "Choose whether to keep repairing now or stop the workflow for manual follow-up.",
            "You can also type a short instruction for the next repair round; custom text is treated as continue.",
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
    if (!stopanswer(answer)) {
      guide = guideanswer(answer) ?? guide
      fix = fixprompt(item, review_issues, tests, guide, files)
      continue
    }

    return {
      log: out,
      paused: {
        story: item.id,
        round: i,
        next_round: i + 1,
        handoff,
        fix,
        guide,
        issues: notes,
        sessions: {
          impl,
          review: compactreview(reviewids),
        },
      },
    }
  }
}

async function finish(ctx: Ctx, data: Plan, dir: string, prog: ReturnType<typeof track>) {
  let sid: string | undefined
  const log: Array<Record<string, unknown>> = []

  for (let i = 1; i <= 5; i++) {
    await ctx.status({
      title: `Final verify ${i}`,
      metadata: { round: i, stories: data.userStories.length },
      progress: prog.finalverify({
        round: i,
        summary: `Final verification round ${i}`,
      }),
    })

    const test = await verify(
      ctx,
      {
        description: `Final test run ${i}`,
        prompt: finalprompt("tasks/prd.json", data.sourcePrdFile ?? "inline-prd.md", data, i),
        subagent: role.test,
        category: "deep",
      },
      `Final test run ${i}`,
    )
    const fail = test.fail
    const row: Record<string, unknown> = {
      round: i,
      output: test.text,
      failures: fail,
    }
    log.push(row)
    await save(ctx, join(dir, `final-test-${i}.txt`), test.text)

    await ctx.status({
      title: `Final verify ${i} result`,
      metadata: { round: i, stories: data.userStories.length, failures: fail ? 1 : 0 },
      progress: prog.finalverifydone({
        round: i,
        summary: fail ? `Final verification failed in round ${i}` : `Final verification passed in round ${i}`,
        fail,
      }),
    })

    if (!fail) break

    await ctx.status({
      title: `Final fix ${i}`,
      metadata: { round: i, stories: data.userStories.length },
      progress: prog.move("final_fix", {
        summary: `Apply final verification fixes for round ${i}`,
        round: i,
      }),
    })

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
    await ctx.status({
      title: `Final fix ${i} result`,
      metadata: { round: i, stories: data.userStories.length },
      progress: prog.stepdone({
        summary: clip(fix.text) || `Applied final verification fixes for round ${i}`,
      }),
    })
  }

  await ctx.status({
    title: "Implementation retrospective",
    metadata: { stories: data.userStories.length },
    progress: prog.move("retrospective", {
      summary: "Write implementation retrospective",
    }),
  })

  const rest = await ctx.task({
    description: "Implementation retrospective",
    prompt: retroprompt("tasks/prd.json", data.sourcePrdFile ?? "inline-prd.md", data, log),
    subagent: role.impl,
    category: "deep",
    session_id: sid,
  })
  await ctx.status({
    title: "Implementation retrospective result",
    metadata: { stories: data.userStories.length },
    progress: prog.stepdone({
      summary: clip(rest.text) || "Implementation retrospective completed",
    }),
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
    paused: raw.paused && typeof raw.paused === "object" ? raw.paused : null,
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

function initstory(item: Story) {
  return {
    story: item.id,
    title: item.title,
    rounds: [] as Array<Record<string, unknown>>,
    decisions: [] as Array<Record<string, unknown>>,
    unresolved: [] as string[],
    commit: null as null | Record<string, unknown>,
    sessions: {} as Sessions,
  }
}

function resumestory(
  log: {
    stories: Array<Record<string, unknown>>
    paused: null | Record<string, unknown>
  },
  item: Story,
) {
  const paused = log.paused && log.paused.story === item.id && !Array.isArray(log.paused) ? log.paused : undefined
  const prev =
    log.stories.toReversed().find((entry) => entry.story === item.id && (!entry.commit || paused)) ??
    (paused ? { story: item.id, title: item.title } : undefined)
  if (!prev) return

  return {
    log: {
      story: typeof prev.story === "string" ? prev.story : item.id,
      title: typeof prev.title === "string" ? prev.title : item.title,
      rounds: Array.isArray(prev.rounds) ? prev.rounds : [],
      decisions: Array.isArray(prev.decisions) ? prev.decisions : [],
      unresolved: Array.isArray(prev.unresolved) ? prev.unresolved.filter((item) => typeof item === "string") : [],
      commit:
        prev.commit && typeof prev.commit === "object" && !Array.isArray(prev.commit)
          ? (prev.commit as Record<string, unknown>)
          : null,
      sessions: sessions(prev.sessions),
    },
    round:
      typeof paused?.next_round === "number"
        ? paused.next_round
        : Array.isArray(prev.rounds)
          ? prev.rounds.length + 1
          : 1,
    handoff: typeof paused?.handoff === "string" ? paused.handoff : "",
    fix: typeof paused?.fix === "string" ? paused.fix : "",
    guide: typeof paused?.guide === "string" ? paused.guide : "",
    sessions: sessions(paused?.sessions ?? prev.sessions),
  }
}

function mergestories(list: Array<Record<string, unknown>>, item: Record<string, unknown>) {
  const id = typeof item.story === "string" ? item.story : ""
  if (!id) return [...list, item]
  const idx = list.findIndex((row) => row.story === id)
  if (idx === -1) return [...list, item]
  return list.map((row, n) => (n === idx ? item : row))
}

function sessions(input: unknown): Sessions {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const item = input as Record<string, unknown>
  return {
    impl: typeof item.impl === "string" ? item.impl : undefined,
    review:
      item.review && typeof item.review === "object" && !Array.isArray(item.review) ? compactreview(item.review) : {},
  }
}

function compactreview(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const item = input as Record<string, unknown>
  return {
    Architect: typeof item.Architect === "string" ? item.Architect : undefined,
    QA: typeof item.QA === "string" ? item.QA : undefined,
    FE: typeof item.FE === "string" ? item.FE : undefined,
  } satisfies Partial<Record<Reviewer, string>>
}

function uniq(input: string[]) {
  return [...new Set(input.filter(Boolean))]
}

function reviewers(files: string[]): Reviewer[] {
  if (files.length === 0) return ["Architect", "QA", "FE"]
  if (files.every((file) => /(^|\/)test\//.test(file) || /\.test\.[^.]+$/.test(file) || /\.spec\.[^.]+$/.test(file))) {
    return ["QA"]
  }
  if (files.some(ui)) return ["Architect", "QA", "FE"]
  return ["Architect", "QA"]
}

function ui(file: string) {
  const low = file.toLowerCase()
  return [".tsx", ".jsx", ".css", ".scss", ".sass", ".less", ".html"].some((ext) => low.endsWith(ext))
}

function reviewagent(name: Reviewer) {
  if (name === "Architect") return role.architect
  if (name === "QA") return role.qa
  return role.fe
}

function reviewcat(name: Reviewer) {
  return name === "Architect" ? "deep" : "medium"
}

async function timed<T>(fn: () => Promise<T>) {
  const start = Date.now()
  return { value: await fn(), ms: Date.now() - start }
}

async function jsontask<T extends z.ZodTypeAny>(ctx: Pick<Ctx, "task">, input: Job, schema: T, label: string) {
  let text = ""
  let err = ""
  let sid = ""

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
    const out = await ctx.task({ ...input, prompt })
    sid = out.session_id
    text = out.text
    try {
      const raw = parse(text)
      const next = schema.safeParse(raw)
      if (next.success) return { data: next.data, text, session_id: sid }
      err = next.error.issues.map((item) => `${item.path.join(".") || "root"}: ${item.message}`).join("\n")
    } catch (cause) {
      err = cause instanceof Error ? cause.message : String(cause)
    }
  }

  throw new Error(`${label} did not return valid JSON after 3 attempts: ${err}`)
}

async function verifytask(ctx: Pick<Ctx, "task">, input: Job, label: string) {
  let text = ""
  let sid = ""

  for (let i = 1; i <= 3; i++) {
    const prompt =
      i === 1
        ? input.prompt
        : [
            input.prompt,
            "",
            `Previous output for ${label} did not follow the required verification format.`,
            "Return exactly one of:",
            "VERIFY: PASS",
            "",
            "or:",
            "VERIFY: FAIL",
            "FAILURES:",
            "<concise failure details>",
            "",
            "Previous output:",
            text || "<empty>",
          ].join("\n")
    const out = await ctx.task({ ...input, prompt })
    sid = out.session_id
    text = out.text.trim()
    const next = parseverify(text)
    if (next) return { ...next, session_id: sid }
  }

  throw new Error(`${label} did not return valid verification output after 3 attempts`)
}

async function changed(ctx: Pick<Ctx, "session">, id: string) {
  const diffs = await ctx.session.diff(id).catch(() => [])
  return diffs.map((item: { file: string }) => item.file)
}

async function rotates(ctx: Pick<Ctx, "session">, id?: string) {
  if (!id) return false
  const msg = await ctx.session.messages(id)
  let count = 0
  for (const item of msg) {
    if (item.parts.some((part: { type: string }) => part.type === "compaction")) count += 1
  }
  return count > 1
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
  guide = "",
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
    "Make focused code changes, run the smallest relevant verification, and return strict JSON only.",
    'Use exactly this shape: {"summary":"...","files":["path/to/file"],"verify":"...","compactions":0}',
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
    guide ? ["", `Operator instruction: ${guide}`].join("\n") : "",
    fix ? ["", "Required fixes:", fix].join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function reviewprompt(
  name: string,
  src: string,
  file: string,
  item: Story,
  round: number,
  handoff: string,
  files: string[],
) {
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
    `Touched files: ${files.join(", ") || "unknown"}`,
    handoff ? ["Implementer summary:", handoff, ""].join("\n") : "",
    "Story:",
    JSON.stringify(item, null, 2),
  ].join("\n")
}

function testprompt(src: string, file: string, item: Story, round: number, files: string[]) {
  return [
    "Run the relevant verification for the current story changes.",
    "Follow repository testing instructions.",
    `Source PRD path: \`${src}\``,
    `Backlog path: \`${file}\``,
    "Read the source PRD and `tasks/prd.json` only if you need more detail.",
    "Return verification in this exact format.",
    "If everything needed for this story is clean, return exactly `VERIFY: PASS`.",
    "If anything fails, return exactly `VERIFY: FAIL`, then a line with `FAILURES:`, then only the concise failure details.",
    "Do not return any other prelude, suffix, or formatting.",
    "",
    `Review round: ${round}`,
    `Touched files: ${files.join(", ") || "unknown"}`,
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
    "Return verification in this exact format.",
    "If the workspace is clean, return exactly `VERIFY: PASS`.",
    "If anything fails, return exactly `VERIFY: FAIL`, then a line with `FAILURES:`, then only the concise failure details.",
    "Do not return any other prelude, suffix, or formatting.",
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

function fixprompt(item: Story, notes: string[], tests: string, guide = "", files: string[] = []) {
  return [
    `Repair story ${item.id} (${item.title}).`,
    [
      "Address every test-runner failure before finishing.",
      "Reviewer issues can be fixed in code or answered with a necessary justification that the same reviewer can accept next round.",
    ].join(" "),
    guide ? `Operator instruction: ${guide}` : "",
    files.length > 0 ? `Touched files: ${files.join(", ")}` : "",
    notes.length > 0 ? `Review findings: ${notes.join(" | ")}` : "Review findings: none.",
    tests ? ["", "Failing testcases or verification errors:", tests].join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function stopanswer(answer: string) {
  const text = answer.trim().toLowerCase()
  return text === "stop workflow" || text === "stop"
}

function guideanswer(answer: string) {
  const text = answer.trim()
  if (!text || text.startsWith("Continue fixing")) return
  if (stopanswer(text)) return
  return text
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

function reviewissues(reviews: Array<{ role: string; issues: string[] }>) {
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

async function verify(ctx: Pick<Ctx, "task">, input: Job, label: string) {
  let text = ""

  for (let i = 1; i <= 3; i++) {
    const prompt =
      i === 1
        ? input.prompt
        : [
            input.prompt,
            "",
            `Previous output for ${label} did not follow the required verification format.`,
            "Return exactly one of:",
            "VERIFY: PASS",
            "",
            "or:",
            "VERIFY: FAIL",
            "FAILURES:",
            "<concise failure details>",
            "",
            "Previous output:",
            text || "<empty>",
          ].join("\n")
    text = (await ctx.task({ ...input, prompt })).text.trim()
    const out = parseverify(text)
    if (out) return out
  }

  throw new Error(`${label} did not return valid verification output after 3 attempts`)
}

function parseverify(text: string) {
  const raw = text.trim()
  if (raw === "VERIFY: PASS") return { text: raw, fail: "" }
  const match = raw.match(/^VERIFY: FAIL\s+FAILURES:\s*([\s\S]+)$/)
  if (!match?.[1].trim()) return
  return {
    text: raw,
    fail: match[1].trim(),
  }
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

function track(name: string, src: string) {
  const start = stamp()
  const flow = [
    { id: "convert", kind: "task", label: "Convert PRD", next: ["select"] },
    { id: "select", kind: "decision", label: "Select story", next: ["implement", "final_verify", "done"] },
    { id: "implement", kind: "task", label: "Implement story", next: ["review"] },
    { id: "fix", kind: "task", label: "Apply fixes", next: ["review"] },
    {
      id: "review",
      kind: "group",
      label: "Review gate",
      children: ["review_architect", "review_qa", "review_fe", "review_test"],
      next: ["fix", "select", "done", "failed"],
    },
    { id: "review_architect", kind: "decision", parent_id: "review", label: "Architect review" },
    { id: "review_qa", kind: "decision", parent_id: "review", label: "QA review" },
    { id: "review_fe", kind: "decision", parent_id: "review", label: "FE review" },
    { id: "review_test", kind: "task", parent_id: "review", label: "Test runner" },
    { id: "final_verify", kind: "task", label: "Final verify", next: ["final_fix", "retrospective", "done"] },
    { id: "final_fix", kind: "task", label: "Final fix", next: ["final_verify"] },
    { id: "retrospective", kind: "task", label: "Retrospective", next: ["done"] },
    { id: "done", kind: "terminal", label: "Done" },
    { id: "failed", kind: "terminal", label: "Failed" },
  ] as const
  const runs = [] as Array<Record<string, unknown>>
  const trans = [] as Array<Record<string, unknown>>
  const seen = {
    convert: 0,
    select: 0,
    implement: 0,
    fix: 0,
    review: 0,
    review_architect: 0,
    review_qa: 0,
    review_fe: 0,
    review_test: 0,
    final_verify: 0,
    final_fix: 0,
    retrospective: 0,
    done: 0,
    failed: 0,
  }
  let node: Node | undefined
  let run: string | undefined
  let kids: string[] = []
  let state: "running" | "waiting" | "blocked" | "failed" | "retrying" | "done" = "running"
  let note = `Convert backlog from ${src}`

  function row(id?: string) {
    if (!id) return
    return runs.find((item) => item.id === id)
  }

  function live(val: unknown) {
    return val === "active" || val === "waiting" || val === "blocked" || val === "retrying"
  }

  function source(item?: Record<string, unknown>) {
    if (!item?.actor || typeof item.actor !== "object" || Array.isArray(item.actor)) return
    const actor = item.actor as Record<string, unknown>
    return {
      type: "agent",
      ...(typeof actor.id === "string" ? { id: actor.id } : {}),
      ...(typeof actor.label === "string" ? { label: actor.label } : {}),
      ...(typeof actor.name === "string" ? { name: actor.name } : {}),
      ...(typeof actor.role === "string" ? { role: actor.role } : {}),
      ...(typeof item.step_id === "string" ? { step_id: item.step_id } : {}),
      ...(typeof item.id === "string" ? { run_id: item.id } : {}),
    }
  }

  function flowstatus(status?: unknown, step?: unknown) {
    if (step === "done") return "done" as const
    if (step === "failed") return "failed" as const
    if (status === "waiting") return "waiting" as const
    if (status === "blocked") return "blocked" as const
    if (status === "retrying") return "retrying" as const
    if (status === "failed") return "retrying" as const
    return "running" as const
  }

  function phasestatus(status?: unknown, step?: unknown) {
    if (step === "done" || status === "completed") return "completed" as const
    if (step === "failed" || status === "failed") return "failed" as const
    if (status === "waiting") return "waiting" as const
    if (status === "blocked") return "blocked" as const
    if (status === "retrying") return "retrying" as const
    return "active" as const
  }

  function syncstate(time: string, next?: Node, status?: unknown) {
    if (next) node = next
    const to = flowstatus(status, node)
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

  function close(id: string | undefined, status: "completed" | "failed" | "retrying", time: string, summary?: string) {
    const item = row(id)
    if (!item || item.ended_at || !live(item.status)) return
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
      ...(source(item) ? { source: source(item) } : {}),
    })
  }

  function closekids(time: string, status: "completed" | "failed" = "completed", summary?: string) {
    kids.forEach((id) => close(id, status, time, summary))
    kids = []
  }

  function enter(
    next: Node,
    input: {
      summary: string
      round?: number
      retry?: number
      parent?: string
      actor?: Record<string, unknown>
      status?: "active" | "completed" | "failed"
    },
  ) {
    const time = stamp()
    seen[next] += 1
    const id = `${next}-${seen[next]}`
    const status = input.status ?? "active"
    runs.push({
      id,
      seq: runs.length,
      step_id: next,
      status,
      summary: input.summary,
      reason: input.summary,
      started_at: time,
      ...(input.parent ? { parent_run_id: input.parent } : {}),
      ...(input.round ? { round: { current: input.round, label: `Round ${input.round}` } } : {}),
      ...(input.retry ? { retry: { current: input.retry, label: `Retry ${input.retry}` } } : {}),
      ...(input.actor ? { actor: input.actor } : {}),
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
      reason: input.summary,
      ...(source(runs[runs.length - 1]) ? { source: source(runs[runs.length - 1]) } : {}),
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
        label: "Implement workflow",
        summary: note,
        started_at: start,
        ...(state === "done" || state === "failed" ? { ended_at: time } : {}),
      },
      phase: {
        status: phasestatus(item?.status, node),
        key: node,
        label: flow.find((item) => item.id === node)?.label ?? "Workflow",
        summary: note,
      },
      machine: {
        id: name,
        key: name,
        label: "Implement workflow",
        root_step_id: "convert",
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

  function move(next: Node, input: { summary: string; round?: number }) {
    note = input.summary
    const time = stamp()
    closekids(time)
    close(run, next === "failed" ? "failed" : "completed", time)
    const item = enter(next, {
      summary: input.summary,
      round: input.round,
      retry: next === "fix" && input.round && input.round > 1 ? input.round - 1 : undefined,
      status: next === "done" ? "completed" : next === "failed" ? "failed" : "active",
    })
    run = item.id
    syncstate(item.time, next, row(item.id)?.status)
    return snapshot(item.time)
  }

  function review(input: { summary: string; round: number; reviewers: Reviewer[] }) {
    note = input.summary
    const time = stamp()
    closekids(time)
    close(run, "completed", time)
    const group = enter("review", {
      summary: input.summary,
      round: input.round,
      retry: input.round > 1 ? input.round : undefined,
    })
    const list = [
      ...(input.reviewers.includes("Architect")
        ? [
            enter("review_architect", {
              summary: "Architect review in progress",
              round: input.round,
              parent: group.id,
              actor: { name: "Architect", role: "reviewer", status: "running" },
            }).id,
          ]
        : []),
      ...(input.reviewers.includes("QA")
        ? [
            enter("review_qa", {
              summary: "QA review in progress",
              round: input.round,
              parent: group.id,
              actor: { name: "QA", role: "reviewer", status: "running" },
            }).id,
          ]
        : []),
      ...(input.reviewers.includes("FE")
        ? [
            enter("review_fe", {
              summary: "FE review in progress",
              round: input.round,
              parent: group.id,
              actor: { name: "FE", role: "reviewer", status: "running" },
            }).id,
          ]
        : []),
      enter("review_test", {
        summary: "Test runner in progress",
        round: input.round,
        parent: group.id,
        actor: { name: "test-runner", role: "test-runner", status: "running" },
      }).id,
    ]
    run = group.id
    kids = list
    syncstate(group.time, "review", row(group.id)?.status)
    return snapshot(group.time)
  }

  function reviewdone(input: {
    summary: string
    round: number
    reviews: Array<{ role: string; issues: string[]; summary: string }>
    tests: string
  }) {
    note = input.summary
    const time = stamp()
    const map = {
      Architect: "review_architect",
      QA: "review_qa",
      FE: "review_fe",
    } as const
    input.reviews.forEach((item) => {
      const step = map[item.role as keyof typeof map]
      if (!step) return
      const hit = kids.find((id) => row(id)?.step_id === step)
      close(hit, item.issues.length > 0 ? "failed" : "completed", time, item.summary)
    })
    close(
      kids.find((id) => row(id)?.step_id === "review_test"),
      input.tests ? "failed" : "completed",
      time,
      input.tests || "Verification passed",
    )
    close(
      run,
      input.tests || input.reviews.some((item) => item.issues.length > 0) ? "retrying" : "completed",
      time,
      input.summary,
    )
    syncstate(time, undefined, row(run)?.status)
    return snapshot(time)
  }

  function finalverify(input: { summary: string; round: number }) {
    return move("final_verify", {
      summary: input.summary,
      round: input.round,
    })
  }

  function finalverifydone(input: { summary: string; round: number; fail: string }) {
    note = input.summary
    const time = stamp()
    const item = row(run)
    if (item?.step_id === "final_verify" && typeof item.id === "string") {
      close(item.id, input.fail ? "failed" : "completed", time, input.summary)
    }
    syncstate(time, undefined, row(run)?.status)
    return snapshot(time)
  }

  function stepdone(input: { summary: string }) {
    note = input.summary
    const time = stamp()
    if (typeof run === "string") close(run, "completed", time, input.summary)
    syncstate(time, undefined, row(run)?.status)
    return snapshot(time)
  }

  return { move, review, reviewdone, finalverify, finalverifydone, stepdone }
}

function stamp() {
  return new Date().toISOString()
}

function branchprompt(src: { file: string }, file: string, data: Plan) {
  return [
    `Switch the repository to branch \`${data.branchName}\`.`,
    `Source PRD path: \`${src.file}\``,
    `Backlog path: \`${file}\``,
    "If the branch does not exist locally, create it from the branch that is currently checked out.",
    "If it already exists, switch to it without recreating it from a fixed base branch.",
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
