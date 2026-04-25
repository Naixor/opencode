import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "url"
import { runtime, type WorkflowContext } from "@lark-opencode/workflow-api"
import { tmpdir } from "../fixture/fixture"

describe("feature workflow", () => {
  test("chains plan and implement while storing only minimal recovery state", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/feature.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({ git: true, config: {} })
    const calls: string[] = []
    const updates: unknown[] = []
    const file = "tasks/prds/prd-ship-roadmap.md"

    const ctx: WorkflowContext = {
      name: "feature",
      raw: "ship roadmap",
      argv: ["ship", "roadmap"],
      files: [],
      sessionID: "sess_test",
      userMessageID: "msg_user",
      assistantMessageID: "msg_assistant",
      directory: tmp.path,
      worktree: tmp.path,
      async status(input) {
        if (input.progress) updates.push(input.progress)
      },
      async write(input) {
        const file = path.isAbsolute(input.file) ? input.file : path.join(tmp.path, input.file)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, input.content, "utf8")
      },
      async ask() {
        throw new Error("ask should not be called in this test")
      },
      async task() {
        throw new Error("task should not be called in this test")
      },
      session: {
        async diff() {
          return []
        },
        async messages() {
          return []
        },
      },
      async workflow(input) {
        calls.push(input.name)
        if (input.name === "plan") {
          await fs.mkdir(path.join(tmp.path, "tasks/prds"), { recursive: true })
          await fs.writeFile(path.join(tmp.path, file), "# PRD\n\nroadmap", "utf8")
          return {
            name: "plan",
            title: "Plan PRD loop",
            output: "planned",
            metadata: { file, log_dir: ".workflows/logs/plan-ship-roadmap-stub" },
          }
        }
        if (input.name === "implement") {
          await fs.mkdir(path.join(tmp.path, "tasks"), { recursive: true })
          await fs.writeFile(
            path.join(tmp.path, "tasks/prd.json"),
            JSON.stringify({
              sourcePrdFile: file,
              userStories: [
                { id: "US-001", passes: true },
                { id: "US-002", passes: true },
              ],
            }),
            "utf8",
          )
          return {
            name: "implement",
            title: "Implement workflow",
            output: "implemented",
            metadata: { log_dir: ".workflows/logs/implement-prd-ship-roadmap" },
          }
        }
        throw new Error(`unexpected workflow: ${input.name}`)
      },
    }

    const input = await flow.input.parseAsync({ raw: "ship roadmap", argv: ["ship", "roadmap"], files: [] })
    const out = await flow.run(ctx, input)
    if (typeof out === "string") throw new Error("expected object output")

    expect(calls).toEqual(["plan", "implement"])
    expect(out.metadata.stage).toBe("done")
    expect(out.metadata.prd_file).toBe(file)

    const log = JSON.parse(
      await Bun.file(path.join(tmp.path, ".workflows/logs/feature-ship-roadmap/run.json")).text(),
    ) as Record<string, unknown>
    expect(Object.keys(log).sort()).toEqual(["goal", "implement", "log_dir", "plan", "prd_file", "stage", "updated_at"])
    expect(log.stage).toBe("done")
    expect(log.plan).toEqual({ done: true, log_dir: ".workflows/logs/plan-ship-roadmap-stub" })
    expect(log.implement).toEqual({ done: true, log_dir: ".workflows/logs/implement-prd-ship-roadmap" })

    const progress = updates.at(-1) as { version: string; workflow: { status: string } }
    expect(progress.version).toBe("workflow-progress.v2")
    expect(progress.workflow.status).toBe("done")
  })

  test("resumes at implement stage without rerunning plan", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/feature.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({ git: true, config: {} })
    const file = "tasks/prds/prd-ship-roadmap.md"
    await fs.mkdir(path.join(tmp.path, ".workflows/logs/feature-ship-roadmap"), { recursive: true })
    await fs.mkdir(path.join(tmp.path, "tasks/prds"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, file), "# PRD\n", "utf8")
    await fs.mkdir(path.join(tmp.path, "tasks"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, "tasks/prd.json"),
      JSON.stringify({ sourcePrdFile: file, userStories: [{ id: "US-001", passes: false }] }),
      "utf8",
    )
    await fs.writeFile(
      path.join(tmp.path, ".workflows/logs/feature-ship-roadmap/run.json"),
      JSON.stringify({
        goal: "ship roadmap",
        prd_file: file,
        log_dir: ".workflows/logs/feature-ship-roadmap",
        stage: "implement",
        plan: { done: true, log_dir: ".workflows/logs/plan-ship-roadmap-stub" },
        implement: { done: false, log_dir: ".workflows/logs/implement-prd-ship-roadmap" },
        updated_at: new Date().toISOString(),
      }),
      "utf8",
    )

    const calls: string[] = []
    const ctx: WorkflowContext = {
      name: "feature",
      raw: "ship roadmap",
      argv: ["ship", "roadmap"],
      files: [],
      sessionID: "sess_test",
      userMessageID: "msg_user",
      assistantMessageID: "msg_assistant",
      directory: tmp.path,
      worktree: tmp.path,
      async status() {},
      async write(input) {
        const file = path.isAbsolute(input.file) ? input.file : path.join(tmp.path, input.file)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, input.content, "utf8")
      },
      async ask() {
        throw new Error("ask should not be called in this test")
      },
      async task() {
        throw new Error("task should not be called in this test")
      },
      session: {
        async diff() {
          return []
        },
        async messages() {
          return []
        },
      },
      async workflow(input) {
        calls.push(input.name)
        if (input.name !== "implement") throw new Error(`unexpected workflow: ${input.name}`)
        await fs.writeFile(
          path.join(tmp.path, "tasks/prd.json"),
          JSON.stringify({ sourcePrdFile: file, userStories: [{ id: "US-001", passes: true }] }),
          "utf8",
        )
        return {
          name: "implement",
          title: "Implement workflow",
          output: "implemented",
          metadata: { log_dir: ".workflows/logs/implement-prd-ship-roadmap" },
        }
      },
    }

    const input = await flow.input.parseAsync({ raw: "ship roadmap", argv: ["ship", "roadmap"], files: [] })
    const out = await flow.run(ctx, input)
    if (typeof out === "string") throw new Error("expected object output")

    expect(calls).toEqual(["implement"])
    expect(out.metadata.stage).toBe("done")
    const log = JSON.parse(
      await Bun.file(path.join(tmp.path, ".workflows/logs/feature-ship-roadmap/run.json")).text(),
    ) as {
      stage: string
      plan: { done: boolean }
      implement: { done: boolean }
    }
    expect(log.stage).toBe("done")
    expect(log.plan.done).toBe(true)
    expect(log.implement.done).toBe(true)
  })
})
