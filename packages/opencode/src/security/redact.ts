import { SecuritySegments } from "./segments"

export namespace SecurityRedact {
  export interface Segment {
    start: number
    end: number
  }

  export const REDACTED_PLACEHOLDER = "[REDACTED: Security Protected]"

  /**
   * Merge overlapping segments into non-overlapping ranges.
   * Segments that touch or overlap are combined into a single range.
   */
  export function mergeSegments(segments: Segment[]): Segment[] {
    if (segments.length === 0) {
      return []
    }

    // Sort by start position
    const sorted = [...segments].sort((a, b) => a.start - b.start)

    const merged: Segment[] = []
    let current = { ...sorted[0] }

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i]
      // Check if segments overlap or touch
      if (next.start <= current.end) {
        // Extend current segment to include the overlapping one
        current.end = Math.max(current.end, next.end)
      }
      if (next.start > current.end) {
        // No overlap, push current and start new segment
        merged.push(current)
        current = { ...next }
      }
    }

    // Don't forget to push the last segment
    merged.push(current)

    return merged
  }

  /**
   * Count the number of newlines in a string.
   */
  function countNewlines(str: string): number {
    let count = 0
    for (const char of str) {
      if (char === "\n") {
        count++
      }
    }
    return count
  }

  /**
   * Redact protected segments from file content.
   * Replaces protected ranges with a placeholder while preserving line numbers
   * (multi-line segments are replaced with same number of newlines).
   *
   * @param content - Original file content
   * @param segments - Array of segments to redact (can be MarkerSegment, ASTSegment, or any object with start/end)
   * @returns Content with protected ranges replaced by redaction placeholder
   */
  export function redactContent(
    content: string,
    segments: (Segment | SecuritySegments.MarkerSegment | SecuritySegments.ASTSegment)[],
  ): string {
    if (segments.length === 0) {
      return content
    }

    // Convert to generic Segment type (just need start/end)
    const genericSegments: Segment[] = segments.map((s) => ({ start: s.start, end: s.end }))

    // Merge overlapping segments
    const merged = mergeSegments(genericSegments)

    // Build the redacted content by processing segments from end to start
    // (processing from end preserves indices)
    let result = content

    for (let i = merged.length - 1; i >= 0; i--) {
      const segment = merged[i]
      const originalText = content.slice(segment.start, segment.end)
      const newlineCount = countNewlines(originalText)

      // Create replacement: placeholder followed by same number of newlines
      const replacement = newlineCount > 0 ? REDACTED_PLACEHOLDER + "\n".repeat(newlineCount) : REDACTED_PLACEHOLDER

      result = result.slice(0, segment.start) + replacement + result.slice(segment.end)
    }

    return result
  }
}
