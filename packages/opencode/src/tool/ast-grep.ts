import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { SecurityAccess } from "../security/access"
import { SecurityConfig } from "../security/config"
import { SecuritySchema } from "../security/schema"
import { SecuritySegments } from "../security/segments"
import { SecurityRedact } from "../security/redact"
import { SecurityAudit } from "../security/audit"
import { Log } from "../util/log"

import SEARCH_DESCRIPTION from "./ast-grep-search.txt"
import REPLACE_DESCRIPTION from "./ast-grep-replace.txt"

const securityLog = Log.create({ service: "security-ast-grep" })

const SUPPORTED_LANGUAGES = [
  "c",
  "cpp",
  "css",
  "csharp",
  "dart",
  "elixir",
  "go",
  "haskell",
  "html",
  "java",
  "javascript",
  "json",
  "kotlin",
  "lua",
  "php",
  "python",
  "ruby",
  "rust",
  "scala",
  "sql",
  "swift",
  "toml",
  "tsx",
  "typescript",
  "yaml",
] as const

type SupportedLang = (typeof SUPPORTED_LANGUAGES)[number]

const LanguageEnum = z.enum(SUPPORTED_LANGUAGES)

function getDefaultRole(config: SecuritySchema.SecurityConfig): string {
  const roles = config.roles ?? []
  if (roles.length === 0) return "viewer"
  const lowestRole = roles.reduce((prev, curr) => (curr.level < prev.level ? curr : prev), roles[0])
  return lowestRole.name
}

function getRoleLevel(roleName: string, roles: SecuritySchema.Role[]): number {
  const role = roles.find((r) => r.name === roleName)
  return role?.level ?? 0
}

function isRoleAllowed(roleName: string, roleLevel: number, allowedRoles: string[], allRoles: SecuritySchema.Role[]): boolean {
  if (allowedRoles.includes(roleName)) return true
  for (const allowedRoleName of allowedRoles) {
    const allowedRoleLevel = getRoleLevel(allowedRoleName, allRoles)
    if (roleLevel > allowedRoleLevel) return true
  }
  return false
}

function findProtectedSegments(
  filepath: string,
  content: string,
  config: SecuritySchema.SecurityConfig,
  currentRole: string,
): SecurityRedact.Segment[] {
  const segments: SecurityRedact.Segment[] = []
  const segmentsConfig = config.segments
  if (!segmentsConfig) return segments

  const roles = config.roles ?? []
  const roleLevel = getRoleLevel(currentRole, roles)

  if (segmentsConfig.markers && segmentsConfig.markers.length > 0) {
    const markerSegments = SecuritySegments.findMarkerSegments(content, segmentsConfig.markers)
    for (const segment of markerSegments) {
      if (segment.rule.deniedOperations.includes("read") && !isRoleAllowed(currentRole, roleLevel, segment.rule.allowedRoles, roles)) {
        segments.push({ start: segment.start, end: segment.end })
      }
    }
  }

  if (segmentsConfig.ast && segmentsConfig.ast.length > 0) {
    const astSegments = SecuritySegments.findASTSegments(filepath, content, segmentsConfig.ast)
    for (const segment of astSegments) {
      if (segment.rule.deniedOperations.includes("read") && !isRoleAllowed(currentRole, roleLevel, segment.rule.allowedRoles, roles)) {
        segments.push({ start: segment.start, end: segment.end })
      }
    }
  }

  return segments
}

function findWriteProtectedSegments(
  filepath: string,
  content: string,
  config: SecuritySchema.SecurityConfig,
  currentRole: string,
): SecurityRedact.Segment[] {
  const segments: SecurityRedact.Segment[] = []
  const segmentsConfig = config.segments
  if (!segmentsConfig) return segments

  const roles = config.roles ?? []
  const roleLevel = getRoleLevel(currentRole, roles)

  if (segmentsConfig.markers && segmentsConfig.markers.length > 0) {
    const markerSegments = SecuritySegments.findMarkerSegments(content, segmentsConfig.markers)
    for (const segment of markerSegments) {
      if (segment.rule.deniedOperations.includes("write") && !isRoleAllowed(currentRole, roleLevel, segment.rule.allowedRoles, roles)) {
        segments.push({ start: segment.start, end: segment.end })
      }
    }
  }

  if (segmentsConfig.ast && segmentsConfig.ast.length > 0) {
    const astSegments = SecuritySegments.findASTSegments(filepath, content, segmentsConfig.ast)
    for (const segment of astSegments) {
      if (segment.rule.deniedOperations.includes("write") && !isRoleAllowed(currentRole, roleLevel, segment.rule.allowedRoles, roles)) {
        segments.push({ start: segment.start, end: segment.end })
      }
    }
  }

  return segments
}

// Minimal type interface for the ast-grep API surface we use
export interface AstGrepApi {
  parse(lang: string, content: string): { root(): AstGrepRoot }
}

export interface AstGrepRoot {
  findAll(pattern: string): AstGrepNode[]
}

export interface AstGrepNode {
  text(): string
  range(): { start: { line: number; column: number; index: number }; end: { line: number; column: number; index: number } }
  replace(text: string): { startPos: number; endPos: number; insertedText: string }
  findAll(pattern: string): AstGrepNode[]
}

// Exported for test injection; default loads @ast-grep/napi dynamically
export const AstGrepLoader = {
  load: (): Promise<AstGrepApi | null> => import("@ast-grep/napi").then((m) => m as unknown as AstGrepApi).catch(() => null),
}

function matchOverlapsProtectedSegment(
  matchStart: number,
  matchEnd: number,
  protectedSegments: SecurityRedact.Segment[],
): boolean {
  return protectedSegments.some((seg) => matchStart < seg.end && matchEnd > seg.start)
}

async function collectFiles(
  searchPaths: string[],
  globs: string[] | undefined,
  lang: SupportedLang,
): Promise<string[]> {
  const files: string[] = []
  const langExtensions: Record<string, string[]> = {
    javascript: [".js", ".mjs", ".cjs", ".jsx"],
    typescript: [".ts", ".mts", ".cts"],
    tsx: [".tsx"],
    python: [".py"],
    rust: [".rs"],
    go: [".go"],
    java: [".java"],
    cpp: [".cpp", ".cc", ".cxx", ".hpp", ".h"],
    c: [".c", ".h"],
    csharp: [".cs"],
    ruby: [".rb"],
    php: [".php"],
    swift: [".swift"],
    kotlin: [".kt", ".kts"],
    scala: [".scala"],
    lua: [".lua"],
    dart: [".dart"],
    elixir: [".ex", ".exs"],
    haskell: [".hs"],
    html: [".html", ".htm"],
    css: [".css"],
    json: [".json"],
    yaml: [".yml", ".yaml"],
    toml: [".toml"],
    sql: [".sql"],
  }
  const extensions = langExtensions[lang] ?? []
  const globPatterns = globs ?? extensions.map((ext) => `**/*${ext}`)

  for (const searchPath of searchPaths) {
    const absPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(Instance.directory, searchPath)
    const stat = await Bun.file(absPath).stat().catch(() => null)

    if (stat?.isFile()) {
      files.push(absPath)
      continue
    }

    for (const pattern of globPatterns) {
      const glob = new Bun.Glob(pattern)
      for await (const match of glob.scan({ cwd: absPath, absolute: true, followSymlinks: false, dot: false })) {
        files.push(match)
      }
    }
  }

  return [...new Set(files)]
}

export const AstGrepSearchTool = Tool.define("ast_grep_search", {
  description: SEARCH_DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The ast-grep pattern to search for. Use $VAR for wildcards."),
    lang: LanguageEnum.describe("The programming language to parse"),
    paths: z.array(z.string()).optional().describe("Directories or files to search in. Defaults to ['.']"),
    globs: z.array(z.string()).optional().describe("Glob patterns to filter files (e.g. ['*.ts', '!*.test.ts'])"),
    context: z.number().int().nonnegative().optional().describe("Number of context lines around each match"),
  }),
  async execute(params, ctx) {
    const astGrep = await AstGrepLoader.load()
    if (!astGrep) {
      return {
        title: "ast-grep not available",
        metadata: { matches: 0, truncated: false },
        output: "ast-grep not available. Install with: bun add @ast-grep/napi",
      }
    }

    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        lang: params.lang,
      },
    })

    const searchPaths = params.paths ?? ["."]
    for (const sp of searchPaths) {
      const absPath = path.isAbsolute(sp) ? sp : path.resolve(Instance.directory, sp)
      await assertExternalDirectory(ctx, absPath, { kind: "directory" })
    }

    const files = await collectFiles(searchPaths, params.globs, params.lang)

    const config = SecurityConfig.getSecurityConfig()
    const currentRole = getDefaultRole(config)
    const contextLines = params.context ?? 0

    const matches: Array<{
      file: string
      line: number
      column: number
      text: string
      context: string
    }> = []
    let filteredFileCount = 0
    let redactedMatchCount = 0

    for (const file of files) {
      const accessResult = SecurityAccess.checkAccess(file, "read", currentRole)
      if (!accessResult.allowed) {
        filteredFileCount++
        SecurityAudit.logSecurityEvent({
          role: currentRole,
          operation: "read",
          path: file,
          allowed: false,
          reason: accessResult.reason,
        })
        continue
      }

      const content = await Bun.file(file).text().catch(() => null)
      if (content === null) continue

      const protectedSegments = findProtectedSegments(file, content, config, currentRole)

      const sgNode = astGrep.parse(params.lang, content)
      const root = sgNode.root()
      const found = root.findAll(params.pattern)

      for (const node of found) {
        const range = node.range()
        const startLine = range.start.line
        const matchText = node.text()

        // Use byte offsets from range for accurate position checking
        const startIdx = range.start.index
        const endIdx = range.end.index

        if (matchOverlapsProtectedSegment(startIdx, endIdx, protectedSegments)) {
          redactedMatchCount++
          continue
        }

        const contentLines = content.split("\n")
        const ctxStart = Math.max(0, startLine - contextLines)
        const ctxEnd = Math.min(contentLines.length - 1, range.end.line + contextLines)
        const contextText =
          contextLines > 0
            ? contentLines.slice(ctxStart, ctxEnd + 1).map((l, i) => `  ${ctxStart + i + 1} | ${l}`).join("\n")
            : ""

        matches.push({
          file,
          line: startLine + 1,
          column: range.start.column + 1,
          text: matchText,
          context: contextText,
        })
      }
    }

    if (filteredFileCount > 0 || redactedMatchCount > 0) {
      securityLog.debug("ast-grep security filtering applied", {
        filteredFileCount,
        redactedMatchCount,
        role: currentRole,
      })
    }

    if (matches.length === 0) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No matches found",
      }
    }

    const limit = 500
    const truncated = matches.length > limit
    const finalMatches = truncated ? matches.slice(0, limit) : matches

    const outputLines = [`Found ${finalMatches.length} matches${truncated ? ` (showing ${limit} of ${matches.length})` : ""}`]

    for (const match of finalMatches) {
      outputLines.push("")
      outputLines.push(`${match.file}:${match.line}:${match.column}`)
      outputLines.push(`  ${match.text}`)
      if (match.context) {
        outputLines.push(match.context)
      }
    }

    return {
      title: params.pattern,
      metadata: {
        matches: finalMatches.length,
        truncated,
      },
      output: outputLines.join("\n"),
    }
  },
})

export const AstGrepReplaceTool = Tool.define("ast_grep_replace", {
  description: REPLACE_DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The ast-grep pattern to search for. Use $VAR for wildcards."),
    rewrite: z.string().describe("The replacement pattern. Use $VAR to reference captured wildcards."),
    lang: LanguageEnum.describe("The programming language to parse"),
    paths: z.array(z.string()).optional().describe("Directories or files to search in. Defaults to ['.']"),
    globs: z.array(z.string()).optional().describe("Glob patterns to filter files (e.g. ['*.ts', '!*.test.ts'])"),
    context: z.number().int().nonnegative().optional().describe("Number of context lines around each match in output"),
    dryRun: z.boolean().optional().describe("If true (default), show changes without applying them"),
  }),
  async execute(params, ctx) {
    const astGrep = await AstGrepLoader.load()
    if (!astGrep) {
      return {
        title: "ast-grep not available",
        metadata: { matches: 0, applied: false, truncated: false },
        output: "ast-grep not available. Install with: bun add @ast-grep/napi",
      }
    }

    const dryRun = params.dryRun !== false

    await ctx.ask({
      permission: dryRun ? "grep" : "write",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        rewrite: params.rewrite,
        lang: params.lang,
        dryRun,
      },
    })

    const searchPaths = params.paths ?? ["."]
    for (const sp of searchPaths) {
      const absPath = path.isAbsolute(sp) ? sp : path.resolve(Instance.directory, sp)
      await assertExternalDirectory(ctx, absPath, { kind: "directory" })
    }

    const files = await collectFiles(searchPaths, params.globs, params.lang)

    const config = SecurityConfig.getSecurityConfig()
    const currentRole = getDefaultRole(config)

    const replacements: Array<{
      file: string
      line: number
      original: string
      replacement: string
    }> = []
    let filteredFileCount = 0
    let protectedSegmentSkips = 0
    const filesToWrite = new Map<string, string>()

    for (const file of files) {
      const readAccess = SecurityAccess.checkAccess(file, "read", currentRole)
      if (!readAccess.allowed) {
        filteredFileCount++
        SecurityAudit.logSecurityEvent({
          role: currentRole,
          operation: "read",
          path: file,
          allowed: false,
          reason: readAccess.reason,
        })
        continue
      }

      if (!dryRun) {
        const writeAccess = SecurityAccess.checkAccess(file, "write", currentRole)
        if (!writeAccess.allowed) {
          filteredFileCount++
          SecurityAudit.logSecurityEvent({
            role: currentRole,
            operation: "write",
            path: file,
            allowed: false,
            reason: writeAccess.reason,
          })
          continue
        }
      }

      const content = await Bun.file(file).text().catch(() => null)
      if (content === null) continue

      const writeProtectedSegments = findWriteProtectedSegments(file, content, config, currentRole)

      const sgNode = astGrep.parse(params.lang, content)
      const root = sgNode.root()
      const found = root.findAll(params.pattern)

      if (found.length === 0) continue

      // Collect replacements for this file, sorted by position (reverse for safe replacement)
      const fileReplacements: Array<{
        start: number
        end: number
        line: number
        original: string
        replacement: string
      }> = []

      for (const node of found) {
        const range = node.range()
        const startLine = range.start.line
        const matchText = node.text()

        const startOffset = range.start.index
        const endOffset = range.end.index

        if (matchOverlapsProtectedSegment(startOffset, endOffset, writeProtectedSegments)) {
          protectedSegmentSkips++
          SecurityAudit.logSecurityEvent({
            role: currentRole,
            operation: "write",
            path: file,
            allowed: false,
            reason: "Match overlaps protected code segment",
          })
          continue
        }

        // node.replace() returns an Edit { startPos, endPos, insertedText }
        const edit = node.replace(params.rewrite)
        const replacementText = edit.insertedText

        fileReplacements.push({
          start: edit.startPos,
          end: edit.endPos,
          line: startLine + 1,
          original: matchText,
          replacement: replacementText,
        })

        replacements.push({
          file,
          line: startLine + 1,
          original: matchText,
          replacement: replacementText,
        })
      }

      if (fileReplacements.length > 0 && !dryRun) {
        // Apply replacements in reverse order to preserve offsets
        const sorted = [...fileReplacements].sort((a, b) => b.start - a.start)
        let modified = content
        for (const rep of sorted) {
          modified = modified.slice(0, rep.start) + rep.replacement + modified.slice(rep.end)
        }
        filesToWrite.set(file, modified)
      }
    }

    // Write files if not dry run
    if (!dryRun) {
      for (const [file, content] of filesToWrite) {
        await Bun.write(file, content)
      }
    }

    if (filteredFileCount > 0 || protectedSegmentSkips > 0) {
      securityLog.debug("ast-grep replace security filtering applied", {
        filteredFileCount,
        protectedSegmentSkips,
        role: currentRole,
      })
    }

    if (replacements.length === 0) {
      return {
        title: params.pattern,
        metadata: { matches: 0, applied: !dryRun, truncated: false },
        output: "No matches found",
      }
    }

    const limit = 200
    const truncated = replacements.length > limit
    const finalReplacements = truncated ? replacements.slice(0, limit) : replacements

    const modeLabel = dryRun ? "DRY RUN" : "APPLIED"
    const outputLines = [
      `[${modeLabel}] Found ${replacements.length} replacement${replacements.length === 1 ? "" : "s"}${truncated ? ` (showing ${limit})` : ""}`,
    ]

    if (protectedSegmentSkips > 0) {
      outputLines.push(`(${protectedSegmentSkips} match${protectedSegmentSkips === 1 ? "" : "es"} in protected segments skipped)`)
    }

    for (const rep of finalReplacements) {
      outputLines.push("")
      outputLines.push(`${rep.file}:${rep.line}`)
      outputLines.push(`  - ${rep.original}`)
      outputLines.push(`  + ${rep.replacement}`)
    }

    return {
      title: params.pattern,
      metadata: {
        matches: replacements.length,
        applied: !dryRun,
        truncated,
      },
      output: outputLines.join("\n"),
    }
  },
})
