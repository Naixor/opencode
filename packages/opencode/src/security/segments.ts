import { SecuritySchema } from "./schema"

export namespace SecuritySegments {
  export interface MarkerSegment {
    start: number
    end: number
    rule: SecuritySchema.MarkerConfig
  }

  interface MarkerMatch {
    index: number
    isStart: boolean
    rule: SecuritySchema.MarkerConfig
  }

  /**
   * Find all protected code segments based on comment markers.
   * Supports common comment styles: //, #, <!-- -->
   * Handles nested markers (inner markers inherit outer protection)
   * and multiple separate marker blocks in the same file.
   */
  export function findMarkerSegments(
    content: string,
    markers: SecuritySchema.MarkerConfig[],
  ): MarkerSegment[] {
    const allMatches: MarkerMatch[] = []

    // Find all start and end markers in the content
    for (const marker of markers) {
      const startPatterns = buildMarkerPatterns(marker.start)
      const endPatterns = buildMarkerPatterns(marker.end)

      // Find all start markers
      for (const pattern of startPatterns) {
        let match: RegExpExecArray | null
        while ((match = pattern.exec(content)) !== null) {
          allMatches.push({
            index: match.index,
            isStart: true,
            rule: marker,
          })
        }
      }

      // Find all end markers
      for (const pattern of endPatterns) {
        let match: RegExpExecArray | null
        while ((match = pattern.exec(content)) !== null) {
          allMatches.push({
            index: match.index + match[0].length,
            isStart: false,
            rule: marker,
          })
        }
      }
    }

    // Sort matches by position
    allMatches.sort((a, b) => a.index - b.index)

    // Process matches using a stack for nested markers
    const segments: MarkerSegment[] = []
    const stack: { index: number; rule: SecuritySchema.MarkerConfig }[] = []

    for (const match of allMatches) {
      if (match.isStart) {
        // Push start marker onto stack
        stack.push({ index: match.index, rule: match.rule })
      }
      if (!match.isStart) {
        // Find matching start marker for this end marker
        const matchingStartIndex = findMatchingStartIndex(stack, match.rule)
        if (matchingStartIndex >= 0) {
          const startMatch = stack[matchingStartIndex]
          segments.push({
            start: startMatch.index,
            end: match.index,
            rule: startMatch.rule,
          })
          stack.splice(matchingStartIndex, 1)
        }
      }
    }

    // Sort segments by start position for consistent output
    segments.sort((a, b) => a.start - b.start)

    return segments
  }

  /**
   * Build regex patterns for a marker text that support common comment styles.
   * Supports: //, #, <!-- -->
   */
  function buildMarkerPatterns(markerText: string): RegExp[] {
    const escapedMarker = escapeRegExp(markerText)
    const patterns: RegExp[] = []

    // Pattern for // style comments (JavaScript, TypeScript, C, C++, Java, etc.)
    patterns.push(new RegExp(`//\\s*${escapedMarker}`, "g"))

    // Pattern for # style comments (Python, Ruby, Shell, etc.)
    patterns.push(new RegExp(`#\\s*${escapedMarker}`, "g"))

    // Pattern for <!-- --> style comments (HTML, XML, Markdown)
    patterns.push(new RegExp(`<!--\\s*${escapedMarker}\\s*-->`, "g"))

    // Pattern for /* */ style comments (C, JavaScript, etc.)
    patterns.push(new RegExp(`/\\*\\s*${escapedMarker}\\s*\\*/`, "g"))

    // Pattern for """ or ''' docstrings (Python)
    patterns.push(new RegExp(`"""\\s*${escapedMarker}\\s*"""`, "g"))
    patterns.push(new RegExp(`'''\\s*${escapedMarker}\\s*'''`, "g"))

    return patterns
  }

  /**
   * Escape special regex characters in a string.
   */
  function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  /**
   * Find the index of the matching start marker in the stack.
   * Looks for the most recent start marker with matching rule markers.
   */
  function findMatchingStartIndex(
    stack: { index: number; rule: SecuritySchema.MarkerConfig }[],
    endRule: SecuritySchema.MarkerConfig,
  ): number {
    // Search from the end of the stack (most recent first)
    for (let i = stack.length - 1; i >= 0; i--) {
      const item = stack[i]
      if (item.rule.start === endRule.start && item.rule.end === endRule.end) {
        return i
      }
    }
    return -1
  }
}
