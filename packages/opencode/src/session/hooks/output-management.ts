import { Log } from "../../util/log"
import { HookChain } from "./index"

export namespace OutputManagementHooks {
  const log = Log.create({ service: "hooks.output-management" })

  // --- Configuration defaults ---

  const DEFAULT_MAX_OUTPUT_SIZE = 50 * 1024 // 50KB default max per tool output
  const DEFAULT_GREP_MAX_MATCHES = 50
  const DEFAULT_QUESTION_LABEL_MAX = 200
  const DEFAULT_CONTEXT_WARNING_THRESHOLD = 0.8
  const DEFAULT_COMPACTION_THRESHOLD = 0.9
  const REDACTED_MARKER = "[REDACTED: Security Protected]"

  // --- Streaming truncation for large outputs ---

  const STREAM_THRESHOLD = 10 * 1024 * 1024 // 10MB

  export function truncateOutput(output: string, maxSize: number): { text: string; wasTruncated: boolean } {
    if (output.length <= maxSize) return { text: output, wasTruncated: false }

    // Preserve [REDACTED: Security Protected] markers
    const markers: Array<{ index: number; length: number }> = []
    let searchStart = 0
    while (true) {
      const idx = output.indexOf(REDACTED_MARKER, searchStart)
      if (idx === -1) break
      markers.push({ index: idx, length: REDACTED_MARKER.length })
      searchStart = idx + REDACTED_MARKER.length
    }

    // If output is extremely large (streaming case), read first N bytes + tail message
    if (output.length >= STREAM_THRESHOLD) {
      const head = output.slice(0, maxSize)
      const preserved = markers
        .filter((m) => m.index >= maxSize)
        .map((m) => output.slice(m.index, m.index + m.length))
      const markerSection = preserved.length > 0 ? "\n\n" + preserved.join("\n") : ""
      return {
        text: head + markerSection + `\n\n[truncated: output was ${output.length} bytes, showing first ${maxSize} bytes]`,
        wasTruncated: true,
      }
    }

    // Standard truncation: keep first maxSize chars, preserving markers
    const head = output.slice(0, maxSize)
    const truncatedMarkers = markers
      .filter((m) => m.index >= maxSize)
      .map((m) => output.slice(m.index, m.index + m.length))
    const markerSection = truncatedMarkers.length > 0 ? "\n\n" + truncatedMarkers.join("\n") : ""

    return {
      text: head + markerSection + `\n\n[truncated: ${output.length - maxSize} bytes removed]`,
      wasTruncated: true,
    }
  }

  // --- tool-output-truncator (PostToolChain, priority 50) ---
  // Truncates ALL tool outputs based on configurable max size

  function registerToolOutputTruncator(): void {
    HookChain.register("tool-output-truncator", "post-tool", 50, async (ctx) => {
      const output = ctx.result.output
      const maxSize = DEFAULT_MAX_OUTPUT_SIZE
      const result = truncateOutput(output, maxSize)
      if (result.wasTruncated) {
        ctx.result.output = result.text
        log.info("tool output truncated", {
          toolName: ctx.toolName,
          sessionID: ctx.sessionID,
          originalSize: output.length,
          maxSize,
        })
      }
    })
  }

  // --- grep-output-truncator (PostToolChain, priority 60) ---
  // Grep-specific truncation with match count reporting

  export function countGrepMatches(output: string): number {
    // Count non-empty lines that look like grep results (file:line: format or just lines of output)
    const lines = output.split("\n").filter((l) => l.trim().length > 0)
    return lines.length
  }

  function registerGrepOutputTruncator(): void {
    HookChain.register("grep-output-truncator", "post-tool", 60, async (ctx) => {
      if (ctx.toolName !== "grep" && ctx.toolName !== "ripgrep") return

      const output = ctx.result.output
      const totalMatches = countGrepMatches(output)

      if (totalMatches <= DEFAULT_GREP_MAX_MATCHES) return

      const lines = output.split("\n")
      const kept: string[] = []
      let count = 0
      for (const line of lines) {
        if (line.trim().length > 0) {
          count++
          if (count > DEFAULT_GREP_MAX_MATCHES) break
        }
        kept.push(line)
      }

      ctx.result.output = kept.join("\n") + `\n\n[showing ${DEFAULT_GREP_MAX_MATCHES} of ${totalMatches} matches]`
      log.info("grep output truncated", {
        sessionID: ctx.sessionID,
        totalMatches,
        shown: DEFAULT_GREP_MAX_MATCHES,
      })
    })
  }

  // --- question-label-truncator (PostToolChain, priority 70) ---
  // Truncate UI question labels to 200 chars max

  function registerQuestionLabelTruncator(): void {
    HookChain.register("question-label-truncator", "post-tool", 70, async (ctx) => {
      if (!ctx.result.title) return
      if (ctx.result.title.length <= DEFAULT_QUESTION_LABEL_MAX) return

      ctx.result.title = ctx.result.title.slice(0, DEFAULT_QUESTION_LABEL_MAX) + "..."
      log.info("question label truncated", {
        sessionID: ctx.sessionID,
        toolName: ctx.toolName,
      })
    })
  }

  // --- context-window-monitor (PreLLMChain, priority 900) ---
  // Calculate current token usage, warn when above threshold

  let configuredWarningThreshold = DEFAULT_CONTEXT_WARNING_THRESHOLD

  export function estimateTokens(text: string): number {
    // Rough token estimate: ~4 chars per token for English text
    return Math.ceil(text.length / 4)
  }

  export function estimateContextUsage(ctx: HookChain.PreLLMContext): { usedTokens: number; maxTokens: number; ratio: number } {
    const systemText = ctx.system.join("\n")
    const messagesText = JSON.stringify(ctx.messages)
    const usedTokens = estimateTokens(systemText) + estimateTokens(messagesText)
    // Default context window sizes based on common models
    const maxTokens = getModelContextWindow(ctx.model)
    const ratio = usedTokens / maxTokens
    return { usedTokens, maxTokens, ratio }
  }

  export function getModelContextWindow(model: string): number {
    // Conservative defaults for common model families
    if (model.includes("claude-opus") || model.includes("claude-sonnet")) return 200000
    if (model.includes("claude")) return 200000
    if (model.includes("gpt-4")) return 128000
    if (model.includes("gpt-3")) return 16000
    if (model.includes("gemini")) return 1000000
    return 128000 // default
  }

  function registerContextWindowMonitor(): void {
    HookChain.register("context-window-monitor", "pre-llm", 900, async (ctx) => {
      const usage = estimateContextUsage(ctx)

      if (usage.ratio >= configuredWarningThreshold && usage.ratio < DEFAULT_COMPACTION_THRESHOLD) {
        const pct = Math.round(usage.ratio * 100)
        ctx.system.push(
          `\n\nWARNING: Context window is ${pct}% full (estimated ${usage.usedTokens} of ${usage.maxTokens} tokens). Consider being more concise and wrapping up current work soon.`,
        )
        log.info("context window warning", {
          sessionID: ctx.sessionID,
          usage: pct,
          usedTokens: usage.usedTokens,
          maxTokens: usage.maxTokens,
        })
      }
    })
  }

  // --- preemptive-compaction (PreLLMChain, priority 910) ---
  // When context >90%, trigger compaction BEFORE sending to LLM

  let configuredCompactionThreshold = DEFAULT_COMPACTION_THRESHOLD

  function registerPreemptiveCompaction(): void {
    HookChain.register("preemptive-compaction", "pre-llm", 910, async (ctx) => {
      const usage = estimateContextUsage(ctx)

      if (usage.ratio >= configuredCompactionThreshold) {
        const pct = Math.round(usage.ratio * 100)
        // Signal compaction via variant metadata
        ctx.variant = "compact"
        ctx.system.push(
          `\n\nCRITICAL: Context window is ${pct}% full. Compaction triggered. Summarize your current progress and key findings before continuing.`,
        )
        log.info("preemptive compaction triggered", {
          sessionID: ctx.sessionID,
          usage: pct,
          usedTokens: usage.usedTokens,
          maxTokens: usage.maxTokens,
        })
      }
    })
  }

  // --- Configure thresholds ---

  export function configureThresholds(options: { warningThreshold?: number; compactionThreshold?: number }): void {
    if (options.warningThreshold !== undefined) {
      configuredWarningThreshold = options.warningThreshold
    }
    if (options.compactionThreshold !== undefined) {
      configuredCompactionThreshold = options.compactionThreshold
    }
  }

  export function resetThresholds(): void {
    configuredWarningThreshold = DEFAULT_CONTEXT_WARNING_THRESHOLD
    configuredCompactionThreshold = DEFAULT_COMPACTION_THRESHOLD
  }

  // --- Register all output management hooks ---

  export function register(): void {
    registerToolOutputTruncator()
    registerGrepOutputTruncator()
    registerQuestionLabelTruncator()
    registerContextWindowMonitor()
    registerPreemptiveCompaction()
  }
}
