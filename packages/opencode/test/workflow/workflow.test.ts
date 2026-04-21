import path from "path"
import { describe, expect, test } from "bun:test"
import { Command } from "../../src/command"
import { Filesystem } from "../../src/util/filesystem"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Workflow } from "../../src/workflow"
import { tmpdir } from "../fixture/fixture"

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
})
