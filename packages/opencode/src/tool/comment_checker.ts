import path from "path"
import { Config } from "../config/config"

export namespace CommentChecker {
  type Sensitivity = "strict" | "normal" | "relaxed"

  const COMMENT_PREFIXES: Record<string, string[]> = {
    ".js": ["//", "/*"],
    ".ts": ["//", "/*"],
    ".tsx": ["//", "/*"],
    ".jsx": ["//", "/*"],
    ".go": ["//", "/*"],
    ".java": ["//", "/*"],
    ".c": ["//", "/*"],
    ".cpp": ["//", "/*"],
    ".rs": ["//", "/*"],
    ".swift": ["//", "/*"],
    ".kt": ["//", "/*"],
    ".py": ["#"],
    ".rb": ["#"],
    ".sh": ["#"],
    ".yaml": ["#"],
    ".yml": ["#"],
    ".html": ["<!--"],
    ".xml": ["<!--"],
    ".svelte": ["<!--"],
    ".vue": ["<!--"],
    ".css": ["/*"],
    ".scss": ["/*"],
    ".less": ["/*"],
    ".sql": ["--"],
    ".lua": ["--"],
  }

  const ALL_PREFIXES = ["//", "/*", "#", "<!--", "--"]

  const OBVIOUS_PATTERNS = [
    /(Initialize|Create|Set|Define|Declare) (the|a|an) \w+/i,
    /(Return|Log|Print|Output) (the|a) \w+/i,
    /(Loop|Iterate|Map|Filter) (through|over|the) \w+/i,
    /(Check|Verify|Validate|Ensure) (if|that|the) \w+/i,
    /(Import|Require|Include) \w+/i,
    /(Function|Method|Class) (to|that|for) \w+/i,
  ]

  const DENSITY_THRESHOLDS: Record<Sensitivity, number> = {
    strict: 0.15,
    normal: 0.3,
    relaxed: 0.5,
  }

  const PATTERN_THRESHOLDS: Record<Sensitivity, number> = {
    strict: 1,
    normal: 3,
    relaxed: 5,
  }

  function prefixes(ext: string): string[] {
    return COMMENT_PREFIXES[ext] ?? ALL_PREFIXES
  }

  function isComment(line: string, commentPrefixes: string[]): boolean {
    const trimmed = line.trimStart()
    return commentPrefixes.some((p) => trimmed.startsWith(p))
  }

  function stripPrefix(line: string, commentPrefixes: string[]): string {
    const trimmed = line.trimStart()
    for (const p of commentPrefixes) {
      if (trimmed.startsWith(p)) return trimmed.slice(p.length).trim()
    }
    return trimmed
  }

  function levenshtein(a: string, b: string): number {
    const m = a.length
    const n = b.length
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
    for (let i = 0; i <= m; i++) dp[i][0] = i
    for (let j = 0; j <= n; j++) dp[0][j] = j
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
      }
    }
    return dp[m][n]
  }

  export async function check(code: string, filePath: string): Promise<string | undefined> {
    const config = await Config.get()
    const setting = config.experimental?.comment_checker
    if (setting === false) return undefined
    const sensitivity: Sensitivity = typeof setting === "string" ? (setting as Sensitivity) : "normal"

    const ext = path.extname(filePath).toLowerCase()
    const cp = prefixes(ext)
    const lines = code.split("\n")
    const codeLines = lines.filter((l) => l.trim().length > 0)
    if (codeLines.length === 0) return undefined

    const commentLines = codeLines.filter((l) => isComment(l, cp))

    const density = commentLines.length / codeLines.length
    if (density > DENSITY_THRESHOLDS[sensitivity]) {
      return "Note: The generated code contains excessive comments. Consider removing obvious comments."
    }

    let patternScore = 0
    for (const line of commentLines) {
      const stripped = stripPrefix(line, cp)
      for (const pattern of OBVIOUS_PATTERNS) {
        if (pattern.test(stripped)) {
          patternScore++
          break
        }
      }
    }
    if (patternScore >= PATTERN_THRESHOLDS[sensitivity]) {
      return "Note: The generated code contains excessive comments. Consider removing obvious comments."
    }

    for (let i = 0; i < lines.length - 1; i++) {
      if (!isComment(lines[i], cp)) continue
      const comment = stripPrefix(lines[i], cp).replace(/\s+/g, " ").trim().toLowerCase()
      const nextCode = lines[i + 1].trim().replace(/\s+/g, " ").toLowerCase()
      if (comment.length < 5 || nextCode.length < 5) continue
      const dist = levenshtein(comment, nextCode)
      if (dist < comment.length * 0.3) {
        return "Note: The generated code contains excessive comments. Consider removing obvious comments."
      }
    }

    return undefined
  }
}
