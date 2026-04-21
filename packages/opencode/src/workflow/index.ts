import { pathToFileURL } from "url"
import path from "path"
import z from "zod"
import { Agent } from "../agent/agent"
import { Categories } from "../agent/background/categories"
import { Config } from "../config/config"
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { Question } from "../question"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Skill } from "../skill"
import { Glob } from "../util/glob"
import { Log } from "../util/log"
import { Filesystem } from "../util/filesystem"
import {
  Args as PublicArgs,
  File as PublicFile,
  Result as PublicResult,
  define,
  type Args as WorkflowArgs,
  type Context as WorkflowContext,
  type Definition as WorkflowDefinition,
  type File as WorkflowFile,
  type Result as WorkflowResultShape,
  type TaskInput,
  type TaskResult,
  type WorkflowInput,
  type WorkflowResult,
  runtime,
} from "../workflow-api"
import { iife } from "@/util/iife"

export { define }
export { PublicArgs as Args, PublicFile as File, PublicResult as Result }
export type { Context, Definition, TaskInput, TaskResult, WorkflowInput, WorkflowResult } from "../workflow-api"

const log = Log.create({ service: "workflow" })
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const quoteTrimRegex = /^["']|["']$/g
const MAX_DEPTH = 8

const FileSchema = MessageV2.FilePart.omit({
  id: true,
  sessionID: true,
  messageID: true,
})

const ArgsSchema = z.object({
  raw: z.string(),
  argv: z.array(z.string()),
  files: z.array(FileSchema),
})

const ResultSchema = z.object({
  title: z.string().optional(),
  output: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

type RuntimeContext<Input = WorkflowArgs> = WorkflowContext<Input> & {
  workflow_stack(): string[]
}

type Loaded = {
  name: string
  path: string
  description?: string
  input?: z.ZodTypeAny
  run: (ctx: WorkflowContext<any>, input: any) => Promise<string | WorkflowResultShape> | string | WorkflowResultShape
}

type Failed = {
  name: string
  path: string
  error: string
}

type CommandInput = {
  sessionID: string
  messageID?: string
  agent?: string
  model?: string
  arguments: string
  variant?: string
  parts?: Array<z.infer<typeof FileSchema>>
}

Reflect.set(globalThis, "opencode", runtime)

export namespace Workflow {
  const state = Instance.state(async () => {
    const out: Record<string, Loaded> = {}
    const err: Record<string, Failed> = {}
    const dirs = await Config.directories()
    const files = dirs
      .flatMap((dir) =>
        Glob.scanSync("{workflow,workflows}/**/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
      )
      .filter((item) => !item.endsWith(".d.ts"))

    if (files.length > 0) await Config.waitForDependencies()

    for (const item of files) {
      const file =
        rel(item, ["/.opencode/workflow/", "/.opencode/workflows/", "/workflow/", "/workflows/"]) ?? path.basename(item)
      const name = trim(file)
      const mod = await import(pathToFileURL(item).href).catch((cause: unknown) => {
        const error = cause instanceof Error ? cause.message : String(cause)
        err[name] = { name, path: item, error }
        log.error("failed to load workflow", { path: item, err: cause })
        return undefined
      })
      if (!mod) continue
      const def = parse(mod.default ?? mod.workflow ?? mod)
      if (!def) {
        err[name] = {
          name,
          path: item,
          error: "Workflow file must export `opencode.workflow({ run() {} })`",
        }
        log.warn("skipping invalid workflow", { path: item })
        continue
      }

      out[name] = {
        name,
        path: item,
        description: def.description,
        input: def.input,
        run: def.run,
      }
    }

    return {
      out,
      err,
    }
  })

  export async function list() {
    return state().then((x) => Object.values(x.out).toSorted((a, b) => a.name.localeCompare(b.name)))
  }

  export async function get(name: string) {
    return state().then((x) => x.out[name])
  }

  export async function failed(name: string) {
    return state().then((x) => x.err[name])
  }

  export async function run(input: CommandInput) {
    const raw = input.arguments.trim()
    const argv = (raw.match(argsRegex) ?? []).map((item) => item.replace(quoteTrimRegex, ""))
    const name = argv[0]
    const rest = name ? raw.slice(raw.indexOf(name) + name.length).trim() : ""
    const files = input.parts ?? []
    const model = await resolveModel(input)
    const agent = input.agent ?? (await Agent.defaultAgent())
    const { SessionPrompt } = await import("../session/prompt")
    const user = await SessionPrompt.prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      agent,
      model,
      variant: input.variant,
      noReply: true,
      parts: [
        {
          type: "text",
          text: raw ? `/workflow ${raw}` : "/workflow",
        },
        ...files,
      ],
    })
    if (user.info.role !== "user") throw new Error("expected workflow invocation to create a user message")

    const assistant = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      sessionID: input.sessionID,
      parentID: user.info.id,
      role: "assistant",
      mode: user.info.agent,
      agent: user.info.agent,
      modelID: user.info.model.modelID,
      providerID: user.info.model.providerID,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant

    let part = (await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: assistant.id,
      sessionID: assistant.sessionID,
      type: "tool",
      callID: crypto.randomUUID(),
      tool: "workflow",
      state: {
        status: "running",
        input: {
          name: name ?? "",
          raw: rest,
          argv: argv.slice(1),
        },
        time: {
          start: Date.now(),
        },
      },
    })) as MessageV2.ToolPart

    const ctx = init({
      name: name ?? "",
      raw: rest,
      argv: argv.slice(1),
      files,
      sessionID: input.sessionID,
      assistantID: assistant.id,
      userID: user.info.id,
      model: user.info.model,
      stack: [],
      update: async (val) => {
        if (part.state.status !== "running") return
        part = (await Session.updatePart({
          ...part,
          state: {
            status: "running",
            input: part.state.input,
            title: val.title,
            metadata: val.metadata,
            time: part.state.time,
          },
        })) as MessageV2.ToolPart
      },
    })

    const res = await Promise.resolve(
      !name ? help() : execute(ctx, { name, raw: rest, argv: argv.slice(1), files }),
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        title: "Workflow failed",
        output: `Workflow failed: ${msg}`,
        metadata: { error: msg },
      } satisfies WorkflowResultShape
    })

    const end = Date.now()
    const fail = res.metadata?.error
    const start = part.state.status === "running" ? part.state.time.start : Date.now()
    part = (await Session.updatePart({
      ...part,
      state: fail
        ? {
            status: "error",
            input: part.state.input,
            error: String(fail),
            metadata: res.metadata,
            time: {
              start,
              end,
            },
          }
        : {
            status: "completed",
            input: part.state.input,
            title: res.title ?? name ?? "workflow",
            metadata: res.metadata ?? {},
            output: res.output ?? "",
            time: {
              start,
              end,
            },
          },
    })) as MessageV2.ToolPart

    if (res.output) {
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: assistant.id,
        sessionID: assistant.sessionID,
        type: "text",
        text: res.output,
        metadata: res.metadata,
      })
    }

    assistant.finish = "stop"
    assistant.time.completed = end
    await Session.updateMessage(assistant)
    return MessageV2.get({ sessionID: input.sessionID, messageID: assistant.id })
  }
}

function parse(input: unknown): WorkflowDefinition<any> | undefined {
  if (!input || typeof input !== "object") return
  if (!("run" in input) || typeof input.run !== "function") return
  const def = input as {
    description?: unknown
    input?: z.ZodTypeAny
    run: (ctx: WorkflowContext<any>, input: any) => Promise<string | WorkflowResultShape> | string | WorkflowResultShape
  }
  return {
    description: typeof def.description === "string" ? def.description : undefined,
    ...(def.input ? { input: def.input } : {}),
    run: def.run,
  }
}

function trim(file: string) {
  const ext = path.extname(file)
  return ext.length ? file.slice(0, -ext.length) : file
}

function rel(file: string, patterns: string[]) {
  const norm = file.replace(/\\/g, "/")
  for (const item of patterns) {
    const idx = norm.indexOf(item)
    if (idx === -1) continue
    return norm.slice(idx + item.length)
  }
}

function help(): WorkflowResultShape {
  return {
    title: "Workflow help",
    output:
      "Run `/workflow <name> [args]` to execute a local workflow from `.opencode/workflows/*.ts`. Use the file path without the extension as the workflow name.",
  }
}

async function execute(
  ctx: RuntimeContext<any>,
  input: { name: string; raw: string; argv: string[]; files: WorkflowFile[] },
): Promise<WorkflowResultShape> {
  if (!input.name) return help()
  const stack = ctx.workflow_stack()
  if (stack.includes(input.name)) {
    throw new Error(`Workflow cycle detected: ${[...stack, input.name].join(" -> ")}`)
  }
  if (stack.length >= MAX_DEPTH) {
    throw new Error(`Workflow nesting too deep: max depth is ${MAX_DEPTH}`)
  }
  const wf = await Workflow.get(input.name)
  if (!wf) {
    const bad = await Workflow.failed(input.name)
    if (bad) {
      return {
        title: "Workflow failed to load",
        output: `Workflow \`${input.name}\` failed to load: ${bad.error}`,
        metadata: { error: bad.error, path: bad.path },
      }
    }
    const names = await Workflow.list().then((items) => items.map((item) => item.name))
    return {
      title: "Unknown workflow",
      output:
        names.length > 0
          ? `Workflow \`${input.name}\` was not found. Available workflows: ${names.join(", ")}`
          : `Workflow \`${input.name}\` was not found. Create one in .opencode/workflows/<name>.ts.`,
    }
  }
  const next = init({
    name: input.name,
    raw: input.raw,
    argv: input.argv,
    files: input.files,
    sessionID: ctx.sessionID,
    userID: ctx.userMessageID,
    assistantID: ctx.assistantMessageID,
    model: { providerID: "", modelID: "" },
    stack: [...stack, input.name],
    update: ctx.status,
  })
  const val = wf.input ? await wf.input.parseAsync(input) : ArgsSchema.parse(input)
  const out = await wf.run(next, val)
  return typeof out === "string" ? { output: out } : ResultSchema.parse(out)
}

function init(input: {
  name: string
  raw: string
  argv: string[]
  files: WorkflowFile[]
  sessionID: string
  userID: string
  assistantID: string
  model: { providerID: string; modelID: string }
  stack: string[]
  update(input: { title?: string; metadata?: Record<string, unknown> }): Promise<void>
}): RuntimeContext {
  const ctx: RuntimeContext = {
    name: input.name,
    raw: input.raw,
    argv: input.argv,
    files: input.files,
    sessionID: input.sessionID,
    userMessageID: input.userID,
    assistantMessageID: input.assistantID,
    directory: Instance.directory,
    worktree: Instance.worktree,
    status(val: { title?: string; metadata?: Record<string, unknown> }) {
      return input.update(val)
    },
    write(val: { file: string; content: string }) {
      const file = path.isAbsolute(val.file) ? val.file : path.join(Instance.worktree, val.file)
      return Filesystem.write(file, val.content)
    },
    ask(val: { questions: Question.Info[] }) {
      return Question.ask({
        sessionID: input.sessionID,
        questions: val.questions,
      })
    },
    task(val: TaskInput) {
      return task(val, input)
    },
    workflow(val: WorkflowInput) {
      const raw = val.raw?.trim() ?? (val.argv ?? []).join(" ")
      const argv =
        val.argv ?? ((raw.match(argsRegex) ?? []).map((item: string) => item.replace(quoteTrimRegex, "")) as string[])
      return execute(ctx, {
        name: val.name,
        raw,
        argv,
        files: val.files ?? [],
      }).then((out: WorkflowResultShape) => ({
        name: val.name,
        title: out.title,
        output: out.output,
        metadata: out.metadata,
      }))
    },
    workflow_stack() {
      return input.stack
    },
  }
  return ctx
}

async function task(input: TaskInput, parent: { sessionID: string; model: { providerID: string; modelID: string } }) {
  const agent = await Agent.get(input.subagent)
  if (!agent) throw new Error(`Unknown subagent: ${input.subagent}`)
  const hasTask = agent.permission.some((item) => item.permission === "task")
  const cfg = await Config.get()
  const ses = await iife(async () => {
    if (!input.session_id) {
      return Session.create({
        parentID: parent.sessionID,
        title: input.description + ` (@${agent.name} workflow)`,
        permission: [
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "todoread",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "delegate_task",
            pattern: "*",
            action: "deny",
          },
          ...(hasTask
            ? []
            : [
                {
                  permission: "task" as const,
                  pattern: "*" as const,
                  action: "deny" as const,
                },
              ]),
          ...(cfg.experimental?.primary_tools?.map((item) => ({
            permission: item,
            pattern: "*",
            action: "allow" as const,
          })) ?? []),
        ],
      })
    }
    return Session.get(input.session_id).catch(() => {
      throw new Error(`Unknown session: ${input.session_id}`)
    })
  })
  const model = await taskModel(input, agent, parent.model)
  const { SessionPrompt } = await import("../session/prompt")
  const text = input.load_skills?.length ? input.prompt + (await skills(input.load_skills)) : input.prompt
  const parts = await SessionPrompt.resolvePromptParts(text)
  const msg = await SessionPrompt.prompt({
    sessionID: ses.id,
    messageID: Identifier.ascending("message"),
    agent: agent.name,
    model,
    tools: {
      todowrite: false,
      todoread: false,
      delegate_task: false,
      ...(hasTask ? {} : { task: false }),
      ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
    },
    parts,
  })
  return {
    session_id: ses.id,
    text: msg.parts.findLast((item: MessageV2.Part) => item.type === "text")?.text ?? "",
  } satisfies TaskResult
}

async function taskModel(input: TaskInput, agent: Agent.Info, parent: { providerID: string; modelID: string }) {
  if (typeof input.model === "string") return Provider.parseModel(input.model)
  if (input.model) return input.model
  const cat = await iife(async () => {
    if (!input.category) return
    const all = await Categories.resolve()
    const item = Categories.lookup(input.category, all)
    if (!item?.model) return
    const [providerID, ...rest] = item.model.split("/")
    const modelID = rest.join("/")
    if (!providerID || !modelID) return
    return { providerID, modelID }
  })
  return cat ?? agent.model ?? parent
}

async function skills(names: string[]) {
  const out: string[] = []
  for (const name of names) {
    const skill = await Skill.get(name)
    if (!skill) continue
    out.push(`\n\n<skill_content name="${skill.name}">\n${skill.content.trim()}\n</skill_content>`)
  }
  return out.join("")
}

async function resolveModel(input: CommandInput) {
  if (input.model) return Provider.parseModel(input.model)
  for await (const item of MessageV2.stream({ sessionID: input.sessionID })) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return Provider.defaultModel()
}
