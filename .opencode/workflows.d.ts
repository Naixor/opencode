import {
  Args,
  File,
  define,
  result,
  type Session,
  type SessionDiff,
  type SessionMessage,
  type TaskInput,
  type WorkflowContext,
  type WorkflowDefinition,
} from "@lark-opencode/workflow-api"

declare global {
  const Bun: {
    file(path: string | URL): {
      text(): Promise<string>
      exists(): Promise<boolean>
    }
    write(path: string | URL, data: string): Promise<number>
  }

  const opencode: {
    workflow: typeof define
    args: typeof Args
    file: typeof File
    result: typeof result
  }
}

export { Args, File, define, result }
export type { Session, SessionDiff, SessionMessage, TaskInput, WorkflowContext, WorkflowDefinition }
