import { Tool } from "./tool"
import z from "zod"
import { SecurityConfig } from "../security/config"
import { SecurityAccess } from "../security/access"
import { SecurityUtil } from "../security/util"
import { Instance } from "../project/instance"
import path from "path"
import type { MessageV2 } from "../session/message-v2"

const IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"])
const PDFS = new Set([".pdf"])

function mime(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
  }
  return map[ext] ?? "application/octet-stream"
}

export const LookAtTool = Tool.define("look_at", {
  description:
    "Analyze media files (PDFs, images, diagrams) that require interpretation beyond raw text. Extracts specific information or summaries from documents, describes visual content. Use when you need analyzed/extracted data rather than literal file contents.",
  parameters: z.object({
    file_path: z.string().optional().describe("Path to image or PDF file to analyze"),
    goal: z.string().describe("What to analyze or extract from the file"),
    image_data: z.string().optional().describe("Base64-encoded image data (when file path not available)"),
  }),
  execute: async (args) => {
    if (!args.file_path && !args.image_data)
      return {
        title: "Error",
        output: "Either file_path or image_data must be provided.",
        metadata: { truncated: false },
      }

    const attachments: MessageV2.FilePart[] = []

    if (args.file_path) {
      const resolved = path.resolve(Instance.directory, args.file_path)
      const config = SecurityConfig.getSecurityConfig()
      const role = SecurityUtil.getDefaultRole(config)
      const access = SecurityAccess.checkAccess(resolved, "read", role)
      if (!access.allowed)
        return { title: "Access denied", output: access.reason ?? "Access denied", metadata: { truncated: false } }

      const ext = path.extname(resolved).toLowerCase()
      if (!IMAGES.has(ext) && !PDFS.has(ext))
        return {
          title: "Unsupported format",
          output: `Unsupported file format: ${ext}. Supported: PNG, JPG, GIF, WebP, SVG, PDF`,
          metadata: { truncated: false },
        }

      const exists = await Bun.file(resolved).exists()
      if (!exists) return { title: "Not found", output: `File not found: ${resolved}`, metadata: { truncated: false } }

      const buffer = await Bun.file(resolved).arrayBuffer()
      const base64 = Buffer.from(buffer).toString("base64")
      const m = mime(ext)

      attachments.push({
        id: "",
        sessionID: "",
        messageID: "",
        type: "file",
        url: `data:${m};base64,${base64}`,
        mime: m,
        filename: path.basename(resolved),
      } as MessageV2.FilePart)
    }

    if (args.image_data) {
      attachments.push({
        id: "",
        sessionID: "",
        messageID: "",
        type: "file",
        url: `data:image/png;base64,${args.image_data}`,
        mime: "image/png",
        filename: "image.png",
      } as MessageV2.FilePart)
    }

    return {
      title: args.file_path ? path.basename(args.file_path) : "Image analysis",
      output: `Analyze the following with this goal: ${args.goal}\n\nThe file has been attached for multimodal analysis.`,
      metadata: { truncated: false },
      attachments,
    }
  },
})
