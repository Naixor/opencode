# PRD: Core Feature Integration & Plugin Security Enforcement

## Introduction

Analysis of the OpenCode plugin ecosystem — specifically the most feature-rich community plugin — revealed two critical findings:

1. **High-value capabilities trapped in plugin-land**: Features like AST-aware code refactoring, multimodal file analysis, todo continuation enforcement, and session crash recovery exist only as plugin features. This imposes 60-560ms overhead per tool call (hook iteration + permission + security scanning), creates dependency on external maintainers for core developer experience, and exposes the largest security attack surface (660+ direct filesystem calls, 30 shell spawn calls in a single plugin).

2. **Plugin system lacks security enforcement**: Third-party plugins run in the same process with full access to Bun APIs, filesystem, network, and shell. Plugin-defined tools bypass `SecurityAccess.checkAccess()` and `LLMScanner` checks. Plugin hooks receive unredacted content including security-protected data.

This PRD addresses both issues through a **two-track approach**:

- **Track A — Core Feature Integration**: Move 7 high-value capabilities from plugin to built-in, eliminating plugin overhead and gaining native security model coverage.
- **Track B — Plugin Security Enforcement**: For remaining third-party plugins, enforce security checks on plugin tools, redact hook payloads, and harden MCP defaults — all **in-process without subprocess sandboxing**.

### Why Not Sandbox?

| Finding                                                                                          | Implication                                                 |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Plugins execute **in-process** via `import()` — no isolation exists today                        | Adding sandbox requires fundamental architecture change     |
| The largest community plugin makes 660+ fs calls, 30 spawn calls, uses `Bun.serve()`             | Sandboxing would break 100% of its functionality            |
| Bun has **no built-in permission model** ([#26637](https://github.com/oven-sh/bun/issues/26637)) | OS-level enforcement impossible without external tools      |
| 80%+ of the largest plugin's features are **pure additive** to OpenCode                          | These features belong in core, not behind a plugin boundary |

**Decision**: Integrate core features first (eliminates the primary security exposure), then apply in-process security enforcement on remaining plugins. Subprocess sandboxing is deferred to a future PRD when Bun adds a native permission model.

### Plugin Security Vectors

| Vector                                 | Description                                                       | Mitigation                                               |
| -------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| **A — Plugin tools bypass security**   | `fromPlugin()` wraps plugin tools with zero security checks       | FR-8: Wrap with `checkAccess()` + `LLMScanner`           |
| **B — Plugin hooks see raw data**      | `experimental.chat.messages.transform` passes unredacted messages | FR-10, FR-11: Clone + scan + structural diff             |
| **C — MCP tools default to "trusted"** | Unknown MCP servers skip scanning                                 | FR-12: Default to "enforced" when security config exists |
| **D — Direct API access**              | Plugins have full `Bun.$`, `fs`, `fetch` access                   | **Not addressed** — deferred to sandbox phase            |

Vector D is explicitly deferred. Core feature integration (Track A) reduces the attack surface by removing the most API-intensive plugin from the plugin boundary.

## Goals

### Track A: Core Feature Integration

1. **Add AST-grep tools** — AST-aware code search and refactoring across 25 languages, filling a gap no built-in tool covers
2. **Promote LSP tools to stable** — Remove experimental flag, add missing operations (diagnostics, rename), make LSP a first-class capability
3. **Add multimodal analysis tool** — Analyze images, PDFs, and diagrams using the model's multimodal capabilities
4. **Enhance context injection** — Extend existing AGENTS.md injection with README discovery and subdirectory-aware context loading
5. **Add todo continuation enforcer** — Ensure agents complete their TODO lists instead of stopping mid-task
6. **Add comment checker** — Prevent AI-generated code from containing excessive comments
7. **Add session recovery** — Automatically detect and recover from session crashes with TODO state preservation

### Track B: Plugin Security Enforcement

8. **Enforce security access control** on all plugin-defined tools (defense-in-depth)
9. **Scan and redact** protected content in plugin hook payloads
10. **Change MCP default policy** from "trusted" to "enforced" when security config is present
11. **Protect `.opencode-security.json`** from modification
12. **Zero breaking changes** for plugins that don't access protected content

## User Stories

### Part A: Core Feature Integration

### US-001: AST-grep search and replace tools

**Description:** As a developer, I want AST-aware code search and replace tools so that I can find and refactor code patterns structurally, not just by text matching.

**Acceptance Criteria:**

- [ ] `ast_grep_search` tool: searches code patterns using AST meta-variables (`$VAR` for single node, `$$$` for multiple nodes)
- [ ] Supports 25 languages: bash, c, cpp, csharp, css, elixir, go, haskell, html, java, javascript, json, kotlin, lua, nix, php, python, ruby, rust, scala, solidity, swift, typescript, tsx, yaml
- [ ] Parameters: `pattern` (string, required), `lang` (enum, required), `paths` (string[], optional), `globs` (string[], optional), `context` (number, optional — lines of surrounding context)
- [ ] Returns matching file paths with line numbers, matched content, and optional surrounding context
- [ ] Safety limits: 60s timeout, 100 file max for search results
- [ ] `ast_grep_replace` tool: rewrites code patterns with AST-aware substitution
- [ ] Parameters: `pattern`, `rewrite`, `lang` (required), `paths`, `globs` (optional), `dryRun` (boolean, default true)
- [ ] Dry-run by default — shows what would change without applying
- [ ] Meta-variables in rewrite preserve matched content (e.g., pattern `console.log($MSG)` → rewrite `logger.info($MSG)`)
- [ ] Both tools call `SecurityAccess.checkAccess()` on target paths, consistent with `GrepTool` and `GlobTool`
- [ ] Typecheck passes

### US-002: Promote LSP tools to stable with full operations

**Description:** As a developer, I want reliable LSP tools available by default (not behind an experimental flag) so that I can navigate and refactor code with language-aware precision.

**Acceptance Criteria:**

- [ ] Remove `OPENCODE_EXPERIMENTAL_LSP_TOOL` flag gate — LSP tools always available
- [ ] Existing operations retained: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls
- [ ] Add `diagnostics` operation: get errors, warnings, hints from language server for a file, with optional severity filter (error, warning, information, hint, all)
- [ ] Add `prepareRename` operation: check if rename is valid at a position before applying
- [ ] Add `rename` operation: rename symbol across entire workspace
- [ ] Typecheck passes

### US-003: Multimodal analysis tool (look_at)

**Description:** As a developer, I want a tool that can analyze images, PDFs, and diagrams so that the AI can understand visual content like screenshots, architecture diagrams, and design mockups.

**Acceptance Criteria:**

- [ ] `look_at` tool accepts `file_path` (string) and `goal` (string describing what to analyze)
- [ ] Supports image formats: PNG, JPG, GIF, WebP, SVG
- [ ] Supports PDF files
- [ ] Accepts optional `image_data` parameter for base64-encoded images (when file path is not available)
- [ ] Uses the current model's multimodal capabilities to analyze the content
- [ ] Returns text description/analysis focused on the specified goal
- [ ] Graceful error when model doesn't support multimodal input
- [ ] Typecheck passes

### US-004: Enhance context injection system

**Description:** As a developer, I want richer project-specific context automatically injected into the AI's system prompt, including README content and subdirectory-level AGENTS.md, so that the AI understands my project conventions without manual prompting.

**Acceptance Criteria:**

- [ ] Existing AGENTS.md injection via `InstructionPrompt` is preserved (already supports `findUp`, `globUp`, global files)
- [ ] Add README.md discovery: when the agent is working in a subdirectory, inject relevant README.md content from that directory
- [ ] Add directory-level AGENTS.md injection: when the `read` tool opens a file in a subdirectory, inject AGENTS.md from that directory if it exists (existing `InstructionPrompt.resolve()` already does this — verify and document)
- [ ] Injected content includes source attribution (`[Instructions from: path/to/AGENTS.md]` — already present)
- [ ] No duplication of content already injected by existing instruction system
- [ ] Configurable: can disable README injection via `.opencode.json`
- [ ] Typecheck passes

### US-005: Todo continuation enforcer

**Description:** As a developer, I want the AI agent to automatically resume incomplete TODOs instead of stopping mid-task, so that complex multi-step tasks are reliably completed.

**Acceptance Criteria:**

- [ ] Monitors session TODO list after each agent turn
- [ ] When agent produces a final response with incomplete TODOs (status = `pending` or `in_progress`), triggers continuation
- [ ] Continuation injects a system reminder prompting the agent to continue working on incomplete items
- [ ] Respects a maximum continuation count (configurable, default 3) to prevent infinite loops
- [ ] Can be disabled per session or globally via configuration
- [ ] Does not trigger during plan-mode (read-only agent)
- [ ] Typecheck passes

### US-006: Comment checker for AI-generated code

**Description:** As a developer, I want AI-generated code to be free of excessive comments so that the codebase stays clean and professional.

**Acceptance Criteria:**

- [ ] Scans code output from write-producing tools (edit, write, apply_patch) for excessive comments
- [ ] Detects patterns: comments explaining obvious code, redundant comments restating the code, excessive inline annotations
- [ ] When excessive comments detected, appends a warning to tool output suggesting the agent reduce comments
- [ ] Configurable sensitivity (strict, normal, relaxed) via `.opencode.json`
- [ ] Advisory only — does not modify code directly, warns the agent
- [ ] Typecheck passes

### US-007: Session crash recovery

**Description:** As a developer, I want the system to automatically detect interrupted sessions and offer to resume from where I left off, so that crashes don't lose my progress.

**Acceptance Criteria:**

- [ ] Detects sessions that were interrupted (process crash, network disconnect, user kill)
- [ ] Preserves TODO state at the time of crash
- [ ] On next startup in the same project, offers to resume the interrupted session
- [ ] Resume restores: TODO list state, session context, last working directory
- [ ] If user declines resume, archives the interrupted session normally
- [ ] Typecheck passes

### Part B: Plugin Security Enforcement

### US-008: Enforce security on plugin-defined tools

**Description:** As a security-conscious user, I want plugin-defined tools to go through the same security checks as built-in tools so that a plugin cannot read protected files through custom tools.

**Acceptance Criteria:**

- [ ] `ToolRegistry.fromPlugin()` wraps plugin tool `execute()` with security enforcement
- [ ] Plugin tool output is scanned via `LLMScanner.scanForProtectedContent()`
- [ ] Protected content in plugin tool output is redacted via `SecurityRedact.redactContent()`
- [ ] File paths in plugin tool arguments are detected by: extracting all strings recursively from args, calling `path.resolve()` on each, checking `fs.existsSync()` to confirm it's a real path, then running `SecurityAccess.checkAccess()` on confirmed paths
- [ ] Audit events are logged for blocked/redacted plugin tool invocations via `SecurityAudit.logSecurityEvent()`
- [ ] Plugin tools that don't return file content continue to work unchanged
- [ ] Typecheck passes

### US-009: Redact protected content in plugin hook payloads with structural diff

**Description:** As a security-conscious user, I want plugin hooks that receive message content to have protected content redacted, and only structural changes (add/remove messages) synced back — not content modifications that could pollute data with redacted values.

**Acceptance Criteria:**

- [ ] `experimental.chat.messages.transform` hook receives a deep-cloned copy of messages with protected content redacted
- [ ] After hook returns, only structural changes synced back: messages added or removed by the plugin are applied, content modifications to existing messages are discarded
- [ ] `experimental.chat.system.transform` hook receives system prompts with protected content already redacted
- [ ] `tool.execute.after` hook receives redacted tool output. **Known gap**: the task tool (`prompt.ts:422-430`) passes its result directly to `tool.execute.after` without security scanning — add `scanAndRedact()` before the hook fires
- [ ] `experimental.text.complete` hook output is scanned before being sent to the LLM
- [ ] Redaction uses existing `LLMScanner.scanForProtectedContent()` + `SecurityRedact.redactContent()`
- [ ] Non-protected content passes through unchanged
- [ ] Typecheck passes

### US-010: Change MCP default policy to "enforced" when security config exists

**Description:** As a security-conscious user, I want MCP tools from unrecognized servers to be scanned by default so that a plugin registering an MCP server cannot bypass security.

**Acceptance Criteria:**

- [ ] When `.opencode-security.json` exists and has rules, `SecurityConfig.getMcpPolicy()` returns "enforced" (not "trusted") for unknown servers
- [ ] When no `.opencode-security.json` exists, default remains "trusted" (backward compatible)
- [ ] Explicitly configured "trusted" servers remain trusted
- [ ] MCP tools from "enforced" servers have both input AND output scanned
- [ ] Typecheck passes

### US-011: Protect `.opencode-security.json` from unauthorized modification

**Description:** As a security-conscious user, I want the security config file itself to be protected from write operations with maximum security by default.

**Acceptance Criteria:**

- [ ] Implicit rule protects `.opencode-security.json` with `deniedOperations: ["write"]` and `allowedRoles: []`
- [ ] Same rule applied to `.opencode-security-audit.log`
- [ ] User can override with explicit rules
- [ ] Write tool, Edit tool, and Bash tool all block modifications to these files
- [ ] `allowedRoles: []` means no role can modify — user must edit outside of OpenCode
- [ ] Typecheck passes

### US-014: Plugin feature query API for graceful degradation

**Description:** As a plugin developer, I want to query whether a feature has been internalized into OpenCode core so that my plugin can automatically skip registration of redundant tools and hooks.

**Acceptance Criteria:**

- [ ] `PluginInput` exposes `hasBuiltIn(feature: string): boolean` method
- [ ] Returns `true` for features that have been internalized (e.g. `"ast-grep"`, `"session-recovery"`)
- [ ] Returns `false` for unknown feature IDs
- [ ] Feature IDs are kebab-case, stable, and documented
- [ ] Plugin can conditionally skip tool/hook registration based on the query result
- [ ] Built-in feature registry is a static `Set<string>` in core — no external config, no runtime mutation
- [ ] Typecheck passes

### US-012: Comprehensive tests

**Description:** As a developer, I want comprehensive test coverage for both core features and plugin security.

**Acceptance Criteria:**

- [ ] Test: AST-grep search finds patterns correctly across multiple languages
- [ ] Test: AST-grep replace applies transformations in dry-run and live mode
- [ ] Test: LSP diagnostics, prepareRename, and rename operations work correctly
- [ ] Test: look_at tool handles image and PDF files
- [ ] Test: Context injection discovers and injects AGENTS.md from subdirectories
- [ ] Test: Todo continuation enforcer triggers when incomplete TODOs exist
- [ ] Test: Todo continuation enforcer respects max retry limit
- [ ] Test: Comment checker detects excessive comments in generated code
- [ ] Test: Session recovery detects and resumes interrupted sessions
- [ ] Test: Plugin tool that reads a protected file gets output redacted
- [ ] Test: Plugin tool with blocked file path in args gets access denied
- [ ] Test: `experimental.chat.messages.transform` hook receives redacted messages
- [ ] Test: Structural diff syncs added/removed messages, discards content modifications
- [ ] Test: MCP default policy is "enforced" when security config has rules
- [ ] Test: MCP default policy is "trusted" when no security config exists
- [ ] Test: Write to `.opencode-security.json` is blocked
- [ ] Test: Plugin audit command detects dangerous API patterns
- [ ] Test: `hasBuiltIn()` returns true for registered features and false for unknown
- [ ] Test: Plugin that checks `hasBuiltIn()` skips tool registration when feature is built-in
- [ ] All tests pass with `bun test`

### US-013: Plugin security audit command

**Description:** As a security-conscious user, I want a command that scans installed plugins for dangerous API usage patterns so that I can assess risk before installation.

**Acceptance Criteria:**

- [ ] Command: `opencode plugin audit <plugin-name>` statically analyzes plugin source code
- [ ] Detects dangerous APIs: `fs.readFileSync`, `fs.readFile`, `Bun.file()`, `Bun.write()`, `Bun.serve()`, `Bun.spawn()`, `child_process`, `net`, `http`, `https`
- [ ] Detects code injection patterns: `globalThis.constructor.constructor`, `Function('return this')`, `eval()`, `new Function()`
- [ ] Detects dynamic imports: `import()` with variable arguments, `require()` with variable arguments
- [ ] Detects hardcoded sensitive file paths (string literals containing `/etc/`, `~/.ssh/`, `.env`)
- [ ] Outputs risk summary with severity classification: **critical** = code injection patterns; **high** = sensitive file paths, dynamic imports; **medium** = direct API usage (fs, spawn, serve); **low** = informational patterns
- [ ] Exit code 0 if no critical findings, non-zero otherwise
- [ ] Can be run before installation (on a package name) or after (on installed plugin directory)
- [ ] Typecheck passes

## Functional Requirements

### Core Feature Integration (FR-1 through FR-7)

- **FR-1: AST-grep tools** — Add two built-in tools (`ast_grep_search`, `ast_grep_replace`) using `@ast-grep/napi` native bindings (Rust → NAPI → Bun, synchronous parsing, async file walking). Register in `ToolRegistry.all()` alongside existing built-in tools. Both tools must call `SecurityAccess.checkAccess()` on target paths before scanning, consistent with `GrepTool` and `GlobTool`. Results pass through `Truncate.output()` for large result handling. The tools follow `Tool.define()` pattern with Zod parameter schemas.

  **`ast_grep_search` implementation**:

  ```typescript
  import { Lang, findInFiles } from "@ast-grep/napi"
  // Use findInFiles() for multi-file search (async, parallel Rust file walking)
  // Config: { paths: string[], matcher: { rule: { pattern: userPattern } }, languageGlobs?: string[] }
  // Callback receives SgNode[] per file — extract: node.text(), node.range(), node.getRoot().filename()
  // Range: { start: { line, column, index }, end: { line, column, index } } (0-based)
  // For context lines: read file, extract lines around match range
  ```

  **`ast_grep_replace` implementation**:

  ```typescript
  import { parse, Lang } from "@ast-grep/napi"
  // For each target file: parse(lang, source).root().findAll(pattern)
  // For each match: node.replace(rewriteText) → Edit { startPos, endPos, insertedText }
  // Meta-variables: node.getMatch('VAR')?.text() to resolve $VAR in rewrite template
  // node.getTransformed('VAR') for transformed meta-variables
  // Apply: edits.sort((a,b) => b.startPos - a.startPos); root.commitEdits(edits) → new source
  // Dry-run (default): return edits without writing. Live: write new source via Bun.write()
  ```

  **Language mapping**: `@ast-grep/napi` exports `Lang` enum with 5 built-in languages (Html, JavaScript, Tsx, Css, TypeScript). The remaining 20 languages require `registerDynamicLanguage()` or using the string language name directly as `NapiLang` accepts `CustomLang = string & {}`. Verify Bun compatibility with the native binding at integration time.

- **FR-2: LSP tools promotion** — Two changes required:

  **Flag removal**: Remove **both** experimental LSP flags: (1) `OPENCODE_EXPERIMENTAL_LSP_TOOL` in `ToolRegistry.all()` (registry.ts line 118) — makes the LspTool always available; (2) `OPENCODE_EXPERIMENTAL_LSP_TY` in `lsp/index.ts` and `lsp/server.ts` — removes gating on LSP server type selection, making pyright/ty fully available without flag.

  **Tool operations**: Extend the existing `LspTool` discriminated union with three operations:
  - `diagnostics`: **Refactor** existing `LSP.diagnostics()` (lsp/index.ts:291) which currently returns all diagnostics for all files (`Record<string, Diagnostic[]>`) with no parameters. Add optional `filePath` parameter to filter to a single file, and optional `severity` filter (error, warning, information, hint, all). Preserve backward compatibility — calling without parameters still returns all diagnostics.
  - `prepareRename`: **New** — add `LSP.prepareRename(position)` method in `lsp/index.ts` using `connection.sendRequest("textDocument/prepareRename", ...)`. Returns rename range or error if rename is not valid at that position.
  - `rename`: **New** — add `LSP.rename(position, newName)` method in `lsp/index.ts` using `connection.sendRequest("textDocument/rename", ...)`. Returns workspace edit (list of file changes). The LspTool must apply the workspace edit (write changed files) and return a summary of changes.

- **FR-3: Multimodal analysis tool** — Add a `look_at` built-in tool. Accepts `file_path` (string), `goal` (string), optional `image_data` (base64 string). Reads the file via `Bun.file()`, constructs a multimodal prompt with the binary content and goal description, invokes the current model's completion API. File access must go through `SecurityAccess.checkAccess()`. **Model capability check**: OpenCode's model metadata already exposes `modalities.input: Array<"text" | "audio" | "image" | "video" | "pdf">` (see `provider/models.ts` line 59) and `capabilities.input.image: boolean` (see `provider/provider.ts` line 641). The tool must check these fields before attempting multimodal input — if the current model lacks `"image"` in `modalities.input`, return a clear error: `"Current model ({modelID}) does not support image input. Switch to a multimodal model."`

- **FR-4: Context injection enhancement** — OpenCode's existing `InstructionPrompt` system already supports hierarchical AGENTS.md injection via `findUp()`, `globUp()`, and directory-level `resolve()`. Enhancements: (1) Add README.md to the discovery list in `InstructionPrompt.resolve()` — when the agent reads a file in a subdirectory, also inject that directory's README.md if it exists and hasn't been claimed. (2) Add configuration option in `.opencode.json` to control README injection (`experimental.readme_injection: boolean`, default true). (3) Document existing AGENTS.md behavior comprehensively since it's poorly discoverable.

- **FR-5: Todo continuation enforcer** — Add a post-turn check in the session processing loop. After each agent turn completes (in `session/llm.ts` or `session/processor.ts`): read the session's TODO list via `Todo.get()`. If any items have status `pending` or `in_progress` and the agent's response contains no pending tool calls, increment a per-session continuation counter. If counter ≤ max (configurable, default 3), inject a continuation message. If counter > max, stop and let the session end normally. Skip when current agent is plan-mode. Store continuation count in session metadata.

- **FR-6: Comment checker** — Add a post-processing step to write-producing tools (edit, write, apply_patch). After the tool produces output containing code, analyze comment density using built-in heuristics (no external dependency). Detection rules:

  **Heuristic 1 — Comment density ratio**: Count comment lines vs code lines in the diff/output. Thresholds by sensitivity: `strict` > 0.15, `normal` > 0.3, `relaxed` > 0.5. A "comment line" is any line where the first non-whitespace content is a comment token (`//`, `#`, `/*`, `*`, `--`, `"""` etc.).

  **Heuristic 2 — Obvious comment patterns**: Regex match against known AI-slop patterns. The comment prefix is detected by file extension:

  | Extension                                                                          | Comment prefixes       |
  | ---------------------------------------------------------------------------------- | ---------------------- |
  | `.js`, `.ts`, `.tsx`, `.jsx`, `.go`, `.java`, `.c`, `.cpp`, `.rs`, `.swift`, `.kt` | `//`, `/*`             |
  | `.py`, `.rb`, `.sh`, `.yaml`, `.yml`                                               | `#`                    |
  | `.html`, `.xml`, `.svelte`, `.vue`                                                 | `<!--`                 |
  | `.css`, `.scss`, `.less`                                                           | `/*`                   |
  | `.sql`                                                                             | `--`                   |
  | `.lua`                                                                             | `--`                   |
  | Unknown                                                                            | Match all of the above |

  After stripping the comment prefix, match against patterns:
  - `(Initialize|Create|Set|Define|Declare) (the|a|an) \w+` — restating the code
  - `(Return|Log|Print|Output) (the|a) \w+` — describing obvious return/log
  - `(Loop|Iterate|Map|Filter) (through|over|the) \w+` — narrating iteration
  - `(Check|Verify|Validate|Ensure) (if|that|the) \w+` — restating conditionals
  - `(Import|Require|Include) \w+` — describing imports
  - `(Function|Method|Class) (to|that|for) \w+` — restating function purpose when function name is self-documenting

  Score: each match adds 1. Thresholds by sensitivity: `strict` ≥ 1, `normal` ≥ 3, `relaxed` ≥ 5.

  **Heuristic 3 — Comment-to-code duplication**: Detect comments that are near-identical to the code on the next line (Levenshtein distance < 30% of comment length after stripping comment tokens and normalizing whitespace).

  When any heuristic triggers, append to tool output: `"Note: The generated code contains excessive comments. Consider removing obvious comments."` Configuration in `.opencode.json`: `experimental.comment_checker: "strict" | "normal" | "relaxed" | false`.

- **FR-7: Session recovery** — Add crash detection to session lifecycle with dual-layer storage (project-local takes priority, global as fallback):

  **Storage locations** (checked in priority order):
  1. `{project}/.opencode/recovery/{sessionID}.json` — project-local, preferred. Automatically add `.opencode/recovery/` to project `.gitignore` if not already present.
  2. `~/.opencode/recovery/{sessionID}.json` — global fallback, used when project directory is not writable or for cross-project recovery.

  **Heartbeat format**: `{ sessionID, projectDir, todoState, timestamp, pid }`

  **Lifecycle**:
  1. On session creation and each message save, write heartbeat to **both** locations (project-local + global). Writes must be lightweight (~1ms) and non-blocking (`Bun.write()` without await in hot path, or debounced).
  2. On graceful session end (complete, archive, or process exit handler via `process.on("exit")`), delete heartbeat from both locations.
  3. On startup, scan for stale heartbeats: first check project-local, then global. A heartbeat is stale when its `pid` is no longer running (check via `process.kill(pid, 0)` in try/catch). Deduplicate by sessionID (project-local wins).
  4. If stale heartbeat found, prompt user to resume or dismiss.

### Plugin Tool Security (FR-8, FR-9)

- **FR-8**: `ToolRegistry.fromPlugin()` must wrap the plugin tool's `execute()` function with two-layer security. The `currentRole` is obtained by calling a shared `SecurityRole.getDefault(config)` utility — extracted from the 6 identical copies across tool files (read.ts, write.ts, bash.ts, grep.ts, glob.ts, edit.ts).
  - **Pre-execution**: Extract all string values recursively from the tool arguments object. For each string, call `path.resolve(directory, str)` to normalize it, then check `fs.existsSync(resolvedPath)` — if it exists, run `SecurityAccess.checkAccess(resolvedPath, "read", currentRole)`. Block execution if any path is denied. **Known limitation**: short common strings like `"src"`, `"lib"` may coincidentally resolve to existing directories, causing unnecessary `checkAccess()` calls. This is accepted — false positives result in extra checks (not false denials). Performance mitigated by short-circuiting when security config has no rules.
  - **Post-execution**: Scan the returned string (or JSON-serialized result for objects/arrays) via `LLMScanner.scanForProtectedContent()` → extract `{start, end}` byte offset pairs → `SecurityRedact.redactContent()`. Note: this only catches content matching markers/patterns — file-level protection relies on pre-execution path checking.

- **FR-9**: All blocked/redacted events from plugin tools must be logged via `SecurityAudit.logSecurityEvent()`. Extend `SecurityEvent` with optional fields: `source?: "plugin-tool" | "plugin-hook"`, `pluginName?: string`, `toolName?: string`. The existing `operation` type (`"read" | "write" | "llm"`) is not extended — plugin events map to existing operation types based on what was attempted.

### Hook Payload Security (FR-10, FR-11)

- **FR-10**: `Plugin.trigger("experimental.chat.system.transform")` must apply `scanAndRedact()` to system prompt strings before passing to plugin hooks. Skip scanning when security config has no rules and no segments.

- **FR-11**: `Plugin.trigger("experimental.chat.messages.transform")` must implement clone + structural diff. Cloning and diffing happen **once per trigger call**, not per plugin — all plugins in the hook chain sequentially mutate the same redacted clone. Skip entirely when security config has no rules and no segments.

  **Algorithm** (operates on the `output` parameter — messages are in the `output` object, not `input`):
  1. Deep-clone `output.messages` array
  2. Apply `scanAndRedact()` to all text content in the cloned messages
  3. Replace `output.messages` with the redacted clone before passing to `trigger()` — all registered plugin hooks mutate the clone sequentially
  4. After all hooks return, compute a structural diff between the original messages array and the final mutated clone:
     - **Message identity**: determined by `message.info.id`
     - **Added messages** (IDs not present in original, or messages without `info.id`): apply to original array
     - **Removed messages** (IDs present in original but not in clone): remove from original array
     - **Modified content on existing messages** (same ID, different content): **DISCARD**
     - **Reordered messages**: ignored — original order is preserved
     - **Duplicate IDs**: the original message takes precedence
  5. Return the original messages with only structural changes applied

### MCP and Config Protection (FR-12 through FR-15)

- **FR-12**: `SecurityConfig.getMcpPolicy()` must return `"enforced"` for unknown servers when `config.rules` is non-empty or `config.segments` is defined. When no `.opencode-security.json` exists at all, continue returning `"trusted"`.

- **FR-13**: Implicit rule `{ pattern: ".opencode-security.json", type: "file", deniedOperations: ["write"], allowedRoles: [] }` appended in **both** `loadSecurityConfig()` and `mergeSecurityConfigs()`. Only append if no explicit user-defined rule exists.

- **FR-14**: Same implicit rule for `.opencode-security-audit.log`

- **FR-15**: Plugin tools returning non-string results (objects, arrays) must have their JSON-serialized form scanned

### Plugin Feature Query API (FR-16)

- **FR-16**: Extend `PluginInput` with `hasBuiltIn(feature: string): boolean`. Implementation:

  **Core side** (`packages/opencode/src/plugin/builtin.ts` — NEW):

  ```typescript
  export namespace BuiltIn {
    // Static registry of internalized feature IDs.
    // Add entries here when a plugin feature is internalized into core.
    const features = new Set<string>([
      // Uncomment as features ship:
      // "ast-grep",
      // "lsp-rename",
      // "look-at",
      // "context-injection",
      // "todo-continuation",
      // "comment-checker",
      // "session-recovery",
    ])

    export function has(feature: string): boolean {
      return features.has(feature)
    }
  }
  ```

  **Plugin input wiring** (`packages/opencode/src/plugin/index.ts`):

  ```typescript
  import { BuiltIn } from "./builtin"
  // ...
  const input: PluginInput = {
    client,
    project: Instance.project,
    worktree: Instance.worktree,
    directory: Instance.directory,
    serverUrl: Server.url(),
    $: Bun.$,
    hasBuiltIn: BuiltIn.has,
  }
  ```

  **Plugin SDK type** (`packages/plugin/src/index.ts`):

  ```typescript
  export type PluginInput = {
    client: ReturnType<typeof createOpencodeClient>
    project: Project
    directory: string
    worktree: string
    serverUrl: URL
    $: BunShell
    hasBuiltIn: (feature: string) => boolean
  }
  ```

  **Feature ID convention**: kebab-case, stable once published, never renamed. Full mapping documented in `tasks/internalization-workflow.md`.

  **Plugin usage pattern**:

  ```typescript
  export default async function (input: PluginInput): Promise<Hooks> {
    const hooks: Hooks = {}
    if (!input.hasBuiltIn("ast-grep")) {
      hooks.tool = {
        ast_grep_search: {
          /* ... */
        },
        ast_grep_replace: {
          /* ... */
        },
      }
    }
    if (!input.hasBuiltIn("session-recovery")) {
      hooks.event = async ({ event }) => {
        /* heartbeat logic */
      }
    }
    return hooks
  }
  ```

  **Fallback for old plugins** that don't call `hasBuiltIn`: tool registration conflicts are handled by `ToolRegistry.register()` (line 87-95 in registry.ts) which replaces by ID — plugin version wins. Hook conflicts result in both firing — built-in first, plugin second. This is acceptable: no silent breakage, worst case slight redundancy.

## Non-Goals

- No subprocess sandboxing for plugins (deferred — see "Why Not Sandbox?" section)
- No per-plugin trust level configuration (future feature)
- No changes to built-in tool security checks (already correctly enforced)
- No sandboxing of config directory custom tools (`{tool,tools}/*.{js,ts}` — user-authored, not third-party). These run in-process via `import()` but go through `fromPlugin()`, so FR-8's security wrap applies.
- No changes to role detection behavior
- No plugin code signing or verification
- No restriction on `chat.headers`, `shell.env`, or `permission.ask` hooks — without subprocess isolation, in-process plugins can bypass any restriction via direct API access. Meaningful enforcement requires the sandbox phase.
- No Docker/container-based or WASM-based sandboxing

## Technical Considerations

### Core Feature Dependencies

| Feature           | External Dependency   | Notes                                                                                                                   |
| ----------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| AST-grep          | `@ast-grep/napi`      | Native Rust→NAPI binding; 5 built-in langs (JS/TS/TSX/HTML/CSS), 20+ via `registerDynamicLanguage()`; ~5MB per platform |
| LSP               | None (existing infra) | Uses existing `packages/opencode/src/lsp/`                                                                              |
| look_at           | None                  | Uses model's multimodal capabilities                                                                                    |
| Context injection | None                  | Extends existing `InstructionPrompt` system                                                                             |
| Todo continuation | None                  | Session processing hook                                                                                                 |
| Comment checker   | None                  | Built-in heuristics: comment density ratio, AI-slop pattern regex, comment-code duplication detection                   |
| Session recovery  | None                  | Dual-layer heartbeat: project `.opencode/recovery/` (priority) + global `~/.opencode/recovery/` (fallback)              |

### Integration Architecture

Core features integrate at the same level as existing built-in tools — they are NOT plugin tools and do NOT go through `fromPlugin()`. They are registered directly in `ToolRegistry.all()` and have native access to internal APIs.

```
ToolRegistry.all() returns:
  [
    ...existing built-in tools (bash, read, write, edit, grep, glob, ...),
    ...NEW core tools (ast_grep_search, ast_grep_replace, look_at),
    ...LspTool (upgraded, no longer behind flag),
    ...custom tools from config directories (via fromPlugin → FR-8 security),
    ...plugin tools (via fromPlugin → FR-8 security),
  ]
```

### Plugin Tool Security Flow

```
Plugin tool call flow (in-process defense-in-depth):

  LLM → tool call → ToolRegistry.fromPlugin()
    → extract all strings from args recursively
    → for each string: path.resolve() → fs.existsSync()
      → if path exists: SecurityAccess.checkAccess()
    → if any path denied: BLOCK, log audit event, return error
    → plugin.execute() (in-process, direct call)
    → scan output → LLMScanner.scanForProtectedContent()
    → SecurityRedact.redactContent()
    → SecurityAudit.logSecurityEvent()
    → result → LLM
```

**Known limitation**: This is defense-in-depth only. Plugins run in-process and can bypass `fromPlugin()` by accessing `Bun.file()`, `fs`, etc. directly. This is accepted until sandbox support is added.

### Hook Structural Diff Flow

```
Plugin.trigger("messages.transform"):
  (skip entirely when no security rules/segments)

  1. originalIDs = Set(originalMessages.map(m => m.info.id))
  2. clone = structuredClone(originalMessages)
  3. for each message in clone:
       message.content = scanAndRedact(content)
  4. pass clone to trigger() → all plugin hooks mutate clone sequentially
  5. structuralDiff(originalIDs, originalMessages, clone):
     - added = clone messages where info.id NOT in originalIDs → append to original
     - removed = originalIDs NOT in clone message IDs → remove from original
     - modified content on existing IDs → DISCARD
     - reordering → IGNORE (keep original order)
     - duplicate IDs → keep first only
  6. return originalMessages with structural changes applied
```

### Key Files to Modify

| File                                           | Change                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/opencode/src/tool/ast_grep.ts`       | **NEW** — AST-grep search and replace tools (FR-1)                                      |
| `packages/opencode/src/tool/look_at.ts`        | **NEW** — Multimodal analysis tool (FR-3)                                               |
| `packages/opencode/src/tool/lsp.ts`            | Add diagnostics, prepareRename, rename operations (FR-2)                                |
| `packages/opencode/src/tool/registry.ts`       | Register new built-in tools; wrap `fromPlugin()` with security (FR-1, FR-2, FR-3, FR-8) |
| `packages/opencode/src/session/instruction.ts` | Add README.md to discovery in `resolve()` (FR-4)                                        |
| `packages/opencode/src/session/llm.ts`         | Todo continuation enforcer hook (FR-5); system prompt scanAndRedact (FR-10)             |
| `packages/opencode/src/session/processor.ts`   | Todo continuation enforcer post-turn check (FR-5)                                       |
| `packages/opencode/src/session/recovery.ts`    | **NEW** — Session crash recovery with heartbeat (FR-7)                                  |
| `packages/opencode/src/tool/edit.ts`           | Comment checker post-processing (FR-6)                                                  |
| `packages/opencode/src/tool/write.ts`          | Comment checker post-processing (FR-6)                                                  |
| `packages/opencode/src/tool/apply_patch.ts`    | Comment checker post-processing (FR-6)                                                  |
| `packages/opencode/src/security/config.ts`     | MCP default policy (FR-12); implicit self-protection rules (FR-13, FR-14)               |
| `packages/opencode/src/security/util.ts`       | **NEW** — Shared `scanAndRedact()` + `SecurityRole.getDefault()` utilities              |
| `packages/opencode/src/plugin/index.ts`        | Hook payload redaction + structural diff (FR-10, FR-11)                                 |
| `packages/opencode/src/plugin/audit.ts`        | **NEW** — Plugin security audit command (US-013)                                        |
| `packages/opencode/src/session/prompt.ts`      | Task tool `scanAndRedact()` gap (US-009)                                                |
| `packages/opencode/src/flag/flag.ts`           | Remove `OPENCODE_EXPERIMENTAL_LSP_TOOL` flag (FR-2)                                     |
| `packages/opencode/src/plugin/builtin.ts`      | **NEW** — Built-in feature registry for `hasBuiltIn()` API (FR-16)                      |
| `packages/opencode/src/lsp/index.ts`           | Refactor diagnostics(), add rename(), prepareRename() (FR-2)                            |
| `packages/opencode/src/agent/agent.ts`         | Apply scanAndRedact() to system.transform hook (FR-10, second call site)                |
| `packages/plugin/src/index.ts`                 | Add `hasBuiltIn` to `PluginInput` type (FR-16)                                          |

Note: implementers should search for **all** call sites of `Plugin.trigger()` and verify each hook is covered by the appropriate security measure. Use `grep -r 'Plugin.trigger' packages/opencode/src/` to find them.

### Performance Considerations

- Core feature tools execute as direct function calls — zero plugin layer overhead
- AST-grep native binding: ~2-5ms initialization, sub-millisecond per search match
- LSP operations use existing language server connections — no additional startup cost
- Plugin tool output scanning adds one `LLMScanner` call per plugin tool invocation
- Message clone + structural diff runs once per `Plugin.trigger()` call — only when security config has rules
- Short-circuit: skip all security work when `config.rules` is empty and `config.segments` is undefined
- `fs.existsSync()` on each string arg adds I/O overhead — mitigated by only running when security config is present
- Todo continuation enforcer: ~1ms check per agent turn (read TODO state)
- Session recovery heartbeat: ~1ms write per message (non-blocking file I/O)

### Backward Compatibility

- All existing built-in tools unaffected
- Plugin tools gain security wrapping but behavior unchanged when not accessing protected files
- LSP tools become always-available (improvement, not breaking)
- MCP default policy change only triggers when `.opencode-security.json` exists with active rules
- Context injection augments existing instruction system — does not replace
- Todo continuation and comment checker are configurable (can be disabled)
- Session recovery is non-intrusive — only prompts on startup if stale heartbeat found

### Migration Impact: Community Plugin Analysis

Integration of 7 core features removes the most API-intensive capabilities from the plugin boundary:

| Category                                       | Count                                                                | Post-Integration Status                            |
| ---------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| Tools overlapping with built-in                | 2 (grep, glob)                                                       | Plugin version redundant — use built-in            |
| Tools now built-in (Track A)                   | 5 (ast-grep ×2, look_at, LSP ×3 ops)                                 | Removed from plugin — use built-in                 |
| Hooks now built-in (Track A)                   | 3 (todo continuation, comment checker, session recovery)             | Removed from plugin — use built-in                 |
| Remaining plugin-only features                 | ~14 tools + ~42 hooks (tmux, background agents, agent orchestration) | Continue as plugin, gain FR-8/FR-10/FR-11 security |
| Direct fs/spawn calls in remaining plugin code | ~300+                                                                | **Not mitigated** — deferred to sandbox phase      |

## Success Metrics

### Track A: Core Feature Integration

- AST-grep tools successfully search/replace across all 25 supported languages
- LSP tools available without experimental flag; diagnostics and rename work correctly
- look_at tool analyzes images and PDFs with accurate descriptions
- Context injection discovers and injects AGENTS.md + README.md from project hierarchy
- Todo continuation enforcer prevents premature agent stops (metric: % reduction in incomplete TODO sessions)
- Comment checker reduces excessive comments in generated code
- Session recovery successfully resumes interrupted sessions

### Track B: Plugin Security

- Plugin tool outputs scanned and redacted when containing protected content
- Plugin hooks receive redacted content; structural diff prevents data pollution
- MCP default policy is "enforced" when security config exists
- `.opencode-security.json` protected from modification
- `hasBuiltIn()` API correctly reports internalized features; plugins that query it skip redundant registration
- All 19 test scenarios from US-012 pass
- Zero regressions in existing plugin functionality

## Resolved Questions

1. **Why not sandbox?** — Analysis of the largest community plugin (660 fs calls, 30 spawn calls, Bun.serve()) showed sandboxing is impractical without Bun-level permission model. Core features should be built-in; remaining plugins get in-process security enforcement. Sandbox deferred.

2. **`scanAndRedact()` utility** — Create shared utility chaining `LLMScanner.scanForProtectedContent()` → extract offsets → `SecurityRedact.redactContent()`, eliminating 6+ duplicated patterns across `llm.ts` and `prompt.ts`.

3. **`getDefaultRole()` extraction** — Extract from 6 duplicated copies in tool files into `SecurityRole.getDefault(config)` shared utility in `security/util.ts`.

4. **`experimental.session.compacting` hook** — Out of scope. Plugin using `client.session.messages()` is mitigated by response-level scanning in the plugin security layer.

5. **Internal plugin trust** — Internal plugins (codex, copilot) are hardcoded as trusted, run in-process without security wrapping. Configurable trust is a future feature.

6. **MCP policy logic** — When no `mcp` block exists but `config.rules` is non-empty or `config.segments` defined, return "enforced" for unknown servers.

7. **Context injection existing coverage** — OpenCode's `InstructionPrompt` already handles hierarchical AGENTS.md injection via `findUp()`, `globUp()`, and per-file `resolve()`. FR-4 only adds README.md discovery and documentation, not a redesign.

8. **`permission.ask` hook restriction** — Deferred. Without subprocess isolation, in-process enforcement is not meaningful — plugins can bypass via direct API access.

9. **AST-grep dependency** — Use `@ast-grep/napi` native Rust→NAPI binding. Provides synchronous single-file parsing (`parse()`), async parallel multi-file search (`findInFiles()`), and edit/replace via `SgNode.replace()` → `commitEdits()`. 5 built-in languages (JS/TS/TSX/HTML/CSS), additional languages via `registerDynamicLanguage()`. No CLI fallback needed.

10. **Comment checker implementation** — Use built-in heuristics (no external dependency): comment density ratio, AI-slop pattern regex matching, and comment-code duplication detection via Levenshtein distance. Three sensitivity levels (strict/normal/relaxed) configurable in `.opencode.json`.

11. **Session recovery storage** — Dual-layer: project-local `{project}/.opencode/recovery/` takes priority (auto-add to `.gitignore`), global `~/.opencode/recovery/` as fallback. Heartbeats written to both; on startup, project-local checked first, deduplicated by sessionID.

12. **look_at model compatibility** — Already solved. OpenCode's `provider/models.ts` defines `modalities.input: Array<"text" | "audio" | "image" | "video" | "pdf">` and `provider/provider.ts` maps this to `capabilities.input.image: boolean`. The tool checks these fields and returns a clear error if the current model lacks multimodal support.

13. **Plugin graceful degradation mechanism** — Use feature flag query API (`hasBuiltIn`), not version comparison. Plugins call `input.hasBuiltIn("ast-grep")` to decide whether to register tools/hooks. Core maintains a static `Set<string>` of internalized feature IDs in `packages/opencode/src/plugin/builtin.ts`. Feature IDs are kebab-case, stable once published. Old plugins that don't check `hasBuiltIn` still work: tool conflicts resolved by last-write-wins in registry, hook conflicts result in harmless duplication. Full workflow documented in `tasks/internalization-workflow.md`.

## Open Questions

None — all questions have been resolved.
