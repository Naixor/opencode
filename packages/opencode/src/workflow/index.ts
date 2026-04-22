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
import { ConfigPaths } from "../config/paths"
import {
  Args as PublicArgs,
  File as PublicFile,
  parseWorkflowProgress,
  mergeWorkflowProgress,
  Result as PublicResult,
  WorkflowProgressKey,
  WorkflowProgressV1VersionValue,
  WorkflowProgressV2VersionValue,
  define,
  normalizeWorkflowMetadata,
  normalizeWorkflowProgressInput,
  validateWorkflowMetadata,
  type Args as WorkflowArgs,
  type Context as WorkflowContext,
  type Definition as WorkflowDefinition,
  type File as WorkflowFile,
  type WorkflowProgress,
  type Result as WorkflowResultShape,
  type WorkflowStatusUpdate,
  type WorkflowStatusUpdateInput,
  type TaskInput,
  type TaskResult,
  type WorkflowInput,
  type WorkflowResult,
  runtime,
} from "@lark-opencode/workflow-api"
import { iife } from "@/util/iife"

export { define }
export { PublicArgs as Args, PublicFile as File, PublicResult as Result }
export type {
  Context,
  Definition,
  TaskInput,
  TaskResult,
  WorkflowInput,
  WorkflowProgress,
  WorkflowResult,
  WorkflowStatusUpdateInput,
  WorkflowStatusUpdate,
} from "@lark-opencode/workflow-api"

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

const StatusSchema = z
  .object({
    title: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    progress: z.unknown().optional(),
  })
  .strict()

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
  command: string
  sessionID: string
  messageID?: string
  agent?: string
  model?: string
  arguments: string
  variant?: string
  parts?: Array<z.infer<typeof FileSchema>>
}

Reflect.set(globalThis, "opencode", runtime)

const api = "@lark-opencode/workflow-api"
const ver = "latest"
const docs = [
  "# Workflow authoring",
  "",
  "Run `/workflow:init` to scaffold workflow files for this project.",
  "",
  "## What it adds",
  "",
  "- `.lark-opencode/workflows.d.ts` for local workflow typing",
  "- `docs/workflow-authoring.md` with the local authoring guide",
  "- `.lark-opencode/workflows/example.ts` as a minimal starting point",
  `- \`${api}\` in \`package.json\``,
  "",
  "## Minimal workflow",
  "",
  "Local workflow files can use the injected `opencode.workflow(...)` helper directly.",
  "",
  "```ts",
  "export default opencode.workflow({",
  '  description: "Echo workflow args",',
  "  run(ctx, input) {",
  '    return { title: "Args", output: `raw=${input.raw}` }',
  "  },",
  "})",
  "```",
  "",
  "## Default input",
  "",
  "Workflows receive `{ raw, argv, files }` unless they define a custom Zod schema.",
  "",
  "- `raw`: raw argument string after the workflow name",
  "- `argv`: parsed argument list",
  "- `files`: attached file parts from the invoking message",
  "",
  "## Return values",
  "",
  "A workflow can return either:",
  "",
  "- a string",
  "- or `{ title?, output?, metadata? }`",
  "",
  "## Context helpers",
  "",
  "Inside `run(ctx, input)`, these helpers are available:",
  "",
  "- `ctx.status({ title?, metadata?, progress? })` for progress updates",
  "- `ctx.ask({ questions })` for explicit user choices",
  "- `ctx.task({ ... })` for focused subagent work",
  "- `ctx.workflow({ ... })` for nested workflow reuse",
  "",
  "## Next steps",
  "",
  "1. Run your package manager install command so the new dependency is available.",
  "2. Edit `.lark-opencode/workflows/example.ts` or add more workflows under `.lark-opencode/workflows/`.",
  "3. Run `/workflow example hello` to verify the setup.",
  "",
].join("\n")
const decl = [
  `import { Args, File, WorkflowProgressKey, define, result, type TaskInput, type WorkflowContext, type WorkflowDefinition, type WorkflowProgress, type WorkflowStatusUpdate, type WorkflowStatusUpdateInput } from \"${api}\"`,
  "",
  "declare global {",
  "  const Bun: {",
  "    file(path: string | URL): {",
  "      text(): Promise<string>",
  "      exists(): Promise<boolean>",
  "    }",
  "    write(path: string | URL, data: string): Promise<number>",
  "  }",
  "",
  "  const opencode: {",
  "    workflow: typeof define",
  "    args: typeof Args",
  "    file: typeof File",
  "    result: typeof result",
  "  }",
  "}",
  "",
  "export { Args, File, WorkflowProgressKey, define, result }",
  "export type { TaskInput, WorkflowContext, WorkflowDefinition, WorkflowProgress, WorkflowStatusUpdate, WorkflowStatusUpdateInput }",
  "",
].join("\n")
const example = [
  "export default opencode.workflow({",
  '  description: "Summarize workflow args",',
  "  run(ctx, input) {",
  '    const argv = input.argv.length > 0 ? input.argv.join(", ") : "(none)"',
  "    return {",
  '      title: "Example workflow",',
  '      output: [`name=${ctx.name}`, `raw=${input.raw || \"(empty)\"}`, `argv=${argv}`].join("\\n"),',
  "      metadata: { files: input.files.length },",
  "    }",
  "  },",
  "})",
  "",
].join("\n")

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
        rel(item, [
          "/.lark-opencode/workflow/",
          "/.lark-opencode/workflows/",
          "/.opencode/workflow/",
          "/.opencode/workflows/",
          "/workflow/",
          "/workflows/",
        ]) ?? path.basename(item)
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

  export async function init(input: CommandInput) {
    const run = await begin(input, {
      tool: "workflow:init",
      input: {},
      parts: input.parts ?? [],
    })
    const res = await scaffold().catch((err: unknown) => ({
      title: "Workflow init failed",
      output: `Workflow init failed: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { error: err instanceof Error ? err.message : String(err) },
    }))
    await finish(run, res)
    return MessageV2.get({ sessionID: input.sessionID, messageID: run.assistant.id })
  }

  export async function run(input: CommandInput) {
    const raw = input.arguments.trim()
    const argv = (raw.match(argsRegex) ?? []).map((item) => item.replace(quoteTrimRegex, ""))
    const name = argv[0]
    const rest = name ? raw.slice(raw.indexOf(name) + name.length).trim() : ""
    const files = input.parts ?? []
    const run = await begin(input, {
      tool: "workflow",
      input: {
        name: name ?? "",
        raw: rest,
        argv: argv.slice(1),
      },
      parts: files,
    })

    const ctx = context({
      name: name ?? "",
      raw: rest,
      argv: argv.slice(1),
      files,
      sessionID: input.sessionID,
      assistantID: run.assistant.id,
      userID: run.user.info.id,
      model: run.user.info.model,
      stack: [],
      update: async (val: WorkflowStatusUpdateInput) => {
        if (run.part.state.status !== "running") return
        run.part = (await Session.updatePart({
          ...run.part,
          state: {
            status: "running",
            input: run.part.state.input,
            title: val.title,
            metadata: mergemeta(run.part.state.metadata, statusmeta(val)),
            time: run.part.state.time,
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

    await finish(run, res)
    return MessageV2.get({ sessionID: input.sessionID, messageID: run.assistant.id })
  }
}

async function scaffold() {
  const made: string[] = []
  const kept: string[] = []
  const deps = await pkg()
  const dir = ConfigPaths.resolveDirectory(Instance.worktree)
  const files = [
    [path.relative(Instance.worktree, path.join(dir, "workflows.d.ts")), decl],
    ["docs/workflow-authoring.md", docs],
    [path.relative(Instance.worktree, path.join(dir, "workflows", "example.ts")), example],
  ] as const

  for (const [file, body] of files) {
    const ok = await ensure(path.join(Instance.worktree, file), body)
    ;(ok ? made : kept).push(file)
  }

  const out = [
    "Workflow init complete.",
    "",
    made.length > 0 ? ["Created:", ...made.map((item) => `- ${item}`)].join("\n") : undefined,
    kept.length > 0 ? ["Kept:", ...kept.map((item) => `- ${item}`)].join("\n") : undefined,
    ["Updated:", `- package.json (${deps})`].join("\n"),
    "",
    "Next:",
    "1. Run your package manager install command.",
    `2. Edit \`${path.relative(Instance.worktree, path.join(dir, "workflows", "example.ts"))}\`.`,
    "3. Run `/workflow example hello`.",
  ]
    .filter(Boolean)
    .join("\n")

  return {
    title: "Workflow init",
    output: out,
    metadata: {
      created: made,
      kept,
      package_json: deps,
    },
  } satisfies WorkflowResultShape
}

async function ensure(file: string, body: string) {
  if (await Filesystem.exists(file)) return false
  await Filesystem.write(file, body)
  return true
}

async function pkg() {
  const file = path.join(Instance.worktree, "package.json")
  const data = (await Filesystem.exists(file))
    ? JSON.parse(await Filesystem.readText(file))
    : {
        private: true,
      }
  const deps = record(data.dependencies)
  const cur = typeof deps[api] === "string" ? deps[api] : undefined
  deps[api] = cur ?? ver
  data.dependencies = deps
  await Filesystem.write(file, JSON.stringify(data, null, 2) + "\n")
  return cur ? `dependency already set to ${cur}` : `added ${api}@${deps[api]}`
}

function record(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {}
}

async function begin(
  input: CommandInput,
  tool: {
    tool: string
    input: Record<string, unknown>
    parts: Array<z.infer<typeof FileSchema>>
  },
) {
  const model = await resolveModel(input)
  const agent = input.agent ?? (await Agent.defaultAgent())
  const { SessionPrompt } = await import("../session/prompt")
  const text = input.arguments.trim() ? `/${input.command} ${input.arguments.trim()}` : `/${input.command}`
  const user = await SessionPrompt.prompt({
    sessionID: input.sessionID,
    messageID: input.messageID,
    agent,
    model,
    variant: input.variant,
    noReply: true,
    parts: [{ type: "text", text }, ...tool.parts],
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

  const part = (await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistant.id,
    sessionID: assistant.sessionID,
    type: "tool",
    callID: crypto.randomUUID(),
    tool: tool.tool,
    state: {
      status: "running",
      input: tool.input,
      time: {
        start: Date.now(),
      },
    },
  })) as MessageV2.ToolPart

  return {
    user,
    assistant,
    part,
  }
}

async function finish(
  run: {
    assistant: MessageV2.Assistant
    part: MessageV2.ToolPart
  },
  res: WorkflowResultShape,
) {
  const end = Date.now()
  const raw = run.part.state.status === "running" ? mergemeta(run.part.state.metadata, res.metadata) : res.metadata
  const fail = raw && "error" in raw ? raw.error : undefined
  const meta = finalmeta(run.part, raw, fail ? "error" : "completed", new Date(end).toISOString())
  const start = run.part.state.status === "running" ? run.part.state.time.start : Date.now()
  run.part = (await Session.updatePart({
    ...run.part,
    state: fail
      ? {
          status: "error",
          input: run.part.state.input,
          error: String(fail),
          metadata: meta,
          time: {
            start,
            end,
          },
        }
      : {
          status: "completed",
          input: run.part.state.input,
          title: res.title ?? run.part.tool,
          metadata: meta ?? {},
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
      messageID: run.assistant.id,
      sessionID: run.assistant.sessionID,
      type: "text",
      text: res.output,
      metadata: res.metadata,
    })
  }

  run.assistant.finish = "stop"
  run.assistant.time.completed = end
  await Session.updateMessage(run.assistant)
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
      "Run `/workflow <name> [args]` to execute a local workflow from `.lark-opencode/workflows/*.ts` or `.opencode/workflows/*.ts`. Use the file path without the extension as the workflow name.",
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
          : `Workflow \`${input.name}\` was not found. Create one in .lark-opencode/workflows/<name>.ts or .opencode/workflows/<name>.ts.`,
    }
  }
  const next = context({
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
  const res = typeof out === "string" ? { output: out } : ResultSchema.parse(out)
  return {
    ...res,
    metadata: workflowmeta(res.metadata),
  }
}

function context(input: {
  name: string
  raw: string
  argv: string[]
  files: WorkflowFile[]
  sessionID: string
  userID: string
  assistantID: string
  model: { providerID: string; modelID: string }
  stack: string[]
  update(input: WorkflowStatusUpdate): Promise<void>
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
    status(val: WorkflowStatusUpdateInput) {
      return input.update(parseStatusUpdate(val))
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

function statusmeta(input: z.infer<typeof StatusSchema> | WorkflowStatusUpdate) {
  const meta = workflowmeta(input.metadata)
  if (!input.progress) return meta
  const progress = normalizeWorkflowProgressInput(input.progress)
  return {
    ...meta,
    ...(progress ? { [WorkflowProgressKey]: progress } : {}),
  } satisfies Record<string, unknown>
}

function parseStatusUpdate(input: WorkflowStatusUpdateInput): WorkflowStatusUpdate {
  const out = StatusSchema.parse(input)
  const version = progressversion(out.progress)
  const meta = statusmeta(out)
  if (out.progress === undefined) {
    return {
      ...(out.title ? { title: out.title } : {}),
      ...(meta ? { metadata: meta } : {}),
    }
  }
  if (version && version !== WorkflowProgressV1VersionValue && version !== WorkflowProgressV2VersionValue) {
    return {
      ...(out.title ? { title: out.title } : {}),
      ...(meta ? { metadata: meta } : {}),
    }
  }
  const progress = normalizeWorkflowProgressInput(out.progress)
  if (!progress) {
    throw new Error(progresserror(out.progress) ?? "Invalid workflow progress metadata")
  }
  return {
    ...(out.title ? { title: out.title } : {}),
    ...(meta ? { metadata: meta } : {}),
    progress,
  }
}

function progressversion(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const item = input as Record<string, unknown>
  return typeof item.version === "string" ? item.version : undefined
}

function workflowmeta(input?: Record<string, unknown>) {
  if (!input) return input
  if (!(WorkflowProgressKey in input)) return { ...input }
  const version = progressversion(input[WorkflowProgressKey])
  if (version && version !== WorkflowProgressV1VersionValue && version !== WorkflowProgressV2VersionValue) {
    return normalizeWorkflowMetadata(input)
  }
  try {
    return validateWorkflowMetadata(input)
  } catch (err) {
    const meta = normalizeWorkflowMetadata(input)
    if (meta?.[WorkflowProgressKey] !== undefined) return meta
    throw new Error(progresserror(input[WorkflowProgressKey]) ?? (err instanceof Error ? err.message : String(err)))
  }
}

function progresserror(input: unknown) {
  try {
    validateWorkflowMetadata({ [WorkflowProgressKey]: input })
    return
  } catch (err) {
    if (err instanceof Error && err.message) return err.message
  }
}

function mergemeta(...items: Array<Record<string, unknown> | undefined>) {
  return items.reduce<Record<string, unknown> | undefined>((acc, item) => {
    if (!item) return acc
    const next = acc ? { ...acc, ...item } : { ...item }
    const progress = mergeWorkflowProgress(acc?.[WorkflowProgressKey], item[WorkflowProgressKey])
    if (!progress) return next
    return {
      ...next,
      [WorkflowProgressKey]: progress,
    }
  }, undefined)
}

function finalmeta(
  part: MessageV2.ToolPart,
  input: Record<string, unknown> | undefined,
  status: "completed" | "error",
  time: string,
) {
  if (part.tool !== "workflow") return normalizeWorkflowMetadata(input)
  const version = progressversion(input?.[WorkflowProgressKey])
  if (version === WorkflowProgressV1VersionValue) {
    const progress = parseWorkflowProgress(input?.[WorkflowProgressKey])
    if (!progress || progress.version !== WorkflowProgressV1VersionValue) return input
    if (progress.workflow.status === "done" || progress.workflow.status === "failed") return input
    return {
      ...input,
      [WorkflowProgressKey]: {
        ...progress,
        workflow: {
          ...progress.workflow,
          status: status === "error" ? "failed" : "done",
          ...(time ? { ended_at: time } : {}),
        },
      },
    }
  }
  const meta = normalizeWorkflowMetadata(input)
  const progress = parseWorkflowProgress(meta?.[WorkflowProgressKey])
  if (!progress || progress.version !== WorkflowProgressV2VersionValue) return meta
  if (progress.workflow.status === "done" || progress.workflow.status === "failed") return meta
  const run = progress.machine.active_run_id
    ? progress.step_runs.find((item) => item.id === progress.machine.active_run_id)
    : progress.machine.active_step_id
      ? [...progress.step_runs]
          .reverse()
          .find(
            (item) =>
              item.step_id === progress.machine.active_step_id &&
              item.status !== "completed" &&
              item.status !== "failed",
          )
      : undefined
  const next = mergeWorkflowProgress(progress, {
    version: WorkflowProgressV2VersionValue,
    workflow: {
      status: status === "error" ? "failed" : "done",
      ...(progress.workflow.name ? { name: progress.workflow.name } : {}),
      ...(time ? { ended_at: time } : {}),
    },
    machine: {
      ...(progress.machine?.id ? { id: progress.machine.id } : {}),
      ...(progress.machine?.key ? { key: progress.machine.key } : {}),
      ...(time ? { updated_at: time } : {}),
    },
    step_definitions: progress.step_definitions,
    step_runs:
      run && run.status !== "completed" && run.status !== "failed"
        ? [
            {
              ...run,
              status: status === "error" ? "failed" : "completed",
              ...(time ? { ended_at: time } : {}),
            },
          ]
        : [],
    transitions: [],
    participants: progress.participants,
  })
  if (!next) return meta
  if (next.version === WorkflowProgressV2VersionValue && next.machine) {
    delete next.machine.active_step_id
    delete next.machine.active_run_id
  }
  return {
    ...meta,
    [WorkflowProgressKey]: next,
  }
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
