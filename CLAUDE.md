# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

OpenCode is an open-source AI coding agent with a terminal UI focus. Built with Bun, TypeScript, and SolidJS. Provider-agnostic (supports Claude, OpenAI, Google, local models). Client/server architecture allows remote operation.

## Development Commands

```bash
# Install dependencies
bun install

# Development (TUI)
bun dev                    # Run TUI in packages/opencode directory
bun dev <directory>        # Run TUI against specific directory
bun dev .                  # Run TUI in repo root

# Development (server/web)
bun dev serve              # Headless API server on port 4096
bun dev serve --port 8080  # Custom port
bun dev web                # Server + web interface

# Build standalone executable
./packages/opencode/script/build.ts --single

# Type checking
bun turbo typecheck

# Tests (run per-package, not from root)
bun test --cwd packages/opencode

# Desktop app (requires Tauri/Rust)
bun run --cwd packages/desktop tauri dev

# Regenerate SDK after API changes
./script/generate.ts
```

## Architecture

### Monorepo Structure

- `packages/opencode/` - Core CLI application & server (main codebase)
- `packages/app/` - SolidJS web UI components (shared)
- `packages/desktop/` - Tauri desktop app wrapper
- `packages/sdk/js/` - TypeScript client/server SDK
- `packages/plugin/` - SDK for external plugins (`@opencode-ai/plugin`)
- `packages/ui/` - Reusable UI component library
- `packages/web/` - Astro public website

### Core Application (`packages/opencode/src/`)

| Directory        | Purpose                                            |
| ---------------- | -------------------------------------------------- |
| `cli/cmd/`       | CLI commands (run, auth, models, serve, mcp, etc.) |
| `cli/cmd/tui/`   | Terminal UI (SolidJS + OpenTUI)                    |
| `server/`        | Hono REST API server                               |
| `server/routes/` | API routes (tui, project, session, pty, mcp, etc.) |
| `agent/`         | AI agent logic                                     |
| `agent/prompt/`  | LLM system prompts                                 |
| `provider/`      | LLM provider integrations                          |
| `skill/`         | Skills (tools) available to agents                 |
| `tool/`          | Tool implementations (file editing, execution)     |
| `bus/`           | Event bus for inter-component communication        |

### Key Technologies

- **Runtime:** Bun
- **Server:** Hono (with OpenAPI, WebSocket, SSE)
- **UI:** SolidJS + OpenTUI (terminal), Tauri (desktop)
- **LLM:** Vercel AI SDK with 16+ provider packages
- **Validation:** Zod
- **Build:** Turbo (monorepo tasks)

### Built-in Agents

- **build** - Default agent with full access
- **plan** - Read-only agent, denies edits, asks permission for bash

## Code Style

From AGENTS.md - these are enforced preferences:

- **No `try`/`catch`** - Use `.catch()` instead
- **No `any` types** - Use precise types
- **No `else` statements** - Use early returns
- **No unnecessary destructuring** - Use dot notation (`obj.a` not `const { a } = obj`)
- **Prefer `const`** - No `let`, use ternaries or early returns
- **Single-word names** - For variables and functions when possible
- **Inline single-use values** - Don't create intermediate variables
- **Functional array methods** - `flatMap`, `filter`, `map` over `for` loops
- **Use Bun APIs** - Like `Bun.file()` when applicable
- **Type inference** - Avoid explicit annotations unless needed for exports
- **Snake_case for DB schemas** - In Drizzle table definitions

## Testing

- Avoid mocks - test actual implementations
- Don't duplicate logic into tests
- Run tests per-package: `bun test --cwd packages/opencode`
- E2E tests: `bun run --cwd packages/app test:e2e`

## Important Notes

- **Default branch:** `master` (not dev, dev is origin opencode source)
- **Always use parallel tools** when applicable
- **Regenerate SDK** after API changes: `./script/generate.ts`
- **PR titles:** Follow conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`)
- **Prettier config:** No semicolons, 120 char width
