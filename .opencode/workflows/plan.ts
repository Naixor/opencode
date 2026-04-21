import z from "zod"

const issue = z
  .object({
    id: z.string(),
    kind: z.enum(["confirm", "open"]),
    question: z.string(),
    why: z.string(),
    options: z.array(z.string()).optional(),
  })
  .strict()

const pmres = z
  .object({
    summary: z.string(),
    prd_markdown: z.string(),
    issues: z.array(issue),
    done: z.boolean().optional(),
  })
  .strict()

const roleres = z
  .object({
    role: z.string(),
    answers: z.array(
      z
        .object({
          id: z.string(),
          stance: z.string(),
          why: z.string(),
          confidence: z.enum(["low", "medium", "high"]).optional(),
        })
        .strict(),
    ),
    overall: z.string().optional(),
  })
  .strict()

const judge = z
  .object({
    similar: z.boolean(),
    summary: z.string(),
    decisions: z.array(
      z
        .object({
          id: z.string(),
          similar: z.boolean(),
          summary: z.string(),
          recommended: z.string(),
          options: z
            .array(
              z
                .object({
                  label: z.string(),
                  description: z.string(),
                })
                .strict(),
            )
            .optional(),
        })
        .strict(),
    ),
  })
  .strict()

const roles = [
  { id: "pm", name: "PM" },
  { id: "architect", name: "Architect" },
  { id: "fe", name: "FE" },
  { id: "qa", name: "QA" },
  { id: "dba", name: "DBA" },
  { id: "muse", name: "Muse" },
] as const

export default opencode.workflow({
  description: "Drive a multi-role PRD planning loop until open questions converge",
  input: opencode.args.transform((input) => {
    let notify: string | undefined
    let max = 5
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
      min_rounds: 3,
      goal: goal.join(" ").trim(),
    }
  }),
  async run(ctx, input) {
    if (!input.goal) {
      return {
        title: "Plan workflow",
        output: "Usage: `/workflow plan <goal> [--notify <chat_id|user_id>] [--max-rounds 3-5]`",
      }
    }

    const sys = await loadRoles()
    const slugged = slug(input.goal)
    const stamp = time()
    const file = `tasks/prds/prd-${slugged}.md`
    const dir = `.workflows/logs/plan-${slugged}-${stamp}`
    const refs = files(input.files)
    let prd = ""
    let note = ""
    let notify = input.notify
    let last: z.infer<typeof pmres> | undefined
    const mem: string[] = []
    const rounds: string[] = []
    const log = {
      goal: input.goal,
      prd_file: file,
      log_dir: dir,
      notify: notify ?? null,
      rounds: [] as Array<Record<string, unknown>>,
      decisions: [] as Array<Record<string, unknown>>,
      notification: null as null | string,
      final: null as null | Record<string, unknown>,
    }

    await ctx.status({
      title: "Initialize roles",
      metadata: { roles: roles.map((item) => item.name), file, dir },
    })

    for (let i = 1; i <= input.max_rounds; i++) {
      const row = {
        round: i,
        pm: {} as Record<string, unknown>,
        roles: {} as Record<string, unknown>,
        judge: {} as Record<string, unknown>,
        user_decisions: [] as Array<Record<string, unknown>>,
      }
      log.rounds.push(row)

      await ctx.status({
        title: `PM round ${i}`,
        metadata: { round: i, file },
      })

      const pm = await json(
        ctx,
        {
          description: `PM round ${i}`,
          prompt: pmPrompt({
            round: i,
            goal: input.goal,
            file,
            prd,
            refs,
            mem,
            role: sys.pm,
            min: input.min_rounds,
            max: input.max_rounds,
          }),
          subagent: "general",
          category: "deep",
          load_skills: ["prd"],
        },
        pmres,
        `PM round ${i}`,
        "pm",
        row.pm,
      )

      last = pm
      prd = pm.prd_markdown
      await save(ctx, file, prd)
      const items = uniq(pm.issues)
      rounds.push(`Round ${i}: ${pm.summary}`)

      if (items.length === 0) {
        if (i >= input.min_rounds && (pm.done ?? true)) break
        mem.push(
          `Round ${i}: PM reported no unresolved questions. Re-check the PRD for hidden assumptions and remaining gaps.`,
        )
        continue
      }

      await ctx.status({
        title: `Role review ${i}`,
        metadata: { round: i, issues: items.length },
      })

      const peers = roles.filter((item) => item.id !== "pm")
      const ans = await Promise.all(
        peers.map(async (item) => ({
          role: item.name,
          data: await json(
            ctx,
            {
              description: `${item.name} round ${i}`,
              prompt: rolePrompt({
                role: item.name,
                sys: sys[item.id],
                goal: input.goal,
                file,
                prd,
                items,
                refs,
              }),
              subagent: "general",
              category: item.id === "muse" ? "deep" : "quick",
            },
            roleres,
            `${item.name} round ${i}`,
            "role",
            (row.roles[item.id] = {}),
          ),
        })),
      )

      const cmp = await json(
        ctx,
        {
          description: `Judge round ${i}`,
          prompt: judgePrompt({ goal: input.goal, items, ans }),
          subagent: "general",
          category: "deep",
        },
        judge,
        `Judge round ${i}`,
        "judge",
        row.judge,
      )

      if (cmp.similar && cmp.decisions.every((item) => item.similar)) {
        mem.push(`Round ${i} consensus:\n${cmp.summary}`)
        continue
      }

      if (!notify) {
        const pick = await ctx.ask({
          questions: [
            {
              header: "Lark target",
              question:
                "If you want a Lark notification for plan decisions, provide a chat_id/user_id. Otherwise choose Skip.",
              options: [{ label: "Skip", description: "Do not send a Lark message this round" }],
              custom: true,
            },
          ],
        })
        const val = pick.answers[0]?.[0]
        if (val && val !== "Skip") notify = val
      }

      if (notify) {
        note = await send(ctx, notify, message({ goal: input.goal, file, round: i, cmp, ans })).catch(
          (err: unknown) => `Lark notification failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        log.notification = note
      }

      const ask = cmp.decisions.filter((item) => !item.similar)
      const res = await ctx.ask({
        questions: ask.map((item, idx) => ({
          header: `Decision ${idx + 1}`,
          question: item.summary,
          options:
            item.options && item.options.length > 0
              ? item.options
              : [
                  { label: item.recommended, description: "Recommended direction" },
                  { label: "Need more analysis", description: "Keep researching before deciding" },
                ],
          custom: true,
        })),
      })

      for (let j = 0; j < ask.length; j++) {
        const item = ask[j]
        const answer = res.answers[j]?.join(", ") || "No answer"
        mem.push(`User decision for ${item.id}: ${answer}`)
        const picked = {
          id: item.id,
          round: i,
          answer,
        }
        row.user_decisions.push(picked)
        log.decisions.push(picked)
      }
    }

    log.final = {
      latest_pm_summary: last?.summary ?? null,
      rounds,
      prd_saved: Boolean(prd),
      notify: notify ?? null,
    }
    await save(ctx, `${dir}/run.json`, JSON.stringify(log, null, 2))
    for (const item of log.rounds) {
      const round = Number(item.round)
      await save(ctx, `${dir}/round-${round}-pm.json`, JSON.stringify(item.pm ?? {}, null, 2))
      await save(ctx, `${dir}/round-${round}-roles.json`, JSON.stringify(item.roles ?? {}, null, 2))
      await save(ctx, `${dir}/round-${round}-judge.json`, JSON.stringify(item.judge ?? {}, null, 2))
      await save(ctx, `${dir}/round-${round}-decisions.json`, JSON.stringify(item.user_decisions ?? [], null, 2))
    }
    if (prd) await save(ctx, `${dir}/final-prd.md`, prd)

    return {
      title: "Plan PRD loop",
      output: [
        `Goal: ${input.goal}`,
        `PRD file: ${file}`,
        `Log dir: ${dir}`,
        note ? `Notification: ${note}` : undefined,
        last ? `Latest PM summary: ${last.summary}` : undefined,
        prd ? `Saved: ${file}` : undefined,
        prd ? ["Final PRD draft:", prd].join("\n\n") : undefined,
        mem.length > 0 ? ["Resolved context:", mem.join("\n")].join("\n\n") : undefined,
      ]
        .filter(Boolean)
        .join("\n\n"),
      metadata: {
        file,
        log_dir: dir,
        rounds,
        notify: notify ?? null,
      },
    }
  },
})

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
  return out || `goal-${Date.now()}`
}

function time() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function uniq(items: z.infer<typeof issue>[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = item.id || item.question
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function strip(input: string) {
  return input.replace(/^---\n[\s\S]*?\n---\n?/, "").trim()
}

async function loadRoles() {
  const rows = await Promise.all(
    roles.map(async (item) => {
      const file = Bun.file(new URL(`../roles/${item.id}.md`, import.meta.url))
      if (!(await file.exists())) throw new Error(`Missing role file for ${item.name}`)
      return [item.id, strip(await file.text())] as const
    }),
  )
  return Object.fromEntries(rows) as Record<(typeof roles)[number]["id"], string>
}

async function save(
  ctx: {
    write(input: { file: string; content: string }): Promise<void>
  },
  file: string,
  body: string,
) {
  await ctx.write({ file, content: body })
  return "saved"
}

function files(items: typeof opencode.args._output.files) {
  if (items.length === 0) return "No attached files."
  return [
    "Attached files:",
    ...items.map((item, idx) => `- [${idx + 1}] ${item.filename ?? item.url} (${item.mime})`),
  ].join("\n")
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

async function json<T extends z.ZodTypeAny>(
  ctx: {
    task(input: {
      description: string
      prompt: string
      subagent: string
      category?: string
      load_skills?: string[]
    }): Promise<{ text: string }>
  },
  input: {
    description: string
    prompt: string
    subagent: string
    category?: string
    load_skills?: string[]
  },
  schema: T,
  label: string,
  kind: "pm" | "role" | "judge",
  log: Record<string, unknown>,
) {
  let text = ""
  let err = ""
  const tries: Array<Record<string, unknown>> = []
  log.kind = kind
  log.label = label
  log.attempts = tries

  for (let i = 1; i <= 3; i++) {
    const prompt =
      i === 1
        ? input.prompt
        : [
            input.prompt,
            "",
            `Previous output could not be parsed for ${label}.`,
            `Parse error: ${err}`,
            "Return strict JSON only.",
            "Do not wrap the answer in commentary.",
            "Previous output:",
            text,
          ].join("\n")
    text = (await ctx.task({ ...input, prompt })).text
    const row: Record<string, unknown> = { attempt: i, raw: text }
    tries.push(row)
    try {
      const raw = parse(text)
      row.parsed = raw
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        err = `Schema validation failed:\n${zerr(parsed.error)}`
        row.error = err
        continue
      }
      const hard = check(kind, parsed.data)
      if (hard.length > 0) {
        err = `Hardcoded contract check failed:\n- ${hard.join("\n- ")}`
        row.error = err
        continue
      }
      log.result = parsed.data
      return parsed.data as z.infer<T>
    } catch (cause) {
      err = cause instanceof Error ? cause.message : String(cause)
      row.error = err
    }
  }

  log.error = err
  throw new Error(`${label} did not return valid JSON after 3 attempts: ${err}`)
}

function zerr(err: z.ZodError) {
  return err.issues.map((item) => `${item.path.join(".") || "root"}: ${item.message}`).join("\n")
}

function nonempty(val: string) {
  return val.trim().length > 0
}

function check(kind: "pm" | "role" | "judge", input: unknown) {
  if (kind === "pm") return checkPm(input)
  if (kind === "role") return checkRole(input)
  return checkJudge(input)
}

function checkPm(input: unknown) {
  const out: string[] = []
  const val = input as z.infer<typeof pmres>
  if (!nonempty(val.summary)) out.push("summary must be a non-empty string")
  if (!nonempty(val.prd_markdown)) out.push("prd_markdown must be a non-empty markdown string")
  const seen = new Set<string>()
  for (let i = 0; i < val.issues.length; i++) {
    const item = val.issues[i]
    if (!nonempty(item.id)) out.push(`issues[${i}].id must be non-empty`)
    if (!nonempty(item.question)) out.push(`issues[${i}].question must be non-empty`)
    if (!nonempty(item.why)) out.push(`issues[${i}].why must be non-empty`)
    if (seen.has(item.id)) out.push(`issues[${i}].id must be unique`)
    seen.add(item.id)
    if (item.options && item.options.some((x) => !nonempty(x)))
      out.push(`issues[${i}].options must not contain empty strings`)
  }
  return out
}

function checkRole(input: unknown) {
  const out: string[] = []
  const val = input as z.infer<typeof roleres>
  if (!nonempty(val.role)) out.push("role must be a non-empty string")
  for (let i = 0; i < val.answers.length; i++) {
    const item = val.answers[i]
    if (!nonempty(item.id)) out.push(`answers[${i}].id must be non-empty`)
    if (!nonempty(item.stance)) out.push(`answers[${i}].stance must be non-empty`)
    if (!nonempty(item.why)) out.push(`answers[${i}].why must be non-empty`)
  }
  return out
}

function checkJudge(input: unknown) {
  const out: string[] = []
  const val = input as z.infer<typeof judge>
  if (!nonempty(val.summary)) out.push("summary must be a non-empty string")
  for (let i = 0; i < val.decisions.length; i++) {
    const item = val.decisions[i]
    if (!nonempty(item.id)) out.push(`decisions[${i}].id must be non-empty`)
    if (!nonempty(item.summary)) out.push(`decisions[${i}].summary must be non-empty`)
    if (!nonempty(item.recommended)) out.push(`decisions[${i}].recommended must be non-empty`)
    if (item.options && item.options.length === 0) out.push(`decisions[${i}].options must not be empty when present`)
    if (item.options) {
      for (let j = 0; j < item.options.length; j++) {
        if (!nonempty(item.options[j].label)) out.push(`decisions[${i}].options[${j}].label must be non-empty`)
        if (!nonempty(item.options[j].description))
          out.push(`decisions[${i}].options[${j}].description must be non-empty`)
      }
    }
  }
  return out
}

function pmPrompt(input: {
  round: number
  goal: string
  file: string
  prd: string
  refs: string
  mem: string[]
  role: string
  min: number
  max: number
}) {
  return [
    input.role,
    "",
    "You are the PM role inside the plan workflow.",
    "Follow the injected prd skill as your method for structuring and updating the PRD.",
    `Write or update the PRD at \`${input.file}\`.`,
    "Do not ask the user directly. Instead, return machine-readable JSON.",
    "",
    `Goal:\n${input.goal}`,
    "",
    input.refs,
    "",
    input.prd ? `Current PRD draft:\n\n${input.prd}` : "Current PRD draft: none yet.",
    "",
    input.mem.length > 0 ? `Resolved context so far:\n${input.mem.join("\n")}` : "Resolved context so far: none.",
    "",
    `This workflow runs ${input.min}-${input.max} rounds. On early rounds, prefer exposing questions rather than pretending certainty.`,
    "Only include net-new unresolved issues that still need cross-role review or user confirmation.",
    "Return JSON with this exact shape:",
    '{"summary":"...","prd_markdown":"# PRD ...","issues":[{"id":"Q1","kind":"confirm","question":"...","why":"...","options":["..."]}],"done":false}',
  ].join("\n")
}

function rolePrompt(input: {
  role: string
  sys: string
  goal: string
  file: string
  prd: string
  items: z.infer<typeof issue>[]
  refs: string
}) {
  return [
    input.sys,
    "",
    `You are the ${input.role} role inside the plan workflow.`,
    `Review the current PRD draft at \`${input.file}\` and answer only the listed PM issues.`,
    "Return strict JSON and do not add markdown prose outside the JSON.",
    "",
    `Goal:\n${input.goal}`,
    "",
    input.refs,
    "",
    `Current PRD draft:\n\n${input.prd}`,
    "",
    `PM issues:\n${JSON.stringify(input.items, null, 2)}`,
    "",
    'Return JSON with this exact shape: {"role":"' +
      input.role +
      '","answers":[{"id":"Q1","stance":"...","why":"...","confidence":"high"}],"overall":"..."}',
  ].join("\n")
}

function judgePrompt(input: {
  goal: string
  items: z.infer<typeof issue>[]
  ans: { role: string; data: z.infer<typeof roleres> }[]
}) {
  return [
    "You are the alignment judge for the plan workflow.",
    "Compare the non-PM role answers issue by issue.",
    "Treat answers as similar when they recommend materially the same direction even if wording differs.",
    "If answers diverge, synthesize 2-4 user-facing options and a recommended choice.",
    "Return strict JSON only.",
    "",
    `Goal:\n${input.goal}`,
    "",
    `Issues:\n${JSON.stringify(input.items, null, 2)}`,
    "",
    `Role answers:\n${JSON.stringify(input.ans, null, 2)}`,
    "",
    'Return JSON with this exact shape: {"similar":false,"summary":"...","decisions":[{"id":"Q1","similar":false,"summary":"...","recommended":"...","options":[{"label":"...","description":"..."}]}]}',
  ].join("\n")
}

function message(input: {
  goal: string
  file: string
  round: number
  cmp: z.infer<typeof judge>
  ans: { role: string; data: z.infer<typeof roleres> }[]
}) {
  return [
    `Need product decision for plan workflow round ${input.round}.`,
    `Goal: ${input.goal}`,
    `PRD file: ${input.file}`,
    "",
    input.cmp.summary,
    "",
    "Role summaries:",
    ...input.ans.map((item) => `- ${item.role}: ${item.data.overall ?? "see structured answers"}`),
  ].join("\n")
}

async function send(
  ctx: {
    task(input: {
      description: string
      prompt: string
      subagent: string
      category?: string
      load_skills?: string[]
    }): Promise<{ text: string }>
  },
  target: string,
  body: string,
) {
  return (
    await ctx.task({
      description: "Send Lark decision note",
      prompt: [
        "Use the injected Lark skills to send the following message.",
        "If needed, load shared auth guidance first and then use the IM shortcut for sending a text message.",
        `Recipient: ${target}`,
        "",
        body,
        "",
        "Return a one-line confirmation or the exact failure reason.",
      ].join("\n"),
      subagent: "general",
      category: "quick",
      load_skills: ["lark-shared", "lark-im"],
    })
  ).text
}
