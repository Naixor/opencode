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
        if (input.description.includes("split check")) {
          const role = input.description.split(" ")[0]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              ok: true,
              summary: `${role} accepts the split`,
              issues: [],
            }),
          }
        }

        if (input.description === "Convert PRD 1") {
          expect(input.subagent).toBe("general")
          expect(input.load_skills).toEqual(["ralph"])
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

        if (input.description === "US-001 implement") {
          return {
            session_id: "sess_impl",
            text: "Implemented US-001 and ran focused verification.",
          }
        }

        if (input.description.includes("split check")) {
          const role = input.description.split(" ")[0]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              ok: true,
              summary: `${role} accepts the split`,
              issues: [],
            }),
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

        if (input.description.startsWith("Switch branch ")) {
          return {
            session_id: "sess_branch",
            text: JSON.stringify({
              ok: true,
              branch: input.description.replace("Switch branch ", ""),
              summary: "switched branch",
            }),
          }
        }

        if (input.description.endsWith(" commit")) {
          return {
            session_id: "sess_commit",
            text: JSON.stringify({ ok: true, commit: "abc123", summary: "committed story" }),
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
    expect(await Bun.file(path.join(dir, "story-US-001.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "final-test-1.txt")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "retrospective.md")).text()).toContain("Completed the only story")
    expect(await Bun.file(path.join(dir, "run.json")).exists()).toBe(true)
  })

  test("does not run split review tasks before implementation", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/implement.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({ git: true, config: {} })
    const jobs: TaskInput[] = []

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
        jobs.push(input)

        if (input.description.includes("split check")) {
          const role = input.description.split(" ")[0]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              ok: true,
              summary: `${role} accepts the split`,
              issues: [],
            }),
          }
        }

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

        if (input.description === "US-001 implement") {
          return {
            session_id: "sess_impl",
            text: "Implemented US-001 and ran focused verification.",
          }
        }

        if (input.description.includes("split check")) {
          const role = input.description.split(" ")[0]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              ok: true,
              summary: `${role} accepts the split`,
              issues: [],
            }),
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

        if (input.description.startsWith("Switch branch ")) {
          return {
            session_id: "sess_branch",
            text: JSON.stringify({
              ok: true,
              branch: input.description.replace("Switch branch ", ""),
              summary: "switched branch",
            }),
          }
        }

        if (input.description.endsWith(" commit")) {
          return {
            session_id: "sess_commit",
            text: JSON.stringify({ ok: true, commit: "abc123", summary: "committed story" }),
          }
        }

        throw new Error(`unexpected task: ${input.description}`)
      },
      async workflow() {
        throw new Error("nested workflow should not be called in this test")
      },
    }

    const out = await flow.run(ctx, {
      raw: "# Demo PRD\n\n## Goals\n\n- Add one tiny feature",
      argv: [],
      files: [],
    })
    if (typeof out === "string") throw new Error("expected object output")

    expect(jobs.some((item) => item.description.includes("split review"))).toBe(false)
    expect(jobs.filter((item) => item.description === "Convert PRD 1")).toHaveLength(1)
  })

  test("retries conversion when prd.json misses Ralph standard fields", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/implement.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({ git: true, config: {} })
    const jobs: TaskInput[] = []
    let n = 0

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
        jobs.push(input)

        if (input.description.includes("split check")) {
          const role = input.description.split(" ")[0]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              ok: true,
              summary: `${role} accepts the split`,
              issues: [],
            }),
          }
        }

        if (input.description === "Convert PRD 1" || input.description === "Convert PRD 2") {
          n += 1
          if (n === 1) {
            return {
              session_id: "sess_convert",
              text: JSON.stringify({
                project: "OpenCode",
                branchName: "demo-prd",
                description: "Demo feature",
                userStories: [
                  {
                    id: "US-010",
                    title: "Implement demo feature",
                    description: "As a user, I want a demo feature so that I can test the workflow.",
                    acceptanceCriteria: ["Feature is implemented"],
                    priority: 9,
                    passes: true,
                    notes: "done",
                  },
                ],
              }),
            }
          }

          return {
            session_id: "sess_convert",
            text: JSON.stringify({
              project: "OpenCode",
              branchName: "ralph/demo-prd",
              description: "Demo feature",
              sourcePrdFile: "inline-prd.md",
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

        if (input.description === "US-001 implement") {
          return {
            session_id: "sess_impl",
            text: "Implemented US-001 and ran focused verification.",
          }
        }

        if (input.description.includes("split check")) {
          const role = input.description.split(" ")[0]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              ok: true,
              summary: `${role} accepts the split`,
              issues: [],
            }),
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

        if (input.description.startsWith("Switch branch ")) {
          return {
            session_id: "sess_branch",
            text: JSON.stringify({
              ok: true,
              branch: input.description.replace("Switch branch ", ""),
              summary: "switched branch",
            }),
          }
        }

        if (input.description.endsWith(" commit")) {
          return {
            session_id: "sess_commit",
            text: JSON.stringify({ ok: true, commit: "abc123", summary: "committed story" }),
          }
        }

        throw new Error(`unexpected task: ${input.description}`)
      },
      async workflow() {
        throw new Error("nested workflow should not be called in this test")
      },
    }

    const out = await flow.run(ctx, {
      raw: "# Demo PRD\n\n## Goals\n\n- Add one tiny feature",
      argv: [],
      files: [],
    })
    if (typeof out === "string") throw new Error("expected object output")

    const rows = jobs.filter((item) => item.description.startsWith("Convert PRD"))
    expect(rows).toHaveLength(2)
    expect(rows[1]?.description).toBe("Convert PRD 2")
    expect(rows[1]?.prompt).toContain("branchName must match `ralph/<kebab-case>`")
    expect(rows[1]?.prompt).toContain("must include `Typecheck passes`")
    expect(rows[1]?.prompt).toContain("must set passes to false during conversion")
    expect(rows[1]?.prompt).toContain("must set notes to an empty string during conversion")
  })

  test("starts a fresh implementation session each round and passes handoff context", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/implement.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({ git: true, config: {} })
    const jobs: TaskInput[] = []

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
        jobs.push(input)

        if (input.description.includes("split check")) {
          const role = input.description.split(" ")[0]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              ok: true,
              summary: `${role} accepts the split`,
              issues: [],
            }),
          }
        }

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

        if (input.description === "US-001 implement") {
          expect(input.session_id).toBeUndefined()
          expect(input.prompt).not.toContain("Previous round handoff:")
          return {
            session_id: "sess_impl_1",
            text: "Implemented US-001 first pass and ran focused verification.",
          }
        }

        if (input.description.includes("review 1")) {
          const role = input.description.split(" ")[1]
          return {
            session_id: `sess_${role.toLowerCase()}_1`,
            text: JSON.stringify({
              role,
              approve: role === "QA" ? false : true,
              summary: `${role} reviewed round 1`,
              issues: role === "QA" ? ["Add regression coverage for empty state"] : [],
            }),
          }
        }

        if (input.description === "US-001 tests 1") {
          return {
            session_id: "sess_test_runner_1",
            text: "empty state test is missing",
          }
        }

        if (input.description === "US-001 fix 1") {
          expect(input.session_id).toBeUndefined()
          expect(input.prompt).toContain("Previous round handoff:")
          expect(input.prompt).toContain("Implemented US-001 first pass and ran focused verification.")
          expect(input.prompt).toContain("Review findings: QA: Add regression coverage for empty state")
          expect(input.prompt).toContain("Failing testcases or verification errors:")
          expect(input.prompt).toContain("empty state test is missing")
          return {
            session_id: "sess_impl_2",
            text: "Added the missing regression coverage and reran the focused checks.",
          }
        }

        if (input.description.includes("review 2")) {
          const role = input.description.split(" ")[1]
          return {
            session_id: `sess_${role.toLowerCase()}_2`,
            text: JSON.stringify({
              role,
              approve: true,
              summary: `${role} approves implementation`,
              issues: [],
            }),
          }
        }

        if (input.description === "US-001 tests 2") {
          return {
            session_id: "sess_test_runner_2",
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
            text: "- Completed the story after one repair round\n- Handoff context kept later rounds grounded",
          }
        }

        if (input.description.startsWith("Switch branch ")) {
          return {
            session_id: "sess_branch",
            text: JSON.stringify({
              ok: true,
              branch: input.description.replace("Switch branch ", ""),
              summary: "switched branch",
            }),
          }
        }

        if (input.description.endsWith(" commit")) {
          return {
            session_id: "sess_commit",
            text: JSON.stringify({ ok: true, commit: "abc123", summary: "committed story" }),
          }
        }

        throw new Error(`unexpected task: ${input.description}`)
      },
      async workflow() {
        throw new Error("nested workflow should not be called in this test")
      },
    }

    const out = await flow.run(ctx, {
      raw: "# Demo PRD\n\n## Goals\n\n- Add one tiny feature",
      argv: [],
      files: [],
    })
    if (typeof out === "string") throw new Error("expected object output")

    expect(jobs.filter((item) => item.description === "US-001 implement")).toHaveLength(1)
    expect(jobs.filter((item) => item.description === "US-001 fix 1")).toHaveLength(1)
  })

  test("requires unresolved single-reviewer issues to be fixed or justified", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/implement.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({ git: true, config: {} })
    const jobs: TaskInput[] = []

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
        jobs.push(input)

        if (input.description.includes("split check")) {
          const role = input.description.split(" ")[0]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              ok: true,
              summary: `${role} accepts the split`,
              issues: [],
            }),
          }
        }

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

        if (input.description === "US-001 implement") {
          return {
            session_id: "sess_impl",
            text: "Implemented US-001 and ran focused verification.",
          }
        }

        if (input.description.includes("split check")) {
          const role = input.description.split(" ")[0]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              ok: true,
              summary: `${role} accepts the split`,
              issues: [],
            }),
          }
        }

        if (input.description.includes("review 1")) {
          const role = input.description.split(" ")[1]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              approve: role !== "QA",
              summary: `${role} reviewed round 1`,
              issues: role === "QA" ? ["Add regression coverage for empty state"] : [],
            }),
          }
        }

        if (input.description === "US-001 tests 1") {
          return {
            session_id: "sess_test_runner",
            text: "",
          }
        }

        if (input.description === "US-001 fix 1") {
          expect(input.prompt).toContain("Required fixes:")
          expect(input.prompt).toContain("QA: Add regression coverage for empty state")
          return {
            session_id: "sess_impl_2",
            text: "Kept the implementation unchanged because the empty state is unreachable in this story scope; added a clear rationale and linked the existing coverage.",
          }
        }

        if (input.description.includes("review 2")) {
          const role = input.description.split(" ")[1]
          return {
            session_id: `sess_${role.toLowerCase()}_2`,
            text: JSON.stringify({
              role,
              approve: true,
              summary: role === "QA" ? "QA accepts the scope-based justification" : `${role} approves implementation`,
              issues: [],
            }),
          }
        }

        if (input.description === "US-001 tests 2") {
          return {
            session_id: "sess_test_runner_2",
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
            text: "- QA concern required an explicit justification round before completion",
          }
        }

        if (input.description.startsWith("Switch branch ")) {
          return {
            session_id: "sess_branch",
            text: JSON.stringify({
              ok: true,
              branch: input.description.replace("Switch branch ", ""),
              summary: "switched branch",
            }),
          }
        }

        if (input.description.endsWith(" commit")) {
          return {
            session_id: "sess_commit",
            text: JSON.stringify({ ok: true, commit: "abc123", summary: "committed story" }),
          }
        }

        throw new Error(`unexpected task: ${input.description}`)
      },
      async workflow() {
        throw new Error("nested workflow should not be called in this test")
      },
    }

    const out = await flow.run(ctx, {
      raw: "# Demo PRD\n\n## Goals\n\n- Add one tiny feature",
      argv: [],
      files: [],
    })
    if (typeof out === "string") throw new Error("expected object output")

    expect(jobs.filter((item) => item.description === "US-001 implement")).toHaveLength(1)
    expect(jobs.filter((item) => item.description === "US-001 fix 1")).toHaveLength(1)

    const dir = path.join(tmp.path, String(out.metadata.log_dir))
    const row = JSON.parse(await Bun.file(path.join(dir, "US-001-review-1.json")).text()) as {
      issues: string[]
      test_failures: string
    }
    expect(row.issues).toEqual(["QA: Add regression coverage for empty state"])
    expect(row.test_failures).toBe("")
  })

  test("marks completed stories and advances by smallest unfinished priority", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/implement.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({ git: true, config: {} })
    const jobs: TaskInput[] = []

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
        jobs.push(input)

        if (input.description.includes("split check")) {
          const role = input.description.split(" ")[0]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              ok: true,
              summary: `${role} accepts the split`,
              issues: [],
            }),
          }
        }

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
                  title: "First story",
                  description: "As a user, I want the first story handled first.",
                  acceptanceCriteria: ["Done", "Typecheck passes"],
                  priority: 1,
                  passes: false,
                  notes: "",
                },
                {
                  id: "US-002",
                  title: "Second story",
                  description: "As a user, I want the second story considered.",
                  acceptanceCriteria: ["Done", "Typecheck passes"],
                  priority: 2,
                  passes: false,
                  notes: "",
                },
                {
                  id: "US-003",
                  title: "Third story",
                  description: "As a user, I want a lower-priority unfinished story deferred.",
                  acceptanceCriteria: ["Done", "Typecheck passes"],
                  priority: 3,
                  passes: false,
                  notes: "",
                },
              ],
              sourcePrdFile: "inline-prd.md",
            }),
          }
        }

        if (input.description === "US-001 implement") {
          return {
            session_id: "sess_impl_1",
            text: "Implemented US-001.",
          }
        }

        if (input.description === "US-002 implement") {
          return {
            session_id: "sess_impl_2",
            text: "Implemented US-002.",
          }
        }

        if (input.description === "US-003 implement") {
          return {
            session_id: "sess_impl_3",
            text: "Implemented US-003.",
          }
        }

        if (input.description.includes("review")) {
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

        if (
          input.description === "US-001 tests 1" ||
          input.description === "US-002 tests 1" ||
          input.description === "US-003 tests 1"
        ) {
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
            text: "- Completed the remaining unfinished stories in priority order",
          }
        }

        if (input.description.startsWith("Switch branch ")) {
          return {
            session_id: "sess_branch",
            text: JSON.stringify({
              ok: true,
              branch: input.description.replace("Switch branch ", ""),
              summary: "switched branch",
            }),
          }
        }

        if (input.description.endsWith(" commit")) {
          return {
            session_id: "sess_commit",
            text: JSON.stringify({ ok: true, commit: "abc123", summary: "committed story" }),
          }
        }

        throw new Error(`unexpected task: ${input.description}`)
      },
      async workflow() {
        throw new Error("nested workflow should not be called in this test")
      },
    }

    const out = await flow.run(ctx, {
      raw: "# Demo PRD\n\n## Goals\n\n- Add one tiny feature",
      argv: [],
      files: [],
    })
    if (typeof out === "string") throw new Error("expected object output")

    const work = jobs.filter((item) => item.description.endsWith("implement")).map((item) => item.description)
    expect(work).toEqual(["US-001 implement", "US-002 implement", "US-003 implement"])

    const prd = JSON.parse(await Bun.file(path.join(tmp.path, "tasks/prd.json")).text()) as {
      userStories: Array<{ id: string; passes: boolean }>
    }
    expect(prd.userStories.find((item) => item.id === "US-001")?.passes).toBe(true)
    expect(prd.userStories.find((item) => item.id === "US-002")?.passes).toBe(true)
    expect(prd.userStories.find((item) => item.id === "US-003")?.passes).toBe(true)
  })

  test("reuses an existing backlog when the input PRD matches", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/implement.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({
      git: true,
      config: {},
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "tasks", "prds"), { recursive: true })
        await fs.writeFile(
          path.join(dir, "tasks", "prds", "demo.md"),
          "# Demo PRD\n\n## Goals\n\n- Add one tiny feature",
        )
        await fs.mkdir(path.join(dir, "tasks"), { recursive: true })
        await fs.writeFile(
          path.join(dir, "tasks", "prd.json"),
          JSON.stringify(
            {
              project: "OpenCode",
              branchName: "ralph/demo-prd",
              sourcePrdFile: "tasks/prds/demo.md",
              description: "Demo feature",
              userStories: [
                {
                  id: "US-001",
                  title: "Already done",
                  description: "done",
                  acceptanceCriteria: ["Done", "Typecheck passes"],
                  priority: 1,
                  passes: true,
                  notes: "done",
                },
                {
                  id: "US-002",
                  title: "Remaining story",
                  description: "todo",
                  acceptanceCriteria: ["Done", "Typecheck passes"],
                  priority: 2,
                  passes: false,
                  notes: "",
                },
              ],
            },
            null,
            2,
          ),
        )
      },
    })

    const jobs: TaskInput[] = []
    const ctx: WorkflowContext = {
      name: "implement",
      raw: "tasks/prds/demo.md",
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
        jobs.push(input)

        if (input.description === "US-002 implement") {
          return {
            session_id: "sess_impl_2",
            text: "Implemented US-002.",
          }
        }

        if (input.description.includes("split check")) {
          const role = input.description.split(" ")[0]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              ok: true,
              summary: `${role} accepts the split`,
              issues: [],
            }),
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

        if (input.description === "US-002 tests 1" || input.description === "Final test run 1") {
          return {
            session_id: "sess_test_runner",
            text: "",
          }
        }

        if (input.description === "Implementation retrospective") {
          return {
            session_id: "sess_retro",
            text: "- Reused the existing backlog and finished the remaining story",
          }
        }

        if (input.description.startsWith("Switch branch ")) {
          return {
            session_id: "sess_branch",
            text: JSON.stringify({
              ok: true,
              branch: input.description.replace("Switch branch ", ""),
              summary: "switched branch",
            }),
          }
        }

        if (input.description.endsWith(" commit")) {
          return {
            session_id: "sess_commit",
            text: JSON.stringify({ ok: true, commit: "abc123", summary: "committed story" }),
          }
        }

        throw new Error(`unexpected task: ${input.description}`)
      },
      async workflow() {
        throw new Error("nested workflow should not be called in this test")
      },
    }

    const out = await flow.run(ctx, {
      raw: "tasks/prds/demo.md",
      argv: [],
      files: [],
    })
    if (typeof out === "string") throw new Error("expected object output")

    expect(jobs.some((item) => item.description === "Convert PRD 1")).toBe(false)
    expect(jobs.filter((item) => item.description.endsWith("implement")).map((item) => item.description)).toEqual([
      "US-002 implement",
    ])
    expect(out.output).toContain("Reused existing backlog for: tasks/prds/demo.md")

    const prd = JSON.parse(await Bun.file(path.join(tmp.path, "tasks/prd.json")).text()) as {
      userStories: Array<{ id: string; passes: boolean }>
    }
    expect(prd.userStories.find((item) => item.id === "US-001")?.passes).toBe(true)
    expect(prd.userStories.find((item) => item.id === "US-002")?.passes).toBe(true)
  })

  test("reuses saved backlog and run records from the PRD log dir", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/implement.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({
      git: true,
      config: {},
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "tasks", "prds"), { recursive: true })
        await fs.writeFile(
          path.join(dir, "tasks", "prds", "demo.md"),
          "# Demo PRD\n\n## Goals\n\n- Add one tiny feature",
        )
        await fs.mkdir(path.join(dir, ".workflows", "logs", "implement-tasks-prds-demo"), { recursive: true })
        await fs.writeFile(
          path.join(dir, ".workflows", "logs", "implement-tasks-prds-demo", "convert-1-prd.json"),
          JSON.stringify(
            {
              project: "OpenCode",
              branchName: "ralph/demo-prd",
              sourcePrdFile: "tasks/prds/demo.md",
              description: "Demo feature",
              userStories: [
                {
                  id: "US-001",
                  title: "Already done",
                  description: "done",
                  acceptanceCriteria: ["Done", "Typecheck passes"],
                  priority: 1,
                  passes: true,
                  notes: "done",
                },
                {
                  id: "US-002",
                  title: "Remaining story",
                  description: "todo",
                  acceptanceCriteria: ["Done", "Typecheck passes"],
                  priority: 2,
                  passes: false,
                  notes: "",
                },
              ],
            },
            null,
            2,
          ),
        )
        await fs.writeFile(
          path.join(dir, ".workflows", "logs", "implement-tasks-prds-demo", "run.json"),
          JSON.stringify(
            {
              source: "tasks/prds/demo.md",
              prd_file: "tasks/prd.json",
              log_dir: ".workflows/logs/implement-tasks-prds-demo",
              reused: true,
              roles: {},
              split_rounds: [],
              stories: [{ story: "US-001", title: "Already done" }],
              final_verify: [],
              paused: null,
              retrospective: "",
            },
            null,
            2,
          ),
        )
      },
    })

    const jobs: TaskInput[] = []
    const ctx: WorkflowContext = {
      name: "implement",
      raw: "tasks/prds/demo.md",
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
        jobs.push(input)

        if (input.description === "US-002 implement") {
          return {
            session_id: "sess_impl_2",
            text: "Implemented US-002.",
          }
        }

        if (input.description.includes("split check")) {
          const role = input.description.split(" ")[0]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              ok: true,
              summary: `${role} accepts the split`,
              issues: [],
            }),
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

        if (input.description === "US-002 tests 1" || input.description === "Final test run 1") {
          return {
            session_id: "sess_test_runner",
            text: "",
          }
        }

        if (input.description === "Implementation retrospective") {
          return {
            session_id: "sess_retro",
            text: "- Reused saved records and finished the remaining story",
          }
        }

        if (input.description.startsWith("Switch branch ")) {
          return {
            session_id: "sess_branch",
            text: JSON.stringify({
              ok: true,
              branch: input.description.replace("Switch branch ", ""),
              summary: "switched branch",
            }),
          }
        }

        if (input.description.endsWith(" commit")) {
          return {
            session_id: "sess_commit",
            text: JSON.stringify({ ok: true, commit: "abc123", summary: "committed story" }),
          }
        }

        throw new Error(`unexpected task: ${input.description}`)
      },
      async workflow() {
        throw new Error("nested workflow should not be called in this test")
      },
    }

    const out = await flow.run(ctx, {
      raw: "tasks/prds/demo.md",
      argv: [],
      files: [],
    })
    if (typeof out === "string") throw new Error("expected object output")

    expect(out.metadata.log_dir).toBe(".workflows/logs/implement-tasks-prds-demo")
    expect(jobs.some((item) => item.description === "Convert PRD 1")).toBe(false)
    expect(jobs.filter((item) => item.description.endsWith("implement")).map((item) => item.description)).toEqual([
      "US-002 implement",
    ])

    const log = JSON.parse(
      await Bun.file(path.join(tmp.path, ".workflows", "logs", "implement-tasks-prds-demo", "run.json")).text(),
    ) as {
      stories: Array<{ story: string }>
    }
    expect(log.stories.map((item) => item.story)).toEqual(["US-001", "US-002"])
  })

  test("returns early when the matching backlog is already complete", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/implement.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({
      git: true,
      config: {},
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "tasks", "prds"), { recursive: true })
        await fs.writeFile(path.join(dir, "tasks", "prds", "done.md"), "# Done PRD\n\n## Goals\n\n- Nothing left")
        await fs.mkdir(path.join(dir, "tasks"), { recursive: true })
        await fs.writeFile(
          path.join(dir, "tasks", "prd.json"),
          JSON.stringify(
            {
              project: "OpenCode",
              branchName: "ralph/done-prd",
              sourcePrdFile: "tasks/prds/done.md",
              description: "Done feature",
              userStories: [
                {
                  id: "US-001",
                  title: "Done",
                  description: "done",
                  acceptanceCriteria: ["Done", "Typecheck passes"],
                  priority: 1,
                  passes: true,
                  notes: "done",
                },
              ],
            },
            null,
            2,
          ),
        )
      },
    })

    const ctx: WorkflowContext = {
      name: "implement",
      raw: "tasks/prds/done.md",
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
        throw new Error(`unexpected task: ${input.description}`)
      },
      async workflow() {
        throw new Error("nested workflow should not be called in this test")
      },
    }

    const out = await flow.run(ctx, {
      raw: "tasks/prds/done.md",
      argv: [],
      files: [],
    })
    if (typeof out === "string") throw new Error("expected object output")

    expect(out.output).toContain("Reused existing backlog for: tasks/prds/done.md")
    expect(out.output).toContain("Nothing left to implement.")
  })
})
