import { expect, test } from "bun:test"
import path from "path"

const root = path.join(__dirname, "../..")
const tui = path.join(root, "src", "cli", "cmd", "tui")

test("TUI custom components do not pass explicit children props", async () => {
  const files = await Array.fromAsync(
    new Bun.Glob("**/*.tsx").scan({
      cwd: tui,
      absolute: true,
      onlyFiles: true,
    }),
  )

  const hits = (
    await Promise.all(
      files.map(async (file) => {
        const text = await Bun.file(file).text()
        return Array.from(text.matchAll(/<([A-Z][A-Za-z0-9]*)\b[^>]*\bchildren=\{/g)).map(
          (item) => `${path.relative(root, file)}:${item[1]}`,
        )
      }),
    )
  ).flat()

  expect(hits).toEqual([])
})

test("session inline spinner renders children through JSX slot", async () => {
  const file = path.join(tui, "routes", "session", "index.tsx")
  const text = await Bun.file(file).text()

  expect(text).toContain("<Spinner color={fg()}>{props.label}</Spinner>")
  expect(text).not.toContain("<Spinner color={fg()} children={props.label} />")
})

test("session route stringifies risky text payloads before rendering", async () => {
  const file = path.join(tui, "routes", "session", "index.tsx")
  const text = await Bun.file(file).text()

  expect(text).toContain("<text fg={theme.textMuted}>{str(props.message.error?.data.message)}</text>")
  expect(text).toContain("<text fg={theme.error}>{str(error())}</text>")
  expect(text).toContain("<text fg={theme.textMuted}>{str(q.question)}</text>")
  expect(text).toContain("function str(input: unknown)")
  expect(text).toContain("return JSON.stringify(input)")
})
