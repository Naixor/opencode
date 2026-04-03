import fs from "fs/promises"
import path from "path"
import os from "os"

const GLOB_CHARS = /[*?[{]/

export function isGlobPattern(pattern: string): boolean {
  return GLOB_CHARS.test(pattern)
}

const REGEX_SPECIAL = /[.()+=^$|\\[\]{}]/g

function escapeRegex(s: string): string {
  return s.replace(REGEX_SPECIAL, "\\$&")
}

function convertSegment(seg: string): string {
  let result = ""
  let i = 0
  while (i < seg.length) {
    const ch = seg[i]
    if (ch === "*") {
      // single * only — ** is handled at segment level
      result += "[^/]*"
      i++
    } else if (ch === "?") {
      result += "[^/]"
      i++
    } else if (REGEX_SPECIAL.test(ch)) {
      result += "\\" + ch
      // reset lastIndex since we use a global regex
      REGEX_SPECIAL.lastIndex = 0
      i++
    } else {
      result += ch
      i++
    }
  }
  return result
}

async function realpathSafe(p: string): Promise<string> {
  const resolved = await fs.realpath(p).catch(() => null)
  if (resolved) return resolved
  const parent = path.dirname(p)
  if (parent === p) return p
  const resolvedParent = await realpathSafe(parent)
  return path.join(resolvedParent, path.basename(p))
}

export async function globToSbplRegex(pattern: string, projectRoot: string): Promise<string> {
  // Split into path segments
  const segments = pattern.split("/")

  // Find the fixed prefix: segments before the first one containing wildcards
  let fixedEnd = 0
  for (let i = 0; i < segments.length; i++) {
    if (isGlobPattern(segments[i])) break
    fixedEnd = i + 1
  }

  // Build the absolute fixed prefix
  const fixedSegments = segments.slice(0, fixedEnd)
  const globSegments = segments.slice(fixedEnd)

  let fixedPath: string
  if (fixedSegments.length > 0) {
    let rawFixed = fixedSegments.join("/")
    if (rawFixed === "~") rawFixed = os.homedir()
    else if (rawFixed.startsWith("~/")) rawFixed = path.join(os.homedir(), rawFixed.slice(2))
    const absFixed = path.isAbsolute(rawFixed) ? rawFixed : path.resolve(projectRoot, rawFixed)
    fixedPath = await realpathSafe(absFixed)
  } else {
    fixedPath = await realpathSafe(projectRoot)
  }

  // Convert glob segments to regex
  // Strategy: build regex by walking segments, handling ** specially
  let regex = escapeRegex(fixedPath)

  for (let i = 0; i < globSegments.length; i++) {
    const seg = globSegments[i]
    if (seg === "**") {
      // ** matches zero or more path segments
      const hasNext = i + 1 < globSegments.length
      if (hasNext) {
        // **/X means: optionally some dirs then /, followed by X
        // Produces: (/.+)?/ which matches "/" (zero dirs) or "/a/b/" (multi dirs)
        // The next non-** segment will be appended directly (no extra /)
        regex += "(/.+)?/"
      } else {
        // Trailing ** — match everything remaining including /
        regex += "/.*"
      }
    } else {
      // Normal segment — add / separator unless preceded by **
      const prevIsDoubleStar = i > 0 && globSegments[i - 1] === "**"
      if (!prevIsDoubleStar) {
        regex += "/"
      }
      regex += convertSegment(seg)
    }
  }

  return "^" + regex + "$"
}
