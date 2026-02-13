import { Log } from "../../util/log"
import { HookChain } from "./index"

export namespace DetectionCheckingHooks {
  const log = Log.create({ service: "hooks.detection-checking" })

  // --- keyword-detector (PreLLMChain, priority 200) ---
  // Detect mode keywords in messages and set variant accordingly

  const KEYWORD_MAP: Array<{ keywords: string[]; variant: string }> = [
    { keywords: ["[ultrawork]", "ulw"], variant: "max" },
    { keywords: ["[analyze-mode]"], variant: "analyze" },
    { keywords: ["[review-mode]"], variant: "review" },
  ]

  function getLastUserMessage(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as { role?: string; content?: unknown }
      if (msg.role !== "user") continue
      if (typeof msg.content === "string") return msg.content
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          const p = part as { type?: string; text?: string }
          if (p.type === "text" && typeof p.text === "string") return p.text
        }
      }
    }
    return ""
  }

  function registerKeywordDetector(): void {
    HookChain.register("keyword-detector", "pre-llm", 200, async (ctx) => {
      const text = getLastUserMessage(ctx.messages)
      if (!text) return

      const lower = text.toLowerCase()
      for (const entry of KEYWORD_MAP) {
        for (const kw of entry.keywords) {
          if (lower.includes(kw.toLowerCase())) {
            ctx.variant = entry.variant
            log.info("keyword detected", {
              sessionID: ctx.sessionID,
              keyword: kw,
              variant: entry.variant,
            })
            return
          }
        }
      }
    })
  }

  // --- comment-checker (PostToolChain, priority 400) ---
  // After edit/write tool, validate generated code doesn't have >40% comment lines

  const DEFAULT_COMMENT_THRESHOLD = 0.4

  let configuredCommentThreshold = DEFAULT_COMMENT_THRESHOLD

  function isCommentLine(line: string): boolean {
    const trimmed = line.trim()
    if (!trimmed) return false
    return (
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("<!--") ||
      trimmed.startsWith("--")
    )
  }

  function calculateCommentRatio(code: string): { ratio: number; commentLines: number; codeLines: number } {
    const lines = code.split("\n")
    const nonEmpty = lines.filter((l) => l.trim().length > 0)
    if (nonEmpty.length === 0) return { ratio: 0, commentLines: 0, codeLines: 0 }
    const commentLines = nonEmpty.filter(isCommentLine).length
    return { ratio: commentLines / nonEmpty.length, commentLines, codeLines: nonEmpty.length }
  }

  function registerCommentChecker(): void {
    HookChain.register("comment-checker", "post-tool", 400, async (ctx) => {
      if (ctx.toolName !== "edit" && ctx.toolName !== "write") return

      const output = ctx.result.output
      // Only check on success
      if (output.includes("Error") || output.includes("error:")) return

      // Try to extract the new_string from args (the code that was written)
      const newContent = (ctx.args.new_string ?? ctx.args.content ?? "") as string
      if (!newContent || newContent.length < 20) return

      const { ratio, commentLines, codeLines } = calculateCommentRatio(newContent)
      if (ratio > configuredCommentThreshold) {
        const pct = Math.round(ratio * 100)
        ctx.result.output =
          output +
          `\n\nWARNING: Generated code has ${pct}% comment lines (${commentLines} of ${codeLines} non-empty lines). This exceeds the ${Math.round(configuredCommentThreshold * 100)}% threshold. Consider reducing excessive comments — code should be self-documenting where possible.`
        log.info("comment checker warning", {
          sessionID: ctx.sessionID,
          ratio: pct,
          commentLines,
          codeLines,
        })
      }
    })
  }

  // --- empty-task-response-detector (PostToolChain, priority 350) ---
  // Detect empty/minimal responses from delegate_task

  function registerEmptyTaskResponseDetector(): void {
    HookChain.register("empty-task-response-detector", "post-tool", 350, async (ctx) => {
      if (ctx.toolName !== "delegate_task" && ctx.toolName !== "task") return

      const output = ctx.result.output.trim()
      if (output.length === 0 || output.length < 10) {
        ctx.result.output =
          (output || "(empty)") +
          "\n\nWARNING: Task returned empty or minimal result. Investigate the task output or retry with more specific instructions."
        log.info("empty task response detected", {
          sessionID: ctx.sessionID,
          outputLength: output.length,
        })
      }
    })
  }

  // --- write-existing-file-guard (PreToolChain, priority 200) ---
  // When write tool targets existing file, inject warning

  function registerWriteExistingFileGuard(): void {
    HookChain.register("write-existing-file-guard", "pre-tool", 200, async (ctx) => {
      if (ctx.toolName !== "write") return

      const filePath = ctx.args.file_path as string | undefined
      if (!filePath) return

      const file = Bun.file(filePath)
      const exists = await file.exists()
      if (exists) {
        ctx.args._warning =
          "WARNING: File already exists. Prefer using the edit tool to make targeted changes instead of overwriting the entire file with write."
        log.info("write-existing-file-guard triggered", {
          sessionID: ctx.sessionID,
          filePath,
        })
      }
    })
  }

  // --- Configure thresholds ---

  export function configureCommentThreshold(threshold: number): void {
    configuredCommentThreshold = threshold
  }

  export function resetCommentThreshold(): void {
    configuredCommentThreshold = DEFAULT_COMMENT_THRESHOLD
  }

  // --- Register all detection/checking hooks ---

  export function register(): void {
    registerKeywordDetector()
    registerCommentChecker()
    registerEmptyTaskResponseDetector()
    registerWriteExistingFileGuard()
  }
}
