import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"

const file = path.resolve(import.meta.dir, "../../src/global/index.ts")
const mod = pathToFileURL(file).href

async function run(dir: string, tag: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, "-e", `await import(${JSON.stringify(`${mod}?${tag}=${Date.now()}`)})`],
    env: {
      ...process.env,
      OPENCODE_TEST_HOME: path.join(dir, "home"),
      XDG_DATA_HOME: path.join(dir, "share"),
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_STATE_HOME: path.join(dir, "state"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const code = await proc.exited
  const err = await new Response(proc.stderr).text()
  expect(code).toBe(0)
  expect(err).toBe("")
}

describe("global migration", () => {
  test("copies legacy opencode data into lark-opencode on import", async () => {
    await using tmp = await tmpdir()
    const oldData = path.join(tmp.path, "share", "opencode")
    const oldCfg = path.join(tmp.path, "config", "opencode")
    const oldState = path.join(tmp.path, "state", "opencode")
    const nextData = path.join(tmp.path, "share", "lark-opencode")
    const nextCfg = path.join(tmp.path, "config", "lark-opencode")
    const nextState = path.join(tmp.path, "state", "lark-opencode")

    await fs.mkdir(path.join(oldData, "memory"), { recursive: true })
    await fs.mkdir(oldCfg, { recursive: true })
    await fs.mkdir(oldState, { recursive: true })
    await Bun.write(path.join(oldData, "auth.json"), '{"ok":true}')
    await Bun.write(path.join(oldData, "memory", "personal.json"), '{"memories":{}}')
    await Bun.write(path.join(oldCfg, "opencode.json"), '{"model":"x/y"}')
    await Bun.write(path.join(oldState, "model.json"), '{"id":"m"}')

    await run(tmp.path, "copy")

    expect(await Bun.file(path.join(nextData, "auth.json")).text()).toBe('{"ok":true}')
    expect(await Bun.file(path.join(nextData, "memory", "personal.json")).text()).toBe('{"memories":{}}')
    expect(await Bun.file(path.join(nextCfg, "opencode.json")).text()).toBe('{"model":"x/y"}')
    expect(await Bun.file(path.join(nextState, "model.json")).text()).toBe('{"id":"m"}')
    expect(await Bun.file(path.join(nextState, "opencode-migration.json")).exists()).toBe(true)
  })

  test("does not overwrite existing lark-opencode data", async () => {
    await using tmp = await tmpdir()
    const oldData = path.join(tmp.path, "share", "opencode")
    const nextData = path.join(tmp.path, "share", "lark-opencode")

    await fs.mkdir(oldData, { recursive: true })
    await fs.mkdir(nextData, { recursive: true })
    await Bun.write(path.join(oldData, "auth.json"), '{"old":true}')
    await Bun.write(path.join(oldData, "extra.json"), '{"extra":true}')
    await Bun.write(path.join(nextData, "auth.json"), '{"new":true}')

    await run(tmp.path, "skip")

    expect(await Bun.file(path.join(nextData, "auth.json")).text()).toBe('{"new":true}')
    expect(await Bun.file(path.join(nextData, "extra.json")).text()).toBe('{"extra":true}')
  })
})
