import z from "zod"
import { Tool } from "./tool"
import path from "path"
import { LSP } from "../lsp"
import DESCRIPTION from "./lsp.txt"
import { Instance } from "../project/instance"
import { pathToFileURL } from "url"
import { assertExternalDirectory } from "./external-directory"

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "diagnostics",
  "prepareRename",
  "rename",
] as const

export const LspTool = Tool.define("lsp", {
  description: DESCRIPTION,
  parameters: z.object({
    operation: z.enum(operations).describe("The LSP operation to perform"),
    filePath: z.string().describe("The absolute or relative path to the file"),
    line: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("The line number (1-based). Required for all operations except diagnostics."),
    character: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("The character offset (1-based). Required for all operations except diagnostics."),
    newName: z.string().optional().describe("The new name for the symbol (required for rename operation)"),
    severity: z
      .enum(["error", "warning", "information", "hint"])
      .optional()
      .describe("Filter diagnostics by severity (only for diagnostics operation)"),
  }),
  execute: async (args, ctx) => {
    const file = path.isAbsolute(args.filePath) ? args.filePath : path.join(Instance.directory, args.filePath)
    await assertExternalDirectory(ctx, file)

    await ctx.ask({
      permission: "lsp",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })
    const uri = pathToFileURL(file).href
    const relPath = path.relative(Instance.worktree, file)

    const exists = await Bun.file(file).exists()
    if (!exists) {
      throw new Error(`File not found: ${file}`)
    }

    const available = await LSP.hasClients(file)
    if (!available) {
      throw new Error("No LSP server available for this file type.")
    }

    await LSP.touchFile(file, true)

    if (args.operation === "diagnostics") {
      const severityMap: Record<string, number> = { error: 1, warning: 2, information: 3, hint: 4 }
      const all = await LSP.diagnostics()
      const fileDiags = all[file] ?? all[uri] ?? []
      const filtered = args.severity ? fileDiags.filter((d) => d.severity === severityMap[args.severity!]) : fileDiags
      const title = `diagnostics ${relPath}`
      const output =
        filtered.length === 0 ? "No diagnostics found" : filtered.map((d) => LSP.Diagnostic.pretty(d)).join("\n")
      return { title, metadata: { result: filtered }, output }
    }

    if (!args.line || !args.character) {
      throw new Error(`line and character are required for ${args.operation}`)
    }

    const position = {
      file,
      line: args.line - 1,
      character: args.character - 1,
    }
    const title = `${args.operation} ${relPath}:${args.line}:${args.character}`

    const result: unknown[] = await (async () => {
      switch (args.operation) {
        case "goToDefinition":
          return LSP.definition(position)
        case "findReferences":
          return LSP.references(position)
        case "hover":
          return LSP.hover(position)
        case "documentSymbol":
          return LSP.documentSymbol(uri)
        case "workspaceSymbol":
          return LSP.workspaceSymbol("")
        case "goToImplementation":
          return LSP.implementation(position)
        case "prepareCallHierarchy":
          return LSP.prepareCallHierarchy(position)
        case "incomingCalls":
          return LSP.incomingCalls(position)
        case "outgoingCalls":
          return LSP.outgoingCalls(position)
        case "prepareRename":
          return LSP.prepareRename(position)
        case "rename":
          if (!args.newName) throw new Error("newName is required for rename operation")
          return LSP.rename({ ...position, newName: args.newName })
        case "diagnostics":
          return []
      }
    })()

    const output = (() => {
      if (result.length === 0) return `No results found for ${args.operation}`
      return JSON.stringify(result, null, 2)
    })()

    return {
      title,
      metadata: { result },
      output,
    }
  },
})
