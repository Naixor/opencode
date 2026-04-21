import path from "path"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "url"
import { runtime } from "@lark-opencode/workflow-api"
import { tmpdir } from "../fixture/fixture"

describe("plan workflow", () => {
  test("persists PRD and writes split round logs", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/plan.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({ git: true, config: {} })

    let pm = 0
    const ctx = {
      name: "plan",
      raw: "ship roadmap",
      argv: ["ship", "roadmap"],
      files: [],
      sessionID: "sess_test",
      userMessageID: "msg_user",
      assistantMessageID: "msg_assistant",
      directory: tmp.path,
      worktree: tmp.path,
      async status() {},
      async ask() {
        throw new Error("ask should not be called in this test")
      },
      async task(input: { description: string; prompt: string }) {
        if (input.description.startsWith("PM round")) {
          pm += 1
          return {
            text: JSON.stringify({
              summary: `pm round ${pm}`,
              prd_markdown: `# PRD\n\nround ${pm}`,
              issues: [],
              done: true,
            }),
          }
        }

        if (input.description === "Persist PRD draft") {
          const match = input.prompt.match(
            /Create or overwrite the file `([^`]+)` with the markdown below\.\nReturn a one-line confirmation only\.\n\n([\s\S]*)$/,
          )
          if (!match) throw new Error("unexpected persist prompt")
          const file = path.join(tmp.path, match[1])
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, match[2], "utf8")
          return { text: `saved ${match[1]}` }
        }

        throw new Error(`unexpected task: ${input.description}`)
      },
      async workflow() {
        throw new Error("nested workflow should not be called in this test")
      },
    }

    const input = await flow.input.parseAsync({
      raw: "ship roadmap",
      argv: ["ship", "roadmap"],
      files: [],
    })
    const out = await flow.run(ctx, input)
    if (typeof out === "string") throw new Error("expected object output")

    const prd = path.join(tmp.path, out.metadata.file)
    expect(await Bun.file(prd).text()).toContain("round 3")

    const dir = path.join(tmp.path, out.metadata.log_dir)
    expect(await Bun.file(path.join(dir, "run.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "final-prd.md")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "round-1-pm.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "round-1-roles.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "round-1-judge.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "round-1-decisions.json")).exists()).toBe(true)

    const log = JSON.parse(await Bun.file(path.join(dir, "run.json")).text()) as {
      rounds: Array<{ pm: { attempts: unknown[] } }>
    }
    expect(log.rounds).toHaveLength(3)
    expect(log.rounds[0]?.pm.attempts).toHaveLength(1)
  })
})
