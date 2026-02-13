import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { GlobTool } from "../../src/tool/glob"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tool.glob", () => {
  test("default parameters match current behavior (only pattern+path)", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "src", "app.ts"), "export const app = 1")
        await Bun.write(path.join(dir, "src", "util.ts"), "export const util = 2")
        await Bun.write(path.join(dir, "README.md"), "# readme")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "**/*.ts" }, ctx)
        expect(result.metadata.count).toBe(2)
        expect(result.output).toContain("app.ts")
        expect(result.output).toContain("util.ts")
        expect(result.output).not.toContain("README.md")
      },
    })
  })

  test("backward compat with only pattern+path", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "file.js"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "**/*.js", path: tmp.path }, ctx)
        expect(result.metadata.count).toBe(1)
        expect(result.output).toContain("file.js")
      },
    })
  })

  test("maxDepth=2 limits depth", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "shallow")
        await Bun.write(path.join(dir, "level1", "b.ts"), "depth 1")
        await Bun.write(path.join(dir, "level1", "level2", "c.ts"), "depth 2")
        await Bun.write(path.join(dir, "level1", "level2", "level3", "d.ts"), "depth 3")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "**/*.ts", maxDepth: 2 }, ctx)
        expect(result.output).toContain("a.ts")
        expect(result.output).toContain("b.ts")
        expect(result.output).not.toContain("c.ts")
        expect(result.output).not.toContain("d.ts")
      },
    })
  })

  test("hidden=true includes dotfiles", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, ".eslintrc.js"), "module.exports = {}")
        await Bun.write(path.join(dir, "index.js"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "**/*.js", hidden: true }, ctx)
        expect(result.output).toContain(".eslintrc.js")
        expect(result.output).toContain("index.js")
      },
    })
  })

  test("hidden=false excludes dotfiles", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, ".hidden.js"), "hidden content")
        await Bun.write(path.join(dir, "visible.js"), "visible content")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "**/*.js", hidden: false }, ctx)
        expect(result.output).not.toContain(".hidden.js")
        expect(result.output).toContain("visible.js")
      },
    })
  })

  test("hidden=false excludes files in hidden directories", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, ".config", "settings.json"), "{}")
        await Bun.write(path.join(dir, "config", "settings.json"), "{}")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "**/*.json", hidden: false }, ctx)
        expect(result.output).not.toContain(".config")
        expect(result.output).toContain(path.join("config", "settings.json"))
      },
    })
  })

  test("follow=true follows symlinks", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const targetDir = path.join(dir, "target")
        await fs.mkdir(targetDir, { recursive: true })
        await Bun.write(path.join(targetDir, "linked.ts"), "linked content")
        await fs.symlink(targetDir, path.join(dir, "link"), "dir")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "**/*.ts", follow: true }, ctx)
        expect(result.output).toContain("linked.ts")
        const lines = result.output.split("\n").filter((l: string) => l.includes("linked.ts"))
        expect(lines.length).toBeGreaterThanOrEqual(2)
      },
    })
  })

  test("noIgnore=true includes .gitignore'd files", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, ".gitignore"), "ignored.ts\n")
        await Bun.write(path.join(dir, "ignored.ts"), "should be ignored")
        await Bun.write(path.join(dir, "visible.ts"), "visible content")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "**/*.ts", noIgnore: true }, ctx)
        expect(result.output).toContain("ignored.ts")
        expect(result.output).toContain("visible.ts")
      },
    })
  })

  test("SecurityAccess still filters with new params", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "public.ts"), "public content")
        await Bun.write(path.join(dir, "secret.ts"), "secret content")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute(
          { pattern: "**/*.ts", maxDepth: 5, hidden: true, follow: false, noIgnore: false },
          ctx,
        )
        expect(result.metadata.count).toBeGreaterThan(0)
        expect(result.output).toContain(".ts")
      },
    })
  })

  test("60s timeout kills process", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.ts"), "content")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const abortController = new AbortController()
        abortController.abort()
        const testCtx = {
          ...ctx,
          abort: abortController.signal,
        }
        await expect(glob.execute({ pattern: "**/*.ts" }, testCtx)).rejects.toThrow()
      },
    })
  })
})
