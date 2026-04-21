---
name: workflow-authoring
description: "Author runnable TypeScript workflows for OpenCode. Use when creating reusable executable flows under .opencode/workflows or when asked how to write, structure, debug, or invoke a workflow. Triggers on: write a workflow, create workflow, workflow authoring, /workflow, .opencode/workflows."
user-invocable: true
---

# Workflow Authoring

Write executable TypeScript workflows that OpenCode can load and run through `/workflow`.

Workflows can also call other workflows through `ctx.workflow(...)`.

---

## When To Use This

Use this skill when the user wants a reusable flow with real execution logic instead of a static prompt.

Good fits:

- Repeated multi-step clarifications
- Agent orchestration with stable branching
- Flows that need user questions at controlled points
- Small internal tools that should run inside the current session

Prefer a workflow over markdown commands or pure skills when the behavior needs code, validation, orchestration, or nested reusable steps.

- Use a markdown command for a static prompt template
- Use a skill for reusable instructions or policy
- Use a workflow for executable logic, branching, status updates, questions, subagent delegation, and workflow composition

---

## File Location And Naming

Put workflow files in:

```text
.opencode/workflows/
```

Rules:

- File extension can be `.ts` or `.js`
- The workflow name is the relative file path without the extension
- `.opencode/workflows/clarify.ts` -> `/workflow clarify`
- `.opencode/workflows/release/notes.ts` -> `/workflow release/notes`

Type hints for workflow files are provided by:

```text
.opencode/workflows.d.ts
```

That file should stay thin and forward to the public workflow interface library:

```text
packages/opencode/src/workflow-api.ts
```

Use that module as the public source of truth for workflow types and helpers. `workflows.d.ts` should expose it to local workflow files, but the actual interface should live in the shared library so other users and tools can read it directly.

That means workflow files can use the global `opencode.workflow(...)` helper directly, while external readers can inspect the public interface module.

---

## Recommended Imports

### Local workflow files

Inside `.opencode/workflows/*.ts`, prefer the injected global helper for the workflow wrapper itself:

```ts
export default opencode.workflow({
  run(ctx, input) {
    return input.raw
  },
})
```

If you need Zod, import it normally:

```ts
import z from "zod"
```

### Public interface imports

If you are documenting, generating, analyzing, or reusing the workflow contract outside the local workflow runtime, import from the public interface module:

```ts
import {
  Args,
  File,
  Result,
  define,
  type WorkflowContext,
  type WorkflowDefinition,
} from "../packages/opencode/src/workflow-api"
```

Use the public module when you want a stable source of truth for workflow helpers and types.

---

## Minimal Workflow

Start with the smallest possible shape:

```ts
export default opencode.workflow({
  description: "Summarize workflow args",
  run(ctx, input) {
    return {
      title: "Args",
      output: `name=${ctx.name}\nraw=${input.raw}`,
      metadata: { argv: input.argv.length },
    }
  },
})
```

Return either:

- a string
- or an object with `title`, `output`, and optional `metadata`

---

## Runtime Model

When a user runs:

```text
/workflow <name> [args]
```

OpenCode will:

1. Resolve the workflow by file name
2. Create a normal user message in the current session
3. Run the workflow
4. Save the workflow result back into the session as an assistant response

If one workflow file is broken, OpenCode should not crash. That workflow becomes unavailable and `/workflow <name>` reports its load error.

---

## The `run(ctx, input)` API

Every workflow gets a context object and parsed input.

### `ctx.status(...)`

Use this to expose progress while the workflow is running.

```ts
await ctx.status({
  title: "Comparing options",
  metadata: { step: "analysis" },
})
```

Use it early and before expensive work.

### `ctx.ask(...)`

Use this when the user must choose something.

```ts
const reply = await ctx.ask({
  questions: [
    {
      header: "Mode",
      question: "Which mode should we use?",
      options: [
        { label: "Fast", description: "Quick pass" },
        { label: "Deep", description: "Thorough pass" },
      ],
    },
  ],
})

const picked = reply.answers[0]?.[0] ?? "Fast"
return `Selected: ${picked}`
```

### `ctx.task(...)`

Use this to delegate a focused subtask to another agent.

```ts
const out = await ctx.task({
  description: "PM review",
  prompt: "Analyze these requirements and propose 2-3 options",
  subagent: "metis",
  category: "deep",
})

return out.text
```

Available fields:

- `description`: short task label
- `prompt`: subagent prompt
- `subagent`: agent name
- `category?`: model routing category
- `model?`: explicit model override
- `session_id?`: continue an earlier subagent session
- `load_skills?`: inject one or more skills into the subagent prompt

### `ctx.workflow(...)`

Use this to call another already-defined workflow.

```ts
const out = await ctx.workflow({
  name: "child",
  raw: input.raw,
})

return `child said: ${out.output ?? ""}`
```

Available fields:

- `name`: workflow name, matching its path under `.opencode/workflows`
- `raw?`: raw argument string for the child workflow
- `argv?`: explicit split args if you do not want raw parsing
- `files?`: optional file attachments for the child workflow

Use `ctx.workflow()` when you want to reuse another workflow's executable behavior instead of copying the same logic into multiple files.

### Context Fields

Useful fields already available on `ctx`:

- `ctx.name`: workflow name
- `ctx.raw`: raw argument string after the workflow name
- `ctx.argv`: split args after the workflow name
- `ctx.files`: attached files from the current message
- `ctx.sessionID`: current session id
- `ctx.directory`: current working directory
- `ctx.worktree`: repo root

---

## Input Parsing Patterns

### Default Input

If you do not define a custom schema, `input` is:

```ts
{
  raw: string
  argv: string[]
  files: WorkflowFile[]
}
```

This is enough for many workflows.

```ts
export default opencode.workflow({
  run(ctx, input) {
    const target = input.argv[0] ?? "."
    return `Inspecting ${target}`
  },
})
```

### Custom Schema

If you want stricter parsing, define `input` with a Zod schema.

If you only need the existing fields, reuse `opencode.args`:

```ts
export default opencode.workflow({
  input: opencode.args,
  run(ctx, input) {
    return input.raw || "No args"
  },
})
```

If you need derived fields, use a Zod transform. Example:

```ts
import z from "zod"

export default opencode.workflow({
  input: opencode.args.transform((input) => ({
    ...input,
    dry: input.argv.includes("--dry"),
    target: input.argv.find((x) => !x.startsWith("--")) ?? ".",
  })),
  run(ctx, input) {
    return `${input.dry ? "Dry run" : "Run"}: ${input.target}`
  },
})
```

Important:

- The runtime passes `{ raw, argv, files }` into your schema
- If you want extra fields, derive them from those values
- Keep schemas simple; avoid overengineering command parsing

---

## Example: Clarify With Multiple Agents

```ts
export default opencode.workflow({
  description: "Compare requirement options before asking the user",
  async run(ctx, input) {
    await ctx.status({ title: "Running internal review" })

    const pm = await ctx.task({
      description: "PM review",
      prompt: `Analyze this requirement and propose product directions:\n\n${input.raw}`,
      subagent: "metis",
      category: "deep",
    })

    const qa = await ctx.task({
      description: "QA review",
      prompt: `Find risks, edge cases, and rollout concerns:\n\n${input.raw}`,
      subagent: "momus",
      category: "deep",
    })

    const ans = await ctx.ask({
      questions: [
        {
          header: "Direction",
          question: "Which direction should we take?",
          options: [
            { label: "PM-first", description: "Favor product value and speed" },
            { label: "QA-first", description: "Favor safety and predictability" },
          ],
        },
      ],
    })

    return {
      title: "Clarify result",
      output: [`PM:\n${pm.text}`, `QA:\n${qa.text}`, `Chosen: ${ans.answers[0]?.[0] ?? "none"}`].join("\n\n"),
    }
  },
})
```

---

## Example: Nested Workflow

```ts
export default opencode.workflow({
  async run(ctx, input) {
    const out = await ctx.workflow({
      name: "child",
      raw: input.raw,
    })

    return {
      title: "Parent",
      output: `parent:${out.output}`,
    }
  },
})
```

This is useful when a larger workflow wants to reuse a smaller one for parsing, formatting, triage, or standard decision logic.

---

## How To Run A Workflow

From the TUI:

```text
/workflow clarify should the feature default to auto-save?
```

Examples:

```text
/workflow release/notes v1.2.0
/workflow clarify add approval flow for production deploys
```

If the workflow accepts file attachments, attach them in the current prompt before running `/workflow ...`.

---

## Third-Party Reuse

If another repo, tool, or documentation generator wants to understand the workflow contract, it should read:

```text
packages/opencode/src/workflow-api.ts
```

That file is the public interface library for:

- default workflow args
- workflow result shape
- workflow context methods
- nested workflow invocation
- subagent task invocation

Recommended reuse patterns:

- Import its exported types to build editor support, docs, or validation helpers
- Treat `.opencode/workflows.d.ts` as the local bridge, not the canonical interface definition
- If you need to mirror the contract elsewhere, mirror `workflow-api.ts`, not a copied ad hoc type block

For local authoring, keep using `opencode.workflow(...)`. For public integrations and references, point people at `workflow-api.ts`.

---

## Debugging And Failure Handling

If a workflow is not being found:

- Check the file path under `.opencode/workflows`
- Check the invoked name matches the relative path without `.ts`
- Check that the file exports `default`

If a workflow fails to load:

- Look for top-level throws
- Check syntax errors and bad imports
- Keep top-level code minimal; put logic inside `run()` when possible

If nested workflow calls fail:

- Check the child workflow name matches its relative path
- Check for workflow cycles like `a -> a` or `a -> b -> a`
- Keep nesting shallow and purposeful
- Prefer shared TS helpers when the logic is not really a workflow step

If a workflow runs but returns bad output:

- Return a string or `{ title?, output?, metadata? }`
- Use `ctx.status()` to narrow down where it fails
- Keep `metadata` small and serializable

If custom parsing behaves unexpectedly:

- Remember your schema receives only `{ raw, argv, files }`
- Derive extra fields from those values with Zod transforms or inside `run()`

---

## Authoring Rules

When writing a workflow for the user:

1. Keep the file in `.opencode/workflows/`
2. Use `export default opencode.workflow({ ... })`
3. Prefer the default `{ raw, argv, files }` input unless stricter parsing is clearly useful
4. Use `ctx.ask()` only for real user decisions
5. Use `ctx.task()` for focused subagent jobs, not broad open-ended delegation
6. Use `ctx.workflow()` when another workflow already models the step cleanly
7. Keep top-level code safe so load failures stay isolated
8. Avoid workflow cycles and unnecessary nesting
9. Return short, readable output that works well inside a session transcript

---

## Quick Checklist

- [ ] File is under `.opencode/workflows/`
- [ ] Name maps cleanly to `/workflow <name>`
- [ ] Default export uses `opencode.workflow({ ... })`
- [ ] Input handling is simple and correct
- [ ] Output is concise and useful
- [ ] Top-level code cannot easily throw
- [ ] User-only decisions go through `ctx.ask()`
- [ ] Delegated work goes through `ctx.task()`
- [ ] Reused workflow steps go through `ctx.workflow()`
- [ ] Nested calls do not create cycles
