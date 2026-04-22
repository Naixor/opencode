import path from "path"
import { describe, expect, test } from "bun:test"
import { WorkflowProgressKey, WorkflowProgressWorkflowTargetId } from "@lark-opencode/workflow-api"
import { Command } from "../../src/command"
import { Filesystem } from "../../src/util/filesystem"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Workflow } from "../../src/workflow"
import { tmpdir } from "../fixture/fixture"

const future = { version: "workflow-progress.v3", workflow: { status: "running" } } as const

describe("workflow", () => {
  test("registers the /workflow command", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cmd = await Command.get(Command.Default.WORKFLOW)
        expect(cmd?.name).toBe("workflow")
        expect(cmd?.description).toContain("workflow")
      },
    })
  })

  test("registers the /workflow:init command", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cmd = await Command.get(Command.Default.WORKFLOW_INIT)
        expect(cmd?.name).toBe("workflow:init")
        expect(cmd?.description).toContain("workflow")
      },
    })
  })

  test("scaffolds workflow starter files with /workflow:init", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: session.id,
          command: "workflow:init",
          arguments: "",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toContain("Workflow init complete")

        expect(await Bun.file(path.join(tmp.path, ".lark-opencode", "workflows.d.ts")).exists()).toBe(true)
        expect(await Bun.file(path.join(tmp.path, ".lark-opencode", "workflows", "example.ts")).exists()).toBe(true)
        expect(await Bun.file(path.join(tmp.path, "docs", "workflow-authoring.md")).exists()).toBe(true)

        const pkg = JSON.parse(await Bun.file(path.join(tmp.path, "package.json")).text()) as {
          dependencies?: Record<string, string>
        }
        expect(pkg.dependencies?.["@lark-opencode/workflow-api"]).toBe("latest")

        const again = await SessionPrompt.command({
          sessionID: session.id,
          command: "workflow:init",
          arguments: "",
          agent: "build",
          model: "openai/gpt-5.2",
        })
        const next = again.parts.findLast((part) => part.type === "text")
        expect(next?.type).toBe("text")
        if (next?.type !== "text") throw new Error("expected text output")
        expect(next.text).toContain("Kept:")

        await Session.remove(session.id)
      },
    })
  })

  test("loads and runs a local workflow from .opencode/workflows", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "hello.ts"),
          [
            "export default opencode.workflow({",
            '  description: "test workflow",',
            "  run(ctx, input) {",
            '    return { title: "hello", output: `hello ${input.raw || ctx.name}` }',
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const items = await Workflow.list()
        expect(items.some((item) => item.name === "hello")).toBe(true)

        const session = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: session.id,
          command: "workflow",
          arguments: "hello world",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toBe("hello world")

        await Session.remove(session.id)
      },
    })
  })

  test("prefers .lark-opencode/workflows over .opencode/workflows", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "hello.ts"),
          ["export default opencode.workflow({", '  run() { return { output: "legacy" } },', "})"].join("\n"),
        )
        await Filesystem.write(
          path.join(dir, ".lark-opencode", "workflows", "hello.ts"),
          ["export default opencode.workflow({", '  run() { return { output: "fork" } },', "})"].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: session.id,
          command: "workflow",
          arguments: "hello",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toBe("fork")

        await Session.remove(session.id)
      },
    })
  })

  test("keeps running when a workflow file throws during load", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(path.join(dir, ".opencode", "workflows", "broken.ts"), 'throw new Error("boom")\n')
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "ok.ts"),
          ["export default opencode.workflow({", "  run() {", '    return { output: "ok" }', "  },", "})"].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const items = await Workflow.list()
        expect(items.map((item) => item.name)).toContain("ok")
        expect(items.map((item) => item.name)).not.toContain("broken")

        const session = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: session.id,
          command: "workflow",
          arguments: "broken",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toContain("failed to load")
        expect(text.text).toContain("boom")

        const ok = await SessionPrompt.command({
          sessionID: session.id,
          command: "workflow",
          arguments: "ok",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const done = ok.parts.findLast((part) => part.type === "text")
        expect(done?.type).toBe("text")
        if (done?.type !== "text") throw new Error("expected text output")
        expect(done.text).toBe("ok")

        await Session.remove(session.id)
      },
    })
  })

  test("allows a workflow to call another workflow", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "child.ts"),
          [
            "export default opencode.workflow({",
            "  run(ctx, input) {",
            '    return { title: "child", output: `child:${input.raw}` }',
            "  },",
            "})",
          ].join("\n"),
        )
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "parent.ts"),
          [
            "export default opencode.workflow({",
            "  async run(ctx, input) {",
            '    const out = await ctx.workflow({ name: "child", raw: input.raw })',
            "    return { output: `parent:${out.output}` }",
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: session.id,
          command: "workflow",
          arguments: "parent hello",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toBe("parent:child:hello")

        await Session.remove(session.id)
      },
    })
  })

  test("blocks workflow cycles", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "loop.ts"),
          [
            "export default opencode.workflow({",
            "  async run(ctx) {",
            '    const out = await ctx.workflow({ name: "loop" })',
            '    return out.output ?? "nope"',
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: session.id,
          command: "workflow",
          arguments: "loop",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toContain("Workflow failed")
        expect(text.text).toContain("cycle detected")

        await Session.remove(session.id)
      },
    })
  })

  test("stores and finalizes workflow progress in status metadata without clobbering siblings", async () => {
    const progress = {
      version: "workflow-progress.v1",
      workflow: {
        status: "running",
        name: "progress",
      },
      phase: {
        status: "active",
        label: "Plan",
      },
      steps: [
        {
          id: "step-1",
          status: "active",
          label: "Inspect",
        },
      ],
    } as const

    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "progress.ts"),
          [
            "export default opencode.workflow({",
            "  async run(ctx) {",
            "    await ctx.status({",
            '      title: "Planning",',
            '      metadata: { keep: "yes" },',
            "      progress: {",
            '        version: "workflow-progress.v1",',
            '        workflow: { status: "running", name: "progress" },',
            '        phase: { status: "active", label: "Plan" },',
            '        steps: [{ id: "step-1", status: "active", label: "Inspect" }],',
            "      },",
            "    })",
            '    return { output: "ok", metadata: { done: true } }',
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: ses.id,
          command: "workflow",
          arguments: "progress",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toBe("ok")

        const all = await Session.messages({ sessionID: ses.id })
        const out = all.findLast((item) => item.info.role === "assistant")
        if (!out) throw new Error("expected assistant message")
        const tool = out.parts.find((part) => part.type === "tool")
        expect(tool?.type).toBe("tool")
        if (tool?.type !== "tool") throw new Error("expected tool part")
        expect(tool.state.status).toBe("completed")
        if (tool.state.status !== "completed") throw new Error("expected completed tool state")
        expect(tool.state.metadata.keep).toBe("yes")
        expect(tool.state.metadata.done).toBe(true)
        expect(tool.state.metadata[WorkflowProgressKey]).toEqual({
          ...progress,
          workflow: {
            ...progress.workflow,
            status: "done",
            ended_at: expect.any(String),
          },
        })

        await Session.remove(ses.id)
      },
    })
  })

  test("rejects invalid workflow progress status updates at runtime", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "bad.ts"),
          [
            "export default opencode.workflow({",
            "  async run(ctx) {",
            "    await ctx.status({",
            "      progress: {",
            '        version: "workflow-progress.v1",',
            '        workflow: { status: "oops" },',
            "      },",
            "    })",
            '    return { output: "nope" }',
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: ses.id,
          command: "workflow",
          arguments: "bad",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toContain("Workflow failed")
        expect(text.text).toContain("Invalid option")

        await Session.remove(ses.id)
      },
    })
  })

  test("rejects malformed v2 workflow progress references in ctx.status", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "bad-v2.ts"),
          [
            "export default opencode.workflow({",
            "  async run(ctx) {",
            "    await ctx.status({",
            "      progress: {",
            '        version: "workflow-progress.v2",',
            '        workflow: { status: "running", name: "bad-v2" },',
            '        machine: { id: "bad-v2", active_step_id: "step-1", active_run_id: "run-1" },',
            '        step_definitions: [{ id: "step-1", kind: "task", label: "Plan" }],',
            '        step_runs: [{ id: "run-1", seq: 0, step_id: "step-1", status: "active" }],',
            '        transitions: [{ id: "trans-1", seq: 0, timestamp: "2026-04-22T10:00:00.000Z", level: "step", target_id: "step-1", run_id: "run-2", to_state: "active" }],',
            "        participants: [],",
            "      },",
            "    })",
            '    return { output: "nope" }',
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: ses.id,
          command: "workflow",
          arguments: "bad-v2",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toContain("Workflow failed")
        expect(text.text).toContain("Unknown step run id: run-2")

        await Session.remove(ses.id)
      },
    })
  })

  test("rejects invalid workflow progress returned in result metadata", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "bad-result.ts"),
          [
            "export default opencode.workflow({",
            "  run() {",
            "    return {",
            '      output: "nope",',
            '      metadata: { workflow_progress: { version: "workflow-progress.v1", workflow: { status: "invalid" } } },',
            "    }",
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: ses.id,
          command: "workflow",
          arguments: "bad-result",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toContain("Workflow failed")
        expect(text.text).toContain("Invalid option")

        await Session.remove(ses.id)
      },
    })
  })

  test("drops unsupported workflow progress versions from ctx.status progress without failing the run", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "future-progress.ts"),
          [
            "export default opencode.workflow({",
            "  async run(ctx) {",
            "    await ctx.status({",
            '      title: "Planning",',
            '      metadata: { keep: "yes" },',
            `      progress: ${JSON.stringify(future)},`,
            "    })",
            '    return { output: "ok" }',
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: ses.id,
          command: "workflow",
          arguments: "future-progress",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toBe("ok")

        const all = await Session.messages({ sessionID: ses.id })
        const out = all.findLast((item) => item.info.role === "assistant")
        if (!out) throw new Error("expected assistant message")
        const tool = out.parts.find((part) => part.type === "tool")
        expect(tool?.type).toBe("tool")
        if (tool?.type !== "tool") throw new Error("expected tool part")
        expect(tool.state.status).toBe("completed")
        if (tool.state.status !== "completed") throw new Error("expected completed tool state")
        expect(tool.state.metadata.keep).toBe("yes")
        expect(tool.state.metadata[WorkflowProgressKey]).toBeUndefined()

        await Session.remove(ses.id)
      },
    })
  })

  test("drops unsupported workflow progress versions from ctx.status metadata without failing the run", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "future-status.ts"),
          [
            "export default opencode.workflow({",
            "  async run(ctx) {",
            "    await ctx.status({",
            '      title: "Planning",',
            `      metadata: { keep: "yes", workflow_progress: ${JSON.stringify(future)} },`,
            "    })",
            '    return { output: "ok" }',
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: ses.id,
          command: "workflow",
          arguments: "future-status",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toBe("ok")

        const all = await Session.messages({ sessionID: ses.id })
        const out = all.findLast((item) => item.info.role === "assistant")
        if (!out) throw new Error("expected assistant message")
        const tool = out.parts.find((part) => part.type === "tool")
        expect(tool?.type).toBe("tool")
        if (tool?.type !== "tool") throw new Error("expected tool part")
        expect(tool.state.status).toBe("completed")
        if (tool.state.status !== "completed") throw new Error("expected completed tool state")
        expect(tool.state.metadata.keep).toBe("yes")
        expect(tool.state.metadata[WorkflowProgressKey]).toBeUndefined()

        await Session.remove(ses.id)
      },
    })
  })

  test("drops unsupported workflow progress versions from result metadata without failing the run", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "future-result.ts"),
          [
            "export default opencode.workflow({",
            "  run() {",
            "    return {",
            '      output: "ok",',
            `      metadata: { keep: true, workflow_progress: ${JSON.stringify(future)} },`,
            "    }",
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: ses.id,
          command: "workflow",
          arguments: "future-result",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toBe("ok")

        const all = await Session.messages({ sessionID: ses.id })
        const out = all.findLast((item) => item.info.role === "assistant")
        if (!out) throw new Error("expected assistant message")
        const tool = out.parts.find((part) => part.type === "tool")
        expect(tool?.type).toBe("tool")
        if (tool?.type !== "tool") throw new Error("expected tool part")
        expect(tool.state.status).toBe("completed")
        if (tool.state.status !== "completed") throw new Error("expected completed tool state")
        expect(tool.state.metadata.keep).toBe(true)
        expect(tool.state.metadata[WorkflowProgressKey]).toBeUndefined()

        await Session.remove(ses.id)
      },
    })
  })

  test("finalizes v1 workflow progress on successful completion", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "stale.ts"),
          [
            "export default opencode.workflow({",
            "  async run(ctx) {",
            "    await ctx.status({",
            "      progress: {",
            '        version: "workflow-progress.v1",',
            '        workflow: { status: "running", name: "stale" },',
            '        phase: { status: "active", label: "Plan" },',
            "      },",
            "    })",
            '    return { output: "ok" }',
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: ses.id,
          command: "workflow",
          arguments: "stale",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toBe("ok")

        const all = await Session.messages({ sessionID: ses.id })
        const out = all.findLast((item) => item.info.role === "assistant")
        if (!out) throw new Error("expected assistant message")
        const tool = out.parts.find((part) => part.type === "tool")
        expect(tool?.type).toBe("tool")
        if (tool?.type !== "tool") throw new Error("expected tool part")
        expect(tool.state.status).toBe("completed")
        if (tool.state.status !== "completed") throw new Error("expected completed tool state")
        expect(tool.state.metadata[WorkflowProgressKey]).toMatchObject({
          version: "workflow-progress.v1",
          workflow: { status: "done", name: "stale" },
          phase: { status: "active", label: "Plan" },
        })

        await Session.remove(ses.id)
      },
    })
  })

  test("preserves explicit terminal v1 workflow statuses from result metadata", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "failed.ts"),
          [
            "export default opencode.workflow({",
            "  async run() {",
            "    return {",
            '      output: "ok",',
            "      metadata: {",
            "        workflow_progress: {",
            '          version: "workflow-progress.v1",',
            '          workflow: { status: "failed", name: "failed" },',
            '          phase: { status: "failed", label: "Review" },',
            '          steps: [{ id: "step-1", status: "failed", label: "Fix", reason: "blocked by review" }],',
            "        },",
            "      },",
            "    }",
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: ses.id,
          command: "workflow",
          arguments: "failed",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toBe("ok")

        const all = await Session.messages({ sessionID: ses.id })
        const out = all.findLast((item) => item.info.role === "assistant")
        if (!out) throw new Error("expected assistant message")
        const tool = out.parts.find((part) => part.type === "tool")
        expect(tool?.type).toBe("tool")
        if (tool?.type !== "tool") throw new Error("expected tool part")
        expect(tool.state.status).toBe("completed")
        if (tool.state.status !== "completed") throw new Error("expected completed tool state")
        expect(tool.state.metadata[WorkflowProgressKey]).toMatchObject({
          version: "workflow-progress.v1",
          workflow: { status: "failed", name: "failed" },
          phase: { status: "failed", label: "Review" },
          steps: [{ id: "step-1", status: "failed", label: "Fix", reason: "blocked by review" }],
        })

        await Session.remove(ses.id)
      },
    })
  })

  test("synthesizes a terminal v2 workflow status on successful completion", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "stale-v2.ts"),
          [
            "export default opencode.workflow({",
            "  async run(ctx) {",
            "    await ctx.status({",
            "      progress: {",
            '        version: "workflow-progress.v2",',
            '        workflow: { status: "running", name: "stale-v2" },',
            '        machine: { id: "machine-1", active_step_id: "step-1", active_run_id: "run-1" },',
            '        step_definitions: [{ id: "step-1", kind: "task", label: "Plan" }],',
            '        step_runs: [{ id: "run-1", seq: 0, step_id: "step-1", status: "active" }],',
            '        transitions: [{ id: "trans-1", seq: 0, timestamp: "2026-04-22T00:00:00.000Z", level: "step", target_id: "step-1", run_id: "run-1", to_state: "active" }],',
            "        participants: [],",
            "      },",
            "    })",
            '    return { output: "ok" }',
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: ses.id,
          command: "workflow",
          arguments: "stale-v2",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toBe("ok")

        const all = await Session.messages({ sessionID: ses.id })
        const out = all.findLast((item) => item.info.role === "assistant")
        if (!out) throw new Error("expected assistant message")
        const tool = out.parts.find((part) => part.type === "tool")
        expect(tool?.type).toBe("tool")
        if (tool?.type !== "tool") throw new Error("expected tool part")
        expect(tool.state.status).toBe("completed")
        if (tool.state.status !== "completed") throw new Error("expected completed tool state")
        expect(tool.state.metadata[WorkflowProgressKey]).toMatchObject({
          version: "workflow-progress.v2",
          workflow: { status: "done", name: "stale-v2" },
          machine: { id: "machine-1" },
          step_definitions: [{ id: "step-1", kind: "task", label: "Plan" }],
          step_runs: [{ id: "run-1", seq: 0, step_id: "step-1", status: "completed" }],
          participants: [],
        })
        const progress = tool.state.metadata[WorkflowProgressKey] as {
          transitions: Array<Record<string, unknown>>
          machine: Record<string, unknown>
          step_runs: Array<Record<string, unknown>>
        }
        expect(progress.machine.active_step_id).toBeUndefined()
        expect(progress.machine.active_run_id).toBeUndefined()
        expect(progress.transitions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ level: "step", target_id: "step-1", run_id: "run-1", to_state: "active" }),
            expect.objectContaining({
              level: "step",
              target_id: "step-1",
              run_id: "run-1",
              from_state: "active",
              to_state: "completed",
            }),
            expect.objectContaining({
              level: "workflow",
              target_id: WorkflowProgressWorkflowTargetId,
              to_state: "running",
            }),
            expect.objectContaining({
              level: "workflow",
              target_id: WorkflowProgressWorkflowTargetId,
              from_state: "running",
              to_state: "done",
            }),
          ]),
        )
        expect(
          progress.transitions.findIndex(
            (item) =>
              item.level === "step" &&
              item.target_id === "step-1" &&
              item.run_id === "run-1" &&
              item.to_state === "completed",
          ),
        ).toBeLessThan(
          progress.transitions.findIndex(
            (item) =>
              item.level === "workflow" &&
              item.target_id === WorkflowProgressWorkflowTargetId &&
              item.to_state === "done",
          ),
        )

        await Session.remove(ses.id)
      },
    })
  })

  test("synthesizes terminal v2 workflow transitions from waiting and blocked states", async () => {
    for (const item of [
      { state: "waiting", reason: "Awaiting input" },
      { state: "blocked", reason: "Blocked by review" },
    ] as const) {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
            },
          },
        },
        init: async (dir) => {
          await Filesystem.write(
            path.join(dir, ".opencode", "workflows", `${item.state}.ts`),
            [
              "export default opencode.workflow({",
              "  async run(ctx) {",
              "    await ctx.status({",
              "      progress: {",
              '        version: "workflow-progress.v2",',
              `        workflow: { status: "${item.state}", name: "${item.state}" },`,
              `        machine: { id: "${item.state}", active_step_id: "step-1", active_run_id: "run-1", updated_at: "2026-04-22T10:00:00.000Z" },`,
              '        step_definitions: [{ id: "step-1", kind: "task", label: "Review" }],',
              `        step_runs: [{ id: "run-1", seq: 0, step_id: "step-1", status: "${item.state}", reason: "${item.reason}", started_at: "2026-04-22T10:00:00.000Z" }],`,
              `        transitions: [{ id: "trans-1", seq: 0, timestamp: "2026-04-22T10:00:00.000Z", level: "workflow", target_id: "workflow", to_state: "${item.state}", reason: "${item.reason}" }],`,
              "        participants: [],",
              "      },",
              "    })",
              '    return { output: "ok" }',
              "  },",
              "})",
            ].join("\n"),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ses = await Session.create({})
          const msg = await SessionPrompt.command({
            sessionID: ses.id,
            command: "workflow",
            arguments: item.state,
            agent: "build",
            model: "openai/gpt-5.2",
          })

          const text = msg.parts.findLast((part) => part.type === "text")
          expect(text?.type).toBe("text")
          if (text?.type !== "text") throw new Error("expected text output")
          expect(text.text).toBe("ok")

          const all = await Session.messages({ sessionID: ses.id })
          const out = all.findLast((val) => val.info.role === "assistant")
          if (!out) throw new Error("expected assistant message")
          const tool = out.parts.find((part) => part.type === "tool")
          expect(tool?.type).toBe("tool")
          if (tool?.type !== "tool") throw new Error("expected tool part")
          expect(tool.state.status).toBe("completed")
          if (tool.state.status !== "completed") throw new Error("expected completed tool state")
          expect(tool.state.metadata[WorkflowProgressKey]).toMatchObject({
            version: "workflow-progress.v2",
            workflow: { status: "done", name: item.state },
            machine: { id: item.state },
            step_definitions: [{ id: "step-1", kind: "task", label: "Review" }],
            step_runs: [{ id: "run-1", seq: 0, step_id: "step-1", status: "completed", reason: item.reason }],
          })
          const progress = tool.state.metadata[WorkflowProgressKey] as {
            transitions: Array<Record<string, unknown>>
            machine: Record<string, unknown>
          }
          expect(progress.machine.active_step_id).toBeUndefined()
          expect(progress.machine.active_run_id).toBeUndefined()
          expect(progress.transitions).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                timestamp: "2026-04-22T10:00:00.000Z",
                level: "workflow",
                target_id: WorkflowProgressWorkflowTargetId,
                to_state: item.state,
                reason: item.reason,
              }),
              expect.objectContaining({
                level: "workflow",
                target_id: WorkflowProgressWorkflowTargetId,
                from_state: item.state,
                to_state: "done",
              }),
              expect.objectContaining({
                level: "step",
                target_id: "step-1",
                run_id: "run-1",
                from_state: item.state,
                to_state: "completed",
                reason: item.reason,
              }),
            ]),
          )
          expect(
            progress.transitions.findIndex(
              (val) =>
                val.level === "step" &&
                val.target_id === "step-1" &&
                val.run_id === "run-1" &&
                val.to_state === "completed",
            ),
          ).toBeLessThan(
            progress.transitions.findIndex(
              (val) =>
                val.level === "workflow" &&
                val.target_id === WorkflowProgressWorkflowTargetId &&
                val.to_state === "done",
            ),
          )

          await Session.remove(ses.id)
        },
      })
    }
  })

  test("merges v2 workflow updates into durable run and transition history", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "history.ts"),
          [
            "export default opencode.workflow({",
            "  async run(ctx) {",
            "    await ctx.status({",
            "      progress: {",
            '        version: "workflow-progress.v2",',
            '        workflow: { status: "running", name: "history", started_at: "2026-04-22T10:00:00.000Z" },',
            '        machine: { id: "history", active_step_id: "convert", active_run_id: "run-1", updated_at: "2026-04-22T10:00:00.000Z" },',
            '        step_definitions: [{ id: "convert", kind: "task", next: ["review"] }, { id: "review", kind: "task" }],',
            '        step_runs: [{ id: "run-1", seq: 0, step_id: "convert", status: "active", started_at: "2026-04-22T10:00:00.000Z" }],',
            "        transitions: [],",
            "        participants: [],",
            "      },",
            "    })",
            "    await ctx.status({",
            "      progress: {",
            '        version: "workflow-progress.v2",',
            '        workflow: { status: "done", name: "history", ended_at: "2026-04-22T10:02:00.000Z" },',
            '        machine: { id: "history", active_step_id: "review", active_run_id: "run-2", updated_at: "2026-04-22T10:02:00.000Z" },',
            '        step_definitions: [{ id: "convert", kind: "task", next: ["review"] }, { id: "review", kind: "task" }],',
            "        step_runs: [",
            '          { id: "run-1", seq: 0, step_id: "convert", status: "completed", started_at: "2026-04-22T10:00:00.000Z", ended_at: "2026-04-22T10:01:00.000Z" },',
            '          { id: "run-2", seq: 1, step_id: "review", status: "completed", started_at: "2026-04-22T10:01:00.000Z", ended_at: "2026-04-22T10:02:00.000Z", round: { current: 2 }, retry: { current: 1 }, actor: { id: "agent-1", name: "sisyphus" } },',
            "        ],",
            "        transitions: [],",
            "        participants: [],",
            "      },",
            "    })",
            '    return { output: "ok" }',
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: ses.id,
          command: "workflow",
          arguments: "history",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toBe("ok")

        const all = await Session.messages({ sessionID: ses.id })
        const out = all.findLast((item) => item.info.role === "assistant")
        if (!out) throw new Error("expected assistant message")
        const tool = out.parts.find((part) => part.type === "tool")
        expect(tool?.type).toBe("tool")
        if (tool?.type !== "tool") throw new Error("expected tool part")
        expect(tool.state.status).toBe("completed")
        if (tool.state.status !== "completed") throw new Error("expected completed tool state")
        expect(tool.state.metadata[WorkflowProgressKey]).toMatchObject({
          version: "workflow-progress.v2",
          machine: {
            id: "history",
            active_step_id: "review",
            active_run_id: "run-2",
            updated_at: "2026-04-22T10:02:00.000Z",
          },
          step_definitions: [
            { id: "convert", kind: "task", next: ["review"] },
            { id: "review", kind: "task" },
          ],
          workflow: {
            status: "done",
            name: "history",
            started_at: "2026-04-22T10:00:00.000Z",
            ended_at: "2026-04-22T10:02:00.000Z",
          },
          step_runs: [
            {
              id: "run-1",
              seq: 0,
              step_id: "convert",
              status: "completed",
              started_at: "2026-04-22T10:00:00.000Z",
              ended_at: "2026-04-22T10:01:00.000Z",
            },
            {
              id: "run-2",
              seq: 1,
              step_id: "review",
              status: "completed",
              started_at: "2026-04-22T10:01:00.000Z",
              ended_at: "2026-04-22T10:02:00.000Z",
              round: { current: 2 },
              retry: { current: 1 },
              actor: { id: "agent-1", name: "sisyphus" },
            },
          ],
          participants: [],
        })
        const progress = tool.state.metadata[WorkflowProgressKey] as {
          transitions: Array<Record<string, unknown>>
        }
        expect(progress.transitions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              timestamp: "2026-04-22T10:00:00.000Z",
              level: "workflow",
              target_id: WorkflowProgressWorkflowTargetId,
              to_state: "running",
            }),
            expect.objectContaining({
              timestamp: "2026-04-22T10:00:00.000Z",
              level: "step",
              target_id: "convert",
              run_id: "run-1",
              to_state: "active",
            }),
            expect.objectContaining({
              timestamp: "2026-04-22T10:01:00.000Z",
              level: "step",
              target_id: "convert",
              run_id: "run-1",
              from_state: "active",
              to_state: "completed",
            }),
            expect.objectContaining({
              timestamp: "2026-04-22T10:02:00.000Z",
              level: "step",
              target_id: "review",
              run_id: "run-2",
              to_state: "completed",
              source: { type: "agent", id: "agent-1", name: "sisyphus" },
            }),
            expect.objectContaining({
              timestamp: "2026-04-22T10:02:00.000Z",
              level: "workflow",
              target_id: WorkflowProgressWorkflowTargetId,
              from_state: "running",
              to_state: "done",
            }),
          ]),
        )
        expect(
          progress.transitions.findIndex(
            (item) =>
              item.level === "workflow" &&
              item.target_id === WorkflowProgressWorkflowTargetId &&
              item.to_state === "running",
          ),
        ).toBeLessThan(
          progress.transitions.findIndex(
            (item) => item.level === "step" && item.target_id === "review" && item.run_id === "run-2",
          ),
        )
        expect(
          progress.transitions.findIndex(
            (item) => item.level === "step" && item.target_id === "review" && item.run_id === "run-2",
          ),
        ).toBeLessThan(
          progress.transitions.findIndex(
            (item) =>
              item.level === "workflow" &&
              item.target_id === WorkflowProgressWorkflowTargetId &&
              item.to_state === "done",
          ),
        )

        await Session.remove(ses.id)
      },
    })
  })

  test("preserves v2 workflow history when result metadata falls back to v1", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "mixed.ts"),
          [
            "export default opencode.workflow({",
            "  async run(ctx) {",
            "    await ctx.status({",
            "      progress: {",
            '        version: "workflow-progress.v2",',
            '        workflow: { status: "running", name: "mixed" },',
            '        machine: { id: "mixed", active_step_id: "step-1", active_run_id: "run-1", updated_at: "2026-04-22T10:00:00.000Z" },',
            '        step_definitions: [{ id: "step-1", kind: "task", label: "Plan" }],',
            '        step_runs: [{ id: "run-1", seq: 0, step_id: "step-1", status: "active", started_at: "2026-04-22T10:00:00.000Z" }],',
            '        transitions: [{ id: "trans-1", seq: 0, timestamp: "2026-04-22T10:00:00.000Z", level: "step", target_id: "step-1", run_id: "run-1", to_state: "active" }],',
            "        participants: [],",
            "      },",
            "    })",
            "    return {",
            '      output: "ok",',
            "      metadata: {",
            "        workflow_progress: {",
            '          version: "workflow-progress.v1",',
            '          workflow: { status: "running", name: "mixed" },',
            '          phase: { status: "active", label: "Plan" },',
            "        },",
            "      },",
            "    }",
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: ses.id,
          command: "workflow",
          arguments: "mixed",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toBe("ok")

        const all = await Session.messages({ sessionID: ses.id })
        const out = all.findLast((item) => item.info.role === "assistant")
        if (!out) throw new Error("expected assistant message")
        const tool = out.parts.find((part) => part.type === "tool")
        expect(tool?.type).toBe("tool")
        if (tool?.type !== "tool") throw new Error("expected tool part")
        expect(tool.state.status).toBe("completed")
        if (tool.state.status !== "completed") throw new Error("expected completed tool state")
        expect(tool.state.metadata[WorkflowProgressKey]).toMatchObject({
          version: "workflow-progress.v2",
          workflow: { status: "done", name: "mixed" },
          machine: { id: "mixed" },
          step_definitions: [{ id: "step-1", kind: "task", label: "Plan" }],
          step_runs: [
            { id: "run-1", seq: 0, step_id: "step-1", status: "completed", started_at: "2026-04-22T10:00:00.000Z" },
          ],
          participants: [],
        })
        const progress = tool.state.metadata[WorkflowProgressKey] as {
          transitions: Array<Record<string, unknown>>
          machine: Record<string, unknown>
        }
        expect(progress.machine.active_step_id).toBeUndefined()
        expect(progress.machine.active_run_id).toBeUndefined()
        expect(progress.transitions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ level: "step", target_id: "step-1", run_id: "run-1", to_state: "active" }),
            expect.objectContaining({
              level: "step",
              target_id: "step-1",
              run_id: "run-1",
              from_state: "active",
              to_state: "completed",
            }),
            expect.objectContaining({
              level: "workflow",
              target_id: WorkflowProgressWorkflowTargetId,
              from_state: "running",
              to_state: "done",
            }),
          ]),
        )
        expect(
          progress.transitions.findIndex(
            (item) =>
              item.level === "step" &&
              item.target_id === "step-1" &&
              item.run_id === "run-1" &&
              item.to_state === "completed",
          ),
        ).toBeLessThan(
          progress.transitions.findIndex(
            (item) =>
              item.level === "workflow" &&
              item.target_id === WorkflowProgressWorkflowTargetId &&
              item.to_state === "done",
          ),
        )

        await Session.remove(ses.id)
      },
    })
  })

  test("synthesizes a terminal v2 workflow failure by closing the active run", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".opencode", "workflows", "stale-fail.ts"),
          [
            "export default opencode.workflow({",
            "  async run(ctx) {",
            "    await ctx.status({",
            "      progress: {",
            '        version: "workflow-progress.v2",',
            '        workflow: { status: "running", name: "stale-fail" },',
            '        machine: { id: "fail-machine", active_step_id: "step-1", active_run_id: "run-1" },',
            '        step_definitions: [{ id: "step-1", kind: "task", label: "Plan" }],',
            '        step_runs: [{ id: "run-1", seq: 0, step_id: "step-1", status: "active" }],',
            "        transitions: [],",
            "        participants: [],",
            "      },",
            "    })",
            '    throw new Error("boom")',
            "  },",
            "})",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ses = await Session.create({})
        const msg = await SessionPrompt.command({
          sessionID: ses.id,
          command: "workflow",
          arguments: "stale-fail",
          agent: "build",
          model: "openai/gpt-5.2",
        })

        const text = msg.parts.findLast((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toContain("Workflow failed: boom")

        const all = await Session.messages({ sessionID: ses.id })
        const out = all.findLast((item) => item.info.role === "assistant")
        if (!out) throw new Error("expected assistant message")
        const tool = out.parts.find((part) => part.type === "tool")
        expect(tool?.type).toBe("tool")
        if (tool?.type !== "tool") throw new Error("expected tool part")
        expect(tool.state.status).toBe("error")
        if (tool.state.status !== "error") throw new Error("expected error tool state")
        const meta = "metadata" in tool.state ? tool.state.metadata : undefined
        if (!meta) throw new Error("expected tool metadata")
        expect(meta[WorkflowProgressKey]).toMatchObject({
          version: "workflow-progress.v2",
          workflow: { status: "failed", name: "stale-fail" },
          machine: { id: "fail-machine" },
          step_definitions: [{ id: "step-1", kind: "task", label: "Plan" }],
          step_runs: [{ id: "run-1", seq: 0, step_id: "step-1", status: "failed" }],
          participants: [],
        })
        const progress = meta[WorkflowProgressKey] as {
          transitions: Array<Record<string, unknown>>
          machine: Record<string, unknown>
        }
        expect(progress.machine.active_step_id).toBeUndefined()
        expect(progress.machine.active_run_id).toBeUndefined()
        expect(progress.transitions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ level: "step", target_id: "step-1", run_id: "run-1", to_state: "active" }),
            expect.objectContaining({
              level: "step",
              target_id: "step-1",
              run_id: "run-1",
              from_state: "active",
              to_state: "failed",
            }),
            expect.objectContaining({
              level: "workflow",
              target_id: WorkflowProgressWorkflowTargetId,
              to_state: "running",
            }),
            expect.objectContaining({
              level: "workflow",
              target_id: WorkflowProgressWorkflowTargetId,
              from_state: "running",
              to_state: "failed",
            }),
          ]),
        )
        expect(
          progress.transitions.findIndex(
            (item) =>
              item.level === "step" &&
              item.target_id === "step-1" &&
              item.run_id === "run-1" &&
              item.to_state === "failed",
          ),
        ).toBeLessThan(
          progress.transitions.findIndex(
            (item) =>
              item.level === "workflow" &&
              item.target_id === WorkflowProgressWorkflowTargetId &&
              item.to_state === "failed",
          ),
        )

        await Session.remove(ses.id)
      },
    })
  })
})
