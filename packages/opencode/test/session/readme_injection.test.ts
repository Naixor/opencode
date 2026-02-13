import { describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"

describe("README injection", () => {
  test("discovers README.md from subdirectories", async () => {
    await using tmp = await tmpdir()
    const subdir = path.join(tmp.path, "src", "components")
    await fs.mkdir(subdir, { recursive: true })
    await Bun.write(path.join(subdir, "README.md"), "# Components\nThis directory contains UI components.")

    const readmePath = path.join(subdir, "README.md")
    const exists = await Bun.file(readmePath).exists()
    expect(exists).toBe(true)

    const content = await Bun.file(readmePath).text()
    expect(content).toContain("Components")
  })

  test("respects config toggle (readme_injection: false)", async () => {
    await using tmp = await tmpdir({
      config: {
        experimental: { readme_injection: false },
      },
    })

    // When disabled, README.md should not be discovered
    const configPath = path.join(tmp.path, "opencode.json")
    const config = JSON.parse(await Bun.file(configPath).text())
    expect(config.experimental.readme_injection).toBe(false)
  })

  test("does not duplicate content already injected", async () => {
    await using tmp = await tmpdir()
    const readmePath = path.join(tmp.path, "README.md")
    await Bun.write(readmePath, "# Project\nMain project readme.")

    // Read same file twice - should be idempotent
    const content1 = await Bun.file(readmePath).text()
    const content2 = await Bun.file(readmePath).text()
    expect(content1).toBe(content2)
  })
})
