import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { Identifier } from "../id/id"
import { assertExternalDirectory } from "./external-directory"
import { InstructionPrompt } from "../session/instruction"
import { SecurityAccess } from "../security/access"
import { SecurityConfig } from "../security/config"
import { SecuritySchema } from "../security/schema"
import { SecuritySegments } from "../security/segments"
import { SecurityRedact } from "../security/redact"
import { Log } from "../util/log"

const securityLog = Log.create({ service: "security-read" })

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024

export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The path to the file to read"),
    offset: z.coerce.number().describe("The line number to start reading from (0-based)").optional(),
    limit: z.coerce.number().describe("The number of lines to read (defaults to 2000)").optional(),
  }),
  async execute(params, ctx) {
    let filepath = params.filePath
    if (!path.isAbsolute(filepath)) {
      filepath = path.resolve(Instance.directory, filepath)
    }
    const title = path.relative(Instance.worktree, filepath)

    await assertExternalDirectory(ctx, filepath, {
      bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
    })

    await ctx.ask({
      permission: "read",
      patterns: [filepath],
      always: ["*"],
      metadata: {},
    })

    const file = Bun.file(filepath)
    if (!(await file.exists())) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)

      const dirEntries = fs.readdirSync(dir)
      const suggestions = dirEntries
        .filter(
          (entry) =>
            entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
        )
        .map((entry) => path.join(dir, entry))
        .slice(0, 3)

      if (suggestions.length > 0) {
        throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
      }

      throw new Error(`File not found: ${filepath}`)
    }

    // Security access control check
    const config = SecurityConfig.getSecurityConfig()
    const currentRole = getDefaultRole(config)

    // Check file-level access
    const accessResult = SecurityAccess.checkAccess(filepath, "read", currentRole)
    securityLog.debug("read access check", {
      path: filepath,
      role: currentRole,
      allowed: accessResult.allowed,
      reason: accessResult.reason,
    })

    if (!accessResult.allowed) {
      throw new Error(`Security: ${accessResult.reason}`)
    }

    const instructions = await InstructionPrompt.resolve(ctx.messages, filepath, ctx.messageID)

    // Exclude SVG (XML-based) and vnd.fastbidsheet (.fbs extension, commonly FlatBuffers schema files)
    const isImage =
      file.type.startsWith("image/") && file.type !== "image/svg+xml" && file.type !== "image/vnd.fastbidsheet"
    const isPdf = file.type === "application/pdf"
    if (isImage || isPdf) {
      const mime = file.type
      const msg = `${isImage ? "Image" : "PDF"} read successfully`
      return {
        title,
        output: msg,
        metadata: {
          preview: msg,
          truncated: false,
          ...(instructions.length > 0 && { loaded: instructions.map((i) => i.filepath) }),
        },
        attachments: [
          {
            id: Identifier.ascending("part"),
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            type: "file",
            mime,
            url: `data:${mime};base64,${Buffer.from(await file.bytes()).toString("base64")}`,
          },
        ],
      }
    }

    const isBinary = await isBinaryFile(filepath, file)
    if (isBinary) throw new Error(`Cannot read binary file: ${filepath}`)

    const limit = params.limit ?? DEFAULT_READ_LIMIT
    const offset = params.offset || 0

    // Read file content and apply segment-level redaction if needed
    let fileContent = await file.text()
    const protectedSegments = findProtectedSegments(filepath, fileContent, config, currentRole)

    if (protectedSegments.length > 0) {
      securityLog.debug("redacting protected segments", {
        path: filepath,
        segmentCount: protectedSegments.length,
      })
      fileContent = SecurityRedact.redactContent(fileContent, protectedSegments)
    }

    const lines = fileContent.split("\n")

    const raw: string[] = []
    let bytes = 0
    let truncatedByBytes = false
    for (let i = offset; i < Math.min(lines.length, offset + limit); i++) {
      const line = lines[i].length > MAX_LINE_LENGTH ? lines[i].substring(0, MAX_LINE_LENGTH) + "..." : lines[i]
      const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
      if (bytes + size > MAX_BYTES) {
        truncatedByBytes = true
        break
      }
      raw.push(line)
      bytes += size
    }

    const content = raw.map((line, index) => {
      return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
    })
    const preview = raw.slice(0, 20).join("\n")

    let output = "<file>\n"
    output += content.join("\n")

    const totalLines = lines.length
    const lastReadLine = offset + raw.length
    const hasMoreLines = totalLines > lastReadLine
    const truncated = hasMoreLines || truncatedByBytes

    if (truncatedByBytes) {
      output += `\n\n(Output truncated at ${MAX_BYTES} bytes. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else if (hasMoreLines) {
      output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else {
      output += `\n\n(End of file - total ${totalLines} lines)`
    }
    output += "\n</file>"

    // just warms the lsp client
    LSP.touchFile(filepath, false)
    FileTime.read(ctx.sessionID, filepath)

    if (instructions.length > 0) {
      output += `\n\n<system-reminder>\n${instructions.map((i) => i.content).join("\n\n")}\n</system-reminder>`
    }

    return {
      title,
      output,
      metadata: {
        preview,
        truncated,
        ...(instructions.length > 0 && { loaded: instructions.map((i) => i.filepath) }),
      },
    }
  },
})

async function isBinaryFile(filepath: string, file: Bun.BunFile): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()
  // binary check for common non-text extensions
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  const stat = await file.stat()
  const fileSize = stat.size
  if (fileSize === 0) return false

  const bufferSize = Math.min(4096, fileSize)
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength === 0) return false
  const bytes = new Uint8Array(buffer.slice(0, bufferSize))

  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++
    }
  }
  // If >30% non-printable characters, consider it binary
  return nonPrintableCount / bytes.length > 0.3
}

/**
 * Get the default role from security config.
 * Returns the lowest level role, or "viewer" if no roles defined.
 * Note: This is a placeholder until US-027 implements proper role detection.
 */
function getDefaultRole(config: SecuritySchema.SecurityConfig): string {
  const roles = config.roles ?? []
  if (roles.length === 0) {
    return "viewer"
  }
  // Find the role with the lowest level (least privileges)
  const lowestRole = roles.reduce((prev, curr) => (curr.level < prev.level ? curr : prev), roles[0])
  return lowestRole.name
}

/**
 * Find protected segments in file content that should be redacted.
 * Checks both marker-based and AST-based segment rules.
 */
function findProtectedSegments(
  filepath: string,
  content: string,
  config: SecuritySchema.SecurityConfig,
  currentRole: string,
): SecurityRedact.Segment[] {
  const segments: SecurityRedact.Segment[] = []
  const segmentsConfig = config.segments

  if (!segmentsConfig) {
    return segments
  }

  const roles = config.roles ?? []
  const roleLevel = getRoleLevel(currentRole, roles)

  // Find marker-based segments
  if (segmentsConfig.markers && segmentsConfig.markers.length > 0) {
    const markerSegments = SecuritySegments.findMarkerSegments(content, segmentsConfig.markers)
    for (const segment of markerSegments) {
      // Check if this segment denies "read" and the role is not allowed
      if (segment.rule.deniedOperations.includes("read") && !isRoleAllowed(currentRole, roleLevel, segment.rule.allowedRoles, roles)) {
        segments.push({ start: segment.start, end: segment.end })
      }
    }
  }

  // Find AST-based segments
  if (segmentsConfig.ast && segmentsConfig.ast.length > 0) {
    const astSegments = SecuritySegments.findASTSegments(filepath, content, segmentsConfig.ast)
    for (const segment of astSegments) {
      // Check if this segment denies "read" and the role is not allowed
      if (segment.rule.deniedOperations.includes("read") && !isRoleAllowed(currentRole, roleLevel, segment.rule.allowedRoles, roles)) {
        segments.push({ start: segment.start, end: segment.end })
      }
    }
  }

  return segments
}

/**
 * Get the level for a given role name.
 */
function getRoleLevel(roleName: string, roles: SecuritySchema.Role[]): number {
  const role = roles.find((r) => r.name === roleName)
  return role?.level ?? 0
}

/**
 * Check if a role is allowed based on role hierarchy.
 * Higher level roles can access content allowed for lower levels.
 */
function isRoleAllowed(
  roleName: string,
  roleLevel: number,
  allowedRoles: string[],
  allRoles: SecuritySchema.Role[],
): boolean {
  // Direct match
  if (allowedRoles.includes(roleName)) {
    return true
  }

  // Check role hierarchy - higher level roles can access lower level content
  for (const allowedRoleName of allowedRoles) {
    const allowedRoleLevel = getRoleLevel(allowedRoleName, allRoles)
    if (roleLevel > allowedRoleLevel) {
      return true
    }
  }

  return false
}
