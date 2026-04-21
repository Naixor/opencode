import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "url"
import { runtime, type TaskInput, type WorkflowContext } from "@lark-opencode/workflow-api"
import { tmpdir } from "../fixture/fixture"

describe("implement workflow", () => {
  test("converts a PRD, completes stories, and writes logs", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/implement.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({ git: true, config: {} })

    const ctx: WorkflowContext = {
      name: "implement",
      raw: "# Demo PRD\n\n## Goals\n\n- Add one tiny feature",
      argv: [],
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
      async task(input: TaskInput) {
        if (input.description === "Convert PRD 1") {
          return {
            session_id: "sess_convert",
            text: JSON.stringify({
              project: "OpenCode",
              branchName: "ralph/demo-prd",
              description: "Demo feature",
              userStories: [
                {
                  id: "US-001",
                  title: "Implement demo feature",
                  description: "As a user, I want a demo feature so that I can test the workflow.",
                  acceptanceCriteria: ["Feature is implemented", "Typecheck passes"],
                  priority: 1,
                  passes: false,
                  notes: "",
                },
              ],
            }),
          }
        }

        if (input.description.endsWith("split review 1")) {
          const role = input.description.split(" ")[0]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              ok: true,
              summary: `${role} approves split`,
              issues: [],
            }),
          }
        }

        if (input.description === "US-001 implement") {
          return {
            session_id: "sess_impl",
            text: "Implemented US-001 and ran focused verification.",
          }
        }

        if (input.description.includes("review 1")) {
          const role = input.description.split(" ")[1]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              approve: true,
              summary: `${role} approves implementation`,
              issues: [],
            }),
          }
        }

        if (input.description === "US-001 tests 1") {
          return {
            session_id: "sess_test_runner",
            text: "",
          }
        }

        if (input.description === "Final test run 1") {
          return {
            session_id: "sess_final_test",
            text: "",
          }
        }

        if (input.description === "Implementation retrospective") {
          return {
            session_id: "sess_retro",
            text: "- Completed the only story\n- No review or test failures remained",
          }
        }

        throw new Error(`unexpected task: ${input.description}`)
      },
      async workflow() {
        throw new Error("nested workflow should not be called in this test")
      },
    }

    const input = {
      raw: "# Demo PRD\n\n## Goals\n\n- Add one tiny feature",
      argv: [],
      files: [],
    }
    const out = await flow.run(ctx, input)
    if (typeof out === "string") throw new Error("expected object output")

    const prd = JSON.parse(await Bun.file(path.join(tmp.path, "tasks/prd.json")).text()) as {
      sourcePrdFile: string
      userStories: Array<{ id: string; passes: boolean; notes: string }>
    }
    expect(prd.sourcePrdFile).toBe("inline-prd.md")
    expect(prd.userStories[0]?.id).toBe("US-001")
    expect(prd.userStories[0]?.passes).toBe(true)
    expect(prd.userStories[0]?.notes).toContain("Completed by implement workflow")

    const dir = path.join(tmp.path, String(out.metadata.log_dir))
    expect(await Bun.file(path.join(dir, "source-prd.md")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "convert-1-prd.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "split-review-1.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "story-US-001.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "final-test-1.txt")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "retrospective.md")).text()).toContain("Completed the only story")
    expect(await Bun.file(path.join(dir, "run.json")).exists()).toBe(true)
  })
})
