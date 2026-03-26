import z from "zod"
import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Memory } from "../memory"
import { Bus } from "@/bus"
import { MemoryEvent } from "../event"
import { load, sections } from "../prompt/loader"
import { render } from "../prompt/template"
import { ConfigPaths } from "@/config/paths"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"

export namespace MemoryExtractor {
  const log = Log.create({ service: "memory.extractor" })

  // Concurrency guard: prevent multiple extractions on the same session
  const inflight = new Set<string>()

  // --- LLM extraction result schema ---

  export const ExtractedItem = z.object({
    action: z.enum(["create", "update"]).default("create"),
    targetID: z.string().optional(),
    content: z.string(),
    category: Memory.Category,
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
      category?: Memory.Category
      tags?: string[]
    },
  ): Promise<Memory.Info> {
    const contextWindow = recentMessages.slice(-10)
    const contextSnapshot = contextWindow.map((m) => `[${m.role}]: ${m.content}`).join("\n---\n")

    const content = userInput
    const category = options?.category ?? "context"
    const tags = options?.tags ?? []

    const memory = await Memory.create({
      content,
      category,
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

  /**
   * Resolve the model ref for memory agents from config or default.
   */
  async function model() {
    const cfg = await Config.get()
    return cfg.memory?.recallProvider && cfg.memory?.recallModel
      ? { providerID: cfg.memory.recallProvider, modelID: cfg.memory.recallModel }
      : await Provider.defaultModel()
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

  /**
   * Extract memories from a session's conversation history.
   *
   * Uses the standard subagent pipeline (SessionPrompt.prompt) for full
   * security, hook chain, log capture, and provider transform support.
   */
  export async function extractFromSession(
    sessionID: string,
    messages: Array<{ role: string; content: string }>,
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
      const tpl = await load("extract", await ConfigPaths.directories(Instance.directory, Instance.worktree))
      const parts = sections(tpl)
      const existing = await Memory.list()
      const prompt = buildAutoExtractPrompt(contextWindow, existing, parts.analysis)

      log.info("extractFromSession: invoking subagent", { sessionID })

      const session = await Session.create({
        parentID: sessionID,
        title: "memory-extractor",
      })

      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        model: await model(),
        agent: "memory-extractor",
        system: parts.system,
        parts: [{ type: "text", text: prompt }],
      })

      // Parse JSON from the text response
      const text = result.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as any).text ?? "")
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
              category: item.category,
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
          category: item.category,
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
      "- Include specific technical details (framework names, config values, code patterns)",
      "- Output JSON: { content, category, tags, citations }",
      "",
      "Context:",
      contextSnapshot,
    ].join("\n")
  }

  function formatExisting(memories: Memory.Info[]): string {
    if (memories.length === 0) return "No existing memories."
    return memories.map((m) => `- [${m.id}] (${m.category}) ${m.content}`).join("\n")
  }

  export function buildAutoExtractPrompt(
    messages: Array<{ role: string; content: string }>,
    existing: Memory.Info[],
    tpl?: string,
  ): string {
    const conversation = messages
      .slice(-20)
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n---\n")

    const memorySummary = formatExisting(existing)

    if (tpl) {
      return render(tpl, { CONVERSATION: conversation, EXISTING_MEMORIES: memorySummary })
    }

    return [
      "Analyze the following development conversation and extract persistent preferences,",
      "code patterns, tool choices, and project conventions worth remembering long-term.",
      "",
      "Distinguish between:",
      '- Persistent preferences ("our project uses Hono", "no semicolons") → EXTRACT',
      '- One-time instructions ("don\'t use console.log for this debug") → DO NOT extract',
      '- Project conventions ("API response format: { code, data, message }") → EXTRACT',
      '- Temporary context ("help me look at this bug") → DO NOT extract',
      "",
      "## Existing memories",
      "",
      memorySummary,
      "",
      "## Rules for action",
      "",
      "For each piece of knowledge worth remembering:",
      '- If it refines, extends, or supersedes an existing memory, use action "update" with the target memory\'s ID.',
      "  Merge the old and new information into a single coherent content string.",
      '- If it is genuinely new, use action "create".',
      "- Do NOT create a memory that duplicates or overlaps with an existing one; update it instead.",
      "",
      "## Conversation",
      "",
      conversation,
      "",
      'If nothing is worth extracting, return an empty items array: { "items": [] }',
      "",
      "Respond ONLY with the JSON object. No explanation before or after.",
    ].join("\n")
  }
}
