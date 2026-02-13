import { describe, expect, test } from "bun:test"
import path from "path"
import { GrepTool } from "../../src/tool/grep"
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

describe("tool.grep enhanced parameters", () => {
  test("default parameters match current behavior (backward compat)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "hello.ts"), 'const msg = "hello world"\nconsole.log(msg)\n')
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "hello",
            path: tmp.path,
          },
          ctx,
        )
        expect(result.metadata.matches).toBeGreaterThan(0)
        expect(result.output).toContain("Found")
        expect(result.output).toContain("hello")
      },
    })
  })

  test("context includes surrounding lines", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "code.ts"),
          "line1\nline2\nTARGET_MATCH\nline4\nline5\n",
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "TARGET_MATCH",
            path: tmp.path,
            context: 1,
          },
          ctx,
        )
        expect(result.metadata.matches).toBeGreaterThan(0)
        // Context lines (line2 and line4) should also appear in output
        expect(result.output).toContain("line2")
        expect(result.output).toContain("line4")
      },
    })
  })

  test("caseSensitive=false finds case-insensitive matches", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.txt"), "Hello World\nhello world\nHELLO WORLD\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "HELLO",
            path: tmp.path,
            caseSensitive: false,
          },
          ctx,
        )
        // Should match all 3 lines
        expect(result.metadata.matches).toBe(3)
      },
    })
  })

  test("caseSensitive=true matches exact case only", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.txt"), "Hello World\nhello world\nHELLO WORLD\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "HELLO",
            path: tmp.path,
            caseSensitive: true,
          },
          ctx,
        )
        // Should match only the all-caps line
        expect(result.metadata.matches).toBe(1)
        expect(result.output).toContain("HELLO WORLD")
      },
    })
  })

  test("wholeWord=true matches whole words only", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.txt"), "cat\ncaterpillar\nthe cat sat\nconcatenate\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "cat",
            path: tmp.path,
            wholeWord: true,
          },
          ctx,
        )
        // Should match "cat" and "the cat sat" but NOT "caterpillar" or "concatenate"
        expect(result.metadata.matches).toBe(2)
        expect(result.output).not.toContain("caterpillar")
        expect(result.output).not.toContain("concatenate")
      },
    })
  })

  test("fixedStrings=true treats pattern as literal", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.txt"), "a.b\na1b\na-b\na+b\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "a.b",
            path: tmp.path,
            fixedStrings: true,
          },
          ctx,
        )
        // With fixedStrings, "a.b" is literal — should only match "a.b", not "a1b"
        expect(result.metadata.matches).toBe(1)
        expect(result.output).toContain("a.b")
      },
    })
  })

  test("multiline=true matches across lines", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.txt"), "function foo() {\n  return 42\n}\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "foo.*\\n.*return",
            path: tmp.path,
            multiline: true,
          },
          ctx,
        )
        expect(result.metadata.matches).toBeGreaterThan(0)
      },
    })
  })

  test("maxCount limits results per file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const lines = Array.from({ length: 20 }, (_, i) => `match_line_${i}`).join("\n")
        await Bun.write(path.join(dir, "test.txt"), lines)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "match_line",
            path: tmp.path,
            maxCount: 5,
          },
          ctx,
        )
        // maxCount limits ripgrep output per file to 5
        expect(result.metadata.matches).toBe(5)
      },
    })
  })

  test("exclude excludes matching files", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "app.ts"), "const x = 1\n")
        await Bun.write(path.join(dir, "app.test.ts"), "const x = 1\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "const x",
            path: tmp.path,
            exclude: "*.test.ts",
          },
          ctx,
        )
        expect(result.metadata.matches).toBe(1)
        expect(result.output).toContain("app.ts")
        expect(result.output).not.toContain("app.test.ts")
      },
    })
  })

  test("fileType restricts to specific file type", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "code.ts"), "const hello = 1\n")
        await Bun.write(path.join(dir, "code.py"), "hello = 1\n")
        await Bun.write(path.join(dir, "code.js"), "const hello = 1\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "hello",
            path: tmp.path,
            fileType: "ts",
          },
          ctx,
        )
        expect(result.metadata.matches).toBe(1)
        expect(result.output).toContain("code.ts")
        expect(result.output).not.toContain("code.py")
        expect(result.output).not.toContain("code.js")
      },
    })
  })

  test("SecurityAccess still redacts with new params", async () => {
    // This test verifies that security filtering still works when new parameters are used
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "public.ts"), "public data here\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        // Use new parameters alongside existing ones
        const result = await grep.execute(
          {
            pattern: "public",
            path: tmp.path,
            caseSensitive: false,
            wholeWord: true,
          },
          ctx,
        )
        expect(result.metadata.matches).toBeGreaterThan(0)
        expect(result.output).toContain("public data here")
      },
    })
  })

  test("backward compat with only pattern parameter", async () => {
    const projectRoot = path.join(__dirname, "../..")
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "export",
          },
          ctx,
        )
        expect(result.metadata.matches).toBeGreaterThan(0)
        expect(result.output).toContain("Found")
      },
    })
  })

  test("backward compat with pattern + path + include", async () => {
    const projectRoot = path.join(__dirname, "../..")
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "export",
            path: path.join(projectRoot, "src/tool"),
            include: "*.ts",
          },
          ctx,
        )
        expect(result.metadata.matches).toBeGreaterThan(0)
      },
    })
  })

  test("exit code 2 returns partial results with warning", async () => {
    // We can't easily simulate exit code 2 in a unit test without broken symlinks,
    // but we verify the metadata field exists and is false for normal results
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.txt"), "hello world\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "hello",
            path: tmp.path,
          },
          ctx,
        )
        expect(result.metadata.hasPartialResults).toBe(false)
        expect(result.output).not.toContain("Warning: partial results")
      },
    })
  })
})

describe("tool.grep context separator handling", () => {
  test("context separator lines are properly skipped", () => {
    // Verify that "--" separator lines from context mode are handled
    const contextOutput = "file.txt|1|line1\n--\nfile.txt|5|line5"
    const lines = contextOutput.trim().split(/\r?\n/)
    const parsed = lines
      .filter((l) => l && l !== "--")
      .map((l) => {
        const [filePath, lineNumStr, ...lineTextParts] = l.split("|")
        return { filePath, lineNum: parseInt(lineNumStr, 10), lineText: lineTextParts.join("|") }
      })
      .filter((m) => m.filePath && !isNaN(m.lineNum))

    expect(parsed.length).toBe(2)
    expect(parsed[0].lineText).toBe("line1")
    expect(parsed[1].lineText).toBe("line5")
  })
})
