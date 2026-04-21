import z from "zod"

/**
 * Public workflow file attachment schema.
 *
 * This mirrors the file objects exposed to workflow `run(ctx, input)` handlers.
 * Use it when validating custom workflow input or documenting workflow contracts.
 */
export const WorkflowFile = z.object({
  type: z.literal("file"),
  mime: z.string(),
  url: z.string(),
  filename: z.string().optional(),
  source: z
    .object({
      type: z.enum(["file", "symbol", "resource"]),
      text: z.object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      }),
      path: z.string().optional(),
      name: z.string().optional(),
      kind: z.number().int().optional(),
      range: z.unknown().optional(),
      clientName: z.string().optional(),
      uri: z.string().optional(),
    })
    .optional(),
})

/**
 * Default input passed to a workflow when no custom schema is supplied.
 *
 * - `raw`: raw argument string after the workflow name
 * - `argv`: shell-like split args
 * - `files`: attached file parts from the invoking message
 */
export const WorkflowArgs = z.object({
  raw: z.string(),
  argv: z.array(z.string()),
  files: z.array(WorkflowFile),
})

/**
 * Standard workflow return payload.
 *
 * Workflows may also return a plain string. Use this object form when you want
 * a stable title or structured metadata in addition to output text.
 */
export const WorkflowResult = z.object({
  title: z.string().optional(),
  output: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type WorkflowFile = z.infer<typeof WorkflowFile>
export type WorkflowArgs = z.infer<typeof WorkflowArgs>
export type WorkflowResult = z.infer<typeof WorkflowResult>

export type WorkflowTaskInput = {
  description: string
  prompt: string
  subagent: string
  category?: string
  model?: `${string}/${string}` | { providerID: string; modelID: string }
  session_id?: string
  load_skills?: string[]
}

export type WorkflowTaskResult = {
  session_id: string
  text: string
}

export type WorkflowInvokeInput = {
  name: string
  raw?: string
  argv?: string[]
  files?: WorkflowFile[]
}

export type WorkflowInvokeResult = {
  name: string
  title?: string
  output?: string
  metadata?: Record<string, unknown>
}

export type WorkflowContext<Input = WorkflowArgs> = {
  name: string
  directory: string
  worktree: string
  sessionID: string
  userMessageID: string
  assistantMessageID: string
  raw: string
  argv: string[]
  files: WorkflowFile[]
  status(input: { title?: string; metadata?: Record<string, unknown> }): Promise<void>
  write(input: { file: string; content: string }): Promise<void>
  ask(input: {
    questions: Array<{
      question: string
      header: string
      options: Array<{
        label: string
        description: string
      }>
      multiple?: boolean
      custom?: boolean
    }>
  }): Promise<{
    answers: string[][]
    images?: Array<{
      mime: string
      url: string
      filename?: string
    }>
  }>
  task(input: WorkflowTaskInput): Promise<WorkflowTaskResult>
  workflow(input: WorkflowInvokeInput): Promise<WorkflowInvokeResult>
}

export type WorkflowDefinition<Input = WorkflowArgs> = {
  description?: string
  input?: z.ZodType<Input>
  run(ctx: WorkflowContext<Input>, input: Input): Promise<string | WorkflowResult> | string | WorkflowResult
}

export type Context<Input = WorkflowArgs> = WorkflowContext<Input>
export type Definition<Input = WorkflowArgs> = WorkflowDefinition<Input>

export function define<Input = WorkflowArgs>(input: WorkflowDefinition<Input>) {
  return input
}

export function result(input: WorkflowResult) {
  return input
}

export const File = WorkflowFile
export const Args = WorkflowArgs
export const Result = WorkflowResult

export type File = WorkflowFile
export type Args = WorkflowArgs
export type Result = WorkflowResult
export type TaskInput = WorkflowTaskInput
export type TaskResult = WorkflowTaskResult
export type WorkflowInput = WorkflowInvokeInput

export const runtime = {
  workflow: define,
  args: Args,
  file: File,
  result,
}
