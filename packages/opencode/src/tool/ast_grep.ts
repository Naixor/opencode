import { Tool } from "./tool"
import z from "zod"
import { findInFiles, parse } from "@ast-grep/napi"
import type { SgNode, Edit } from "@ast-grep/napi"
import { SecurityConfig } from "../security/config"
import { SecurityAccess } from "../security/access"
import { SecurityUtil } from "../security/util"
import { Instance } from "../project/instance"
import path from "path"

const LANGS = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "elixir",
  "go",
  "haskell",
  "html",
  "java",
  "javascript",
  "json",
  "kotlin",
  "lua",
  "nix",
  "php",
  "python",
  "ruby",
  "rust",
  "scala",
  "solidity",
  "swift",
  "typescript",
  "tsx",
  "yaml",
] as const

const langEnum = z.enum(LANGS)

const MAX_FILES = 100
const MAX_MATCHES = 1000

export const AstGrepSearchTool = Tool.define("ast_grep_search", {
  description:
    "Search code patterns across filesystem using AST-aware matching. Supports 25 languages. Use meta-variables: $VAR (single node), $$$ (multiple nodes). IMPORTANT: Patterns must be complete AST nodes (valid code). For functions, include params and body: 'export async function $NAME($$$) { $$$ }' not 'export async function $NAME'. Examples: 'console.log($MSG)', 'def $FUNC($$$):', 'async function $NAME($$$)'",
  parameters: z.object({
    pattern: z.string().describe("AST pattern to search for"),
    lang: langEnum.describe("Programming language to parse as"),
    paths: z.array(z.string()).optional().describe("Directories to search in. Defaults to project root."),
    globs: z.array(z.string()).optional().describe("File glob patterns to include"),
    context: z.number().optional().describe("Number of surrounding context lines"),
  }),
  execute: async (args) => {
    const config = SecurityConfig.getSecurityConfig()
    const role = SecurityUtil.getDefaultRole(config)
    const dir = Instance.directory
    const searchPaths = args.paths?.map((p) => path.resolve(dir, p)) ?? [dir]

    for (const p of searchPaths) {
      const access = SecurityAccess.checkAccess(p, "read", role)
      if (!access.allowed)
        return { title: "Access denied", output: access.reason ?? "Access denied", metadata: { truncated: false } }
    }

    const results: { file: string; line: number; col: number; text: string }[] = []
    let fileCount = 0

    await findInFiles(
      args.lang,
      {
        paths: searchPaths,
        matcher: { rule: { pattern: args.pattern } },
      },
      (_err, nodes) => {
        if (fileCount >= MAX_FILES) return
        fileCount++
        for (const node of nodes) {
          if (results.length >= MAX_MATCHES) return
          const range = node.range()
          results.push({
            file: node.getRoot().filename(),
            line: range.start.line + 1,
            col: range.start.column + 1,
            text: node.text(),
          })
        }
      },
    ).catch(() => {})

    if (results.length === 0)
      return { title: "No matches", output: "No matches found.", metadata: { truncated: false } }

    if (args.context && args.context > 0) {
      const cache = new Map<string, string[]>()
      for (const r of results) {
        if (!cache.has(r.file)) {
          const content = await Bun.file(r.file)
            .text()
            .catch(() => "")
          cache.set(r.file, content.split("\n"))
        }
        const lines = cache.get(r.file)!
        const start = Math.max(0, r.line - 1 - args.context)
        const end = Math.min(lines.length, r.line + args.context)
        ;(r as { context?: string }).context = lines.slice(start, end).join("\n")
      }
    }

    const output = results
      .map((r) => {
        const loc = `${r.file}:${r.line}:${r.col}`
        const ctx = (r as { context?: string }).context
        if (ctx) return `${loc}\n${ctx}\n`
        return `${loc}\n${r.text}\n`
      })
      .join("\n")

    return {
      title: `${results.length} match(es) in ${fileCount} file(s)`,
      output,
      metadata: { truncated: false },
    }
  },
})

export const AstGrepReplaceTool = Tool.define("ast_grep_replace", {
  description:
    "Replace code patterns across filesystem with AST-aware rewriting. Dry-run by default. Use meta-variables in rewrite to preserve matched content. Example: pattern='console.log($MSG)' rewrite='logger.info($MSG)'",
  parameters: z.object({
    pattern: z.string().describe("AST pattern to match"),
    rewrite: z.string().describe("Replacement pattern. Use $VAR to reference matched meta-variables."),
    lang: langEnum.describe("Programming language"),
    paths: z.array(z.string()).optional().describe("Directories to search. Defaults to project root."),
    globs: z.array(z.string()).optional().describe("File glob patterns"),
    dryRun: z.boolean().default(true).describe("If true (default), show changes without applying."),
  }),
  execute: async (args) => {
    const config = SecurityConfig.getSecurityConfig()
    const role = SecurityUtil.getDefaultRole(config)
    const dir = Instance.directory
    const searchPaths = args.paths?.map((p) => path.resolve(dir, p)) ?? [dir]
    const operation = args.dryRun ? "read" : "write"

    for (const p of searchPaths) {
      const access = SecurityAccess.checkAccess(p, operation, role)
      if (!access.allowed)
        return { title: "Access denied", output: access.reason ?? "Access denied", metadata: { truncated: false } }
    }

    const files = new Set<string>()
    await findInFiles(
      args.lang,
      {
        paths: searchPaths,
        matcher: { rule: { pattern: args.pattern } },
      },
      (_err, nodes) => {
        for (const node of nodes) {
          files.add(node.getRoot().filename())
        }
      },
    ).catch(() => {})

    if (files.size === 0) return { title: "No matches", output: "No matches found.", metadata: { truncated: false } }

    const changes: string[] = []
    let totalEdits = 0

    for (const file of files) {
      if (!args.dryRun) {
        const access = SecurityAccess.checkAccess(file, "write", role)
        if (!access.allowed) {
          changes.push(`SKIPPED ${file}: ${access.reason}`)
          continue
        }
      }

      const source = await Bun.file(file).text()
      const ast = parse(args.lang, source)
      const root = ast.root()
      const matches = root.findAll(args.pattern)

      if (matches.length === 0) continue

      const edits: Edit[] = matches.map((m) => m.replace(args.rewrite))
      edits.sort((a, b) => b.startPos - a.startPos)
      const newSource = root.commitEdits(edits)
      totalEdits += edits.length

      if (args.dryRun) {
        changes.push(`${file}: ${edits.length} replacement(s) (dry-run)`)
      } else {
        await Bun.write(file, newSource)
        changes.push(`${file}: ${edits.length} replacement(s) applied`)
      }
    }

    return {
      title: `${totalEdits} edit(s) in ${files.size} file(s)${args.dryRun ? " (dry-run)" : ""}`,
      output: changes.join("\n"),
      metadata: { truncated: false },
    }
  },
})
