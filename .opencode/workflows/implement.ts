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

const review = z
  .object({
    role: z.string(),
    approve: z.boolean(),
    summary: z.string(),
    issues: z.array(z.string()),
  })
  .strict()

const role = {
  rd: "sisyphus",
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

    const name = slug(src.file, src.body)
    const stamp = time()
    const dir = join(".workflows", "logs", `implement-${name}-${stamp}`)
    const file = "tasks/prd.json"
    const log = {
      source: src.file,
      prd_file: file,
      log_dir: dir,
      roles: role,
      split_rounds: [] as Array<Record<string, unknown>>,
      stories: [] as Array<Record<string, unknown>>,
      final_verify: [] as Array<Record<string, unknown>>,
      retrospective: "",
    }

    await ctx.status({
      title: "Initialize roles",
      metadata: { source: src.file, prd_file: file, log_dir: dir, roles: role },
    })
    await save(ctx, join(dir, "source-prd.md"), src.body)
    await save(ctx, join(dir, "roles.json"), JSON.stringify(role, null, 2))

    let data = await draft(ctx, src, dir, log)
    while (true) {
      const item = pick(data)
      if (!item) break
      const out = await runstory(ctx, src, data, item, dir)
      log.stories.push(out.log)
      data = mark(data, item.id, out.note)
      await writeplan(ctx, file, data)
      await save(ctx, join(dir, `story-${item.id}.json`), JSON.stringify(out.log, null, 2))
    }

    const verify = await finish(ctx, data, dir)
    log.final_verify = verify.log
    log.retrospective = verify.retro
    await save(ctx, join(dir, "retrospective.md"), verify.retro)
    await save(ctx, join(dir, "run.json"), JSON.stringify(log, null, 2))

    return {
      title: "Implement workflow",
      output: [
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
        subagent: role.rd,
        category: "deep",
        load_skills: ["ralph"],
      },
      plan,
      `Convert PRD ${i}`,
    )
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
          description: `Architect split review ${i}`,
          prompt: splitprompt("Architect", src, data),
          subagent: role.architect,
          category: "deep",
        },
        split,
        `Architect split review ${i}`,
      ),
      json(
        ctx,
        {
          description: `QA split review ${i}`,
          prompt: splitprompt("QA", src, data),
          subagent: role.qa,
          category: "deep",
        },
        split,
        `QA split review ${i}`,
      ),
      json(
        ctx,
        {
          description: `FE split review ${i}`,
          prompt: splitprompt("FE", src, data),
          subagent: role.fe,
          category: "deep",
        },
        split,
        `FE split review ${i}`,
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

async function runstory(ctx: Ctx, src: { file: string; body: string }, data: Plan, item: Story, dir: string) {
  const out = {
    story: item.id,
    title: item.title,
    rounds: [] as Array<Record<string, unknown>>,
  }
  let sid: string | undefined
  let fix = ""

  for (let i = 1; i <= 6; i++) {
    await ctx.status({
      title: `${item.id} work ${i}`,
      metadata: { story: item.id, round: i },
    })

    const job = await ctx.task({
      description: i === 1 ? `${item.id} implement` : `${item.id} fix ${i - 1}`,
      prompt: workprompt(src, data, item, fix, i),
      subagent: role.rd,
      category: "deep",
      session_id: sid,
    })
    sid = job.session_id
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
          prompt: reviewprompt("Architect", item, i),
          subagent: role.architect,
          category: "deep",
        },
        review,
        `${item.id} architect review ${i}`,
      ),
      json(
        ctx,
        {
          description: `${item.id} QA review ${i}`,
          prompt: reviewprompt("QA", item, i),
          subagent: role.qa,
          category: "deep",
        },
        review,
        `${item.id} QA review ${i}`,
      ),
      json(
        ctx,
        {
          description: `${item.id} FE review ${i}`,
          prompt: reviewprompt("FE", item, i),
          subagent: role.fe,
          category: "deep",
        },
        review,
        `${item.id} FE review ${i}`,
      ),
      ctx.task({
        description: `${item.id} tests ${i}`,
        prompt: testprompt(item, i),
        subagent: role.test,
        category: "deep",
      }),
    ])

    const reviews = [rows[0].data, rows[1].data, rows[2].data]
    const tests = rows[3].text.trim()
    const notes = issues(reviews, tests)
    const row = {
      round: i,
      work: clip(job.text),
      reviews,
      test_failures: tests,
      issues: notes,
    }
    out.rounds.push(row)
    await save(ctx, join(dir, `${item.id}-review-${i}.json`), JSON.stringify(row, null, 2))

    if (notes.length === 0) {
      return {
        log: out,
        note: note(job.text, i),
      }
    }

    fix = fixprompt(item, notes, tests)
  }

  throw new Error(`Story ${item.id} exceeded the review repair limit`)
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
      prompt: finalprompt(data, i),
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
      prompt: finalfix(data, fail),
      subagent: role.rd,
      category: "deep",
      session_id: sid,
    })
    sid = fix.session_id
    row.fix = clip(fix.text)
    await save(ctx, join(dir, `final-fix-${i}.md`), fix.text)
  }

  const rest = await ctx.task({
    description: "Implementation retrospective",
    prompt: retroprompt(data, log),
    subagent: role.rd,
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
    "Return strict JSON only.",
    'Use exactly this shape: {"role":"' + name + '","ok":true,"summary":"...","issues":["..."]}',
    "",
    "PRD markdown:",
    src.body,
    "",
    "prd.json:",
    JSON.stringify(data, null, 2),
  ].join("\n")
}

function workprompt(src: { file: string; body: string }, data: Plan, item: Story, fix: string, round: number) {
  return [
    "You are Sisyphus implementing one story from the generated backlog.",
    `Source PRD: \`${src.file}\``,
    "Only implement the current story.",
    "Do not edit `tasks/prd.json`; the workflow updates pass state itself.",
    "Make focused code changes, run the smallest relevant verification, and summarize what changed.",
    fix
      ? "This is a repair round. Address every review item and every failing testcase listed below."
      : "This is the first implementation pass for the story.",
    "",
    `Review round: ${round}`,
    "Current backlog:",
    JSON.stringify(data, null, 2),
    "",
    "Current story:",
    JSON.stringify(item, null, 2),
    fix ? ["", "Required fixes:", fix].join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function reviewprompt(name: string, item: Story, round: number) {
  return [
    `You are the ${name} reviewer for the current story implementation.`,
    focus(name, false),
    "Inspect the current workspace changes for this story and report only actionable review items.",
    "If the story is fine for your role, return `approve: true` with an empty `issues` list.",
    "Return strict JSON only.",
    'Use exactly this shape: {"role":"' + name + '","approve":true,"summary":"...","issues":["..."]}',
    "",
    `Review round: ${round}`,
    "Story:",
    JSON.stringify(item, null, 2),
  ].join("\n")
}

function testprompt(item: Story, round: number) {
  return [
    "Run the relevant verification for the current story changes.",
    "Follow repository testing instructions.",
    "Return only failing testcases, typecheck errors, build errors, or other verification failures.",
    "Return an empty response when everything needed for this story is clean.",
    "",
    `Review round: ${round}`,
    "Story:",
    JSON.stringify(item, null, 2),
  ].join("\n")
}

function finalprompt(data: Plan, round: number) {
  return [
    "Rerun the full relevant verification for the current change set.",
    "Follow repository testing instructions.",
    "Return only failing testcases, typecheck errors, build errors, or other verification failures.",
    "Return an empty response when the workspace is clean.",
    "",
    `Final verify round: ${round}`,
    "Backlog:",
    JSON.stringify(data, null, 2),
  ].join("\n")
}

function finalfix(data: Plan, fail: string) {
  return [
    "Fix every remaining verification failure in the workspace.",
    "Do not edit `tasks/prd.json` unless the workflow asks for it later.",
    "Run the smallest relevant verification before you finish and summarize what changed.",
    "",
    "Backlog:",
    JSON.stringify(data, null, 2),
    "",
    "Verification failures:",
    fail,
  ].join("\n")
}

function retroprompt(data: Plan, log: Array<Record<string, unknown>>) {
  return [
    "Write a concise implementation retrospective in markdown.",
    "Cover completed scope, recurring review or test issues, and practical follow-ups.",
    "Keep it brief and specific.",
    "",
    "Final backlog:",
    JSON.stringify(data, null, 2),
    "",
    "Final verify log:",
    JSON.stringify(log, null, 2),
  ].join("\n")
}

function fixprompt(item: Story, notes: string[], tests: string) {
  return [
    `Repair story ${item.id} (${item.title}).`,
    "Address every review point before finishing.",
    notes.length > 0 ? `Review issues:\n- ${notes.join("\n- ")}` : "Review issues: none.",
    tests ? ["", "Failing testcases or verification errors:", tests].join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function fixplan(data: Plan, file: string) {
  if (data.sourcePrdFile) return data
  return {
    ...data,
    sourcePrdFile: file,
  }
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

function issues(reviews: Review[], tests: string) {
  const out = reviews.flatMap((item) => item.issues.map((note) => `${item.role}: ${note}`))
  if (!tests) return out
  return [...out, `Tests: ${tests}`]
}

function note(text: string, round: number) {
  const body = clip(text)
  if (!body) return `Completed by implement workflow after ${round} review round(s).`
  return `Completed by implement workflow after ${round} review round(s). ${body}`
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
  return out || `implement-${Date.now()}`
}

function title(body: string) {
  return body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "))
    ?.slice(2)
    .trim()
}

function join(...parts: string[]) {
  return parts.filter(Boolean).join("/").replace(/\\/g, "/").replace(/\/+/g, "/")
}

function time() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}
