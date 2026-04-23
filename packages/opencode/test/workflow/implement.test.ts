import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "url"
import { WorkflowProgressKey, runtime, type TaskInput, type WorkflowContext } from "@lark-opencode/workflow-api"
import { workflowscreen } from "../../src/cli/cmd/tui/routes/session/workflow-screen"
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
            text: "VERIFY: PASS",
          }
        }

        if (input.description === "Final test run 1") {
          return {
            session_id: "sess_final_test",
            text: "VERIFY: PASS",
          }
        }

        if (input.description === "Implementation retrospective") {
          return {
            session_id: "sess_retro",
            text: "- Completed the only story\n- No review or test failures remained",
          }
        }

        if (input.description.startsWith("Switch branch ")) {
          expect(input.prompt).toContain("create it from the branch that is currently checked out")
          expect(input.prompt).toContain("without recreating it from a fixed base branch")
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
  }, 20000)

  test("emits workflow-progress.v2 state that renders through the shared workflow screen", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/implement.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({ git: true, config: {} })
    const updates: unknown[] = []

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

        if (input.description === "US-001 implement") {
          return {
            session_id: "sess_impl",
            text: '{"summary":"Implemented the story","files":["packages/opencode/src/demo.ts"],"verify":"bun test test/workflow/implement.test.ts","compactions":0}',
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

        if (input.description === "US-001 tests 1" || input.description === "Final test run 1") {
          return {
            session_id: "sess_test_runner",
            text: "VERIFY: PASS",
          }
        }

        if (input.description.endsWith(" commit")) {
          return {
            session_id: "sess_commit",
            text: JSON.stringify({ ok: true, commit: "abc123", summary: "committed story" }),
          }
        }

        if (input.description === "Implementation retrospective") {
          return {
            session_id: "sess_retro",
            text: "- Completed the only story",
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

    const seen = updates.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return []
      const machine = "machine" in item && item.machine && typeof item.machine === "object" ? item.machine : undefined
      const step =
        machine && "active_step_id" in machine && typeof machine.active_step_id === "string"
          ? machine.active_step_id
          : undefined
      return step ? [step] : []
    })
    expect(seen).toEqual(expect.arrayContaining(["convert", "select", "implement", "review", "done"]))

    const last = updates.at(-1)
    expect(last).toBeDefined()
    if (!last || typeof last !== "object" || Array.isArray(last)) throw new Error("expected final workflow progress")
    expect(last).toMatchObject({
      version: "workflow-progress.v2",
      workflow: { status: "done", name: "implement", label: "Implement workflow" },
      machine: { active_step_id: "done" },
    })
    if (!("step_definitions" in last) || !("step_runs" in last) || !("transitions" in last)) {
      throw new Error("expected explicit workflow state-machine sections")
    }
    expect(last.step_definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "convert", label: "Convert PRD", next: ["select"] }),
        expect.objectContaining({ id: "select", label: "Select story", next: ["implement", "final_verify", "done"] }),
        expect.objectContaining({ id: "implement", label: "Implement story" }),
        expect.objectContaining({
          id: "review",
          kind: "group",
          label: "Review gate",
          next: ["fix", "select", "done", "failed"],
        }),
        expect.objectContaining({ id: "review_architect", parent_id: "review", label: "Architect review" }),
        expect.objectContaining({ id: "review_test", parent_id: "review", label: "Test runner" }),
        expect.objectContaining({ id: "final_verify", label: "Final verify" }),
        expect.objectContaining({ id: "retrospective", label: "Retrospective" }),
        expect.objectContaining({ id: "done", label: "Done" }),
      ]),
    )
    expect(last.step_runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step_id: "convert" }),
        expect.objectContaining({ step_id: "select" }),
        expect.objectContaining({ step_id: "implement" }),
        expect.objectContaining({ step_id: "review" }),
        expect.objectContaining({ step_id: "done", status: "completed" }),
      ]),
    )
    expect(last.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "workflow", target_id: "workflow", to_state: "done" }),
        expect.objectContaining({ level: "step", target_id: "review" }),
        expect.objectContaining({ level: "step", target_id: "done", to_state: "completed" }),
      ]),
    )
    const select = updates.find((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false
      return (
        "machine" in item &&
        item.machine &&
        typeof item.machine === "object" &&
        "active_step_id" in item.machine &&
        item.machine.active_step_id === "select"
      )
    })
    expect(select).toBeDefined()
    if (!select || typeof select !== "object" || Array.isArray(select)) throw new Error("expected select progress")
    expect("round" in select).toBe(false)
    expect("round" in last).toBe(false)

    const view = workflowscreen({
      metadata: {
        [WorkflowProgressKey]: last,
      },
      name: "implement",
      tool_status: "completed",
    })
    expect(view.empty).toBe(false)
    expect(view.header.title).toBe("Implement workflow")
    expect(view.header.status).toBe("done")
    expect(view.timeline.some((item) => item.label === "Done")).toBe(true)
    expect(view.history.length).toBeGreaterThan(0)
    expect(view.alerts).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "done", title: "Implement workflow" })]),
    )
  })

  test("emits grouped review children plus distinct repair and final verification retry runs", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/implement.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({ git: true, config: {} })
    const updates: unknown[] = []

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

        if (input.description === "US-001 implement") {
          return {
            session_id: "sess_impl_1",
            text: "Implemented the first pass.",
          }
        }

        if (input.description === "US-001 fix 1") {
          return {
            session_id: "sess_impl_2",
            text: "Applied review fixes.",
          }
        }

        if (input.description.includes("review 1")) {
          const role = input.description.split(" ")[1]
          return {
            session_id: `sess_${role.toLowerCase()}_1`,
            text: JSON.stringify({
              role,
              approve: role !== "Architect",
              summary: `${role} reviewed round 1`,
              issues: role === "Architect" ? ["Tighten the reducer coverage"] : [],
            }),
          }
        }

        if (input.description.includes("review 2")) {
          const role = input.description.split(" ")[1]
          return {
            session_id: `sess_${role.toLowerCase()}_2`,
            text: JSON.stringify({
              role,
              approve: true,
              summary: `${role} approves round 2`,
              issues: [],
            }),
          }
        }

        if (input.description === "US-001 tests 1" || input.description === "US-001 tests 2") {
          return {
            session_id: `sess_tests_${input.description.endsWith("1") ? "1" : "2"}`,
            text: "VERIFY: PASS",
          }
        }

        if (input.description === "Final test run 1") {
          return {
            session_id: "sess_final_test_1",
            text: "VERIFY: FAIL\nFAILURES:\nfull verification still fails",
          }
        }

        if (input.description === "Final fix 1") {
          return {
            session_id: "sess_final_fix_1",
            text: "Fixed the remaining workspace verification issue.",
          }
        }

        if (input.description === "Final test run 2") {
          return {
            session_id: "sess_final_test_2",
            text: "VERIFY: PASS",
          }
        }

        if (input.description === "Implementation retrospective") {
          return {
            session_id: "sess_retro",
            text: "- Completed after one repair round and one final verification retry",
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

    const group = updates.find((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false
      if (!("machine" in item) || !item.machine || typeof item.machine !== "object") return false
      const machine = item.machine as { active_step_id?: string }
      if (machine.active_step_id !== "review") return false
      if (!("step_runs" in item) || !Array.isArray(item.step_runs)) return false
      return item.step_runs.some(
        (run) =>
          run &&
          typeof run === "object" &&
          !Array.isArray(run) &&
          run.step_id === "review_architect" &&
          run.status === "active" &&
          typeof run.parent_run_id === "string",
      )
    })
    expect(group).toBeDefined()
    if (!group || typeof group !== "object" || Array.isArray(group)) throw new Error("expected grouped review progress")
    if (!("step_runs" in group) || !Array.isArray(group.step_runs)) throw new Error("expected grouped step runs")

    const review = group.step_runs.find(
      (run) => run && typeof run === "object" && !Array.isArray(run) && run.step_id === "review",
    )
    expect(review).toBeDefined()
    if (!review || typeof review !== "object" || Array.isArray(review) || typeof review.id !== "string") {
      throw new Error("expected review group run")
    }

    expect(group.step_runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step_id: "review", status: "active" }),
        expect.objectContaining({ step_id: "review_architect", status: "active", parent_run_id: review.id }),
        expect.objectContaining({ step_id: "review_qa", status: "active", parent_run_id: review.id }),
        expect.objectContaining({ step_id: "review_fe", status: "active", parent_run_id: review.id }),
        expect.objectContaining({ step_id: "review_test", status: "active", parent_run_id: review.id }),
      ]),
    )

    const mixed = updates.find((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false
      if (!("machine" in item) || !item.machine || typeof item.machine !== "object") return false
      const machine = item.machine as { active_step_id?: string }
      if (machine.active_step_id !== "review") return false
      if (!("step_runs" in item) || !Array.isArray(item.step_runs)) return false
      return item.step_runs.some(
        (run) =>
          run &&
          typeof run === "object" &&
          !Array.isArray(run) &&
          run.step_id === "review_architect" &&
          run.status === "failed",
      )
    })
    expect(mixed).toBeDefined()
    if (
      !mixed ||
      typeof mixed !== "object" ||
      Array.isArray(mixed) ||
      !("step_runs" in mixed) ||
      !Array.isArray(mixed.step_runs) ||
      !("transitions" in mixed) ||
      !Array.isArray(mixed.transitions) ||
      !("workflow" in mixed) ||
      !mixed.workflow ||
      typeof mixed.workflow !== "object" ||
      !("phase" in mixed) ||
      !mixed.phase ||
      typeof mixed.phase !== "object"
    ) {
      throw new Error("expected mixed review results progress")
    }
    expect(mixed.workflow).toMatchObject({ status: "retrying" })
    expect(mixed.phase).toMatchObject({ status: "retrying" })
    expect(mixed.step_runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step_id: "review", status: "retrying" }),
        expect.objectContaining({ step_id: "review_architect", status: "failed" }),
        expect.objectContaining({ step_id: "review_qa", status: "completed" }),
        expect.objectContaining({ step_id: "review_fe", status: "completed" }),
        expect.objectContaining({ step_id: "review_test", status: "completed" }),
      ]),
    )

    const last = updates.at(-1)
    expect(last).toBeDefined()
    if (!last || typeof last !== "object" || Array.isArray(last)) throw new Error("expected final workflow progress")
    if (!("step_runs" in last) || !Array.isArray(last.step_runs)) throw new Error("expected final step runs")
    expect(last.step_runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "implement-1", step_id: "implement", status: "completed" }),
        expect.objectContaining({ id: "fix-1", step_id: "fix", status: "completed" }),
        expect.objectContaining({ id: "review-1", step_id: "review", status: "retrying" }),
        expect.objectContaining({ id: "review-2", step_id: "review", status: "completed" }),
        expect.objectContaining({ id: "final_verify-1", step_id: "final_verify", status: "failed" }),
        expect.objectContaining({ id: "final_fix-1", step_id: "final_fix", status: "completed" }),
        expect.objectContaining({ id: "final_verify-2", step_id: "final_verify", status: "completed" }),
        expect.objectContaining({ id: "retrospective-1", step_id: "retrospective", status: "completed" }),
        expect.objectContaining({ id: "done-1", step_id: "done", status: "completed" }),
      ]),
    )

    if (!("transitions" in last) || !Array.isArray(last.transitions)) throw new Error("expected final transitions")
    expect(last.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target_id: "final_verify", run_id: "final_verify-1", to_state: "active" }),
        expect.objectContaining({ target_id: "final_verify", run_id: "final_verify-1", to_state: "failed" }),
        expect.objectContaining({ target_id: "final_fix", run_id: "final_fix-1", to_state: "active" }),
        expect.objectContaining({ target_id: "final_verify", run_id: "final_verify-2", to_state: "active" }),
        expect.objectContaining({ target_id: "final_verify", run_id: "final_verify-2", to_state: "completed" }),
      ]),
    )

    const verify = updates.find((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false
      if (!("machine" in item) || !item.machine || typeof item.machine !== "object") return false
      const machine = item.machine as { active_step_id?: string }
      if (machine.active_step_id !== "final_verify") return false
      if (!("workflow" in item) || !item.workflow || typeof item.workflow !== "object") return false
      const workflow = item.workflow as { status?: string }
      return workflow.status === "retrying"
    })
    expect(verify).toBeDefined()
    if (
      !verify ||
      typeof verify !== "object" ||
      Array.isArray(verify) ||
      !("phase" in verify) ||
      !verify.phase ||
      !("workflow" in verify) ||
      !verify.workflow
    ) {
      throw new Error("expected failed final verify progress")
    }
    expect(verify.workflow).toMatchObject({ status: "retrying" })
    expect(verify.phase).toMatchObject({ status: "failed" })

    const trans = mixed.transitions as Array<Record<string, unknown>>
    const architect = trans.find((item) => item.run_id === "review_architect-1" && item.to_state === "failed")
    expect(architect).toBeDefined()
    expect(architect).toMatchObject({
      from_state: "active",
      source: {
        type: "agent",
        name: "Architect",
        role: "reviewer",
        step_id: "review_architect",
        run_id: "review_architect-1",
      },
    })

    const view = workflowscreen({
      metadata: {
        [WorkflowProgressKey]: mixed,
      },
      name: "implement",
      tool_status: "running",
    })
    expect(view.empty).toBe(false)
    expect(view.timeline.map((item) => ({ step_id: item.step_id, status: item.status }))).toEqual(
      expect.arrayContaining([
        { step_id: "review", status: "retrying" },
        { step_id: "review_architect", status: "failed" },
        { step_id: "review_qa", status: "completed" },
        { step_id: "review_fe", status: "completed" },
        { step_id: "review_test", status: "completed" },
      ]),
    )
    expect(view.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Architect review", source: "Architect", to_state: "failed" }),
      ]),
    )
  })

  test("emits a terminal failed progress update when the operator stops after repair rounds", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/implement.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({ git: true, config: {} })
    const updates: unknown[] = []

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
      async status(input) {
        if (input.progress) updates.push(input.progress)
      },
      async write(input) {
        const file = path.isAbsolute(input.file) ? input.file : path.join(tmp.path, input.file)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, input.content, "utf8")
      },
      async ask() {
        return {
          answers: [["Stop workflow"]],
        }
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

        if (input.description === "US-001 implement" || input.description.startsWith("US-001 fix ")) {
          return {
            session_id: `sess_${input.description.replace(/\s+/g, "_").toLowerCase()}`,
            text: `Worked on ${input.description}`,
          }
        }

        if (input.description.includes("review")) {
          const role = input.description.split(" ")[1]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              approve: role !== "Architect",
              summary: `${role} reviewed the story`,
              issues: role === "Architect" ? ["Keep fixing"] : [],
            }),
          }
        }

        if (input.description.startsWith("US-001 tests ")) {
          return {
            session_id: "sess_test_runner",
            text: "VERIFY: PASS",
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

    expect(out.output).toContain("Paused on: US-001")
    const last = updates.at(-1)
    expect(last).toBeDefined()
    if (!last || typeof last !== "object" || Array.isArray(last)) throw new Error("expected failed workflow progress")
    expect(last).toMatchObject({
      version: "workflow-progress.v2",
      workflow: { status: "failed" },
      machine: { active_step_id: "failed" },
    })
    expect("round" in last).toBe(false)
    if (!("transitions" in last)) throw new Error("expected failed transitions")
    expect(last.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "step", target_id: "failed", to_state: "failed" }),
        expect.objectContaining({ level: "workflow", target_id: "workflow", to_state: "failed" }),
      ]),
    )
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
            text: "VERIFY: PASS",
          }
        }

        if (input.description === "Final test run 1") {
          return {
            session_id: "sess_final_test",
            text: "VERIFY: PASS",
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
            text: "VERIFY: PASS",
          }
        }

        if (input.description === "Final test run 1") {
          return {
            session_id: "sess_final_test",
            text: "VERIFY: PASS",
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
          expect(input.session_id).toBeUndefined()
          return {
            session_id: "sess_test_runner_1",
            text: "VERIFY: FAIL\nFAILURES:\nempty state test is missing",
          }
        }

        if (input.description === "US-001 fix 1") {
          expect(input.session_id).toBe("sess_impl_1")
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
          expect(input.session_id).toBeUndefined()
          return {
            session_id: "sess_test_runner_2",
            text: "VERIFY: PASS",
          }
        }

        if (input.description === "Final test run 1") {
          return {
            session_id: "sess_final_test",
            text: "VERIFY: PASS",
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
            text: "VERIFY: PASS",
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
            text: "VERIFY: PASS",
          }
        }

        if (input.description === "Final test run 1") {
          return {
            session_id: "sess_final_test",
            text: "VERIFY: PASS",
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

  test("treats custom ask input as continue and passes it into the next repair prompt", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/implement.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({ git: true, config: {} })
    const jobs: TaskInput[] = []
    let askCount = 0

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
        askCount += 1
        return {
          answers: [["fix architect issues and keep test pass, then goto next user story"]],
        }
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
            session_id: "sess_impl_1",
            text: "Implemented US-001 first pass.",
          }
        }

        if (input.description.startsWith("US-001 fix ")) {
          if (input.description === "US-001 fix 5") {
            expect(input.prompt).toContain(
              "Operator instruction: fix architect issues and keep test pass, then goto next user story",
            )
            return {
              session_id: "sess_impl_6",
              text: "Applied the requested architect fix and kept verification clean.",
            }
          }

          return {
            session_id: `sess_impl_${input.description.split(" ").at(-1)}`,
            text: `Repair round for ${input.description}`,
          }
        }

        if (input.description.includes("review 7")) {
          const role = input.description.split(" ")[1]
          return {
            session_id: `sess_${role.toLowerCase()}_7`,
            text: JSON.stringify({
              role,
              approve: true,
              summary: `${role} approves implementation`,
              issues: [],
            }),
          }
        }

        if (input.description.includes("review")) {
          const role = input.description.split(" ")[1]
          return {
            session_id: `sess_${role.toLowerCase()}`,
            text: JSON.stringify({
              role,
              approve: role !== "Architect",
              summary: `${role} reviewed implementation`,
              issues: role === "Architect" ? ["Keep fixing"] : [],
            }),
          }
        }

        if (input.description === "US-001 tests 7" || input.description === "Final test run 1") {
          return {
            session_id: "sess_test_runner_final",
            text: "VERIFY: PASS",
          }
        }

        if (input.description.startsWith("US-001 tests ")) {
          return {
            session_id: "sess_test_runner",
            text: "VERIFY: PASS",
          }
        }

        if (input.description === "Implementation retrospective") {
          return {
            session_id: "sess_retro",
            text: "- Continued after operator guidance and completed the story",
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

    expect(askCount).toBe(1)
    expect(jobs.some((item) => item.description === "US-001 fix 5")).toBe(true)
    expect(out.output).toContain("Stories completed: 1/1")
  })

  test("retries test-runner when output format is invalid", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/implement.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({ git: true, config: {} })
    const jobs: TaskInput[] = []
    let testCount = 0

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
          testCount += 1
          if (testCount === 1) {
            return {
              session_id: "sess_test_runner_1",
              text: "all green",
            }
          }

          expect(input.prompt).toContain("did not follow the required verification format")
          return {
            session_id: "sess_test_runner_2",
            text: "VERIFY: PASS",
          }
        }

        if (input.description === "Final test run 1") {
          return {
            session_id: "sess_final_test",
            text: "VERIFY: PASS",
          }
        }

        if (input.description === "Implementation retrospective") {
          return {
            session_id: "sess_retro",
            text: "- Retried verification after invalid test-runner output",
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

    await flow.run(ctx, {
      raw: "# Demo PRD\n\n## Goals\n\n- Add one tiny feature",
      argv: [],
      files: [],
    })

    expect(testCount).toBe(2)
  })

  test("marks completed stories and advances by smallest unfinished priority", async () => {
    Reflect.set(globalThis, "opencode", runtime)
    const mod = await import(
      pathToFileURL(path.resolve(import.meta.dir, "../../../../.opencode/workflows/implement.ts")).href
    )
    const flow = mod.default

    await using tmp = await tmpdir({ git: true, config: {} })
    const jobs: TaskInput[] = []
    const updates: unknown[] = []

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
            text: "VERIFY: PASS",
          }
        }

        if (input.description === "Final test run 1") {
          return {
            session_id: "sess_final_test",
            text: "VERIFY: PASS",
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
    const steps = updates.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return []
      if (!("machine" in item) || !item.machine || typeof item.machine !== "object") return []
      if (!("active_step_id" in item.machine) || typeof item.machine.active_step_id !== "string") return []
      return [item.machine.active_step_id]
    })
    const review = steps.indexOf("review")
    const select = steps.indexOf("select", review + 1)
    expect(review).toBeGreaterThan(-1)
    expect(select).toBeGreaterThan(review)
    const loop = updates[select]
    expect(loop).toBeDefined()
    if (!loop || typeof loop !== "object" || Array.isArray(loop)) throw new Error("expected loop progress")
    if (!("step_definitions" in loop) || !Array.isArray(loop.step_definitions)) {
      throw new Error("expected workflow step definitions")
    }
    expect(loop.step_definitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "review", next: ["fix", "select", "done", "failed"] })]),
    )

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
            text: "VERIFY: PASS",
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
            text: "VERIFY: PASS",
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

  test("resumes a paused story from the next repair round", async () => {
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
                  title: "Resume story",
                  description: "todo",
                  acceptanceCriteria: ["Done", "Typecheck passes"],
                  priority: 1,
                  passes: false,
                  notes: "",
                },
              ],
            },
            null,
            2,
          ),
        )
        await fs.mkdir(path.join(dir, ".workflows", "logs", "implement-tasks-prds-demo"), { recursive: true })
        await fs.writeFile(
          path.join(dir, ".workflows", "logs", "implement-tasks-prds-demo", "run.json"),
          JSON.stringify(
            {
              source: "tasks/prds/demo.md",
              prd_file: "tasks/prd.json",
              log_dir: ".workflows/logs/implement-tasks-prds-demo",
              reused: true,
              roles: {},
              branch: null,
              split_rounds: [],
              stories: [
                {
                  story: "US-001",
                  title: "Resume story",
                  rounds: [
                    {
                      round: 1,
                      work: "earlier work",
                      reviews: [],
                      review_issues: ["Architect: keep fixing"],
                      test_output: "VERIFY: PASS",
                      test_failures: "",
                      issues: ["Architect: keep fixing"],
                    },
                  ],
                  decisions: [],
                  unresolved: [],
                  commit: null,
                },
              ],
              final_verify: [],
              paused: {
                story: "US-001",
                round: 6,
                next_round: 7,
                handoff: "Last handoff",
                fix: "Repair story US-001 (Resume story).",
                guide: "Keep architect fix focused",
                issues: ["Architect: keep fixing"],
              },
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

        if (input.description === "US-001 fix 6") {
          expect(input.prompt).toContain("Review round: 7")
          expect(input.prompt).toContain("Previous round handoff:\nLast handoff")
          expect(input.prompt).toContain("Operator instruction: Keep architect fix focused")
          return {
            session_id: "sess_impl_resume",
            text: "Resumed from the paused repair round and finished the fix.",
          }
        }

        if (input.description.includes("review 7")) {
          const role = input.description.split(" ")[1]
          return {
            session_id: `sess_${role.toLowerCase()}_7`,
            text: JSON.stringify({
              role,
              approve: true,
              summary: `${role} approves implementation`,
              issues: [],
            }),
          }
        }

        if (input.description === "US-001 tests 7" || input.description === "Final test run 1") {
          return {
            session_id: "sess_test_runner",
            text: "VERIFY: PASS",
          }
        }

        if (input.description === "Implementation retrospective") {
          return {
            session_id: "sess_retro",
            text: "- Resumed the paused story from round 7",
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

    expect(jobs.some((item) => item.description === "US-001 implement")).toBe(false)
    expect(jobs.some((item) => item.description === "US-001 fix 6")).toBe(true)

    const log = JSON.parse(
      await Bun.file(path.join(tmp.path, ".workflows", "logs", "implement-tasks-prds-demo", "run.json")).text(),
    ) as {
      paused: null | Record<string, unknown>
      stories: Array<{ story: string; rounds: Array<{ round: number }> }>
    }
    expect(log.paused).toBeNull()
    expect(log.stories.find((item) => item.story === "US-001")?.rounds.map((item) => item.round)).toEqual([1, 7])
    expect(out.output).toContain("Stories completed: 1/1")
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
