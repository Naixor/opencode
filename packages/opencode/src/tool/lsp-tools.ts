import z from "zod"
import { Tool } from "./tool"
import path from "path"
import { LSP } from "../lsp"
import { Instance } from "../project/instance"
import { pathToFileURL, fileURLToPath } from "url"
import { assertExternalDirectory } from "./external-directory"
import { SecurityAccess } from "../security/access"
import GOTO_DEFINITION_DESC from "./lsp-goto-definition.txt"
import FIND_REFERENCES_DESC from "./lsp-find-references.txt"
import SYMBOLS_DESC from "./lsp-symbols.txt"
import HOVER_DESC from "./lsp-hover.txt"
import IMPLEMENTATION_DESC from "./lsp-implementation.txt"

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
    const filePath = (() => {
      if (uri.startsWith("file://")) return fileURLToPath(uri)
      return uri
    })()
    const result = SecurityAccess.checkAccess(filePath, "read", "agent")
    return result.allowed
  })
}

function formatLocation(item: Record<string, unknown>): string {
  const uri = (item.uri as string) ?? (item.location as Record<string, unknown>)?.uri as string
  if (!uri) return JSON.stringify(item, null, 2)
  const filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri
  const range = (item.range ?? (item.location as Record<string, unknown>)?.range) as Record<string, Record<string, number>> | undefined
  if (!range) return relPath(filePath)
  return `${relPath(filePath)}:${range.start.line + 1}:${range.start.character + 1}`
}

export const LspGotoDefinitionTool = Tool.define("lsp_goto_definition", {
  description: GOTO_DEFINITION_DESC,
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
    const result = await LSP.definition(position)
    const filtered = filterByAccess(result as Record<string, unknown>[])
    const title = `goToDefinition ${relPath(file)}:${args.line}:${args.character}`

    if (filtered.length === 0) return { title, metadata: { result: filtered }, output: "No definition found" }

    const output = filtered.map(formatLocation).join("\n")
    return { title, metadata: { result: filtered }, output }
  },
})

export const LspFindReferencesTool = Tool.define("lsp_find_references", {
  description: FIND_REFERENCES_DESC,
  parameters: z.object({
    filePath: z.string().describe("The absolute or relative path to the file"),
    line: z.number().int().min(1).describe("The line number (1-based)"),
    character: z.number().int().min(1).describe("The character offset (1-based)"),
    includeDeclaration: z.boolean().optional().default(true).describe("Whether to include the declaration itself"),
    limit: z.number().int().positive().optional().default(100).describe("Maximum number of results"),
  }),
  execute: async (args, ctx) => {
    const file = resolveFile(args.filePath)
    await assertExternalDirectory(ctx, file)
    await ctx.ask({ permission: "lsp", patterns: ["*"], always: ["*"], metadata: {} })
    await ensureLsp(file)

    const position = { file, line: args.line - 1, character: args.character - 1 }
    const uri = pathToFileURL(file).href

    const result = await LSP.references(position) as Record<string, unknown>[]
    const filtered = filterByAccess(result)

    const withDeclaration = args.includeDeclaration
      ? filtered
      : filtered.filter((item) => {
          const itemUri = (item.uri as string) ?? ((item.location as Record<string, unknown>)?.uri as string)
          const range = (item.range ?? (item.location as Record<string, unknown>)?.range) as Record<string, Record<string, number>> | undefined
          if (!itemUri || !range) return true
          if (itemUri !== uri) return true
          return range.start.line !== args.line - 1 || range.start.character !== args.character - 1
        })

    const limited = withDeclaration.slice(0, args.limit)
    const title = `findReferences ${relPath(file)}:${args.line}:${args.character}`
    const totalCount = withDeclaration.length
    const shownCount = limited.length

    if (limited.length === 0) return { title, metadata: { result: limited, totalCount: 0 }, output: "No references found" }

    const lines = limited.map(formatLocation)
    const suffix = totalCount > shownCount ? `\n\n(showing ${shownCount} of ${totalCount} references)` : ""
    return { title, metadata: { result: limited, totalCount }, output: lines.join("\n") + suffix }
  },
})

export const LspSymbolsTool = Tool.define("lsp_symbols", {
  description: SYMBOLS_DESC,
  parameters: z.object({
    filePath: z.string().describe("The file path (used for server selection)"),
    scope: z.enum(["document", "workspace"]).describe("Search scope"),
    query: z.string().optional().default("").describe("Query for workspace scope"),
    limit: z.number().int().positive().optional().default(50).describe("Maximum results"),
  }),
  execute: async (args, ctx) => {
    const file = resolveFile(args.filePath)
    await assertExternalDirectory(ctx, file)
    await ctx.ask({ permission: "lsp", patterns: ["*"], always: ["*"], metadata: {} })
    await ensureLsp(file)

    const title = `symbols:${args.scope} ${relPath(file)}`

    if (args.scope === "document") {
      const uri = pathToFileURL(file).href
      const result = await LSP.documentSymbol(uri) as Record<string, unknown>[]
      const limited = result.slice(0, args.limit)

      if (limited.length === 0) return { title, metadata: { result: limited, totalCount: 0 }, output: "No symbols found" }

      const output = limited.map((s) => {
        const name = s.name as string
        const kind = s.kind as number
        const range = (s.range ?? s.selectionRange) as Record<string, Record<string, number>> | undefined
        const loc = range ? `:${range.start.line + 1}:${range.start.character + 1}` : ""
        return `${name} (kind: ${kind})${loc}`
      }).join("\n")
      const suffix = result.length > args.limit ? `\n\n(showing ${args.limit} of ${result.length} symbols)` : ""
      return { title, metadata: { result: limited, totalCount: result.length }, output: output + suffix }
    }

    const result = await LSP.workspaceSymbol(args.query) as Record<string, unknown>[]
    const filtered = filterByAccess(result)
    const limited = filtered.slice(0, args.limit)

    if (limited.length === 0) return { title, metadata: { result: limited, totalCount: 0 }, output: "No symbols found" }

    const output = limited.map((s) => {
      const name = s.name as string
      const kind = s.kind as number
      const location = s.location as Record<string, unknown> | undefined
      const loc = location ? formatLocation({ location } as Record<string, unknown>) : ""
      return `${name} (kind: ${kind}) ${loc}`
    }).join("\n")
    const suffix = filtered.length > args.limit ? `\n\n(showing ${args.limit} of ${filtered.length} symbols)` : ""
    return { title, metadata: { result: limited, totalCount: filtered.length }, output: output + suffix }
  },
})

export const LspHoverTool = Tool.define("lsp_hover", {
  description: HOVER_DESC,
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
    const result = await LSP.hover(position)
    const title = `hover ${relPath(file)}:${args.line}:${args.character}`
    const filtered = (result as unknown[]).filter(Boolean)

    if (filtered.length === 0) return { title, metadata: { result: filtered }, output: "No hover information available" }

    const output = JSON.stringify(filtered, null, 2)
    return { title, metadata: { result: filtered }, output }
  },
})

export const LspImplementationTool = Tool.define("lsp_implementation", {
  description: IMPLEMENTATION_DESC,
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
    const result = await LSP.implementation(position)
    const filtered = filterByAccess(result as Record<string, unknown>[])
    const title = `implementation ${relPath(file)}:${args.line}:${args.character}`

    if (filtered.length === 0) return { title, metadata: { result: filtered }, output: "No implementations found" }

    const output = filtered.map(formatLocation).join("\n")
    return { title, metadata: { result: filtered }, output }
  },
})
