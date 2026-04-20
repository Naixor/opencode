import z from "zod"
import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Memory } from "../memory"
import { Bus } from "@/bus"
import { MemoryEvent } from "../event"
import { load, sections } from "../prompt/loader"
import { ConfigPaths } from "@/config/paths"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { Token } from "@/util/token"
import { composeRecallQuery, prepareRetentionTranscript, truncateRecallQuery } from "../hindsight/content"
import { MemoryHindsightRetain } from "../hindsight/retain"
import { MemoryHindsightRecall } from "../hindsight/recall"

export namespace MemoryExtractor {
  const log = Log.create({ service: "memory.extractor" })
  type Prompt = "extract" | "extract-hindsight"
  const DEFAULT_HINT_ITEMS = 6
  const DEFAULT_HINT_TOKENS = 1200

  export interface Hint {
    text: string
    kind?: string
    id?: string
    score?: number
  }

  // Concurrency guard: prevent multiple extractions on the same session
  const inflight = new Set<string>()

  // --- LLM extraction result schema ---

  export const ExtractedItem = z.object({
    action: z.enum(["create", "update"]).default("create"),
    targetID: z.string().optional(),
    content: z.string(),
    categories: z.array(Memory.Category).min(1),
    tags: z.array(z.string()).default([]),
    citations: z.array(z.string()).default([]),
  })
  export type ExtractedItem = z.infer<typeof ExtractedItem>

  const Schema = z.object({ items: z.array(ExtractedItem) })

  /**
   * /remember command handler: extract memory with full conversation context.
   */
  export async function rememberWithContext(
    sessionID: string,
    userInput: string,
    recentMessages: Array<{ role: string; content: string }>,
    options?: {
      llmLogID?: string
      categories?: Memory.Category[]
      tags?: string[]
    },
  ): Promise<Memory.Info> {
    const contextWindow = recentMessages.slice(-10)
    const contextSnapshot = contextWindow.map((m) => `[${m.role}]: ${m.content}`).join("\n---\n")

    const content = userInput
    const categories = options?.categories ?? ["context"]
    const tags = options?.tags ?? []

    const memory = await Memory.create({
      content,
      categories,
      scope: "personal",
      status: "confirmed",
      tags,
      source: {
        sessionID,
        llmLogID: options?.llmLogID,
        method: "manual",
        contextSnapshot,
      },
    })

    Memory.markDirty(sessionID)
    await Bus.publish(MemoryEvent.Created, { info: memory })

    log.info("remember with context", {
      id: memory.id,
      sessionID,
      contentLength: content.length,
      contextMessages: contextWindow.length,
    })

    return memory
  }

  // Track whether we've warned this session about primary model usage
  const warned = new Set<string>()

  /**
   * Resolve the model ref for memory agents from config or default.
   */
  async function model() {
    const cfg = await Config.get()
    const agent = cfg.agent?.["memory-extractor"]
    if (agent?.model) {
      return Provider.parseModel(agent.model)
    }
    if (cfg.memory?.recallModel) {
      const primary = await Provider.defaultModel()
      return {
        providerID: cfg.memory.recallProvider ?? primary.providerID,
        modelID: cfg.memory.recallModel,
      }
    }
    const primary = await Provider.defaultModel()
    const small = await Provider.getSmallModel(primary.providerID)
    if (small) {
      return { providerID: small.providerID, modelID: small.id }
    }
    if (!warned.has("extractor")) {
      warned.add("extractor")
      log.warn(
        "memory-extractor using primary model, consider config.agent.memory-extractor.model or config.small_model",
      )
      Bus.publish(MemoryEvent.Warning, {
        type: "memory_model_cost",
        agent: "memory-extractor",
        model: `${primary.providerID}/${primary.modelID}`,
      })
    }
    return primary
  }

  /**
   * Parse JSON from LLM text response, handling markdown code fences.
   */
  function parse(text: string): z.infer<typeof Schema> | undefined {
    // Strip markdown code fences
    const clean = text.replace(/```(?:json)?\s*\n?([\s\S]*?)\n?```/g, "$1").trim()
    // Try to find JSON object
    const start = clean.indexOf("{")
    if (start === -1) return undefined
    const end = clean.lastIndexOf("}")
    if (end === -1) return undefined
    const result = Schema.safeParse(JSON.parse(clean.slice(start, end + 1)))
    return result.success ? result.data : undefined
  }

  async function prompt() {
    const cfg = await Config.get()
    const name: Prompt = cfg.memory?.hindsight.enabled && cfg.memory.hindsight.extract ? "extract-hindsight" : "extract"
    const dirs = await ConfigPaths.directories(Instance.directory, Instance.worktree)
    const tpl = await load(name, dirs)
    return {
      name,
      parts: sections(tpl, name),
      items: cfg.memory?.hindsight.context_max_items,
      tokens: cfg.memory?.hindsight.context_max_tokens,
    }
  }

  function system(input: { system: string; existing: Memory.Info[]; snapshot: string; hints?: string }) {
    const result = [input.system, "", "## Existing memories", "", formatExisting(input.existing)]
    if (input.hints) {
      result.push("", "## Hindsight context", "", input.hints)
    }
    result.push("", "## Session conversation", "", input.snapshot)
    return result.join("\n")
  }

  function note(input: Hint) {
    const parts = [
      input.kind,
      input.id,
      typeof input.score === "number" && Number.isFinite(input.score) ? `score:${input.score.toFixed(3)}` : undefined,
    ].filter(Boolean)
    return parts.join(", ")
  }

  function entry(input: Hint, text = input.text.replace(/\s+/g, " ").trim()) {
    if (!text) return ""
    const meta = note(input)
    return meta ? `- ${text} (${meta})` : `- ${text}`
  }

  function fit(lines: string[], input: Hint, cap: number) {
    const text = input.text.replace(/\s+/g, " ").trim()
    if (!text) return

    let low = 0
    let high = text.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      const next = entry(input, `${text.slice(0, mid).trimEnd()}${mid < text.length ? "..." : ""}`)
      if (!next) break
      if (Token.estimate([...lines, next].join("\n")) <= cap) {
        low = mid
        continue
      }
      high = mid - 1
    }

    if (low <= 0) return
    return entry(input, `${text.slice(0, low).trimEnd()}${low < text.length ? "..." : ""}`)
  }

  export function formatHints(list: Hint[], input: { items?: number; tokens?: number } = {}) {
    const max = input.items ?? DEFAULT_HINT_ITEMS
    const cap = input.tokens ?? DEFAULT_HINT_TOKENS
    if (max <= 0 || cap <= 0 || list.length === 0) return ""

    const lines: string[] = []
    for (const item of list) {
      if (lines.length >= max) break
      const full = entry(item)
      if (full && Token.estimate([...lines, full].join("\n")) <= cap) {
        lines.push(full)
        continue
      }
      const next = fit(lines, item, cap)
      if (next) lines.push(next)
      break
    }
    return lines.join("\n")
  }

  async function retain(sessionID: string, messages: Array<{ role: string; content: string }>, name: Prompt) {
    if (name !== "extract-hindsight") return
    const start = Math.max(messages.length - Math.min(messages.length, 20), 0)
    const view = messages.slice(start)
    const transcript = prepareRetentionTranscript(view, true).transcript
    if (!transcript) return
    const now = Date.now()
    const result = await MemoryHindsightRetain.session({
      session_id: sessionID,
      start,
      end: messages.length,
      content: transcript,
      created_at: now,
      updated_at: now,
    })
    log.info("extract session retained", {
      sessionID,
      status: result.status,
      document_id: result.document_id,
      start,
      end: messages.length,
    })
  }

  function query(messages: Array<{ role: string; content: string }>) {
    const latest = [...messages]
      .reverse()
      .find((item) => item.role === "user")
      ?.content.trim()
    if (!latest) return ""
    return truncateRecallQuery(
      composeRecallQuery(
        latest,
        messages,
        messages.filter((item) => item.role === "user" && item.content.trim()).length,
      ),
      latest,
      800,
    )
  }

  /**
   * Extract memories from a session's conversation history.
   *
   * Uses the standard subagent pipeline (SessionPrompt.prompt) for full
   * security, hook chain, log capture, and provider transform support.
   */
  export async function extractFromSession(
    sessionID: string,
    messages: Array<{ role: string; content: string }>,
    options?: { context?: Hint[] },
  ): Promise<Memory.Info[]> {
    if (messages.length === 0) {
      log.info("no messages to extract from", { sessionID })
      return []
    }

    if (inflight.has(sessionID)) {
      log.info("extraction already in flight, skipping", { sessionID })
      return []
    }
    inflight.add(sessionID)

    const contextWindow = messages.slice(-20)
    const contextSnapshot = contextWindow.map((m) => `[${m.role}]: ${m.content}`).join("\n---\n")

    try {
      const cfg = await prompt()
      const existing = await Memory.list()
      await retain(sessionID, messages, cfg.name)

      const base = options?.context ?? []
      const extra =
        cfg.name === "extract-hindsight"
          ? await MemoryHindsightRecall.context({ query: query(contextWindow) || contextSnapshot })
          : undefined
      const merged = [...base, ...(extra?.items ?? [])]
      const hints = cfg.name === "extract-hindsight" ? formatHints(merged, cfg) : ""
      const sys = system({
        system: cfg.parts.system,
        existing,
        snapshot: contextSnapshot,
        hints,
      })

      const task = cfg.parts.analysis || buildTaskInstructions()

      log.info("extractFromSession: invoking subagent", {
        sessionID,
        prompt: cfg.name,
        hindsight_used: Boolean(hints),
        hindsight_hits: extra?.hits ?? 0,
        hints: hints ? hints.split("\n").length : 0,
      })

      const session = await Session.create({
        parentID: sessionID,
        title: "memory-extractor",
      })

      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        model: await model(),
        agent: "memory-extractor",
        system: sys,
        variant: cfg.name === "extract-hindsight" ? "hindsight" : undefined,
        parts: [{ type: "text", text: task }],
      })

      // Parse JSON from the text response
      const text = result.parts
        .filter((p: { type: string }) => p.type === "text")
        .map((p: { text?: string }) => p.text ?? "")
        .join("")
      const parsed = parse(text)
      const extracted = parsed?.items ?? []

      if (extracted.length === 0) {
        log.info("no memories worth extracting", { sessionID })
        return []
      }

      // Apply each action
      const existingContents = new Set(existing.map((m) => m.content.toLowerCase()))
      const existingIDs = new Map(existing.map((m) => [m.id, m]))

      const changed: Memory.Info[] = []
      for (const item of extracted) {
        if (item.action === "update" && item.targetID) {
          const target = existingIDs.get(item.targetID)
          if (target) {
            const updated = await Memory.update(target.id, {
              content: item.content,
              categories: item.categories,
              tags: [...new Set([...target.tags, ...item.tags])],
              citations: [...new Set([...(target.citations ?? []), ...item.citations])],
              source: {
                ...target.source,
                sessionID,
                method: "auto",
                contextSnapshot,
              },
            })
            if (updated) {
              changed.push(updated)
              await Bus.publish(MemoryEvent.Updated, { info: updated })
            }
            continue
          }
          log.info("update target not found, creating instead", { targetID: item.targetID })
        }

        if (existingContents.has(item.content.toLowerCase())) continue

        const memory = await Memory.create({
          content: item.content,
          categories: item.categories,
          scope: "personal",
          status: "pending",
          tags: item.tags,
          citations: item.citations,
          source: {
            sessionID,
            method: "auto",
            contextSnapshot,
          },
        })
        changed.push(memory)
        await Bus.publish(MemoryEvent.Created, { info: memory })
      }

      log.info("extracted memories from session", {
        sessionID,
        extracted: extracted.length,
        created: changed.filter((m) => m.source.method === "auto" && !existingIDs.has(m.id)).length,
        updated: changed.filter((m) => existingIDs.has(m.id)).length,
        skipped: extracted.length - changed.length,
      })

      return changed
    } catch (err) {
      log.error("LLM extraction failed", {
        sessionID,
        error: err,
        errorName: err instanceof Error ? err.name : "unknown",
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack : undefined,
        errorCause: err instanceof Error ? (err as any).cause : undefined,
      })
      return []
    } finally {
      inflight.delete(sessionID)
    }
  }

  export function buildRememberPrompt(userInput: string, contextSnapshot: string): string {
    return [
      `The user said: "${userInput}"`,
      "",
      "Based on the conversation context below, extract a clear, self-contained memory",
      "that can be understood without the original conversation.",
      "",
      "Requirements:",
      '- Content must be self-contained, no pronouns like "this" or "that"',
      "- Keep it concise and focused on one durable rule or preference",
      '- Prefer structured wording like "Topic: detail" when helpful',
      "- Keep content under 120 characters unless extra detail is necessary",
      "- Include specific technical details (framework names, config values, code patterns)",
      "- Output JSON: { content, category, tags, citations }",
      "",
      "Context:",
      contextSnapshot,
    ].join("\n")
  }

  function formatExisting(memories: Memory.Info[]): string {
    if (memories.length === 0) return "No existing memories."
    return memories.map((m) => `- [${m.id}] (${m.categories.join(",")}) ${m.content}`).join("\n")
  }

  /**
   * Build the user-prompt task instructions for auto-extraction.
   * Context (conversation, existing memories) is in the system prompt.
   */
  function buildTaskInstructions(): string {
    return [
      "Analyze the session conversation provided in the system prompt and extract persistent preferences,",
      "code patterns, tool choices, and project conventions worth remembering long-term.",
      "",
      "Distinguish between:",
      '- Persistent preferences ("our project uses Hono", "no semicolons") → EXTRACT',
      '- One-time instructions ("don\'t use console.log for this debug") → DO NOT extract',
      '- Project conventions ("API response format: { code, data, message }") → EXTRACT',
      '- Temporary context ("help me look at this bug") → DO NOT extract',
      "",
      "## Rules for action",
      "",
      "For each piece of knowledge worth remembering:",
      '- If it refines, extends, or supersedes an existing memory, use action "update" with the target memory\'s ID.',
      "  Merge the old and new information into a single coherent content string.",
      '- If it is genuinely new, use action "create".',
      "- Do NOT create a memory that duplicates or overlaps with an existing one; update it instead.",
      "- Keep each memory concise and scoped to one durable point.",
      '- Prefer structured wording like "Topic: detail" when helpful.',
      "- Keep content under 120 characters unless extra detail is necessary.",
      "- Put extra lookup terms in tags instead of padding the content.",
      "",
      'If nothing is worth extracting, return an empty items array: { "items": [] }',
      "",
      "Respond ONLY with the JSON object. No explanation before or after.",
    ].join("\n")
  }
}
