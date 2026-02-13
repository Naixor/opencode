import z from "zod"
import path from "path"
import { generateText } from "ai"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { SecurityAccess } from "../security/access"
import { SecurityConfig } from "../security/config"
import { SecurityAudit } from "../security/audit"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { Identifier } from "../id/id"

import DESCRIPTION from "./look-at.txt"

const securityLog = Log.create({ service: "security-look-at" })

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
])

const SUPPORTED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".pdf",
])

function getDefaultRole(config: { roles?: Array<{ name: string; level: number }> }): string {
  const roles = config.roles ?? []
  if (roles.length === 0) return "viewer"
  const lowestRole = roles.reduce((prev, curr) => (curr.level < prev.level ? curr : prev), roles[0])
  return lowestRole.name
}

const VISION_MODEL_PRIORITY = [
  "gemini-2.5-flash",
  "gemini-2-flash",
  "gemini-3-flash",
  "gpt-5-mini",
  "gpt-4-turbo",
  "claude-haiku-4.5",
  "claude-haiku-4-5",
  "claude-sonnet-4",
]

async function resolveVisionModel(): Promise<{ providerID: string; modelID: string }> {
  const cfg = await Config.get()
  const visionModel = (cfg as Record<string, unknown>).vision_model as string | undefined
  if (visionModel) {
    return Provider.parseModel(visionModel)
  }

  const providers = await Provider.list()
  for (const hint of VISION_MODEL_PRIORITY) {
    for (const provider of Object.values(providers)) {
      for (const modelID of Object.keys(provider.models)) {
        if (modelID.includes(hint)) {
          return { providerID: provider.id, modelID }
        }
      }
    }
  }

  const defaultModel = await Provider.defaultModel()
  return defaultModel
}

export const LookAtTool = Tool.define("look_at", {
  description: DESCRIPTION,
  parameters: z.object({
    file_path: z.string().describe("Path to an image, screenshot, PDF, or diagram file").optional(),
    image_data: z.string().describe("Base64-encoded image data").optional(),
    goal: z.string().describe("What to analyze or extract from the image"),
  }),
  async execute(
    params,
    ctx,
  ): Promise<{ title: string; metadata: { [key: string]: unknown }; output: string }> {
    if (!params.file_path && !params.image_data) {
      return {
        title: "Error",
        metadata: { error: true },
        output: "Error: At least one of file_path or image_data must be provided.",
      }
    }

    let imageUrl: string
    let mime: string
    let title: string

    if (params.file_path) {
      let filepath = params.file_path
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(Instance.directory, filepath)
      }
      title = path.relative(Instance.worktree, filepath)

      const file = Bun.file(filepath)
      if (!(await file.exists())) {
        return {
          title,
          metadata: { error: true },
          output: `Error: File not found: ${filepath}`,
        }
      }

      const ext = path.extname(filepath).toLowerCase()
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        return {
          title,
          metadata: { error: true, unsupportedType: true },
          output: `Error: Unsupported file type '${ext}'. Supported types: ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
        }
      }

      const config = SecurityConfig.getSecurityConfig()
      const currentRole = getDefaultRole(config)

      const readAccess = SecurityAccess.checkAccess(filepath, "read", currentRole)
      securityLog.debug("read access check", {
        path: filepath,
        role: currentRole,
        allowed: readAccess.allowed,
      })

      if (!readAccess.allowed) {
        SecurityAudit.logSecurityEvent({
          role: currentRole,
          operation: "read",
          path: filepath,
          allowed: false,
          reason: readAccess.reason,
        })
        return {
          title,
          metadata: { error: true, securityDenied: true },
          output: `Error: Security access denied for reading file: ${readAccess.reason}`,
        }
      }

      const llmAccess = SecurityAccess.checkAccess(filepath, "llm", currentRole)
      securityLog.debug("llm access check", {
        path: filepath,
        role: currentRole,
        allowed: llmAccess.allowed,
      })

      if (!llmAccess.allowed) {
        SecurityAudit.logSecurityEvent({
          role: currentRole,
          operation: "llm",
          path: filepath,
          allowed: false,
          reason: llmAccess.reason,
        })
        return {
          title,
          metadata: { error: true, securityDenied: true },
          output: `Error: Security access denied for sending file to vision model: ${llmAccess.reason}`,
        }
      }

      mime = file.type
      const isPdf = mime === "application/pdf" || ext === ".pdf"
      if (isPdf) {
        mime = "application/pdf"
      }

      if (!isPdf && !SUPPORTED_IMAGE_TYPES.has(mime)) {
        mime = extensionToMime(ext)
      }

      const bytes = await file.bytes()
      imageUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
    } else {
      title = "base64 image"
      mime = "image/png"
      imageUrl = params.image_data!.startsWith("data:")
        ? params.image_data!
        : `data:image/png;base64,${params.image_data}`
    }

    const resolved = await resolveVisionModel()
    const model = await Provider.getModel(resolved.providerID, resolved.modelID).catch(() => null)

    if (!model) {
      return {
        title,
        metadata: { error: true },
        output: `Error: Vision model '${resolved.providerID}/${resolved.modelID}' not available. Configure 'vision_model' in opencode.jsonc or ensure a vision-capable model is available.`,
      }
    }

    const language = await Provider.getLanguage(model)

    const isPdfMime = mime === "application/pdf"
    const contentParts: Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType?: string } | { type: "file"; data: string; mediaType: string }> = [
      { type: "text", text: params.goal },
    ]

    if (isPdfMime) {
      contentParts.push({
        type: "file",
        data: imageUrl,
        mediaType: mime,
      })
    } else {
      contentParts.push({
        type: "image",
        image: imageUrl,
        mediaType: mime,
      })
    }

    const result = await generateText({
      model: language,
      messages: [
        {
          role: "user",
          content: contentParts,
        },
      ],
      system: "You are a precise visual analysis assistant. Analyze the provided image and respond to the user's goal. Be thorough but concise. Focus on extracting exactly the information requested.",
    })

    return {
      title,
      metadata: {
        model: `${resolved.providerID}/${resolved.modelID}`,
        truncated: false,
      },
      output: result.text,
    }
  },
})

function extensionToMime(ext: string): string {
  switch (ext) {
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".gif":
      return "image/gif"
    case ".webp":
      return "image/webp"
    case ".bmp":
      return "image/bmp"
    case ".tiff":
    case ".tif":
      return "image/tiff"
    case ".pdf":
      return "application/pdf"
    default:
      return "application/octet-stream"
  }
}
