import z from "zod"
import { text } from "node:stream/consumers"
import { Tool } from "./tool"
import { Filesystem } from "../util/filesystem"
import { Ripgrep } from "../file/ripgrep"
import { Process } from "../util/process"

import DESCRIPTION from "./grep.txt"
import { Instance } from "../project/instance"
import path from "path"
import { assertExternalDirectory } from "./external-directory"
import { SecurityAccess } from "../security/access"
import { SecurityConfig } from "../security/config"
import { SecuritySchema } from "../security/schema"
import { SecuritySegments } from "../security/segments"
import { SecurityRedact } from "../security/redact"
import { Log } from "../util/log"

const securityLog = Log.create({ service: "security-grep" })

const MAX_LINE_LENGTH = 2000

export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
    context: z.number().int().nonnegative().optional().describe("Number of lines to show before and after each match"),
    caseSensitive: z.boolean().optional().describe("Whether the search is case sensitive. Defaults to smart case (case-insensitive if pattern is all lowercase)"),
    wholeWord: z.boolean().optional().describe("Match whole words only"),
    fixedStrings: z.boolean().optional().describe("Treat pattern as a literal string instead of a regex"),
    multiline: z.boolean().optional().describe("Enable multiline matching (pattern can match across line boundaries)"),
    maxCount: z.number().int().positive().optional().describe("Maximum number of matches to return per file. Defaults to 500"),
    maxColumns: z.number().int().positive().optional().describe("Maximum number of columns (characters) to show per line"),
    exclude: z.string().optional().describe('Glob pattern to exclude from the search (e.g. "*.test.ts", "node_modules/**")'),
    fileType: z.string().optional().describe('Restrict search to specific file type (e.g. "ts", "js", "py", "rust")'),
  }),
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    let searchPath = params.path ?? Instance.directory
    searchPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(Instance.directory, searchPath)
    await assertExternalDirectory(ctx, searchPath, { kind: "directory" })

    const rgPath = await Ripgrep.filepath()
    const args = ["-nH", "--hidden", "--no-messages", "--field-match-separator=|"]

    // Pattern mode flags
    if (params.fixedStrings) {
      args.push("--fixed-strings", "--", params.pattern)
    } else if (params.multiline) {
      args.push("--multiline", "--regexp", params.pattern)
    } else {
      args.push("--regexp", params.pattern)
    }

    // Case sensitivity
    if (params.caseSensitive === true) {
      args.push("--case-sensitive")
    } else if (params.caseSensitive === false) {
      args.push("--ignore-case")
    }
    // default: smart case (ripgrep default)

    if (params.wholeWord) args.push("--word-regexp")
    if (params.context !== undefined) args.push(`--context=${params.context}`)
    if (params.maxCount !== undefined) args.push(`--max-count=${params.maxCount}`)
    if (params.maxColumns !== undefined) args.push(`--max-columns=${params.maxColumns}`)

    if (params.include) {
      args.push("--glob", params.include)
    }
    if (params.exclude) {
      args.push("--glob", `!${params.exclude}`)
    }
    if (params.fileType) {
      args.push("--type", params.fileType)
    }
    args.push(searchPath)

    const proc = Process.spawn([rgPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      abort: ctx.abort,
    })

    if (!proc.stdout || !proc.stderr) {
      throw new Error("Process output not available")
    }

    const output = await text(proc.stdout)
    const errorOutput = await text(proc.stderr)
    const exitCode = await proc.exited

    // Exit codes: 0 = matches found, 1 = no matches, 2 = errors (but may still have matches)
    // With --no-messages, we suppress error output but still get exit code 2 for broken symlinks etc.
    // Only fail if exit code is 2 AND no output was produced
    if (exitCode === 1 || (exitCode === 2 && !output.trim())) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false, hasPartialResults: false },
        output: "No files found",
      }
    }

    if (exitCode !== 0 && exitCode !== 2) {
      throw new Error(`ripgrep failed: ${errorOutput}`)
    }

    // Exit code 2 means partial results (some paths inaccessible, encoding issues, etc.)
    const hasPartialResults = exitCode === 2

    // Handle both Unix (\n) and Windows (\r\n) line endings
    const lines = output.trim().split(/\r?\n/)
    const matches = []

    // Security access control: get config and role
    const config = SecurityConfig.getSecurityConfig()
    const currentRole = getDefaultRole(config)

    // Track files we've already checked for access
    const fileAccessCache = new Map<string, boolean>()
    let filteredFileCount = 0

    for (const line of lines) {
      if (!line) continue
      // Context mode adds "--" separator lines between match groups
      if (line === "--") continue

      // Match lines use "|" as field separator (via --field-match-separator=|)
      // Context lines (from --context) use "-" as separator: file-linenum-text
      let filePath: string
      let lineNum: number
      let lineText: string

      const pipeIdx = line.indexOf("|")
      if (pipeIdx !== -1) {
        // Match line: file|linenum|text
        const parts = line.split("|")
        filePath = parts[0]
        lineNum = parseInt(parts[1], 10)
        lineText = parts.slice(2).join("|")
      } else {
        // Context line: file-linenum-text (dash-separated)
        // Need to parse carefully since file paths can contain dashes
        const match = line.match(/^(.+)-(\d+)-(.*)$/)
        if (!match) continue
        filePath = match[1]
        lineNum = parseInt(match[2], 10)
        lineText = match[3]
      }

      if (!filePath || isNaN(lineNum)) continue

      // Security check: Filter out matches in fully protected files
      let fileAccessAllowed = fileAccessCache.get(filePath)
      if (fileAccessAllowed === undefined) {
        const accessResult = SecurityAccess.checkAccess(filePath, "read", currentRole)
        fileAccessAllowed = accessResult.allowed
        fileAccessCache.set(filePath, fileAccessAllowed)
        if (!fileAccessAllowed) {
          filteredFileCount++
        }
      }

      if (!fileAccessAllowed) {
        continue
      }

      const stats = Filesystem.stat(filePath)
      if (!stats) continue

      matches.push({
        path: filePath,
        modTime: stats.mtime.getTime(),
        lineNum,
        lineText,
      })
    }

    matches.sort((a, b) => b.modTime - a.modTime)

    const limit = params.maxCount ?? 500
    const truncated = matches.length > limit
    const finalMatches = truncated ? matches.slice(0, limit) : matches

    if (finalMatches.length === 0) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false, hasPartialResults: false },
        output: "No files found",
      }
    }

    const totalMatches = matches.length
    const outputLines = [`Found ${totalMatches} matches${truncated ? ` (showing first ${limit})` : ""}`]

    let currentFile = ""
    for (const match of finalMatches) {
      if (currentFile !== match.path) {
        if (currentFile !== "") {
          outputLines.push("")
        }
        currentFile = match.path
        outputLines.push(`${match.path}:`)
      }
      const truncatedLineText =
        match.lineText.length > MAX_LINE_LENGTH ? match.lineText.substring(0, MAX_LINE_LENGTH) + "..." : match.lineText
      outputLines.push(`  Line ${match.lineNum}: ${truncatedLineText}`)
    }

    if (truncated) {
      outputLines.push("")
      outputLines.push(
        `(Results truncated: showing ${limit} of ${totalMatches} matches (${totalMatches - limit} hidden). Consider using a more specific path or pattern.)`,
      )
    }

    if (hasPartialResults) {
      outputLines.push("")
      outputLines.push("(Warning: partial results - some paths were inaccessible or had encoding issues)")
    }

    return {
      title: params.pattern,
      metadata: {
        matches: totalMatches,
        truncated,
        hasPartialResults,
      },
      output: outputLines.join("\n"),
    }
  },
})

function getDefaultRole(config: SecuritySchema.SecurityConfig): string {
  const roles = config.roles ?? []
  if (roles.length === 0) {
    return "viewer"
  }
  const lowestRole = roles.reduce((prev, curr) => (curr.level < prev.level ? curr : prev), roles[0])
  return lowestRole.name
}
