/**
 * Agent LLM Request Tests — REAL HTTP requests (no mocks)
 *
 * Sends actual requests to the Anthropic API to verify the full request
 * pipeline for memory-extractor, memory-recall, and omo-explore.
 *
 * ⚠️  MANUAL TEST — excluded from `bun test` by default to avoid
 *    burning API tokens on every CI / local test run.
 *
 * Run explicitly:
 *   cd packages/opencode
 *   AGENT_REQUEST_TEST=1 bun test test/session/agent-request.test.ts
 *
 * Auth resolution order:
 *   1. ANTHROPIC_API_KEY env var (standard)
 *   2. OAuth access token from ~/.local/share/opencode/auth.json
 *
 * Uses claude-haiku-4-5 (cheapest) with minimal prompts to keep cost low.
 */
import { describe, expect, test } from "bun:test"
import path from "path"
import z from "zod"
import type { ModelMessage } from "ai"
import { LLM } from "../../src/session/llm"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Agent } from "../../src/agent/agent"
import { MemoryExtractor } from "../../src/memory/engine/extractor"
import { MemoryRecall } from "../../src/memory/engine/recall"
import { Memory } from "../../src/memory/memory"
import { MemoryStorage } from "../../src/memory/storage"
import { Filesystem } from "../../src/util/filesystem"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"
import type { MessageV2 } from "../../src/session/message-v2"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROVIDER = "anthropic"
const MODEL = "claude-haiku-4-5"
const TIMEOUT = 60_000

// ---------------------------------------------------------------------------
// Gate: require AGENT_REQUEST_TEST=1 to run (avoid burning tokens by default)
// ---------------------------------------------------------------------------

const ENABLED = process.env.AGENT_REQUEST_TEST === "1"

if (!ENABLED) {
  console.log("⏭️  agent-request tests skipped (set AGENT_REQUEST_TEST=1 to run)")
}

// ---------------------------------------------------------------------------
// Auth: resolve credentials for tests
// ---------------------------------------------------------------------------

const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

type AuthEntry =
  | {
      type: "oauth"
      refresh: string
      access: string
      expires: number
    }
  | {
      type: "api"
      key: string
    }

/** Read stored auth entry from auth.json */
async function readAuth(): Promise<AuthEntry | undefined> {
  for (const dir of [Global.Path.data, path.join(process.env.HOME ?? "", ".local/share/opencode")]) {
    const file = path.join(dir, "auth.json")
    const data = await Filesystem.readJson<Record<string, any>>(file).catch(() => null)
    if (data?.[PROVIDER]) return data[PROVIDER] as AuthEntry
  }
  return undefined
}

/** Refresh OAuth token if expired, returns fresh access token */
async function freshToken(entry: AuthEntry & { type: "oauth" }): Promise<string> {
  if (entry.access && entry.expires > Date.now()) return entry.access

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: entry.refresh,
      client_id: CLIENT_ID,
    }),
  })
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`)
  const json = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number }

  // Update stored auth
  const file = path.join(Global.Path.data, "auth.json")
  const data = await Filesystem.readJson<Record<string, any>>(file).catch(() => ({}) as Record<string, any>)
  data[PROVIDER] = {
    type: "oauth",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  }
  await Bun.write(file, JSON.stringify(data, null, 2))

  return json.access_token
}

// Only resolve auth when test is enabled
let RUN = false

if (ENABLED) {
  const stored = await readAuth()
  const envKey = process.env.ANTHROPIC_API_KEY

  const mode = envKey
    ? ("apiKey" as const)
    : stored?.type === "api"
      ? ("apiKey" as const)
      : stored?.type === "oauth"
        ? ("oauth" as const)
        : undefined

  RUN = !!mode

  if (!RUN) {
    console.warn("⚠️  No anthropic auth — skipping agent-request tests")
    console.warn("   Set ANTHROPIC_API_KEY or run `opencode auth anthropic`")
  } else {
    console.log("✅ Anthropic auth found (mode=%s), running real request tests", mode)

    // Set ANTHROPIC_API_KEY env var for the SDK to pick up
    if (mode === "oauth" && stored?.type === "oauth") {
      process.env.ANTHROPIC_API_KEY = await freshToken(stored)
    } else if (mode === "apiKey" && !envKey && stored?.type === "api") {
      process.env.ANTHROPIC_API_KEY = stored.key
    }
  }
}

// anthropic-beta features that are safe for all subscriptions.
// Omits "context-1m-2025-08-07" which requires a special subscription.
const SAFE_BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "prompt-caching-2024-07-31",
  "prompt-caching-scope-2026-01-05",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
].join(",")

async function setup() {
  return tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: [PROVIDER],
          provider: {
            [PROVIDER]: {
              options: {
                headers: { "anthropic-beta": SAFE_BETAS },
              },
            },
          },
          memory: {
            enabled: true,
            recallProvider: PROVIDER,
            recallModel: MODEL,
          },
        }),
      )
    },
  })
}

// ---------------------------------------------------------------------------
// 1. LLM.generate() — memory-extractor agent
//
// Replicates extractFromSession call path:
//   Agent.get("memory-extractor")
//   → buildAutoExtractPrompt(conversation, existing)
//   → LLM.generate({ schema: { items: ExtractedItem[] } })
// ---------------------------------------------------------------------------

describe("memory-extractor: LLM.generate() real request", () => {
  test.skipIf(!RUN)(
    "extracts memories via structured output",
    async () => {
      await using tmp = await setup()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const model = await Provider.getModel(PROVIDER, MODEL)
          const sessionID = "ses_extractor_real_1"

          const agent = await Agent.get("memory-extractor")
          expect(agent).toBeDefined()
          expect(agent!.name).toBe("memory-extractor")
          expect(agent!.temperature).toBe(0)

          const conversation = [
            { role: "user", content: "We use Hono for HTTP routing in this project" },
            { role: "assistant", content: "Got it, I'll use Hono for routing." },
            { role: "user", content: "Always use snake_case for database column names" },
            { role: "assistant", content: "Understood, snake_case for DB columns." },
          ]
          const prompt = MemoryExtractor.buildAutoExtractPrompt(conversation, [])
          const msgs: ModelMessage[] = [{ role: "user", content: prompt }]
          const schema = z.object({ items: z.array(MemoryExtractor.ExtractedItem) })

          const result = await LLM.generate({
            sessionID,
            model,
            agent: { ...agent!, prompt: agent!.prompt },
            system: [],
            messages: msgs,
            schema,
          })

          expect(result.object).toBeDefined()
          expect(result.object.items).toBeInstanceOf(Array)
          expect(result.object.items.length).toBeGreaterThan(0)

          for (const item of result.object.items) {
            expect(["create", "update"]).toContain(item.action)
            expect(item.content.length).toBeGreaterThan(0)
            expect(Memory.Category.options).toContain(item.category)
            expect(item.tags).toBeInstanceOf(Array)
          }

          expect(result.usage.inputTokens).toBeGreaterThan(0)
          expect(result.usage.outputTokens).toBeGreaterThan(0)
          expect(result.response.modelId).toBeTruthy()

          console.log("✅ memory-extractor items:", JSON.stringify(result.object.items, null, 2))
          console.log("   tokens: in=%d out=%d", result.usage.inputTokens, result.usage.outputTokens)
        },
      })
    },
    TIMEOUT,
  )
})

// ---------------------------------------------------------------------------
// 2. LLM.generate() — memory-recall agent
//
// Replicates MemoryRecall.invoke call path:
//   Agent.get("memory-recall")
//   → build candidates + context prompt
//   → LLM.generate({ schema: Result })
// ---------------------------------------------------------------------------

describe("memory-recall: LLM.generate() real request", () => {
  test.skipIf(!RUN)(
    "filters candidate memories by relevance",
    async () => {
      await using tmp = await setup()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const model = await Provider.getModel(PROVIDER, MODEL)
          const sessionID = "ses_recall_real_1"

          const agent = await Agent.get("memory-recall")
          expect(agent).toBeDefined()
          expect(agent!.temperature).toBe(0)

          const now = Date.now()
          const memories: Memory.Info[] = [
            {
              id: "mem_hono",
              content: "Project uses Hono for HTTP routing",
              category: "tool",
              scope: "personal",
              status: "confirmed",
              tags: ["framework", "hono"],
              source: { sessionID: "ses_old", method: "manual" },
              citations: [],
              score: 5.0,
              baseScore: 5.0,
              useCount: 3,
              hitCount: 1,
              inject: false,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "mem_vitest",
              content: "Use vitest for unit testing",
              category: "tool",
              scope: "personal",
              status: "confirmed",
              tags: ["testing"],
              source: { sessionID: "ses_old", method: "manual" },
              citations: [],
              score: 3.0,
              baseScore: 3.0,
              useCount: 1,
              hitCount: 0,
              inject: false,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "mem_python",
              content: "Use black for Python formatting",
              category: "style",
              scope: "personal",
              status: "confirmed",
              tags: ["python", "formatting"],
              source: { sessionID: "ses_old", method: "manual" },
              citations: [],
              score: 2.0,
              baseScore: 2.0,
              useCount: 0,
              hitCount: 0,
              inject: false,
              createdAt: now,
              updatedAt: now,
            },
          ]

          const candidates = memories.map((m) => ({
            id: m.id,
            content: m.content,
            category: m.category,
            tags: m.tags,
          }))

          const context = "[user]: Help me write an HTTP handler using our routing framework"
          const prompt = [
            "## Candidate Memories",
            "",
            JSON.stringify(candidates, null, 2),
            "",
            "## Recent Conversation",
            "",
            context,
          ].join("\n")

          const msgs: ModelMessage[] = [{ role: "user", content: prompt }]

          const result = await LLM.generate({
            sessionID,
            model,
            agent: { ...agent!, prompt: agent!.prompt },
            system: [],
            messages: msgs,
            schema: MemoryRecall.Result,
          })

          expect(result.object.relevant).toBeInstanceOf(Array)
          expect(result.object.conflicts).toBeInstanceOf(Array)
          expect(result.object.relevant).toContain("mem_hono")
          expect(result.object.relevant).not.toContain("mem_python")

          const ids = new Set(memories.map((m) => m.id))
          for (const id of result.object.relevant) {
            expect(ids.has(id)).toBe(true)
          }

          expect(result.usage.inputTokens).toBeGreaterThan(0)

          console.log("✅ memory-recall:", JSON.stringify(result.object, null, 2))
          console.log("   tokens: in=%d out=%d", result.usage.inputTokens, result.usage.outputTokens)
        },
      })
    },
    TIMEOUT,
  )
})

// ---------------------------------------------------------------------------
// 3. LLM.stream() — omo-explore agent
//
// Replicates subagent invocation: LLM.stream() with agent prompt + empty tools
// ---------------------------------------------------------------------------

describe("omo-explore: LLM.stream() real request", () => {
  test.skipIf(!RUN)(
    "streams response with omo-explore system prompt",
    async () => {
      await using tmp = await setup()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const model = await Provider.getModel(PROVIDER, MODEL)
          const sessionID = "ses_omo_explore_real_1"

          const agent = await Agent.get("omo-explore")
          expect(agent).toBeDefined()
          expect(agent!.mode).toBe("subagent")
          expect(agent!.prompt).toContain("omo-explore")

          const user: MessageV2.User = {
            id: "user-omo-1",
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent!.name,
            model: { providerID: PROVIDER, modelID: model.id },
          }

          const stream = await LLM.stream({
            user,
            sessionID,
            model,
            agent: agent!,
            system: [],
            abort: new AbortController().signal,
            messages: [
              {
                role: "user",
                content:
                  'Briefly list what tools you would use to find TypeScript files importing "@/memory". 2-3 sentences max.',
              },
            ],
            tools: {},
          })

          let text = ""
          for await (const chunk of stream.textStream) {
            text += chunk
          }

          expect(text.length).toBeGreaterThan(0)

          const lower = text.toLowerCase()
          expect(
            lower.includes("grep") || lower.includes("glob") || lower.includes("search") || lower.includes("find"),
          ).toBe(true)

          const usage = await stream.usage
          expect(usage.inputTokens).toBeGreaterThan(0)
          expect(usage.outputTokens).toBeGreaterThan(0)

          console.log("✅ omo-explore (%d chars):", text.length)
          console.log("   ", text.slice(0, 300))
          console.log("   tokens: in=%d out=%d", usage.inputTokens, usage.outputTokens)
        },
      })
    },
    TIMEOUT,
  )
})

// ---------------------------------------------------------------------------
// 4. MemoryExtractor.extractFromSession — full E2E
// ---------------------------------------------------------------------------

describe("MemoryExtractor.extractFromSession: full E2E", () => {
  test.skipIf(!RUN)(
    "extracts and stores memories from conversation",
    async () => {
      await using tmp = await setup()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await MemoryStorage.clear()

          const sessionID = "ses_e2e_extract_1"
          const messages = [
            { role: "user", content: "In this project we always use Bun APIs instead of Node.js equivalents" },
            { role: "assistant", content: "Understood, I will prefer Bun.file() over fs.readFile()." },
            { role: "user", content: "Our naming convention is single-word variable names wherever possible" },
            { role: "assistant", content: "Got it — short names like cfg, err, opts." },
          ]

          const result = await MemoryExtractor.extractFromSession(sessionID, messages)

          expect(result.length).toBeGreaterThan(0)

          for (const mem of result) {
            expect(mem.id).toMatch(/^mem_/)
            expect(mem.content.length).toBeGreaterThan(0)
            expect(Memory.Category.options).toContain(mem.category)
            expect(mem.source.sessionID).toBe(sessionID)
            expect(mem.source.method).toBe("auto")
          }

          const stored = await Memory.list()
          expect(stored.length).toBeGreaterThanOrEqual(result.length)

          console.log("✅ extractFromSession: %d memories", result.length)
          for (const mem of result) {
            console.log("   [%s] %s", mem.category, mem.content.slice(0, 80))
          }
        },
      })
    },
    TIMEOUT,
  )
})

// ---------------------------------------------------------------------------
// 5. MemoryRecall.invoke — full E2E
// ---------------------------------------------------------------------------

describe("MemoryRecall.invoke: full E2E", () => {
  test.skipIf(!RUN)(
    "filters memories via real LLM call",
    async () => {
      await using tmp = await setup()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const now = Date.now()
          const memories: Memory.Info[] = [
            {
              id: "mem_bun",
              content: "Always use Bun APIs instead of Node.js equivalents",
              category: "tool",
              scope: "personal",
              status: "confirmed",
              tags: ["bun"],
              source: { sessionID: "ses_old", method: "manual" },
              citations: [],
              score: 5.0,
              baseScore: 5.0,
              useCount: 3,
              hitCount: 1,
              inject: false,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "mem_django",
              content: "Django project uses class-based views with DRF serializers",
              category: "pattern",
              scope: "personal",
              status: "confirmed",
              tags: ["django", "python"],
              source: { sessionID: "ses_old", method: "manual" },
              citations: [],
              score: 2.0,
              baseScore: 2.0,
              useCount: 0,
              hitCount: 0,
              inject: false,
              createdAt: now,
              updatedAt: now,
            },
          ]

          const result = await MemoryRecall.invoke({
            sessionID: "ses_e2e_recall_1",
            memories,
            recentMessages: [{ role: "user", content: "I need to read a JSON config file using Bun" }],
          })

          expect(result.relevant).toContain("mem_bun")
          expect(result.relevant).not.toContain("mem_django")

          console.log("✅ MemoryRecall.invoke:", JSON.stringify(result, null, 2))
        },
      })
    },
    TIMEOUT,
  )
})

// ---------------------------------------------------------------------------
// 6. OAuth mcp_ prefix vs generateObject "json" tool
//
// Bug: log_d240b3aaf001KKApPeZFTYT4XW (all 54 memory-extractor calls fail)
//
// Root cause: The Anthropic OAuth fetch wrapper (src/plugin/anthropic.ts)
// adds mcp_ prefix to ALL tool names. Vercel AI SDK's generateObject()
// internally creates a tool named "json" for structured output. The wrapper
// renames it to "mcp_json", but tool_choice still references "json", so
// the API returns "Tool 'json' not found in provided tools".
//
// This only affects OAuth/Max auth (custom fetch wrapper active).
// API key auth has no wrapper and works fine.
// ---------------------------------------------------------------------------

describe("OAuth mcp_ prefix: generateObject json tool", () => {
  // Verify the bug mechanism: the old wrapper code renames "json" → "mcp_json"
  test("bug: old wrapper renames json → mcp_json", () => {
    const PREFIX = "mcp_"
    const tools = [{ name: "json", input_schema: { type: "object" } }]

    // Old code (before fix)
    const renamed = tools.map((t: any) => ({
      ...t,
      name: t.name ? `${PREFIX}${t.name}` : t.name,
    }))

    expect(renamed[0].name).toBe("mcp_json")
    console.log("✅ Confirmed bug: 'json' → '%s' breaks generateObject", renamed[0].name)
  })

  // Verify the fix: SDK-internal tools like "json" are skipped
  test("fix: json tool skipped, MCP tools still prefixed", () => {
    const PREFIX = "mcp_"
    const SDK_TOOLS = new Set(["json"])
    const tools = [
      { name: "json", input_schema: { type: "object" } },
      { name: "read_file", input_schema: { type: "object" } },
      { name: "bash", input_schema: { type: "object" } },
    ]

    // Fixed code
    const renamed = tools.map((t: any) => ({
      ...t,
      name: t.name && !SDK_TOOLS.has(t.name) ? `${PREFIX}${t.name}` : t.name,
    }))

    expect(renamed[0].name).toBe("json")
    expect(renamed[1].name).toBe("mcp_read_file")
    expect(renamed[2].name).toBe("mcp_bash")
    console.log("✅ Fix verified: 'json' preserved, MCP tools prefixed")
  })

  // Real API call with the conversation from the failing log
  test.skipIf(!RUN)(
    "LLM.generate() with log conversation",
    async () => {
      await using tmp = await setup()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const model = await Provider.getModel(PROVIDER, MODEL)
          const agent = await Agent.get("memory-extractor")
          expect(agent).toBeDefined()

          const now = Date.now()
          const existing: Memory.Info[] = [
            {
              id: "mem_log_1",
              content: "All LLM calls must be captured by log-viewer.",
              category: "workflow",
              scope: "personal",
              status: "confirmed",
              tags: ["log-viewer"],
              source: { sessionID: "ses_old", method: "manual" },
              citations: [],
              score: 5.0,
              baseScore: 5.0,
              useCount: 3,
              hitCount: 1,
              inject: false,
              createdAt: now,
              updatedAt: now,
            },
          ]

          const conversation = [
            { role: "user", content: "Anthropic auth 相关代码的原理是什么？provider.models从哪里取得" },
            { role: "assistant", content: "Let me explore the codebase to understand Anthropic auth." },
            { role: "assistant", content: "provider.models comes from models.dev data." },
          ]

          const prompt = MemoryExtractor.buildAutoExtractPrompt(conversation, existing)
          const msgs: ModelMessage[] = [{ role: "user", content: prompt }]
          const schema = z.object({ items: z.array(MemoryExtractor.ExtractedItem) })

          const result = await LLM.generate({
            sessionID: "ses_json_tool_repro",
            model,
            agent: { ...agent!, prompt: agent!.prompt },
            system: [],
            messages: msgs,
            schema,
          })

          expect(result.object).toBeDefined()
          expect(result.object.items).toBeInstanceOf(Array)
          expect(result.usage.inputTokens).toBeGreaterThan(0)

          console.log("✅ json-tool repro — structured result:")
          console.log(
            JSON.stringify(
              {
                object: result.object,
                usage: {
                  inputTokens: result.usage.inputTokens,
                  outputTokens: result.usage.outputTokens,
                  totalTokens: result.usage.totalTokens,
                },
                response: {
                  modelId: result.response.modelId,
                  id: result.response.id,
                  timestamp: result.response.timestamp,
                  headers: result.response.headers,
                },
                finishReason: result.finishReason,
                request: result.request,
                warnings: result.warnings,
                providerMetadata: result.providerMetadata,
              },
              null,
              2,
            ),
          )
        },
      })
    },
    TIMEOUT,
  )
})
