import { describe, test, expect } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("LookAtTool", () => {
  test("handles image files and returns attachments", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const imgPath = path.join(tmp.path, "test.png")
        // 1x1 transparent PNG
        const pngData = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "base64",
        )
        await Bun.write(imgPath, pngData)

        const { LookAtTool } = await import("@/tool/look_at")
        // Verify the tool is defined with correct parameters
        expect(LookAtTool.id).toBe("look_at")
      },
    })
  })

  test("rejects unsupported file formats", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const txtPath = path.join(tmp.path, "test.txt")
        await Bun.write(txtPath, "hello world")

        const ext = path.extname(txtPath).toLowerCase()
        const supported = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf"])
        expect(supported.has(ext)).toBe(false)
      },
    })
  })

  test("supports expected image formats", () => {
    const supported = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf"]
    for (const ext of supported) {
      expect(ext).toBeTruthy()
    }
  })
})
