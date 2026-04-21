import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import path from "path"
import os from "os"
import { Filesystem } from "../util/filesystem"

const app = "lark-opencode"
const prev = "opencode"

const data = path.join(process.env.XDG_DATA_HOME || xdgData!, app)
const cache = path.join(process.env.XDG_CACHE_HOME || xdgCache!, app)
const config = path.join(process.env.XDG_CONFIG_HOME || xdgConfig!, app)
const state = path.join(process.env.XDG_STATE_HOME || xdgState!, app)
const legacy = {
  data: path.join(process.env.XDG_DATA_HOME || xdgData!, prev),
  config: path.join(process.env.XDG_CONFIG_HOME || xdgConfig!, prev),
  state: path.join(process.env.XDG_STATE_HOME || xdgState!, prev),
} as const

export namespace Global {
  export const Path = {
    // Allow override via OPENCODE_TEST_HOME for test isolation
    get home() {
      return process.env.OPENCODE_TEST_HOME || os.homedir()
    },
    data,
    bin: path.join(data, "bin"),
    log: path.join(data, "log"),
    cache,
    config,
    state,
  }
}

async function copy(from: string, to: string, stats: { copied: number; skipped: number }) {
  const list = await fs.readdir(from, { withFileTypes: true }).catch(() => [])
  for (const item of list) {
    const src = path.join(from, item.name)
    const dst = path.join(to, item.name)
    if (item.isDirectory()) {
      await fs.mkdir(dst, { recursive: true })
      await copy(src, dst, stats)
      continue
    }
    if (!item.isFile()) continue
    if (await Filesystem.exists(dst)) {
      stats.skipped++
      continue
    }
    await fs.mkdir(path.dirname(dst), { recursive: true })
    await fs.copyFile(src, dst)
    stats.copied++
  }
}

async function migrate() {
  const file = path.join(Global.Path.state, "opencode-migration.json")
  if (await Filesystem.exists(file)) return

  const stats = {
    copied: 0,
    skipped: 0,
    roots: [] as string[],
  }

  for (const [key, from] of Object.entries(legacy)) {
    if (!(await Filesystem.isDir(from))) continue
    stats.roots.push(key)
    await copy(from, Global.Path[key as keyof typeof legacy], stats)
  }

  await Filesystem.writeJson(file, {
    from: prev,
    to: app,
    time: Date.now(),
    ...stats,
  })
}

await Promise.all([
  fs.mkdir(Global.Path.data, { recursive: true }),
  fs.mkdir(Global.Path.config, { recursive: true }),
  fs.mkdir(Global.Path.state, { recursive: true }),
  fs.mkdir(Global.Path.log, { recursive: true }),
  fs.mkdir(Global.Path.bin, { recursive: true }),
])

await migrate()

const CACHE_VERSION = "21"

const version = await Filesystem.readText(path.join(Global.Path.cache, "version")).catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Global.Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Global.Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch (e) {}
  await Filesystem.write(path.join(Global.Path.cache, "version"), CACHE_VERSION)
}
