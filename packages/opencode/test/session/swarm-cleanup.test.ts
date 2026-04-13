import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { SwarmCleanup } from "../../src/session/swarm-cleanup"
import { Swarm } from "../../src/session/swarm"
import { SwarmState } from "../../src/session/swarm-state"

describe("SwarmCleanup", () => {
  test("supports dry-run and cleanup marker flow", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = path.join(Global.Path.data, "projects", Instance.project.id, "board")
        await Bun.write(path.join(root, "swarms.json"), "[]")
        await Bun.write(path.join(root, "SW-old", "state.json"), "{}")

        const dry = await SwarmCleanup.run({ dry_run: true })
        expect(dry.stats.total).toBe(2)
        expect(await SwarmCleanup.ready()).toBe(false)
        await expect(SwarmCleanup.assertReady()).rejects.toThrow("cleanup completes")

        const done = await SwarmCleanup.run({ dry_run: false, confirm: "purge-legacy-swarms" })
        expect(done.ready).toBe(true)
        expect(await SwarmCleanup.ready()).toBe(true)
        expect(await Bun.file(path.join(root, "swarms.json")).exists()).toBe(false)
        expect(await Bun.file(path.join(root, "SW-old", "state.json")).exists()).toBe(false)
      },
    })
  })

  test("blocks launch until cleanup completes and then creates schema version 3 swarms", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(Swarm.launch({ goal: "Should block" })).rejects.toThrow("cleanup completes")
        await SwarmCleanup.run({ dry_run: false, confirm: "purge-legacy-swarms" })
        const info = await Swarm.launch({ goal: "Ready for v3" })
        const state = await SwarmState.read(info.id)
        expect(state?.schema_version).toBe(3)
        expect(state?.alignment.catalog.scope).toBe("project")
        expect(state?.alignment.catalog.roles).toEqual({})
      },
    })
  })

  test("dedupes repeated launch requests with the same key", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SwarmCleanup.run({ dry_run: false, confirm: "purge-legacy-swarms" })
        const a = await Swarm.launch({ goal: "Ready for v3", dedupe_key: "launch-1" })
        const b = await Swarm.launch({ goal: "Ready for v3", dedupe_key: "launch-1" })
        expect(b.id).toBe(a.id)
        expect((await Swarm.list()).map((item) => item.id)).toEqual([a.id])
      },
    })
  })

  test("queues prepared workers before execution starts", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SwarmCleanup.run({ dry_run: false, confirm: "purge-legacy-swarms" })
        const info = await Swarm.launch({ goal: "Ready for v3" })
        const queued = await Swarm.enlist({
          swarm_id: info.id,
          session_id: "SE-worker-1",
          agent: "atlas",
          task_id: "T-1",
          status: "queued",
        })
        expect(queued.stage).toBe("dispatching")
        expect(queued.reason).toBe("awaiting worker confirmation")
        expect(queued.workers[0]?.status).toBe("queued")
        expect(queued.workers[0]?.task_id).toBe("T-1")

        const running = await Swarm.enlist({
          swarm_id: info.id,
          session_id: "SE-worker-1",
          agent: "atlas",
          task_id: "T-1",
          status: "running",
        })
        expect(running.stage).toBe("executing")
        expect(running.reason).toBeNull()
        expect(running.workers[0]?.status).toBe("running")
        expect(running.workers[0]?.task_id).toBe("T-1")
      },
    })
  })
})
