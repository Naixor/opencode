import z from "zod"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"

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

    const proc = Bun.spawn([rgPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      signal: ctx.abort,
    })

    const output = await new Response(proc.stdout).text()
    const errorOutput = await new Response(proc.stderr).text()
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

    // Track files we've already checked for access or segments
    const fileAccessCache = new Map<string, boolean>()
    const fileSegmentCache = new Map<string, SecurityRedact.Segment[]>()
    const fileContentCache = new Map<string, string>()
    let filteredFileCount = 0
    let redactedMatchCount = 0

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

      // Security check 1: Filter out matches in fully protected files
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

      const file = Bun.file(filePath)
      const stats = await file.stat().catch(() => null)
      if (!stats) continue

      // Security check 2: Check if match falls within a protected segment
      let protectedSegments = fileSegmentCache.get(filePath)
      if (protectedSegments === undefined) {
        let fileContent = fileContentCache.get(filePath)
        if (fileContent === undefined) {
          fileContent = await file.text().catch(() => "")
          fileContentCache.set(filePath, fileContent)
        }
        protectedSegments = findProtectedSegments(filePath, fileContent, config, currentRole)
        fileSegmentCache.set(filePath, protectedSegments)
      }

      // Calculate match position in file content
      let finalLineText = lineText
      if (protectedSegments.length > 0) {
        let fileContent = fileContentCache.get(filePath)
        if (fileContent === undefined) {
          fileContent = await file.text().catch(() => "")
          fileContentCache.set(filePath, fileContent)
        }

        // Find the position of this line in the file
        const lineStartPos = getLineStartPosition(fileContent, lineNum)
        const lineEndPos = lineStartPos + lineText.length

        // Check if this match overlaps with any protected segment
        const isProtected = protectedSegments.some(
          (seg) => lineStartPos < seg.end && lineEndPos > seg.start,
        )

        if (isProtected) {
          finalLineText = SecurityRedact.REDACTED_PLACEHOLDER
          redactedMatchCount++
        }
      }

      matches.push({
        path: filePath,
        modTime: stats.mtime.getTime(),
        lineNum,
        lineText: finalLineText,
      })
    }

    // Log security filtering summary
    if (filteredFileCount > 0 || redactedMatchCount > 0) {
      securityLog.debug("grep security filtering applied", {
        filteredFileCount,
        redactedMatchCount,
        role: currentRole,
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

    const outputLines = [`Found ${finalMatches.length} matches`]

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
      outputLines.push("(Results are truncated. Consider using a more specific path or pattern.)")
    }

    if (hasPartialResults) {
      outputLines.push("")
      outputLines.push("(Warning: partial results - some paths were inaccessible or had encoding issues)")
    }

    return {
      title: params.pattern,
      metadata: {
        matches: finalMatches.length,
        truncated,
        hasPartialResults,
      },
      output: outputLines.join("\n"),
    }
  },
})

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
 * Calculate the starting byte position of a line in file content.
 * Line numbers are 1-based.
 */
function getLineStartPosition(content: string, lineNum: number): number {
  let pos = 0
  let currentLine = 1

  while (currentLine < lineNum && pos < content.length) {
    if (content[pos] === "\n") {
      currentLine++
    }
    pos++
  }

  return pos
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
