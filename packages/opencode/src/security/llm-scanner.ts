import { SecuritySchema } from "./schema"
import { SecuritySegments } from "./segments"

export namespace LLMScanner {
  export interface ProtectedMatch {
    start: number
    end: number
    matchedText: string
    ruleType: "marker" | "ast" | "pattern"
    rule: SecuritySchema.MarkerConfig | SecuritySchema.ASTConfig | SecuritySchema.Rule
  }

  /**
   * Scan outgoing LLM request content for protected patterns.
   * Checks content against all configured segment markers and file-path patterns
   * from the security config.
   *
   * @param content - The content string to scan
   * @param config - The security configuration with rules and segment definitions
   * @returns Array of matches indicating protected content found, with rule info
   */
  export function scanForProtectedContent(
    content: string,
    config: SecuritySchema.SecurityConfig,
  ): ProtectedMatch[] {
    const matches: ProtectedMatch[] = []

    // Check against segment markers (comment-based protection markers)
    const markerMatches = scanMarkers(content, config.segments?.markers ?? [])
    matches.push(...markerMatches)

    // Check against file-path pattern rules that deny 'llm' operations
    const patternMatches = scanPathPatterns(content, config.rules ?? [])
    matches.push(...patternMatches)

    // Sort by start position for consistent output
    matches.sort((a, b) => a.start - b.start)

    return matches
  }

  /**
   * Scan content for marker-based protected segments.
   * Only reports markers whose deniedOperations include 'llm'.
   */
  function scanMarkers(content: string, markers: SecuritySchema.MarkerConfig[]): ProtectedMatch[] {
    const llmMarkers = markers.filter((m) => m.deniedOperations.includes("llm"))

    if (llmMarkers.length === 0) {
      return []
    }

    const segments = SecuritySegments.findMarkerSegments(content, llmMarkers)

    return segments.map((seg) => ({
      start: seg.start,
      end: seg.end,
      matchedText: content.slice(seg.start, Math.min(seg.end, seg.start + 100)),
      ruleType: "marker" as const,
      rule: seg.rule,
    }))
  }

  /**
   * Scan content for file-path patterns that appear in the text.
   * Checks rules that deny 'llm' operations and looks for their glob patterns
   * as literal substrings in the content (e.g., ".env", "secrets/", "private/").
   */
  function scanPathPatterns(content: string, rules: SecuritySchema.Rule[]): ProtectedMatch[] {
    const llmRules = rules.filter((r) => r.deniedOperations.includes("llm"))

    if (llmRules.length === 0) {
      return []
    }

    const matches: ProtectedMatch[] = []

    for (const rule of llmRules) {
      // Extract a searchable literal from the glob pattern
      const searchPattern = extractLiteralFromGlob(rule.pattern)
      if (!searchPattern) {
        continue
      }

      // Search for occurrences of the pattern in the content
      let startIndex = 0
      while (true) {
        const index = content.indexOf(searchPattern, startIndex)
        if (index === -1) {
          break
        }

        matches.push({
          start: index,
          end: index + searchPattern.length,
          matchedText: searchPattern,
          ruleType: "pattern" as const,
          rule,
        })

        startIndex = index + 1
      }
    }

    return matches
  }

  /**
   * Extract a searchable literal string from a glob pattern.
   * Strips leading glob wildcards and returns the meaningful path portion.
   * Returns undefined if the pattern is too generic to search for.
   */
  function extractLiteralFromGlob(pattern: string): string | undefined {
    // Remove leading **/ or */
    const stripped = pattern.replace(/^\*\*\//, "").replace(/^\*\//, "")

    // If the remaining pattern is just wildcards, skip it
    if (/^\*+$/.test(stripped)) {
      return undefined
    }

    // If the pattern still contains wildcards in the middle, use the longest literal prefix
    const wildcardIndex = stripped.search(/[*?[\]{]/)
    if (wildcardIndex === 0) {
      return undefined
    }
    if (wildcardIndex > 0) {
      return stripped.slice(0, wildcardIndex)
    }

    // No wildcards remaining, use the full stripped pattern
    return stripped
  }
}
