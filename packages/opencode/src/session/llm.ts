import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import {
  streamText,
  generateObject,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  tool,
  jsonSchema,
} from "ai"
import type { ZodType } from "zod"
import { mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { HookChain } from "@/session/hooks"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { PermissionNext } from "@/permission/next"
import { Auth } from "@/auth"
import { SecurityConfig } from "@/security/config"
import { LLMScanner } from "@/security/llm-scanner"
import { SecurityRedact } from "@/security/redact"
import { SecurityAudit } from "@/security/audit"
import { LlmLogCapture } from "@/log/capture"

export namespace LLM {
  const log = Log.create({ service: "llm" })
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: "auto" | "required" | "none"
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  export async function stream(input: StreamInput) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    const isCodex = provider.id === "openai" && auth?.type === "oauth"

    const system = []
    system.push(
      [
        // use agent prompt otherwise provider prompt
        // For Codex sessions, skip SystemPrompt.provider() since it's sent via options.instructions
        ...(input.agent.prompt ? [input.agent.prompt] : isCodex ? [] : SystemPrompt.provider(input.model)),
        // any custom prompt passed into this call
        ...input.system,
        // any custom prompt from last user message
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    // Build variant and providerOptions BEFORE executePreLLM so hooks can modify them
    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    let options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    if (isCodex) {
      options.instructions = SystemPrompt.instructions()
    }

    l.info("[TRACE-REPLACE] llm.ts BEFORE pre-llm hooks", { system: system.map((s) => s.substring(0, 200)) })
    const header = system[0]
    const preLLMCtx: HookChain.PreLLMContext = {
      sessionID: input.sessionID,
      system,
      agent: input.agent.name,
      model: input.model.id,
      variant: input.user.variant,
      messages: input.messages,
      providerOptions: options,
    }
    await HookChain.executePreLLM(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
      preLLMCtx,
    )
    // Read back any modifications from hooks
    if (preLLMCtx.providerOptions) {
      options = preLLMCtx.providerOptions as Record<string, any>
    }
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    l.info("[TRACE-REPLACE] llm.ts AFTER pre-llm hooks", { system: system.map((s) => s.substring(0, 200)) })
    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    const maxOutputTokens =
      isCodex || provider.id.includes("github-copilot") ? undefined : ProviderTransform.maxOutputTokens(input.model)

    const tools = await resolveTools(input)

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    const final = {
      ...(input.model.providerID.startsWith("opencode")
        ? {
            "x-opencode-project": Instance.project.id,
            "x-opencode-session": input.sessionID,
            "x-opencode-request": input.user.id,
            "x-opencode-client": Flag.OPENCODE_CLIENT,
          }
        : input.model.providerID !== "anthropic"
          ? {
              "User-Agent": `opencode/${Installation.VERSION}`,
            }
          : undefined),
      ...input.model.headers,
      ...headers,
    }

    // Merge SDK-level provider headers for log-viewer capture
    // Provider options.headers are set during SDK init (e.g. anthropic-beta)
    // and aren't included in the per-request `final` object
    const captured = {
      ...(provider.options?.["headers"] as Record<string, string> | undefined),
      ...final,
    }
    LlmLogCapture.captureHeaders(input.sessionID, captured)

    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
      toolChoice: input.toolChoice,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: final,
      maxRetries: input.retries ?? 0,
      messages: [
        ...system.map(
          (x): ModelMessage => ({
            role: "system",
            content: x,
          }),
        ),
        ...input.messages,
      ],
      model: wrapLanguageModel({
        model: language,
        middleware: [
          securityScanMiddleware(),
          {
            async transformParams(args) {
              if (args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
              }
              return args.params
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  // --- Structured generation with full pipeline ---

  export type GenerateInput<T> = {
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    messages: ModelMessage[]
    schema: ZodType<T>
  }

  /**
   * Structured object generation that goes through the same pipeline as stream():
   * system prompt construction, pre-llm hooks, security middleware, provider transforms,
   * headers, and plugin hooks — then calls generateObject instead of streamText.
   */
  export async function generate<T>(input: GenerateInput<T>) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("agent", input.agent.name)
    l.info("generate", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })

    const [language, cfg, provider] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
    ])

    // Build system prompt: agent prompt → provider prompt → caller system
    const system: string[] = []
    system.push(
      [...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)), ...input.system]
        .filter((x) => x)
        .join("\n"),
    )

    // Provider options
    const base = ProviderTransform.options({
      model: input.model,
      sessionID: input.sessionID,
      providerOptions: provider.options,
    })
    let options: Record<string, any> = pipe(base, mergeDeep(input.model.options), mergeDeep(input.agent.options))

    // Execute pre-llm hook chain (includes log capture, memory-injector, think-mode, etc.)
    const header = system[0]
    const ctx: HookChain.PreLLMContext = {
      sessionID: input.sessionID,
      system,
      agent: input.agent.name,
      model: input.model.id,
      messages: input.messages,
      providerOptions: options,
      metadata: {},
    }
    await HookChain.executePreLLM(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
      ctx,
    )
    if (ctx.providerOptions) {
      options = ctx.providerOptions as Record<string, any>
    }
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    // Plugin params & headers
    const params = await Plugin.trigger(
      "chat.params",
      { sessionID: input.sessionID, agent: input.agent, model: input.model, provider },
      {
        temperature: input.agent.temperature ?? ProviderTransform.temperature(input.model),
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )
    const { headers } = await Plugin.trigger(
      "chat.headers",
      { sessionID: input.sessionID, agent: input.agent, model: input.model, provider },
      { headers: {} },
    )

    const msgs: ModelMessage[] = [
      ...system.map((x): ModelMessage => ({ role: "system", content: x })),
      ...input.messages,
    ]

    const po = ProviderTransform.providerOptions(input.model, params.options)
    l.info("generate: before generateObject", {
      providerID: input.model.providerID,
      modelID: input.model.id,
      systemCount: system.length,
      msgCount: msgs.length,
      providerOptions: JSON.stringify(po),
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
    })

    return generateObject({
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: po,
      headers: {
        ...(input.model.providerID.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : input.model.providerID !== "anthropic"
            ? { "User-Agent": `opencode/${Installation.VERSION}` }
            : undefined),
        ...input.model.headers,
        ...headers,
      },
      messages: msgs,
      model: wrapLanguageModel({
        model: language,
        middleware: [securityScanMiddleware()],
      }),
      schema: input.schema as any,
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user">) {
    const disabled = PermissionNext.disabled(Object.keys(input.tools), input.agent.permission)
    for (const tool of Object.keys(input.tools)) {
      if (input.user.tools?.[tool] === false || disabled.has(tool)) {
        delete input.tools[tool]
      }
    }
    return input.tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }

  const securityLog = Log.create({ service: "security-llm" })

  function extractTextFromPrompt(prompt: unknown[]): Array<{ text: string; messageIndex: number; partIndex: number }> {
    const results: Array<{ text: string; messageIndex: number; partIndex: number }> = []
    for (let i = 0; i < prompt.length; i++) {
      const msg = prompt[i] as Record<string, unknown>
      if (!msg || !msg.role) continue

      // System messages have string content
      if (msg.role === "system" && typeof msg.content === "string") {
        results.push({ text: msg.content, messageIndex: i, partIndex: -1 })
        continue
      }

      // User, assistant, and tool messages have array content
      if (!Array.isArray(msg.content)) continue
      for (let j = 0; j < msg.content.length; j++) {
        const part = msg.content[j] as Record<string, unknown>
        if (!part) continue

        if (part.type === "text" && typeof part.text === "string") {
          results.push({ text: part.text, messageIndex: i, partIndex: j })
          continue
        }
        if (part.type === "reasoning" && typeof part.text === "string") {
          results.push({ text: part.text, messageIndex: i, partIndex: j })
          continue
        }
        // Tool results can contain text or JSON
        if (part.type === "tool-result" && part.output) {
          const output = part.output as Record<string, unknown>
          if (output.type === "text" && typeof output.value === "string") {
            results.push({ text: output.value, messageIndex: i, partIndex: j })
            continue
          }
          if (output.type === "json" && output.value !== undefined) {
            results.push({ text: JSON.stringify(output.value), messageIndex: i, partIndex: j })
            continue
          }
          if (output.type === "content" && Array.isArray(output.value)) {
            for (const item of output.value) {
              const v = item as Record<string, unknown>
              if (v.type === "text" && typeof v.text === "string") {
                results.push({ text: v.text, messageIndex: i, partIndex: j })
              }
            }
          }
        }
      }
    }
    return results
  }

  function redactTextInPrompt(
    prompt: unknown[],
    messageIndex: number,
    partIndex: number,
    matches: LLMScanner.ProtectedMatch[],
  ): void {
    const msg = prompt[messageIndex] as Record<string, unknown>
    if (!msg) return

    // System message: content is a string
    if (partIndex === -1 && typeof msg.content === "string") {
      const segments = matches.map((m) => ({ start: m.start, end: m.end }))
      msg.content = SecurityRedact.redactContent(msg.content, segments)
      return
    }

    if (!Array.isArray(msg.content)) return
    const part = msg.content[partIndex] as Record<string, unknown>
    if (!part) return

    if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
      const segments = matches.map((m) => ({ start: m.start, end: m.end }))
      part.text = SecurityRedact.redactContent(part.text, segments)
      return
    }

    if (part.type === "tool-result" && part.output) {
      const output = part.output as Record<string, unknown>
      if (output.type === "text" && typeof output.value === "string") {
        const segments = matches.map((m) => ({ start: m.start, end: m.end }))
        output.value = SecurityRedact.redactContent(output.value, segments)
        return
      }
      if (output.type === "json" && output.value !== undefined) {
        const original = JSON.stringify(output.value)
        const segments = matches.map((m) => ({ start: m.start, end: m.end }))
        const redacted = SecurityRedact.redactContent(original, segments)
        output.value = redacted
        output.type = "text"
        return
      }
    }
  }

  function securityScanMiddleware() {
    return {
      // @ts-expect-error - prompt is typed as LanguageModelV2Prompt but we need to inspect it generically
      async transformParams(args) {
        log.info("securityScanMiddleware.transformParams", {
          type: args.type,
          paramsKeys: Object.keys(args.params),
          hasTools: !!args.params.tools,
          toolNames: args.params.tools ? Object.keys(args.params.tools) : [],
          hasMode: !!args.params.mode,
          mode: args.params.mode,
          promptLength: Array.isArray(args.params.prompt) ? args.params.prompt.length : "not-array",
        })

        const config = SecurityConfig.getSecurityConfig()
        const hasRules =
          (config.rules ?? []).some((r) => r.deniedOperations.includes("llm")) ||
          (config.segments?.markers ?? []).some((m) => m.deniedOperations.includes("llm"))

        if (!hasRules) {
          log.info("securityScanMiddleware: no rules, passthrough", { type: args.type })
          return args.params
        }

        const prompt = args.params.prompt as unknown[]
        if (!Array.isArray(prompt)) {
          return args.params
        }

        const textParts = extractTextFromPrompt(prompt)
        const blockViolations: Array<{ text: string; match: LLMScanner.ProtectedMatch }> = []
        const redactTargets: Array<{
          messageIndex: number
          partIndex: number
          matches: LLMScanner.ProtectedMatch[]
        }> = []

        for (const part of textParts) {
          const matches = LLMScanner.scanForProtectedContent(part.text, config)
          if (matches.length === 0) continue

          // Determine action based on rule's llmAction field (defaults to "redact" when unset)
          const blockMatches = matches.filter((m) => m.rule.llmAction === "block")
          const redactMatches = matches.filter((m) => m.rule.llmAction !== "block")

          for (const match of blockMatches) {
            blockViolations.push({ text: part.text.slice(match.start, match.end).slice(0, 50), match })
          }

          // If no block violations from this part, collect redact targets
          if (redactMatches.length > 0) {
            redactTargets.push({ messageIndex: part.messageIndex, partIndex: part.partIndex, matches: redactMatches })
          }
        }

        // Log all interceptions
        for (const violation of blockViolations) {
          SecurityAudit.logSecurityEvent({
            role: "unknown",
            operation: "llm",
            path: "outgoing-request",
            allowed: false,
            reason: `Protected content detected in LLM request (${violation.match.ruleType} rule)`,
            rulePattern:
              "rulePattern" in violation.match.rule
                ? (violation.match.rule as { rulePattern: string }).rulePattern
                : undefined,
            content: violation.text,
          })
        }

        for (const target of redactTargets) {
          for (const match of target.matches) {
            SecurityAudit.logSecurityEvent({
              role: "unknown",
              operation: "llm",
              path: "outgoing-request",
              allowed: true,
              reason: `Protected content redacted from LLM request (${match.ruleType} rule)`,
              content: match.matchedText.slice(0, 50),
            })
          }
        }

        // If there are block violations, throw error
        if (blockViolations.length > 0) {
          const details = blockViolations.map((v) => `${v.match.ruleType}: "${v.text}..."`).join(", ")
          securityLog.info("blocked LLM request due to protected content", { count: blockViolations.length })
          throw new Error(
            `Security: LLM request blocked - protected content detected (${blockViolations.length} violation(s): ${details})`,
          )
        }

        // Apply redaction to remaining matches
        for (const target of redactTargets) {
          redactTextInPrompt(prompt, target.messageIndex, target.partIndex, target.matches)
          securityLog.debug("redacted protected content from LLM request", {
            messageIndex: target.messageIndex,
            matchCount: target.matches.length,
          })
        }

        log.info("securityScanMiddleware: returning params", {
          type: args.type,
          paramsKeys: Object.keys(args.params),
          hasTools: !!args.params.tools,
          toolNames: args.params.tools ? Object.keys(args.params.tools) : [],
        })
        return args.params
      },
    }
  }
}
