import z from "zod"
import { Tool } from "./tool"
import path from "path"
import { LSP } from "../lsp"
import { Instance } from "../project/instance"
import { pathToFileURL, fileURLToPath } from "url"
import { assertExternalDirectory } from "./external-directory"
import { SecurityAccess } from "../security/access"
import { Log } from "@/util/log"
import DIAGNOSTICS_DESC from "./lsp-diagnostics.txt"
import PREPARE_RENAME_DESC from "./lsp-prepare-rename.txt"
import RENAME_DESC from "./lsp-rename.txt"
import CALL_HIERARCHY_DESC from "./lsp-call-hierarchy.txt"

const log = Log.create({ service: "tool.lsp-extended" })

function resolveFile(filePath: string) {
  return path.isAbsolute(filePath) ? filePath : path.join(Instance.directory, filePath)
}

function relPath(file: string) {
  return path.relative(Instance.worktree, file)
}

async function ensureLsp(file: string) {
  const exists = await Bun.file(file).exists()
  if (!exists) throw new Error(`File not found: ${file}`)
  const available = await LSP.hasClients(file)
  if (!available) throw new Error("No LSP server available for this file type.")
  await LSP.touchFile(file, true)
}

function filterByAccess<T extends { uri?: string; location?: { uri?: string } }>(results: T[]): T[] {
  return results.filter((item) => {
    const uri = item.uri ?? item.location?.uri
    if (!uri) return true
    const filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri
    const result = SecurityAccess.checkAccess(filePath, "read", "agent")
    return result.allowed
  })
}

function formatLocation(item: Record<string, unknown>): string {
  const uri = (item.uri as string) ?? ((item.location as Record<string, unknown>)?.uri as string)
  if (!uri) return JSON.stringify(item, null, 2)
  const filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri
  const range = (item.range ?? (item.location as Record<string, unknown>)?.range) as
    | Record<string, Record<string, number>>
    | undefined
  if (!range) return relPath(filePath)
  return `${relPath(filePath)}:${range.start.line + 1}:${range.start.character + 1}`
}

const severityMap: Record<number, string> = {
  1: "ERROR",
  2: "WARNING",
  3: "INFORMATION",
  4: "HINT",
}

const severityFilter: Record<string, number[]> = {
  error: [1],
  warning: [2],
  information: [3],
  hint: [4],
  all: [1, 2, 3, 4],
}

export const LspDiagnosticsTool = Tool.define("lsp_diagnostics", {
  description: DIAGNOSTICS_DESC,
  parameters: z.object({
    filePath: z.string().describe("File path to check for LSP server availability"),
    severity: z
      .enum(["error", "warning", "information", "hint", "all"])
      .optional()
      .default("all")
      .describe("Filter diagnostics by severity level"),
  }),
  execute: async (args, ctx) => {
    const file = resolveFile(args.filePath)
    await assertExternalDirectory(ctx, file)
    await ctx.ask({ permission: "lsp", patterns: ["*"], always: ["*"], metadata: {} })
    await ensureLsp(file)

    const allDiagnostics = await LSP.diagnostics()
    const allowedSeverities = severityFilter[args.severity]
    const lines: string[] = []
    let totalCount = 0

    for (const [filePath, diagnostics] of Object.entries(allDiagnostics)) {
      const accessResult = SecurityAccess.checkAccess(filePath, "read", "agent")
      if (!accessResult.allowed) continue

      const filtered = diagnostics.filter((d) => allowedSeverities.includes(d.severity ?? 1))
      if (filtered.length === 0) continue

      totalCount += filtered.length
      for (const d of filtered) {
        const severity = severityMap[d.severity ?? 1] ?? "UNKNOWN"
        const line = d.range.start.line + 1
        const col = d.range.start.character + 1
        const rel = relPath(filePath)
        lines.push(`${severity} [${line}:${col}] ${d.message} (${rel}:${line}:${col})`)
      }
    }

    const title = `diagnostics:${args.severity}`

    if (lines.length === 0)
      return { title, metadata: { totalCount: 0 }, output: `No ${args.severity} diagnostics found` }

    return { title, metadata: { totalCount }, output: lines.join("\n") }
  },
})

export const LspPrepareRenameTool = Tool.define("lsp_prepare_rename", {
  description: PREPARE_RENAME_DESC,
  parameters: z.object({
    filePath: z.string().describe("The absolute or relative path to the file"),
    line: z.number().int().min(1).describe("The line number (1-based)"),
    character: z.number().int().min(1).describe("The character offset (1-based)"),
  }),
  execute: async (args, ctx) => {
    const file = resolveFile(args.filePath)
    await assertExternalDirectory(ctx, file)
    await ctx.ask({ permission: "lsp", patterns: ["*"], always: ["*"], metadata: {} })
    await ensureLsp(file)

    const position = { file, line: args.line - 1, character: args.character - 1 }
    const result = await LSP.prepareRename(position)
    const title = `prepareRename ${relPath(file)}:${args.line}:${args.character}`

    if (result.length === 0) return { title, metadata: { result: [] }, output: "Symbol cannot be renamed at this position" }

    const item = result[0] as Record<string, unknown>
    const range = (item.range ?? item) as Record<string, Record<string, number>> | undefined
    const placeholder = (item.placeholder as string) ?? ""

    const parts: string[] = []
    if (placeholder) parts.push(`Symbol: ${placeholder}`)
    if (range?.start) parts.push(`Range: ${range.start.line + 1}:${range.start.character + 1} - ${range.end.line + 1}:${range.end.character + 1}`)
    parts.push("Symbol can be renamed. Use lsp_rename to perform the rename.")

    return { title, metadata: { result }, output: parts.join("\n") }
  },
})

export const LspRenameTool = Tool.define("lsp_rename", {
  description: RENAME_DESC,
  parameters: z.object({
    filePath: z.string().describe("The absolute or relative path to the file"),
    line: z.number().int().min(1).describe("The line number (1-based)"),
    character: z.number().int().min(1).describe("The character offset (1-based)"),
    newName: z.string().min(1).describe("The new name for the symbol"),
  }),
  execute: async (args, ctx) => {
    const file = resolveFile(args.filePath)
    await assertExternalDirectory(ctx, file)
    await ctx.ask({ permission: "lsp", patterns: ["*"], always: ["*"], metadata: {} })
    await ensureLsp(file)

    const position = { file, line: args.line - 1, character: args.character - 1, newName: args.newName }
    const result = await LSP.rename(position)
    const title = `rename ${relPath(file)}:${args.line}:${args.character} -> ${args.newName}`

    if (result.length === 0) return { title, metadata: { result: [], affectedFiles: 0 }, output: "Rename failed or symbol cannot be renamed" }

    const workspaceEdit = result[0] as Record<string, unknown>
    const changes = (workspaceEdit.changes ?? {}) as Record<string, unknown[]>
    const documentChanges = (workspaceEdit.documentChanges ?? []) as Record<string, unknown>[]

    const affectedFiles: string[] = []
    const lines: string[] = []

    if (Object.keys(changes).length > 0) {
      for (const [uri, edits] of Object.entries(changes)) {
        const filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri
        const accessResult = SecurityAccess.checkAccess(filePath, "read", "agent")
        if (!accessResult.allowed) continue
        affectedFiles.push(relPath(filePath))
        lines.push(`${relPath(filePath)}: ${(edits as unknown[]).length} change(s)`)
      }
    }

    if (documentChanges.length > 0) {
      for (const change of documentChanges) {
        const textDocument = change.textDocument as Record<string, string> | undefined
        const uri = textDocument?.uri
        if (!uri) continue
        const filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri
        const accessResult = SecurityAccess.checkAccess(filePath, "read", "agent")
        if (!accessResult.allowed) continue
        const edits = (change.edits ?? []) as unknown[]
        affectedFiles.push(relPath(filePath))
        lines.push(`${relPath(filePath)}: ${edits.length} change(s)`)
      }
    }

    if (lines.length === 0) return { title, metadata: { result, affectedFiles: 0 }, output: "No accessible files affected by rename" }

    const output = `Rename '${args.newName}' affects ${affectedFiles.length} file(s):\n${lines.join("\n")}`
    return { title, metadata: { result, affectedFiles: affectedFiles.length }, output }
  },
})

export const LspCallHierarchyTool = Tool.define("lsp_call_hierarchy", {
  description: CALL_HIERARCHY_DESC,
  parameters: z.object({
    filePath: z.string().describe("The absolute or relative path to the file"),
    line: z.number().int().min(1).describe("The line number (1-based)"),
    character: z.number().int().min(1).describe("The character offset (1-based)"),
    direction: z.enum(["prepare", "incoming", "outgoing"]).describe("The call hierarchy direction"),
  }),
  execute: async (args, ctx) => {
    const file = resolveFile(args.filePath)
    await assertExternalDirectory(ctx, file)
    await ctx.ask({ permission: "lsp", patterns: ["*"], always: ["*"], metadata: {} })
    await ensureLsp(file)

    const position = { file, line: args.line - 1, character: args.character - 1 }
    const title = `callHierarchy:${args.direction} ${relPath(file)}:${args.line}:${args.character}`

    if (args.direction === "prepare") {
      const result = await LSP.prepareCallHierarchy(position)
      const filtered = filterByAccess(result as Record<string, unknown>[])

      if (filtered.length === 0) return { title, metadata: { result: filtered }, output: "No call hierarchy item found at this position" }

      const output = filtered
        .map((item) => {
          const name = (item as Record<string, unknown>).name as string
          const kind = (item as Record<string, unknown>).kind as number
          const loc = formatLocation(item)
          return `${name} (kind: ${kind}) ${loc}`
        })
        .join("\n")
      return { title, metadata: { result: filtered }, output }
    }

    if (args.direction === "incoming") {
      const result = await LSP.incomingCalls(position)
      const items = (result as Record<string, unknown>[]).map((item) => {
        const from = (item as Record<string, unknown>).from as Record<string, unknown> | undefined
        return from ?? item
      })
      const filtered = filterByAccess(items)

      if (filtered.length === 0) return { title, metadata: { result: filtered }, output: "No incoming calls found" }

      const output = filtered.map((item) => {
        const name = item.name as string
        const loc = formatLocation(item)
        return `${name} ${loc}`
      }).join("\n")
      return { title, metadata: { result: filtered }, output }
    }

    // outgoing
    const result = await LSP.outgoingCalls(position)
    const items = (result as Record<string, unknown>[]).map((item) => {
      const to = (item as Record<string, unknown>).to as Record<string, unknown> | undefined
      return to ?? item
    })
    const filtered = filterByAccess(items)

    if (filtered.length === 0) return { title, metadata: { result: filtered }, output: "No outgoing calls found" }

    const output = filtered.map((item) => {
      const name = item.name as string
      const loc = formatLocation(item)
      return `${name} ${loc}`
    }).join("\n")
    return { title, metadata: { result: filtered }, output }
  },
})
