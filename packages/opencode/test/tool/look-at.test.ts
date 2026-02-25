import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from "bun:test"
import path from "path"
import fs from "fs"
import { LookAtTool } from "../../src/tool/look-at"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { setupSecurityConfig, teardownSecurityConfig } from "../security/access_control_cases/helpers"
import { Provider } from "../../src/provider/provider"

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

// Create a minimal 1x1 PNG (base64) for testing
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

// Mock the generateText function to avoid real API calls
const mockGenerateText = mock(() =>
  Promise.resolve({ text: "Analysis: This image shows a 1x1 pixel." }),
)

// Keep mock.module for "ai" (external module, named function import)
mock.module("ai", () => ({
  generateText: mockGenerateText,
}))

// Use spyOn for Provider namespace to avoid leaking mock.module to other test files
const mockGetLanguage = mock(() => Promise.resolve({}))
const mockGetModel = mock(() =>
  Promise.resolve({
    id: "gemini-2.5-flash",
    providerID: "google",
    api: { id: "gemini-2.5-flash" },
  }),
)
const mockParseModel = mock((model: string) => {
  const [providerID, ...rest] = model.split("/")
  return { providerID, modelID: rest.join("/") }
})
const mockProviderList = mock(() =>
  Promise.resolve({
    google: {
      id: "google",
      models: {
        "gemini-2.5-flash": { id: "gemini-2.5-flash", providerID: "google" },
      },
    },
  }),
)

const spies: Array<ReturnType<typeof spyOn>> = []

describe("look_at tool", () => {
  beforeEach(() => {
    spies.push(
      spyOn(Provider, "getModel").mockImplementation(mockGetModel as typeof Provider.getModel),
      spyOn(Provider, "getLanguage").mockImplementation(mockGetLanguage as typeof Provider.getLanguage),
      spyOn(Provider, "parseModel").mockImplementation(mockParseModel as typeof Provider.parseModel),
      spyOn(Provider, "list").mockImplementation(mockProviderList as typeof Provider.list),
      spyOn(Provider, "defaultModel").mockImplementation(async () => ({ providerID: "google", modelID: "gemini-2.5-flash" }) as Awaited<ReturnType<typeof Provider.defaultModel>>),
    )
  })

  afterEach(() => {
    spies.forEach((s) => s.mockRestore())
    spies.length = 0
    teardownSecurityConfig()
    mockGenerateText.mockClear()
    mockGetModel.mockClear()
    mockGetLanguage.mockClear()
  })

  test("file_path to image -> read + analyzed", async () => {
    await using tmp = await tmpdir()
    const imgPath = path.join(tmp.path, "test.png")
    fs.writeFileSync(imgPath, Buffer.from(TINY_PNG_BASE64, "base64"))

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LookAtTool.init()
        const result = await tool.execute(
          { file_path: imgPath, goal: "Describe this image" },
          ctx,
        )
        expect(result.output).toContain("Analysis")
        expect(result.metadata.error).toBeUndefined()
        expect(mockGenerateText).toHaveBeenCalled()
      },
    })
  })

  test("base64 image_data -> analyzed without file read", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LookAtTool.init()
        const result = await tool.execute(
          { image_data: TINY_PNG_BASE64, goal: "What is this?" },
          ctx,
        )
        expect(result.output).toContain("Analysis")
        expect(result.title).toBe("base64 image")
        expect(mockGenerateText).toHaveBeenCalled()
      },
    })
  })

  test("base64 image_data with data: prefix -> analyzed", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LookAtTool.init()
        const result = await tool.execute(
          {
            image_data: `data:image/png;base64,${TINY_PNG_BASE64}`,
            goal: "What is this?",
          },
          ctx,
        )
        expect(result.output).toContain("Analysis")
        expect(mockGenerateText).toHaveBeenCalled()
      },
    })
  })

  test("neither file_path nor image_data provided -> error", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LookAtTool.init()
        const result = await tool.execute({ goal: "Analyze" }, ctx)
        expect(result.output).toContain("At least one of file_path or image_data must be provided")
        expect(result.metadata.error).toBe(true)
      },
    })
  })

  test("protected file -> SecurityAccess denies read", async () => {
    await using tmp = await tmpdir()
    const realPath = fs.realpathSync(tmp.path)
    const imgPath = path.join(realPath, "secret.png")
    fs.writeFileSync(imgPath, Buffer.from(TINY_PNG_BASE64, "base64"))

    await setupSecurityConfig(
      {
        version: "1.0",
        roles: [{ name: "viewer", level: 1 }],
        rules: [
          {
            pattern: `${realPath}/secret.png`,
            type: "file" as const,
            deniedOperations: ["read" as const],
            allowedRoles: [],
          },
        ],
      },
      realPath,
    )

    await Instance.provide({
      directory: realPath,
      fn: async () => {
        const tool = await LookAtTool.init()
        const result = await tool.execute(
          { file_path: imgPath, goal: "Analyze" },
          ctx,
        )
        expect(result.output).toContain("Security access denied")
        expect(result.output).toContain("reading file")
        expect(result.metadata.securityDenied).toBe(true)
        expect(mockGenerateText).not.toHaveBeenCalled()
      },
    })
  })

  test("read allowed but llm denied -> blocked before vision model", async () => {
    await using tmp = await tmpdir()
    const realPath = fs.realpathSync(tmp.path)
    const imgPath = path.join(realPath, "sensitive.png")
    fs.writeFileSync(imgPath, Buffer.from(TINY_PNG_BASE64, "base64"))

    await setupSecurityConfig(
      {
        version: "1.0",
        roles: [{ name: "viewer", level: 1 }],
        rules: [
          {
            pattern: `${realPath}/sensitive.png`,
            type: "file" as const,
            deniedOperations: ["llm" as const],
            allowedRoles: [],
          },
        ],
      },
      realPath,
    )

    await Instance.provide({
      directory: realPath,
      fn: async () => {
        const tool = await LookAtTool.init()
        const result = await tool.execute(
          { file_path: imgPath, goal: "Analyze" },
          ctx,
        )
        expect(result.output).toContain("Security access denied")
        expect(result.output).toContain("vision model")
        expect(result.metadata.securityDenied).toBe(true)
        expect(mockGenerateText).not.toHaveBeenCalled()
      },
    })
  })

  test("goal parameter affects extraction", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LookAtTool.init()
        await tool.execute(
          { image_data: TINY_PNG_BASE64, goal: "Extract all text labels" },
          ctx,
        )
        const calls = mockGenerateText.mock.calls
        expect(calls.length).toBeGreaterThan(0)
        const call = calls[calls.length - 1] as unknown as [{ messages: Array<{ content: Array<{ type: string; text?: string }> }> }]
        const textPart = call[0].messages[0].content.find(
          (p: { type: string }) => p.type === "text",
        ) as { type: string; text: string }
        expect(textPart.text).toBe("Extract all text labels")
      },
    })
  })

  test("unsupported file type -> clear error", async () => {
    await using tmp = await tmpdir()
    const txtPath = path.join(tmp.path, "data.xyz")
    fs.writeFileSync(txtPath, "not an image")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LookAtTool.init()
        const result = await tool.execute(
          { file_path: txtPath, goal: "Analyze" },
          ctx,
        )
        expect(result.output).toContain("Unsupported file type")
        expect(result.output).toContain(".xyz")
        expect(result.metadata.unsupportedType).toBe(true)
        expect(mockGenerateText).not.toHaveBeenCalled()
      },
    })
  })

  test("file not found -> error message", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LookAtTool.init()
        const result = await tool.execute(
          { file_path: "/nonexistent/image.png", goal: "Analyze" },
          ctx,
        )
        expect(result.output).toContain("File not found")
        expect(result.metadata.error).toBe(true)
      },
    })
  })

  test("supported image extensions are accepted", async () => {
    const extensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".pdf"]
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        for (const ext of extensions) {
          const filePath = path.join(tmp.path, `test${ext}`)
          fs.writeFileSync(filePath, Buffer.from(TINY_PNG_BASE64, "base64"))

          const tool = await LookAtTool.init()
          const result = await tool.execute(
            { file_path: filePath, goal: "Analyze" },
            ctx,
          )
          expect(result.metadata.error).toBeUndefined()
          expect(result.output).toContain("Analysis")
        }
      },
    })
  })

  test("relative file path resolved against Instance.directory", async () => {
    await using tmp = await tmpdir()
    const imgPath = path.join(tmp.path, "screenshot.png")
    fs.writeFileSync(imgPath, Buffer.from(TINY_PNG_BASE64, "base64"))

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LookAtTool.init()
        const result = await tool.execute(
          { file_path: "screenshot.png", goal: "Analyze" },
          ctx,
        )
        expect(result.output).toContain("Analysis")
        expect(result.metadata.error).toBeUndefined()
      },
    })
  })
})
