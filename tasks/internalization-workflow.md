# Upstream Feature Internalization Workflow

How community plugin features get evaluated, internalized into OpenCode core, and how plugins gracefully degrade when their features become built-in.

## Overview

```
┌─────────────────┐     ┌──────────┐     ┌────────────┐     ┌──────────┐     ┌──────────┐
│ Upstream Release │────▶│ Evaluate │────▶│ PRD + Plan │────▶│ Implement│────▶│ Release  │
│   (oh-my-oc)    │     │ (Triage) │     │            │     │ + Test   │     │ + Notify │
└─────────────────┘     └──────────┘     └────────────┘     └──────────┘     └──────────┘
                              │                                                     │
                              │ reject                                              │
                              ▼                                                     ▼
                        stays plugin                                    plugin auto-skips
```

## Phase 1: Upstream Monitoring

### What to Watch

| Source                          | Method                                      | Frequency     |
| ------------------------------- | ------------------------------------------- | ------------- |
| oh-my-opencode releases         | GitHub Watch → Releases only                | Per release   |
| oh-my-opencode changelog / diff | `git diff <last-evaluated-tag>...<new-tag>` | Per release   |
| Community requests              | GitHub Issues / Discord mentions            | Weekly glance |

### Trigger

A new oh-my-opencode release (or any community plugin with significant adoption) publishes features that touch OpenCode's core domain: tool execution, session management, LLM interaction, or security-sensitive operations.

## Phase 2: Triage

Each new upstream feature is evaluated against these criteria. A feature must score **≥4 YES** to be considered for internalization.

| #   | Criterion              | Internalize (YES)                                                 | Keep as Plugin (NO)                              |
| --- | ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| 1   | **Security surface**   | Requires fs/net/process/shell access                              | Pure UI/display, no privileged ops               |
| 2   | **User demand**        | ≥30% of plugin users enable it (or widespread community requests) | Niche use case                                   |
| 3   | **Stability**          | ≥2 releases without breaking changes to that feature              | Still experimental / API unstable                |
| 4   | **Performance**        | Would benefit from native integration (eliminates hook overhead)  | No measurable perf difference                    |
| 5   | **Duplication**        | Reimplements or wraps an existing core API                        | Adds genuinely new capability orthogonal to core |
| 6   | **Maintenance burden** | Low — <500 LOC, clear module boundary                             | High — cross-cutting, complex external deps      |

### Triage Output

For each evaluated feature, record:

```markdown
### Feature: [name]

- Source: [plugin name]@[version]
- Score: [N/6]
- Decision: INTERNALIZE | DEFER | REJECT
- Reason: [1-2 sentences]
- If INTERNALIZE: target OpenCode version, estimated effort
```

Keep a running log in `tasks/internalization-log.md`.

## Phase 3: Implementation

### 3a. PRD Entry

For each internalized feature:

1. Add a new `US-XXX` (User Story) and `FR-XXX` (Functional Requirement) to the existing PRD, or create a dedicated PRD if scope warrants it
2. Identify source files in the upstream plugin
3. Map to target locations in OpenCode following namespace conventions
4. Specify the `hasBuiltIn` feature ID (see Phase 5)

### 3b. Code Integration

Follow OpenCode conventions from `AGENTS.md`:

- **Namespace pattern**: `Tool.define()`, `Session.create()`, etc.
- **Error handling**: Result patterns, no throwing in tools
- **Logging**: `Log.create({ service: "name" })`
- **Validation**: Zod schemas for inputs
- **Imports**: Relative for local, named preferred

### 3c. Testing

- Unit tests for the new module
- Integration test verifying the feature works end-to-end
- **Conflict test**: verify that if the upstream plugin is still installed, both don't fire (the `hasBuiltIn` mechanism kicks in)

### 3d. Update Feature Registry

Add the feature ID to the built-in feature registry (see Phase 5 implementation).

## Phase 4: Release + Notify

### OpenCode Side

1. Include the internalized feature in the release changelog
2. Document: "Feature X is now built-in since vN.M.P. Plugins providing this feature will automatically skip registration."

### Upstream Coordination (Best Effort)

Notify the upstream plugin maintainer:

```
OpenCode vN.M.P now includes [feature] as a built-in.
Plugins can detect this via `input.hasBuiltIn("[feature-id]")` and skip registration.
See: https://opencode.ai/docs/plugin-builtin-detection
```

This is **best effort** — OpenCode doesn't control upstream release cycles. The `hasBuiltIn` mechanism ensures correctness regardless of whether upstream updates.

## Phase 5: Plugin Graceful Degradation (`hasBuiltIn` API)

### Design

Extend `PluginInput` with a feature query function:

```typescript
// packages/plugin/src/index.ts
export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>
  project: Project
  directory: string
  worktree: string
  serverUrl: URL
  $: BunShell
  hasBuiltIn: (feature: string) => boolean // NEW
}
```

### Core Implementation

```typescript
// packages/opencode/src/plugin/builtin.ts
export namespace BuiltIn {
  // Registry of internalized features, keyed by stable feature ID.
  // Add entries here when a plugin feature is internalized.
  const features = new Set<string>([
    // Track A (from prd-plugin-security-enforcement.md)
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

Wired into `PluginInput` construction in `packages/opencode/src/plugin/index.ts`:

```typescript
const input: PluginInput = {
  client,
  project: Instance.project,
  worktree: Instance.worktree,
  directory: Instance.directory,
  serverUrl: Server.url(),
  $: Bun.$,
  hasBuiltIn: BuiltIn.has, // NEW
}
```

### Upstream Plugin Usage

```typescript
// In oh-my-opencode or any community plugin
export default async function (input: PluginInput): Promise<Hooks> {
  const hooks: Hooks = {}

  // Only register AST-grep tools if not built into core
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

  // Only register session recovery if not built into core
  if (!input.hasBuiltIn("session-recovery")) {
    hooks.event = async ({ event }) => {
      // heartbeat logic
    }
  }

  return hooks
}
```

### Feature ID Convention

Feature IDs are **kebab-case**, stable, and never renamed once published:

| Feature ID          | Description                             | Internalized In |
| ------------------- | --------------------------------------- | --------------- |
| `ast-grep`          | AST-aware search and replace tools      | (planned)       |
| `lsp-rename`        | LSP rename and prepare-rename tools     | (planned)       |
| `look-at`           | Multimodal file analysis tool           | (planned)       |
| `context-injection` | README.md / AGENTS.md context discovery | (planned)       |
| `todo-continuation` | Post-turn todo completion enforcer      | (planned)       |
| `comment-checker`   | AI slop / placeholder comment detection | (planned)       |
| `session-recovery`  | Crash recovery via heartbeat + journal  | (planned)       |

### Fallback Behavior

If a plugin does **not** check `hasBuiltIn` (old plugins, or plugins that ignore it):

- **Tool conflict**: `ToolRegistry.register()` replaces existing tools by ID (line 89-94 in registry.ts). If plugin registers a tool with the same ID as a built-in, the plugin version overwrites it. This is acceptable — user explicitly installed the plugin, they want its behavior.
- **Hook conflict**: Both fire. Built-in runs first (it's in core), plugin hook runs after. For additive hooks (context injection, event logging) this is harmless duplication. For mutative hooks (system.transform), last-write-wins — plugin overrides core. Again, acceptable for explicit installs.

No silent breakage. Worst case: slight redundancy.

## Phase 6: Ongoing Maintenance

### When Upstream Adds a New Feature

```
1. Triage (Phase 2)
   ├── Score ≥4 → Phase 3 (implement)
   └── Score <4 → Log decision, revisit next quarter
```

### When Upstream Modifies an Internalized Feature

The upstream may continue to evolve a feature that's already been internalized. Evaluate:

| Situation                                  | Action                                              |
| ------------------------------------------ | --------------------------------------------------- |
| Bug fix in upstream's version              | Check if same bug exists in core version, fix if so |
| New capability added to upstream's version | Triage the delta as a new feature                   |
| Breaking change in upstream's API          | No action — core version is independent             |
| Upstream removes the feature               | No action — core version is independent             |

### Deprecation Timeline

Once a feature is internalized:

| Timeline     | State                                                                 |
| ------------ | --------------------------------------------------------------------- |
| v0 (release) | Feature built-in. `hasBuiltIn` returns true. Plugins can query.       |
| v0 + 2 minor | If plugin still registers conflicting tools, log a warning            |
| v0 + 4 minor | No further action. Plugin ecosystem self-corrects or users don't care |

No forced removal. The `hasBuiltIn` mechanism is purely opt-in for plugins.
