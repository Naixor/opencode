# PRD: Internalize Oh-My-OpenCode (OMO) into OpenCode

## Introduction

Oh-My-OpenCode (OMO) is a community plugin providing multi-agent orchestration, 46+ lifecycle hooks, 18+ tools (AST-Grep, LSP suite, delegate-task, etc.), background agent execution, and advanced context management. This PRD defines the plan to internalize OMO's full capabilities into OpenCode core, with three guiding principles:

1. **Feature alignment & quality** - All OMO functionality becomes first-class in OpenCode
2. **Security preservation** - OpenCode's role-based access control, segment protection, bash scanning, and audit logging remain intact and are extended to cover new tools
3. **Sustainable upstream tracking** - Automated diff tooling to track OMO releases and selectively adopt improvements

The internalization is split into 8 phases across 30 user stories, all implemented together as a single milestone. Each US includes comprehensive unit tests.

## OMO 源码参考

**获取方式：**
```bash
gh repo clone code-yeongyu/oh-my-opencode /tmp/oh-my-opencode
```

**源码目录结构（实现时必须参考）：**
```
/tmp/oh-my-opencode/src/
├── agents/          # 11 个 agent 定义（system prompt、model、tool restrictions）
├── hooks/           # 46+ hook 实现（每个 hook 独立目录）
├── tools/           # 18+ tool 实现（参数 schema、execute 逻辑、安全处理）
├── features/        # 核心子系统（background-agent、opencode-skill-loader、claude-tasks 等）
├── mcp/             # 内置 MCP 服务器配置（websearch、context7、grep_app）
├── config/          # Zod config schema 定义
├── shared/          # 通用工具函数
├── plugin/          # 插件接口层
├── plugin-handlers/ # 配置处理器
├── cli/             # CLI 系统（不在内置范围内）
└── index.ts         # 插件入口
```

> **重要原则：** 实现每个 US 时，**必须先阅读 OMO 对应的源码文件**，理解其实现细节、边界处理和错误恢复逻辑，再在 OpenCode 架构下重新实现。不要仅依赖 PRD 描述，PRD 是行为规格，OMO 源码是实现参考。具体对应关系：
>
> | US 主题 | OMO 源码参考路径 |
> |---------|-----------------|
> | Hook 基础设施 (US-001) | `src/plugin/hooks/`、`src/create-hooks.ts` |
> | 错误恢复 hooks (US-002) | `src/hooks/edit-error-recovery/`、`src/hooks/anthropic-context-window-limit-recovery/`、`src/hooks/delegate-task-retry/`、`src/hooks/ralph-loop/` |
> | 输出管理 hooks (US-003) | `src/hooks/tool-output-truncator/`、`src/hooks/grep-output-truncator/`、`src/hooks/context-window-monitor/`、`src/hooks/preemptive-compaction/` |
> | 上下文注入 hooks (US-004) | `src/hooks/directory-agents-injector/`、`src/hooks/directory-readme-injector/`、`src/hooks/rules-injector/`、`src/hooks/compaction-context-injector/`、`src/hooks/compaction-todo-preserver/` |
> | Agent 行为 hooks (US-005) | `src/hooks/keyword-detector/`、`src/hooks/comment-checker/`、`src/hooks/todo-continuation-enforcer/`、`src/hooks/subagent-question-blocker/`、`src/hooks/write-existing-file-guard/` |
> | Session 管理 hooks (US-006) | `src/hooks/session-recovery/`、`src/hooks/session-notification/`、`src/hooks/unstable-agent-babysitter/`、`src/hooks/think-mode/`、`src/hooks/anthropic-effort/` |
> | Sisyphus agent (US-007) | `src/agents/sisyphus.ts`、`src/agents/dynamic-agent-prompt-builder.ts` |
> | omo-explore agent (US-008) | `src/agents/explore.ts` |
> | Oracle agent (US-009) | `src/agents/oracle.ts` |
> | 可选 agents (US-010) | `src/agents/hephaestus.ts`、`src/agents/prometheus/`、`src/agents/atlas/`、`src/agents/librarian.ts`、`src/agents/metis.ts`、`src/agents/momus.ts`、`src/agents/multimodal-looker.ts`、`src/agents/sisyphus-junior/` |
> | Background manager (US-011) | `src/features/background-agent/` |
> | Category 系统 (US-012) | `src/config/schema/categories.ts`、`src/tools/delegate-task/constants.ts` |
> | Glob 增强 (US-013) | `src/tools/glob/` |
> | Grep 增强 (US-014) | `src/tools/grep/` |
> | LSP 拆分 (US-015) | `src/tools/lsp/` |
> | AST-Grep 工具 (US-016) | `src/tools/ast-grep/` |
> | delegate-task 工具 (US-017) | `src/tools/delegate-task/`、`src/tools/background-task/` |
> | look-at 工具 (US-018) | `src/tools/look-at/` |
> | skill-mcp 工具 (US-019) | `src/tools/skill-mcp/` |
> | interactive-bash 工具 (US-020) | `src/tools/interactive-bash/` |
> | Task 持久化 (US-021) | `src/features/claude-tasks/`、`src/tools/task/` |
> | Skill 增强 (US-022) | `src/tools/skill/`、`src/features/opencode-skill-loader/` |
> | MCP 服务器 (US-023) | `src/mcp/` |
> | Skills & Commands (US-024) | `src/features/builtin-skills/`、`src/features/builtin-commands/` |
> | Config schema (US-025) | `src/config/schema/` |

## Key Architectural Decisions

### AD-1: Sisyphus replaces `build` as default agent
Sisyphus becomes the default agent for new sessions. The existing `build` agent is retained as a fallback but is no longer the default. Users see Sisyphus on first use.

### AD-2: `@ast-grep/napi` as peer dependency
Users install `@ast-grep/napi` themselves. The AST-Grep tools detect availability at runtime and return a clear error message with install instructions if missing. No graceful degradation - the tools simply report "not available".

### AD-3: SecurityConfig shared by reference, immutable at runtime
Sub-agents share the parent session's `SecurityConfig` by reference. `SecurityConfig` is frozen (`Object.freeze`) after loading during bootstrap. No runtime modification is allowed. This avoids both clone overhead and race conditions.

### AD-4: Phase ordering - Hooks first, tools last
Hooks (Phase 1) are implemented first because output truncation, error recovery, and context injection affect all subsequent tool and agent work. Tools are implemented last since they are independent and can be adapted to the hook pipeline.

### AD-6: Prometheus replaces `plan` agent when enabled
When Prometheus is enabled via config (`"agents": { "prometheus": { "enabled": true } }`), it replaces the existing `plan` agent for plan mode. When Prometheus is disabled (default), the existing `plan` agent continues to serve plan mode. Sisyphus handles runtime task planning independently of plan mode.

### AD-7: Separate `omo-explore` agent, original `explore` untouched
The original `explore` agent remains unchanged for backward compatibility. A new `omo-explore` agent is created as a Sisyphus sub-agent variant with enhanced LSP/AST-grep tool strategy and parallel execution emphasis. Sisyphus delegates to `omo-explore`; the original `explore` remains available for direct use.

### AD-8: Plugin.trigger() preserved, plugins execute first
Existing `Plugin.trigger()` calls in `llm.ts`/`prompt.ts` are preserved for external plugin compatibility. Execution order: **external plugins first → internal middleware chain second**. This allows plugins to override or preempt built-in hook behavior, maintaining the plugin ecosystem's extensibility.

### AD-9: Background task lifecycle configurable
When the main session ends, background tasks default to **cancelled**. Users can set `"background_task": { "persist_on_exit": true }` to allow tasks to continue running and write results to `.opencode/tasks/`. This prevents orphaned processes by default while supporting long-running autonomous workflows.

### AD-10: Category system visible to all agents, usable only with delegate_task permission
All agents can see the category list (for context awareness), but only agents with `delegate_task` tool permission can actually use categories to route tasks. In practice this means Sisyphus and Hephaestus can route via categories; read-only agents (Oracle, Librarian, etc.) can reference categories in their output but cannot invoke them.

### AD-11: Built-in MCP servers default disabled, auto-enable on API key configuration
Built-in MCP servers (Exa websearch, Context7, grep.app) are disabled by default. When the user provides an API key (via environment variable or `opencode.jsonc`), the corresponding MCP server auto-enables. No bundled API keys. Clear documentation on which env vars to set (e.g., `EXA_API_KEY`, `CONTEXT7_API_KEY`).

### AD-12: OMO diff tool supports manual script + CI template
The diff tool is available as both `bun run script/omo-diff.ts` for manual use and a GitHub Actions workflow template (`.github/workflows/omo-diff.yml`) for scheduled CI runs (e.g., weekly). It does NOT run on `bun install` to avoid slowing down dependency installation.

### AD-5: Hook implementation architecture

**Decision:** Hooks are implemented as a **middleware chain in the session processing pipeline**, not as a separate event system.

**Reasoning (security + performance):**

1. **Security**: Inline middleware guarantees execution order. Security-critical hooks (output redaction, LLM scanning, access control) MUST run before the result reaches the LLM. A pub/sub event system cannot guarantee ordering, creating a window where unredacted content could leak. Middleware chains enforce: `security hooks → transform hooks → output hooks` in deterministic order.

2. **Performance**: The session pipeline already has 6 plugin hook points (`chat.system.transform`, `chat.params`, `chat.headers`, `chat.messages.transform`, `tool.execute.before`, `tool.execute.after`). Adding 46+ hooks as individual Bus subscribers would create O(n) dispatch overhead per event. Instead, hooks are grouped into typed middleware chains:
   - **Pre-LLM chain** (runs once per LLM call, ~1ms): context injection, system prompt modification, parameter adjustment
   - **Pre-tool chain** (runs per tool call, ~2ms): argument validation, permission checks, rate limiting
   - **Post-tool chain** (runs per tool result, ~5ms): output truncation, security redaction, error detection
   - **Session lifecycle chain** (runs on session events, async): recovery, notification, compaction

3. **Insertion points** (from architecture analysis):
   - Pre-LLM: `llm.ts:71-101` (system prompt build) and `llm.ts:122-153` (params/headers)
   - Pre-tool: `prompt.ts:716` (built-in) and `prompt.ts:774` (MCP) - existing `tool.execute.before`
   - Post-tool: `prompt.ts:728/851` (existing `tool.execute.after`) → `prompt.ts:862-895` (format + truncate)
   - Error recovery: `processor.ts:339-364` (retry logic) - new hook point after `SessionRetry.retryable()`
   - Session lifecycle: `session/index.ts:229` (created), `compaction.ts:136` (compacting), `session/index.ts:368` (deleted) - via Bus.subscribe

4. **Fast-path optimization**: Each hook has an `enabled` boolean checked before any processing. Disabled hooks cost exactly one boolean check (~0ns). The middleware chain is compiled once at session start, not re-evaluated per call.

## Goals

- Replace `build` agent with Sisyphus as default; create `omo-explore` as new sub-agent; internalize Oracle as built-in sub-agent
- Make remaining OMO agents (including Prometheus as plan-mode replacement) opt-in via `opencode.jsonc`
- Internalize all 46+ OMO hooks as core middleware in session/processor/LLM layers
- Add OMO-unique tools (ast-grep, delegate-task, look-at, skill-mcp, interactive-bash) to ToolRegistry
- Enhance existing tools (glob, grep, LSP, skill, task) with OMO features while preserving security model
- Build automated diff reporting tool for OMO upstream tracking
- Maintain zero regression in security access control
- Comprehensive unit tests for every user story

## User Stories

---

### Phase 1: Hook System Internalization (implement first - affects all subsequent phases)

### US-001: Create hook middleware infrastructure
**Description:** As a developer, I want a typed middleware chain system for hooks so that all subsequent hook implementations have a consistent, performant, and security-ordered execution framework.

**Acceptance Criteria:**
- [ ] Create `packages/opencode/src/session/hooks/` directory with middleware chain infrastructure
- [ ] Define 4 chain types: `PreLLMChain`, `PreToolChain`, `PostToolChain`, `SessionLifecycleChain`
- [ ] Each chain enforces execution order: security hooks first, then transform hooks, then output hooks
- [ ] Each hook has an `enabled` property read from config; disabled hooks cost one boolean check
- [ ] Chain is compiled once at session start (no per-call re-evaluation)
- [ ] Hook registration API: `HookChain.register(name, priority, handler)` with numeric priority for ordering
- [ ] **Plugin.trigger() compatibility**: Existing `Plugin.trigger()` calls preserved. Execution order at each hook point: **external plugins first (Plugin.trigger) → internal middleware chain second**. This allows plugins to override or preempt built-in hook behavior.
- [ ] Config schema: `"hooks": { "hook-name": { "enabled": boolean } }` in opencode.jsonc
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test chain execution order respects priority (lower number = earlier execution)
- [ ] Test disabled hook is skipped with zero overhead (mock + timing)
- [ ] Test chain compilation caches correctly (register, compile, verify no recompile on subsequent calls)
- [ ] Test error in one hook does not crash chain (error isolation with logging)
- [ ] Test PreLLMChain receives correct system prompt context
- [ ] Test PreToolChain receives tool name + args
- [ ] Test PostToolChain receives tool result + can modify it
- [ ] Test SessionLifecycleChain receives session events
- [ ] Test config-driven enable/disable toggles hook at runtime reload
- [ ] Test Plugin.trigger() executes BEFORE internal middleware chain at same hook point
- [ ] Test plugin can modify data that internal middleware chain then receives (plugin-first ordering)
- [ ] Test internal middleware chain still runs when no plugins registered

### US-002: Internalize error recovery hooks
**Description:** As a developer, I want automatic error recovery for edit failures, context window overflow, and delegate-task retries built into the session processing pipeline.

**Acceptance Criteria:**
- [ ] **edit-error-recovery** (PostToolChain, priority 100): When edit tool returns "oldString not found" / "found multiple times" / "oldString and newString must be different", inject recovery reminder into next assistant message (read file, verify state, retry with corrected content)
- [ ] **anthropic-context-window-limit-recovery** (SessionLifecycleChain, priority 10): On "context_window_exceeded" error at `processor.ts:339`, trigger session compaction and context pruning automatically before retry
- [ ] **delegate-task-retry** (PostToolChain, priority 200): On delegate_task failure, retry once with exponential backoff (1s, then 2s)
- [ ] **iterative-error-recovery** (PostToolChain, priority 300): Detect repeated identical error patterns (3+ occurrences), inject corrective guidance suggesting alternative approach
- [ ] Insert new hook point at `processor.ts:345` (after `SessionRetry.retryable()`) for error recovery chain
- [ ] Each hook individually toggleable via `"hooks": { "edit-error-recovery": { "enabled": true } }`
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test edit-error-recovery: mock edit tool returning "oldString not found" → verify recovery message injected
- [ ] Test edit-error-recovery: mock edit tool returning "found multiple times" → verify recovery message injected
- [ ] Test edit-error-recovery: mock edit tool returning success → verify no injection
- [ ] Test context-window-limit-recovery: mock "context_window_exceeded" error → verify compaction triggered
- [ ] Test context-window-limit-recovery: mock non-context error → verify no compaction
- [ ] Test delegate-task-retry: mock delegate_task failure → verify retry with backoff delay
- [ ] Test delegate-task-retry: mock delegate_task success → verify no retry
- [ ] Test iterative-error-recovery: send same error 3 times → verify corrective guidance injected
- [ ] Test iterative-error-recovery: send same error 2 times → verify no guidance yet
- [ ] Test disabled hook: disable edit-error-recovery in config → verify no injection on edit failure

### US-003: Internalize output management hooks
**Description:** As a developer, I want automatic tool output truncation, grep result limiting, and context window monitoring built into the core.

**Acceptance Criteria:**
- [ ] **tool-output-truncator** (PostToolChain, priority 50): Truncate ALL tool outputs based on remaining context budget, with configurable max size per tool. Integrates at `prompt.ts:895` (existing Truncate.output location). Must preserve `[REDACTED: Security Protected]` markers during truncation.
- [ ] **grep-output-truncator** (PostToolChain, priority 60): Grep-specific truncation with match count reporting ("showing 50 of 342 matches")
- [ ] **question-label-truncator** (PostToolChain, priority 70): Truncate UI question labels to 200 chars max
- [ ] **context-window-monitor** (PreLLMChain, priority 900): Calculate current token usage, warn when >80% of context consumed, inject warning into system prompt. Configurable threshold.
- [ ] **preemptive-compaction** (PreLLMChain, priority 910): When context usage >90%, trigger compaction BEFORE sending to LLM instead of waiting for error
- [ ] Streaming truncation for 10MB+ outputs (read first N bytes + tail message, not load-all-then-truncate)
- [ ] Each individually toggleable via config
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test tool-output-truncator: 1MB output → verify truncated to budget with "[truncated]" suffix
- [ ] Test tool-output-truncator: 100 byte output → verify no truncation
- [ ] Test tool-output-truncator: output containing `[REDACTED: Security Protected]` → verify markers preserved after truncation
- [ ] Test grep-output-truncator: 500 matches → verify truncated with count message "showing N of 500"
- [ ] Test grep-output-truncator: 10 matches → verify no truncation
- [ ] Test question-label-truncator: 300 char label → verify truncated to 200 with "..."
- [ ] Test context-window-monitor: 85% usage → verify warning injected
- [ ] Test context-window-monitor: 50% usage → verify no warning
- [ ] Test preemptive-compaction: 92% usage → verify compaction triggered
- [ ] Test preemptive-compaction: 85% usage → verify no compaction
- [ ] Test streaming truncation: mock 15MB stream → verify only first N bytes read + tail message
- [ ] Test config: set custom threshold to 70% → verify warning triggers at 70%

### US-004: Internalize context injection hooks
**Description:** As a developer, I want automatic injection of AGENTS.md, README.md, and custom rules into agent context so that agents have relevant project knowledge.

**Acceptance Criteria:**
- [ ] **directory-agents-injector** (PreLLMChain, priority 100): Scan for AGENTS.md in project root and `.opencode/`, inject content into system prompt array at `llm.ts:71-84`
- [ ] **directory-readme-injector** (PreLLMChain, priority 110): Inject README.md only for first message in session or when working directory changes
- [ ] **rules-injector** (PreLLMChain, priority 120): Inject custom rules from `.opencode/rules/*.md` and `.claude/rules/*.md`
- [ ] **compaction-context-injector** (SessionLifecycleChain, priority 100): At `compaction.ts:136`, preserve and re-inject critical context (project structure, key decisions) during session compaction
- [ ] **compaction-todo-preserver** (SessionLifecycleChain, priority 110): Extract incomplete todos from pre-compaction messages, re-inject into post-compaction context
- [ ] All injections: `SecurityAccess.checkAccess(filePath, "read")` before reading, `SecurityAccess.checkAccess(filePath, "llm")` before injecting to LLM
- [ ] LLM scanner applied to injected content - redact protected segments
- [ ] Cache injected content per session (AGENTS.md/README.md don't change mid-session)
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test agents-injector: create mock AGENTS.md → verify content appears in system prompt
- [ ] Test agents-injector: no AGENTS.md exists → verify no injection, no error
- [ ] Test agents-injector: AGENTS.md is security-protected → verify access denied, no injection
- [ ] Test agents-injector: AGENTS.md contains protected segment → verify segment redacted before injection
- [ ] Test readme-injector: first message → verify README.md injected
- [ ] Test readme-injector: second message same directory → verify no duplicate injection
- [ ] Test readme-injector: directory change → verify new README.md injected
- [ ] Test rules-injector: create rules in `.opencode/rules/` → verify all rules injected
- [ ] Test rules-injector: protected rule file → verify skipped with security log
- [ ] Test compaction-context-injector: mock compaction event → verify context preserved
- [ ] Test compaction-todo-preserver: mock messages with incomplete todos → verify todos extracted and re-injected
- [ ] Test caching: inject AGENTS.md twice → verify file read only once

### US-005: Internalize agent behavior hooks
**Description:** As a developer, I want built-in agent behavior controls including keyword detection, comment checking, todo continuation enforcement, and subagent question blocking.

**Acceptance Criteria:**
- [ ] **keyword-detector** (PreLLMChain, priority 200): Detect mode keywords in user messages ([analyze-mode], [review-mode], [ultrawork]/ulw) and set message variant accordingly (max reasoning for ultrawork)
- [ ] **comment-checker** (PostToolChain, priority 400): After edit/write tool, validate that generated code doesn't contain excessive comments (>40% comment lines in changed region). Configurable threshold.
- [ ] **todo-continuation-enforcer** (SessionLifecycleChain, priority 200): When agent stops with incomplete todos (status != completed), inject continuation prompt "You have N incomplete tasks remaining"
- [ ] **stop-continuation-guard** (SessionLifecycleChain, priority 190): Detect explicit stop signal from user, prevent todo-continuation-enforcer from triggering
- [ ] **subagent-question-blocker** (PreToolChain, priority 100): When agent is a subagent, block `question` tool calls and return "Proceed autonomously without asking questions"
- [ ] **empty-task-response-detector** (PostToolChain, priority 350): Detect empty/minimal responses from delegate_task, inject "Task returned empty result, investigate or retry"
- [ ] **write-existing-file-guard** (PreToolChain, priority 200): When `write` tool targets existing file, inject warning "File exists, prefer edit tool for modifications"
- [ ] Each individually toggleable via config
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test keyword-detector: message contains "[ultrawork]" → verify variant set to "max"
- [ ] Test keyword-detector: message contains "[analyze-mode]" → verify mode set
- [ ] Test keyword-detector: normal message → verify no variant change
- [ ] Test comment-checker: edit result with 50% comments → verify warning injected
- [ ] Test comment-checker: edit result with 10% comments → verify no warning
- [ ] Test comment-checker: configurable threshold at 30% → verify triggers at 30%
- [ ] Test todo-continuation: agent stops with 3 incomplete todos → verify continuation prompt
- [ ] Test todo-continuation: agent stops with all todos complete → verify no prompt
- [ ] Test stop-continuation-guard: user sends stop → verify continuation blocked
- [ ] Test subagent-question-blocker: subagent calls question tool → verify blocked with message
- [ ] Test subagent-question-blocker: primary agent calls question tool → verify allowed
- [ ] Test empty-task-response-detector: delegate_task returns "" → verify warning
- [ ] Test empty-task-response-detector: delegate_task returns content → verify no warning
- [ ] Test write-existing-file-guard: write to existing file → verify warning
- [ ] Test write-existing-file-guard: write to new file → verify no warning

### US-006: Internalize session management hooks
**Description:** As a developer, I want built-in session recovery, notifications, and stability monitoring so that long-running agent sessions are resilient.

**Acceptance Criteria:**
- [ ] **session-recovery** (SessionLifecycleChain, priority 10): On session start, check for crashed previous session (status stuck in "busy"), offer to resume with todo continuation
- [ ] **session-notification** (SessionLifecycleChain, priority 300): Platform-native notifications on task completion: macOS `osascript` AppleScript, Linux `notify-send`. Configurable: `"notification": { "enabled": true, "sound": true }`
- [ ] **unstable-agent-babysitter** (SessionLifecycleChain, priority 250): Count consecutive failures per agent. After 3 consecutive failures, inject diagnostic guidance ("Agent appears unstable, consider: 1. Check model availability, 2. Reduce task complexity, 3. Switch to different agent")
- [ ] **think-mode** (PreLLMChain, priority 50): Set Claude `thinking` parameter based on task complexity. When message variant is "max", set `thinkingBudget: 32000`. When variant is "quick", disable thinking.
- [ ] **anthropic-effort** (PreLLMChain, priority 60): Set Anthropic effort level based on message variant. Map: "max" → "high", "quick" → "low", default → "medium"
- [ ] All hooks implemented via Bus.subscribe for session events + middleware chains for LLM events
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test session-recovery: mock crashed session (status "busy") → verify resume offered
- [ ] Test session-recovery: mock clean session → verify no recovery prompt
- [ ] Test session-notification macOS: mock process.platform="darwin" → verify osascript called
- [ ] Test session-notification Linux: mock process.platform="linux" → verify notify-send called
- [ ] Test session-notification disabled: config enabled=false → verify no notification
- [ ] Test babysitter: 3 consecutive failures → verify diagnostic guidance injected
- [ ] Test babysitter: 2 failures then success → verify counter reset, no guidance
- [ ] Test think-mode: variant "max" → verify thinkingBudget=32000
- [ ] Test think-mode: variant "quick" → verify thinking disabled
- [ ] Test think-mode: no variant → verify default behavior unchanged
- [ ] Test anthropic-effort: variant "max" → verify effort="high"
- [ ] Test anthropic-effort: variant "quick" → verify effort="low"

---

### Phase 2: Core Agent Internalization

### US-007: Internalize Sisyphus agent as default primary agent
**Description:** As a developer, I want Sisyphus as the default agent that orchestrates task delegation, category-based routing, and multi-step work coordination.

**Acceptance Criteria:**
- [ ] Create Sisyphus agent definition in `packages/opencode/src/agent/sisyphus.ts` following existing `Agent.define()` pattern
- [ ] Replace `build` as default agent. `build` remains available but Sisyphus is selected by default for new sessions.
- [ ] Agent mode: "primary" (respects UI-selected model, default claude-opus-4-6)
- [ ] Dynamic prompt builder: inject available agents table, available skills list, available categories, and delegation guide
- [ ] Task management discipline in prompt: enforce TaskCreate/TaskUpdate pattern for multi-step work
- [ ] Full tool access (unrestricted)
- [ ] Temperature: 0.1
- [ ] Register in agent registry; update default agent resolution logic
- [ ] Respect existing PermissionNext permission system
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test Sisyphus is returned as default agent when no agent specified
- [ ] Test `build` agent still accessible by explicit name
- [ ] Test dynamic prompt contains available agents table when agents exist
- [ ] Test dynamic prompt contains categories when categories configured
- [ ] Test dynamic prompt contains skills when skills available
- [ ] Test Sisyphus has unrestricted tool access (no tool denied)
- [ ] Test Sisyphus temperature is 0.1
- [ ] Test Sisyphus respects PermissionNext rules (mock deny rule → verify tool blocked)
- [ ] Test Sisyphus agent definition validates against Agent schema

### US-008: Create omo-explore agent as Sisyphus sub-agent
**Description:** As a developer, I want a new `omo-explore` agent with LSP, AST-grep, and parallel tool execution strategy, separate from the original `explore` agent, for use as a Sisyphus delegation target.

**Acceptance Criteria:**
- [ ] Create new `omo-explore` agent in `packages/opencode/src/agent/omo-explore.ts` (original `explore` agent unchanged)
- [ ] Tool restrictions: DENIED write, edit, task, delegate_task (search-only)
- [ ] Model preference: fast/cheap models (haiku, gpt-mini)
- [ ] System prompt emphasizes parallel tool execution (3+ tools simultaneously)
- [ ] Tool strategy priority in prompt: LSP > ast_grep > grep > glob > git
- [ ] Structured results with absolute paths
- [ ] Register as subagent mode; Sisyphus delegation table references `omo-explore`
- [ ] Original `explore` agent remains unchanged and accessible
- [ ] Respect SecurityAccess for all file operations
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test omo-explore agent denies write tool
- [ ] Test omo-explore agent denies edit tool
- [ ] Test omo-explore agent denies task tool
- [ ] Test omo-explore agent denies delegate_task tool
- [ ] Test omo-explore agent allows grep, glob, read, lsp, ast_grep_search tools
- [ ] Test omo-explore system prompt contains parallel execution guidance
- [ ] Test omo-explore system prompt contains tool strategy priority (LSP > ast_grep > grep > glob)
- [ ] Test omo-explore respects SecurityAccess (mock protected file → verify denied)
- [ ] Test original explore agent is unchanged (no prompt modification, same tool set)
- [ ] Test Sisyphus delegation table lists omo-explore as subagent option

### US-009: Internalize Oracle agent as strategic advisor
**Description:** As a developer, I want a built-in strategic advisor agent for hard debugging and architecture decisions.

**Acceptance Criteria:**
- [ ] Create Oracle agent in `packages/opencode/src/agent/oracle.ts`
- [ ] Read-only access: DENIED write, edit, task, delegate_task
- [ ] Model preference: high-reasoning models (claude-opus, gpt-5.x)
- [ ] System prompt: pragmatic minimalism, 2-3 sentence bottom line, effort estimation (Quick/Short/Medium/Large)
- [ ] Temperature: 0.1
- [ ] 32k thinking budget for Claude models / "medium" reasoning for GPT
- [ ] Register as subagent mode in agent registry
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test Oracle denies write, edit, task, delegate_task tools
- [ ] Test Oracle allows read, grep, glob, lsp tools
- [ ] Test Oracle temperature is 0.1
- [ ] Test Oracle system prompt contains effort estimation guidance
- [ ] Test Oracle registered as subagent mode
- [ ] Test Oracle thinking budget is 32000 for Claude models

### US-010: Make remaining OMO agents opt-in via configuration
**Description:** As a developer, I want to enable specialized agents (Hephaestus, Prometheus, Atlas, Librarian, Metis, Momus, Multimodal-Looker, Sisyphus-Junior) through configuration. When Prometheus is enabled, it replaces the existing `plan` agent for plan mode.

**Acceptance Criteria:**
- [ ] Create agent definitions in `packages/opencode/src/agent/optional/` for all 8 agents
- [ ] Each agent loadable via opencode.jsonc: `"agents": { "hephaestus": { "enabled": true } }`
- [ ] Default state: all 8 agents disabled (not loaded unless explicitly enabled)
- [ ] **Prometheus special behavior**: When `"agents": { "prometheus": { "enabled": true } }`, Prometheus replaces the existing `plan` agent for plan mode. When disabled, original `plan` agent continues to serve plan mode.
- [ ] Agent-specific model preferences and fallback chains from OMO preserved
- [ ] Tool restrictions per agent preserved:
  - Hephaestus: full access
  - Prometheus: read-only (no write/edit), serves plan mode when enabled
  - Atlas: no task/delegate_task
  - Librarian: read-only
  - Metis: read-only
  - Momus: read-only
  - Multimodal-Looker: only read tool allowed
  - Sisyphus-Junior: no task (prevent recursion)
- [ ] Per-agent config: `model`, `temperature`, `thinking`, `prompt_append`
- [ ] All agents respect SecurityAccess and PermissionNext
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test: agent not in config → verify not loaded in registry
- [ ] Test: agent enabled in config → verify loaded and accessible
- [ ] Test: each agent's tool restrictions enforced (8 agents x restriction test)
- [ ] Test: per-agent model override works
- [ ] Test: per-agent temperature override works
- [ ] Test: per-agent prompt_append appended to system prompt
- [ ] Test: disabled agent not listed in Sisyphus delegation table
- [ ] Test: enabled agent appears in Sisyphus delegation table
- [ ] Test: Prometheus disabled → verify original `plan` agent used for plan mode
- [ ] Test: Prometheus enabled → verify Prometheus used for plan mode, original `plan` agent not active
- [ ] Test: Prometheus enabled → verify plan mode prompt uses Prometheus system prompt

---

### Phase 3: Background Agent System

### US-011: Implement background agent manager
**Description:** As a developer, I want a background agent manager that handles async task queuing, concurrency control, status tracking, and configurable lifecycle on session exit.

**Acceptance Criteria:**
- [ ] Create `BackgroundManager` in `packages/opencode/src/agent/background/manager.ts`
- [ ] Task lifecycle: Create → Queue → Concurrency Check → Execute → Monitor → Notify → Cleanup
- [ ] Concurrency config: `defaultConcurrency` (number, default 3), `providerConcurrency` (Record<string, number>), `modelConcurrency` (Record<string, number>)
- [ ] Stale timeout detection (default: 180000ms / 3 minutes) with automatic cleanup
- [ ] Event callbacks: `onSubagentSessionCreated(sessionID)`, `onShutdown()`
- [ ] **Session exit behavior** (AD-9): Default: cancel all background tasks on main session exit. Configurable: `"background_task": { "persist_on_exit": true }` allows tasks to continue running and write results to `.opencode/tasks/`.
- [ ] When `persist_on_exit=false` (default): onShutdown cancels all running tasks immediately
- [ ] When `persist_on_exit=true`: onShutdown detaches tasks, they continue writing to `.opencode/tasks/{task_id}.json`
- [ ] Background tasks share parent session's SecurityConfig by reference (frozen, immutable)
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test task creation returns unique task ID
- [ ] Test task queuing when at concurrency limit (4th task queued when limit=3)
- [ ] Test task dequeued when running task completes
- [ ] Test providerConcurrency: limit anthropic to 2 → verify 3rd anthropic task queued
- [ ] Test modelConcurrency: limit claude-opus to 1 → verify 2nd opus task queued
- [ ] Test stale timeout: mock task running >3min → verify cleaned up
- [ ] Test onSubagentSessionCreated callback fires on task start
- [ ] Test persist_on_exit=false (default): onShutdown cancels all running tasks
- [ ] Test persist_on_exit=true: onShutdown detaches tasks, tasks continue running
- [ ] Test persist_on_exit=true: detached task writes result to .opencode/tasks/{id}.json
- [ ] Test SecurityConfig shared by reference (Object.is check)
- [ ] Test SecurityConfig is frozen (Object.isFrozen check)
- [ ] Test task status transitions: pending → running → completed
- [ ] Test task status transitions: pending → running → failed
- [ ] Test task status transitions: running → cancelled (on shutdown with persist_on_exit=false)

### US-012: Implement task category system
**Description:** As a developer, I want task categories that map to models and configurations for delegated work. All agents can see categories for context, but only agents with delegate_task permission can use them.

**Acceptance Criteria:**
- [ ] Define default categories in `packages/opencode/src/agent/background/categories.ts`:
  - "visual-engineering": UI/frontend tasks
  - "ultrabrain": complex reasoning tasks
  - "deep": thorough analysis tasks
  - "artistry": creative/design tasks
  - "quick": simple/fast tasks
  - "writing": documentation/text tasks
  - "unspecified-low": default low-cost tasks
  - "unspecified-high": default high-quality tasks
- [ ] Each category: `{ description: string, model?: string, prompt_append?: string }`
- [ ] Categories configurable via opencode.jsonc: `"categories": { "my-category": { ... } }`
- [ ] User categories merge with (and can override) defaults
- [ ] **Visibility** (AD-10): All agents can see the category list (injected into context for awareness). Only agents with `delegate_task` tool permission can route tasks via categories.
- [ ] Sisyphus dynamic prompt builder generates delegation table from available categories
- [ ] Categories integrate with delegate_task tool's `category` parameter
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test all 8 default categories exist with descriptions
- [ ] Test user category overrides default category
- [ ] Test user adds new custom category
- [ ] Test category lookup by name returns correct config
- [ ] Test unknown category returns error
- [ ] Test Sisyphus prompt contains category delegation table
- [ ] Test delegate_task resolves category to model correctly
- [ ] Test read-only agent (Oracle) can see category list in context
- [ ] Test read-only agent (Oracle) cannot invoke delegate_task with category (tool denied)

---

### Phase 4: Tool Enhancement & New Tools

### US-013: Enhance Glob tool with OMO parameters
**Description:** As a developer, I want the glob tool to support `maxDepth`, `hidden`, `follow`, and `noIgnore` parameters for finer file discovery control.

**Acceptance Criteria:**
- [ ] Add optional parameters: `maxDepth` (number, default 20), `hidden` (boolean, default false), `follow` (boolean, default false), `noIgnore` (boolean, default false)
- [ ] Pass parameters to underlying Ripgrep.files() invocation
- [ ] Existing SecurityAccess filtering continues to work on all results
- [ ] Add explicit 60s timeout with process kill (supplement ctx.abort)
- [ ] Existing parameter schema remains valid (backward compatible)
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test default parameters match current behavior (no regression)
- [ ] Test maxDepth=2 limits depth (create nested dirs, verify deep files excluded)
- [ ] Test hidden=true includes dotfiles
- [ ] Test hidden=false (default) excludes dotfiles
- [ ] Test follow=true follows symlinks
- [ ] Test noIgnore=true includes .gitignore'd files
- [ ] Test SecurityAccess still filters protected files with new params
- [ ] Test 60s timeout kills process (mock slow execution)
- [ ] Test backward compat: call with only pattern+path → verify works

### US-014: Enhance Grep tool with OMO parameters
**Description:** As a developer, I want advanced ripgrep options (context, case sensitivity, word matching, multiline) for more precise searches.

**Acceptance Criteria:**
- [ ] Add optional parameters: `context` (number), `caseSensitive` (boolean), `wholeWord` (boolean), `fixedStrings` (boolean), `multiline` (boolean), `maxCount` (number, default 500), `maxColumns` (number), `exclude` (string glob), `fileType` (string)
- [ ] Map parameters to ripgrep flags in Ripgrep abstraction layer
- [ ] SecurityAccess file filtering and segment redaction continue to work
- [ ] Handle ripgrep exit code 2 (partial results) gracefully - return results with warning
- [ ] Existing parameter schema remains valid (backward compatible)
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test default parameters match current behavior
- [ ] Test context=3 includes 3 lines before and after match
- [ ] Test caseSensitive=false finds case-insensitive matches
- [ ] Test wholeWord=true matches whole words only
- [ ] Test fixedStrings=true treats pattern as literal
- [ ] Test multiline=true matches across lines
- [ ] Test maxCount=10 limits results to 10
- [ ] Test exclude="*.test.ts" excludes test files
- [ ] Test fileType="ts" only searches TypeScript files
- [ ] Test SecurityAccess still redacts protected segments with new params
- [ ] Test exit code 2 returns partial results with warning message
- [ ] Test backward compat: call with only pattern → verify works

### US-015: Split LSP tool into 6 focused tools
**Description:** As a developer, I want separate LSP tools for goto-definition, find-references, symbols, diagnostics, prepare-rename, and rename.

**Acceptance Criteria:**
- [ ] Create 6 new tools: `lsp_goto_definition`, `lsp_find_references`, `lsp_symbols`, `lsp_diagnostics`, `lsp_prepare_rename`, `lsp_rename`
- [ ] `lsp_find_references`: add `includeDeclaration` (boolean) and `limit` (number, default 100)
- [ ] `lsp_symbols`: add `scope` (enum: "document" | "workspace"), `query` (string), `limit` (number, default 50)
- [ ] `lsp_diagnostics`: add `severity` (enum: "error" | "warning" | "information" | "hint" | "all")
- [ ] Preserve existing operations (hover, implementation, callHierarchy) as `lsp_hover`, `lsp_implementation`, `lsp_call_hierarchy`
- [ ] Deprecate old unified `lsp` tool (log deprecation warning, forward to new tools)
- [ ] Register all tools in ToolRegistry with experimental flag
- [ ] SecurityAccess.checkAccess(filePath, "read") on file paths in LSP results
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test lsp_goto_definition: mock LSP response → verify formatted output with file:line:col
- [ ] Test lsp_find_references: mock 150 references with limit=100 → verify truncated to 100
- [ ] Test lsp_find_references: includeDeclaration=false → verify declaration excluded
- [ ] Test lsp_symbols: scope="document" → verify only document symbols returned
- [ ] Test lsp_symbols: scope="workspace" with query="Foo" → verify filtered results
- [ ] Test lsp_diagnostics: severity="error" → verify only errors returned
- [ ] Test lsp_diagnostics: severity="all" → verify all severities returned
- [ ] Test lsp_prepare_rename: mock renameable symbol → verify success response
- [ ] Test lsp_rename: mock rename → verify all affected files listed
- [ ] Test deprecated lsp tool: call unified tool → verify deprecation warning + forwarded
- [ ] Test SecurityAccess: LSP result with protected file → verify filtered out

### US-016: Add AST-Grep search and replace tools
**Description:** As a developer, I want AST-aware code search and refactoring tools for structural code pattern matching.

**Acceptance Criteria:**
- [ ] Create `ast_grep_search` tool: `pattern` (string), `lang` (enum 25 languages), `paths` (string[], default ["."]), `globs` (string[]), `context` (number)
- [ ] Create `ast_grep_replace` tool: same params + `rewrite` (string), `dryRun` (boolean, default true)
- [ ] `@ast-grep/napi` is peer dependency. If not installed, tool returns clear error: "ast-grep not available. Install with: bun add @ast-grep/napi"
- [ ] SecurityAccess.checkAccess(path, "read") for all matched files in search
- [ ] SecurityAccess.checkAccess(path, "write") for all target files in replace
- [ ] SecuritySegments protection: do not replace within protected code segments (marker-based and AST-based)
- [ ] SecurityAudit.log() for denied operations
- [ ] Gate behind experimental flag initially
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test search: pattern `console.log($MSG)` in JS → verify matches found with meta-variable bindings
- [ ] Test search: no matches → verify empty result with "No matches found"
- [ ] Test replace dryRun=true: verify changes shown but NOT applied to files
- [ ] Test replace dryRun=false: verify file modified on disk
- [ ] Test replace on protected file → verify SecurityAccess blocks with error
- [ ] Test replace on file with protected segment → verify only non-protected regions modified
- [ ] Test SecurityAudit: denied replacement → verify audit event logged
- [ ] Test @ast-grep/napi not installed → verify clear error message with install instructions
- [ ] Test experimental flag: flag disabled → verify tool not registered
- [ ] Test 25 language enum values accepted
- [ ] Test globs parameter: `["!*.test.ts"]` excludes test files

### US-017: Add delegate-task tool with background execution
**Description:** As a developer, I want to delegate tasks to agents with category routing and background execution.

**Acceptance Criteria:**
- [ ] Create `delegate_task` tool: `description` (string), `prompt` (string), `run_in_background` (boolean), `category` (string, optional), `subagent_type` (string, optional), `session_id` (string, optional), `load_skills` (string[], optional)
- [ ] Create `background_output` tool: `task_id` (string) → returns status + output
- [ ] Create `background_cancel` tool: `task_id` (string) → cancels running task
- [ ] `run_in_background=true`: return task_id immediately
- [ ] `run_in_background=false`: wait for completion, return result
- [ ] Category resolution: look up model + prompt_append from category system (US-012)
- [ ] Skill injection: load skills by name, inject content into sub-agent context
- [ ] Session continuation: `session_id` continues existing sub-session
- [ ] Sub-agent permission: deny `delegate_task` for sub-agents (prevent recursion)
- [ ] Integrate with BackgroundManager (US-011) for concurrency
- [ ] Sub-agents share parent SecurityConfig by reference
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test sync execution: run_in_background=false → verify waits and returns result
- [ ] Test async execution: run_in_background=true → verify returns task_id immediately
- [ ] Test background_output: poll task → verify status + partial output
- [ ] Test background_cancel: cancel running task → verify terminated
- [ ] Test category routing: category="quick" → verify cheap model selected
- [ ] Test subagent_type routing: subagent_type="oracle" → verify Oracle agent used
- [ ] Test mutual exclusivity: both category and subagent_type → verify error
- [ ] Test skill injection: load_skills=["git-master"] → verify skill content in sub-agent prompt
- [ ] Test session continuation: session_id provided → verify existing session continued
- [ ] Test recursion prevention: sub-agent calls delegate_task → verify denied
- [ ] Test SecurityConfig sharing: sub-agent inherits frozen config
- [ ] Test concurrency: exceed limit → verify task queued

### US-018: Add look-at (multimodal analyzer) tool
**Description:** As a developer, I want a tool to analyze images, PDFs, and diagrams using vision models.

**Acceptance Criteria:**
- [ ] Create `look_at` tool: `file_path` (string, optional), `image_data` (string base64, optional), `goal` (string, required)
- [ ] At least one of `file_path` or `image_data` must be provided
- [ ] Route to vision-capable model (configurable, default gemini-flash)
- [ ] SecurityAccess.checkAccess(filePath, "read") before reading file
- [ ] SecurityAccess.checkAccess(filePath, "llm") before sending to vision model
- [ ] Return extracted text information
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test with file_path to image → verify read + analyzed
- [ ] Test with base64 image_data → verify analyzed without file read
- [ ] Test neither file_path nor image_data → verify error
- [ ] Test protected file → verify SecurityAccess denies read
- [ ] Test file allowed for read but denied for llm → verify blocked before vision model
- [ ] Test goal parameter affects extraction (mock vision model)
- [ ] Test unsupported file type → verify clear error message

### US-019: Add skill-mcp tool for MCP operations within skills
**Description:** As a developer, I want to invoke MCP tools, resources, and prompts from within skill context.

**Acceptance Criteria:**
- [ ] Create `skill_mcp` tool: `mcp_name` (string), `tool_name` (string, optional), `resource_name` (string, optional), `prompt_name` (string, optional), `arguments` (string/object, optional)
- [ ] Validate exactly ONE of tool_name/resource_name/prompt_name provided
- [ ] Reuse existing MCP client management (MCP.tools() infrastructure)
- [ ] Apply MCP security policy from .opencode-security.json (blocked/enforced/trusted)
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test tool invocation: tool_name="search" → verify MCP tool called with arguments
- [ ] Test resource access: resource_name="docs" → verify resource fetched
- [ ] Test prompt execution: prompt_name="summarize" → verify prompt run
- [ ] Test multiple operations specified → verify validation error
- [ ] Test no operation specified → verify validation error
- [ ] Test blocked MCP server → verify access denied with policy message
- [ ] Test unknown MCP server → verify clear error message
- [ ] Test arguments as JSON string → verify parsed correctly
- [ ] Test arguments as object → verify passed through

### US-020: Add interactive-bash tool for tmux management
**Description:** As a developer, I want tmux session management for parallel agent terminal panes.

**Acceptance Criteria:**
- [ ] Create `interactive_bash` tool: `tmux_command` (string)
- [ ] Block dangerous subcommands: `send-keys`, `send`, `type`, `paste` (prevent shell injection bypass)
- [ ] BashScanner applied to file paths in tmux commands
- [ ] Gate behind experimental flag + tmux availability check
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test allowed command: `list-sessions` → verify executed
- [ ] Test blocked command: `send-keys` → verify denied with message
- [ ] Test blocked command: `send` → verify denied
- [ ] Test tmux command with protected file path → verify BashScanner blocks
- [ ] Test tmux not installed → verify clear error message
- [ ] Test experimental flag disabled → verify tool not registered

### US-021: Enhance Task tool with persistent storage and dependencies
**Description:** As a developer, I want tasks to persist across sessions with dependency tracking.

**Acceptance Criteria:**
- [ ] File-based storage in `.opencode/tasks/` directory (one JSON file per task)
- [ ] Fields: `id` (T-{uuid}), `subject`, `description`, `status` (pending/in_progress/completed/deleted), `blockedBy` (string[]), `blocks` (string[]), `owner` (string), `metadata` (object), `activeForm` (string), `createdAt`, `updatedAt`
- [ ] Atomic writes with file-level locking (prevent concurrent corruption)
- [ ] "ready" filter: list tasks where all blockedBy dependencies are completed
- [ ] Backward compatible with existing TaskTool (agent spawning) - complementary features
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test create: verify JSON file created in .opencode/tasks/ with T-{uuid} format
- [ ] Test create: verify all fields populated with defaults
- [ ] Test list: verify all tasks returned with summary
- [ ] Test list with ready filter: blockedBy task incomplete → verify excluded from ready list
- [ ] Test list with ready filter: blockedBy task completed → verify included in ready list
- [ ] Test get: verify full task details returned
- [ ] Test get: nonexistent ID → verify clear error
- [ ] Test update status: pending → in_progress → completed transitions
- [ ] Test update status: invalid transition → verify error
- [ ] Test delete: verify file removed
- [ ] Test dependency: add blockedBy → verify stored and enforced
- [ ] Test atomic write: simulate concurrent writes → verify no corruption (file lock)
- [ ] Test backward compat: existing task tool (agent spawning) still works

### US-022: Enhance Skill tool with MCP listing
**Description:** As a developer, I want the skill tool to show MCP capabilities and support lazy loading.

**Acceptance Criteria:**
- [ ] When skill defines `mcp` metadata, list available tools/resources/prompts per MCP server
- [ ] Lazy content loading for large skill templates (defer read until tool invoked)
- [ ] Skill-to-agent restriction: `skill.agent` field limits which agents can use the skill
- [ ] Support `<skill-instruction>` XML block extraction for template content
- [ ] Preserve existing skill permission filtering via PermissionNext
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test MCP listing: skill with MCP config → verify tools/resources/prompts listed in output
- [ ] Test MCP listing: skill without MCP → verify no MCP section in output
- [ ] Test lazy loading: large skill → verify content not read until tool invoked
- [ ] Test agent restriction: skill.agent="sisyphus", current agent="explore" → verify denied
- [ ] Test agent restriction: skill.agent="sisyphus", current agent="sisyphus" → verify allowed
- [ ] Test XML extraction: skill with `<skill-instruction>` → verify only that block returned
- [ ] Test permission filtering: skill denied by PermissionNext → verify not listed

---

### Phase 5: MCP & Skill Enhancements

### US-023: Integrate OMO built-in MCP servers
**Description:** As a developer, I want built-in MCP configurations for web search, documentation, and code search. Servers are disabled by default and auto-enable when the user provides API keys.

**Acceptance Criteria:**
- [ ] Add built-in MCP configs: `websearch` (Exa), `context7` (documentation), `grep_app` (GitHub code search)
- [ ] **Default disabled** (AD-11): Each server disabled until user provides API key
- [ ] **Auto-enable on API key**: When env var is set (e.g., `EXA_API_KEY`) or key configured in opencode.jsonc, the corresponding server auto-enables
- [ ] Supported env vars documented: `EXA_API_KEY`, `CONTEXT7_API_KEY`, `GREP_APP_API_KEY`
- [ ] Remote MCP server type with URL, headers, OAuth support
- [ ] Apply MCP security policy from .opencode-security.json
- [ ] Individually disableable even with API key: `"disabled_mcps": ["websearch"]`
- [ ] Clear user feedback: when agent tries to use disabled MCP, return "MCP server 'websearch' requires API key. Set EXA_API_KEY environment variable to enable."
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test all 3 MCP servers have valid configurations
- [ ] Test default state: all disabled (no API keys)
- [ ] Test auto-enable: set EXA_API_KEY env → verify websearch server enabled
- [ ] Test auto-enable: set key in opencode.jsonc → verify server enabled
- [ ] Test no API key + agent tries MCP → verify clear error message with env var name
- [ ] Test disable via config: API key set but disabled_mcps=["websearch"] → verify not loaded
- [ ] Test MCP security policy: blocked server → verify tools not exposed
- [ ] Test MCP security policy: enforced server → verify input scanning applied
- [ ] Test OAuth config: verify OAuth params passed to MCP client

### US-024: Internalize OMO built-in skills and commands
**Description:** As a developer, I want built-in skills (git-master, playwright) and commands available by default.

**Acceptance Criteria:**
- [ ] Port `git-master` skill: atomic commit generation, conventional commit enforcement
- [ ] Port `playwright` skill: browser automation for testing
- [ ] Port built-in commands (up to 6 from OMO)
- [ ] Skills/commands discoverable via existing APIs (Skill.all(), command discovery)
- [ ] User-defined skills/commands take priority over built-in (user can override)
- [ ] Skills respect PermissionNext filtering
- [ ] Commands respect SecurityAccess for file operations
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test git-master skill loaded and discoverable
- [ ] Test playwright skill loaded and discoverable
- [ ] Test user skill with same name overrides built-in
- [ ] Test built-in commands loaded
- [ ] Test user command with same name overrides built-in
- [ ] Test skill permission filtering applies to built-in skills
- [ ] Test command with file operation respects SecurityAccess

---

### Phase 6: Configuration & Security Integration

### US-025: Extend opencode.jsonc schema for OMO features
**Description:** As a developer, I want all OMO features configurable through opencode.jsonc.

**Acceptance Criteria:**
- [ ] Add config sections with Zod schemas:
  - `agents`: `Record<string, { enabled?: boolean, model?: string, temperature?: number, thinking?: number, prompt_append?: string }>`
  - `categories`: `Record<string, { description: string, model?: string, prompt_append?: string }>`
  - `hooks`: `Record<string, { enabled: boolean }>` (all hooks default enabled)
  - `background_task`: `{ defaultConcurrency?: number, providerConcurrency?: Record<string, number>, modelConcurrency?: Record<string, number>, staleTimeoutMs?: number, persist_on_exit?: boolean }`
  - `notification`: `{ enabled?: boolean, sound?: boolean }`
  - `disabled_mcps`: `string[]`
- [ ] Merge with existing config loading precedence
- [ ] Backward compatible: no existing config breaks
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test empty config (no new sections) → verify all defaults applied
- [ ] Test agents section: enable hephaestus → verify agent loaded
- [ ] Test categories section: add custom category → verify available
- [ ] Test hooks section: disable hook → verify hook skipped
- [ ] Test background_task section: set concurrency → verify enforced
- [ ] Test notification section: disable → verify no notifications
- [ ] Test disabled_mcps: add server → verify not loaded
- [ ] Test invalid config value → verify Zod error with helpful message
- [ ] Test backward compat: existing valid config → verify no errors

### US-026: Security integration for all new tools and agents
**Description:** As a developer, I want all new components fully integrated with security access control.

**Acceptance Criteria:**
- [ ] `ast_grep_search`: SecurityAccess.checkAccess(path, "read") for all matched files
- [ ] `ast_grep_replace`: SecurityAccess.checkAccess(path, "write") + SecuritySegments for protected code
- [ ] `delegate_task`: Sub-agents share parent SecurityConfig (frozen reference). SecurityConfig is `Object.freeze()`'d during bootstrap.
- [ ] `look_at`: SecurityAccess.checkAccess(path, "read") + checkAccess(path, "llm")
- [ ] `skill_mcp`: MCP security policy from .opencode-security.json
- [ ] `interactive_bash`: BashScanner on tmux command arguments
- [ ] Context injection hooks: SecurityAccess + LLM scanner before injecting content
- [ ] Background agents: frozen SecurityConfig propagated by reference
- [ ] SecurityAudit.log() for all new security-relevant operations
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test ast_grep_search on protected file → access denied + audit logged
- [ ] Test ast_grep_replace on protected segment → blocked + audit logged
- [ ] Test ast_grep_replace on non-protected region of file with protected segment → only non-protected replaced
- [ ] Test delegate_task SecurityConfig: verify Object.is(parent.config, child.config) === true
- [ ] Test delegate_task SecurityConfig: verify Object.isFrozen(config) === true
- [ ] Test delegate_task SecurityConfig: verify mutation throws TypeError
- [ ] Test look_at read-denied → blocked
- [ ] Test look_at llm-denied (read allowed) → blocked before vision model
- [ ] Test skill_mcp blocked server → denied
- [ ] Test interactive_bash with protected file path → BashScanner blocks
- [ ] Test context injection: AGENTS.md with protected segment → segment redacted
- [ ] Test audit: verify SecurityAudit.log called for each denied operation

---

### Phase 7: Upstream Tracking

### US-027: Build OMO upstream diff reporting tool
**Description:** As a maintainer, I want automated diff reports when OMO releases new versions, available as both manual script and CI workflow.

**Acceptance Criteria:**
- [ ] Create `script/omo-diff.ts`:
  - Fetch latest OMO from npm registry (`npm view oh-my-opencode`)
  - Download and extract tarball to temp directory
  - Compare against baseline version in `packages/opencode/.omo-baseline.json`
  - Generate structured diff report in `tasks/omo-diff-report-{version}.md`
- [ ] Diff report sections:
  - New/modified tools (parameter schema changes, execute logic changes)
  - New/modified hooks (behavior changes)
  - New/modified agents (model/prompt/restriction changes)
  - Config schema changes
  - Dependency changes
- [ ] Each change categorized: "backport recommended" / "review needed" / "skip (diverged)"
- [ ] Impact analysis: affected opencode files per change
- [ ] Runnable via `bun run script/omo-diff.ts`
- [ ] **CI template** (AD-12): Create `.github/workflows/omo-diff.yml` GitHub Actions workflow:
  - Scheduled: weekly (e.g., every Monday 09:00 UTC)
  - Manual trigger via `workflow_dispatch`
  - Steps: checkout → install deps → run omo-diff.ts → commit report if changes found → open PR with diff report
  - Does NOT run on `bun install` (no postinstall hook)
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test npm registry fetch: mock npm view → verify version extracted
- [ ] Test tarball download and extraction: mock tarball → verify files extracted
- [ ] Test baseline comparison: mock baseline + new version → verify diff generated
- [ ] Test report generation: verify all sections present
- [ ] Test categorization logic: new tool → "backport recommended"
- [ ] Test categorization logic: modified tool with security divergence → "skip (diverged)"
- [ ] Test impact analysis: tool change → verify affected opencode file listed
- [ ] Test no changes: same version → verify "no changes" report
- [ ] Test CI workflow YAML is valid (parse and validate structure)
- [ ] Test script exit code: changes found → exit 0; no changes → exit 0; error → exit 1

### US-028: Create OMO baseline tracking file
**Description:** As a maintainer, I want a baseline file recording which OMO version was internalized.

**Acceptance Criteria:**
- [ ] Create `packages/opencode/.omo-baseline.json`:
  ```json
  {
    "version": "3.5.2",
    "date": "2026-02-14",
    "tools": { "ast_grep_search": "internalized", "ast_grep_replace": "internalized", ... },
    "hooks": { "edit-error-recovery": "internalized", ... },
    "agents": { "sisyphus": "internalized", "hephaestus": "optional", ... },
    "notes": "..."
  }
  ```
- [ ] Diff tool (US-027) reads and optionally updates this file
- [ ] Typecheck passes

**Unit Tests:**
- [ ] Test baseline file schema validates with Zod
- [ ] Test diff tool reads baseline correctly
- [ ] Test diff tool updates baseline version after comparison
- [ ] Test baseline with missing fields → verify defaults applied

---

### Phase 8: Integration Testing & Performance

### US-029: Integration tests for security across all new components
**Description:** As a developer, I want integration tests verifying security access control works end-to-end with all new tools and agents.

**Acceptance Criteria:**
- [ ] Test: ast_grep_search on protected file → access denied
- [ ] Test: ast_grep_replace on protected segment → operation blocked, non-protected regions still modifiable
- [ ] Test: delegate_task sub-agent inherits frozen SecurityConfig, cannot modify it
- [ ] Test: look_at on read-protected file → access denied
- [ ] Test: look_at on llm-protected file → access denied before vision model
- [ ] Test: context injection (AGENTS.md) with protected segments → segments redacted in LLM context
- [ ] Test: context injection (rules) with protected rule file → file skipped
- [ ] Test: background agent respects same security rules as parent (file read denied)
- [ ] Test: tool-output-truncator preserves `[REDACTED: Security Protected]` markers
- [ ] Test: interactive_bash with protected file in tmux command → BashScanner blocks
- [ ] Test: skill_mcp with blocked MCP server → denied
- [ ] Test: SecurityAudit receives events for all above denials
- [ ] Tests run via `bun test --cwd packages/opencode`
- [ ] Typecheck passes

### US-030: Performance benchmarks for hook pipeline
**Description:** As a developer, I want benchmarks ensuring hooks don't degrade performance.

**Acceptance Criteria:**
- [ ] Benchmark: full hook pipeline (all hooks enabled) overhead per tool execution
- [ ] Target: PreLLMChain < 5ms per LLM call
- [ ] Target: PreToolChain < 2ms per tool call
- [ ] Target: PostToolChain < 10ms per tool result (excluding truncation I/O)
- [ ] Target: tool-output-truncator < 50ms for 10MB output
- [ ] Target: context-window-monitor < 1ms per message (token counting cached)
- [ ] Target: disabled hook < 0.01ms overhead (boolean check only)
- [ ] Benchmark context injection caching: second call < 0.1ms (cached)
- [ ] Results documented in `tasks/omo-perf-report.md`
- [ ] All benchmarks run as part of test suite with `--bench` flag
- [ ] Typecheck passes

**Unit Tests (benchmark format):**
- [ ] Bench: PreLLMChain with 5 hooks → measure p50/p99 latency
- [ ] Bench: PreToolChain with 3 hooks → measure p50/p99 latency
- [ ] Bench: PostToolChain with 5 hooks → measure p50/p99 latency
- [ ] Bench: tool-output-truncator on 1KB/100KB/1MB/10MB inputs
- [ ] Bench: context-window-monitor token counting
- [ ] Bench: disabled hook overhead (1000 iterations)
- [ ] Bench: AGENTS.md injection cache hit vs miss
- [ ] Bench: full pipeline (message → tool → result) with all hooks

## Functional Requirements

- FR-1: All new tools must register in ToolRegistry and be discoverable via `ToolRegistry.all()`
- FR-2: Enhanced tools must maintain 100% backward compatibility (additive parameter changes only)
- FR-3: Sisyphus replaces `build` as default agent; `build` remains accessible by name; `omo-explore` created as new sub-agent (original `explore` unchanged)
- FR-4: Optional agents load only when explicitly enabled in `opencode.jsonc`
- FR-5: All 46+ hooks implemented as typed middleware chains in session/processor/LLM layers
- FR-6: Each hook individually toggleable via `"hooks": { "name": { "enabled": bool } }`
- FR-7: Background tasks enforce concurrency limits per provider and per model
- FR-8: All new tools call SecurityAccess.checkAccess() for file operations
- FR-9: All new tools with write operations check SecuritySegments for protected code
- FR-10: All context injections pass through LLM scanner
- FR-11: BashScanner applied to interactive_bash commands
- FR-12: SecurityAudit logs events for all new security-relevant operations
- FR-13: SecurityConfig is Object.freeze()'d at bootstrap; sub-agents share by reference
- FR-14: Category system extensible via configuration
- FR-15: Built-in MCP servers default disabled, auto-enable on API key, respect .opencode-security.json policies
- FR-16: `@ast-grep/napi` is peer dependency; clear error if missing
- FR-17: OMO diff tool runnable via `bun run script/omo-diff.ts` + GitHub Actions weekly workflow
- FR-18: Category list visible to all agents; only delegate_task-permitted agents can route via categories
- FR-19: Every US has comprehensive unit tests; `bun test --cwd packages/opencode` passes

## Non-Goals (Out of Scope)

- **OMO CLI system** (`src/cli/`) - OpenCode has its own CLI
- **OMO config migration** - No auto-migration from `.opencode/oh-my-opencode.jsonc`
- **Tmux multi-pane UI** - interactive_bash provides tmux access but not the full pane management UI
- **OMO plugin loading** - OpenCode has its own plugin system
- **OMO auto-update checker** - OpenCode manages its own updates
- **OMO native binaries** - Cross-platform binary distribution not needed
- **Provider-specific auth plugins** - Already exist in OpenCode
- **Boulder state** - OpenCode's session system serves this purpose
- **"Ralph Loop" branding** - Error recovery patterns internalized without brand
- **Magic keywords branding** - Keyword detection hook internalized; specific keywords configurable

## Technical Considerations

### Dependencies
- `@ast-grep/napi` (^0.40.0) - Peer dependency for AST-Grep tools. Users install separately.
- No other new external dependencies.

### Architecture
- **Hook middleware chains**: 4 typed chains (PreLLM, PreTool, PostTool, SessionLifecycle) in `packages/opencode/src/session/hooks/`
- **Agent registration**: Follow existing `Agent.define()` pattern
- **Tool registration**: Follow existing `Tool.define()` pattern + `ToolRegistry.register()`
- **Background manager**: New module at `packages/opencode/src/agent/background/`
- **SecurityConfig immutability**: `Object.freeze()` after loading in bootstrap

### Performance
- Hook fast-path: boolean `enabled` check before any processing
- Middleware chain compiled once at session start
- Context injection cached per session
- Output truncation uses streaming (read first N bytes + tail)
- AST-Grep pattern compilation cached per session
- Token counting for context-window-monitor cached and incrementally updated

### Security
- All new tools: SecurityAccess.checkAccess() before file I/O
- All write tools: SecuritySegments check for protected code
- All context injections: LLM scanner before sending to model
- Background agents: frozen SecurityConfig shared by reference
- SecurityAudit.log() for all denied operations
- BashScanner for interactive_bash commands

## Success Metrics

- All OMO tools functional with equivalent or better capability
- Zero security regression: all existing + new security tests pass
- Hook pipeline overhead: PreLLM <5ms, PreTool <2ms, PostTool <10ms
- Configuration-driven: every feature toggleable without code changes
- Diff tool generates actionable OMO upgrade reports
- Startup time increase < 200ms
- All 30 US have comprehensive unit tests passing

## Open Questions (Resolved)

| # | Question | Decision |
|---|----------|----------|
| 1 | Sisyphus vs build as default? | **Sisyphus replaces build as default** (AD-1) |
| 2 | Hook implementation location? | **Middleware chains in session pipeline** (AD-5) |
| 3 | @ast-grep/napi bundling? | **Peer dependency, user installs** (AD-2) |
| 4 | SecurityConfig in sub-agents? | **Shared by reference, frozen at bootstrap** (AD-3) |
| 5 | Phase ordering? | **Hooks first, tools last** (AD-4) |
| 6 | Unit tests? | **Comprehensive tests for every US** |
| 7 | Prometheus vs plan agent? | **Prometheus replaces plan agent when enabled** (AD-6) |
| 8 | Explore agent strategy? | **New omo-explore agent, original explore untouched** (AD-7) |
| 9 | Plugin.trigger() compatibility? | **Preserved, plugins execute first** (AD-8) |
| 10 | Background task lifecycle? | **Default cancel, configurable persist_on_exit** (AD-9) |
| 11 | Category system scope? | **All agents see categories, only delegate_task-permitted agents can use** (AD-10) |
| 12 | Built-in MCP API keys? | **Default disabled, auto-enable on user API key config** (AD-11) |
| 13 | Diff tool trigger method? | **Manual script + CI GitHub Action template** (AD-12) |

## Remaining Open Questions

All resolved. See AD-10, AD-11, AD-12.
