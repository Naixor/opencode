# PRD: ULW Mode Trigger Optimization

## Introduction

ULW (Ultra Lightweight Work / ultrawork) mode sets `variant = "max"`, which increases Claude's thinking budget to 32K tokens and effort level to "high". Currently, ULW is triggered by keyword detection — scanning the last user message for substrings like `ulw` or `[ultrawork]`. This causes false positives when users mention "ulw" in unrelated contexts. This PRD replaces the loose keyword trigger with explicit, intentional activation mechanisms.

## Goals

- Eliminate false-positive ULW activation from casual keyword matches
- Provide `/ulw` slash command in the TUI for one-tap activation
- Support inline `/ulw` prefix in prompt input (e.g., `/ulw fix the bug`)
- Keep CLI activation via `--variant max` (already exists, no changes needed)
- Maintain backward compatibility: the keyword trigger stays but requires stricter format

## User Stories

### US-001: Stricter keyword detection
**Description:** As a user, I want the keyword trigger to require `/ulw` at the start of my message instead of matching `ulw` anywhere, so that I don't accidentally activate ULW mode.

**Acceptance Criteria:**
- [ ] Keyword detector no longer matches `ulw` as a substring (e.g., "check ulw config" does NOT trigger)
- [ ] `[ultrawork]` keyword is removed from the keyword map
- [ ] `/ulw` at the **start** of the message (after optional whitespace) triggers `variant = "max"`
- [ ] `/ulw` in the middle of a message does NOT trigger
- [ ] Existing `[analyze-mode]` and `[review-mode]` keywords are unaffected
- [ ] Tests updated for new behavior
- [ ] Typecheck passes

### US-002: `/ulw` slash command in TUI
**Description:** As a TUI user, I want a `/ulw` slash command so that I can explicitly activate ULW mode for my next message.

**Acceptance Criteria:**
- [ ] `/ulw` appears in the slash command autocomplete list with description "activate ULW (max variant) for next message"
- [ ] Selecting `/ulw` sets the variant to `max` for the next prompt only
- [ ] After the next prompt is sent, variant reverts to whatever it was before (or `undefined`)
- [ ] `/ulw` is visible in the command palette (not hidden)
- [ ] If variant is already `max`, `/ulw` toggles it off (sets to `undefined`)
- [ ] Status bar shows the active variant indicator when ULW is active
- [ ] Typecheck passes

### US-003: Inline `/ulw` prefix in prompt input
**Description:** As a user, I want to type `/ulw fix the bug` in the prompt input and have ULW activate for that message, with `/ulw` stripped from the sent text.

**Acceptance Criteria:**
- [ ] When user types `/ulw some message` and submits, the message sent to the server is `some message` (prefix stripped)
- [ ] The variant for that specific message is set to `max`
- [ ] The variant does NOT persist to subsequent messages
- [ ] `/ulw` alone (without following text) behaves like the slash command (US-002: sets variant for next message)
- [ ] Works in both TUI prompt and CLI `opencode run "/ulw fix the bug"`
- [ ] Typecheck passes

### US-004: Revert variant after one-shot activation
**Description:** As a user, I want ULW to automatically deactivate after my next message when activated via `/ulw`, so I don't accidentally leave it on.

**Acceptance Criteria:**
- [ ] When variant is set via `/ulw` (slash command or inline prefix), it applies to the immediately next prompt only
- [ ] After that prompt completes, variant returns to its previous value
- [ ] If variant was set via `variant_cycle` keybind or `--variant` CLI flag, it persists normally (not one-shot)
- [ ] The one-shot behavior is distinguishable from persistent variant selection
- [ ] Typecheck passes

## Functional Requirements

### Stripping layer: two-layer approach (prompt submission + hook fallback)

- FR-1: **Prompt submission layer (TUI)** — In `prompt/index.tsx`, before sending the message, detect `/ulw` prefix, strip it from text, and set variant to `max`
- FR-2: **Prompt submission layer (CLI)** — In `run.ts`, before calling `sdk.session.prompt()`, detect `/ulw` prefix, strip it from message, and pass `variant: "max"`
- FR-3: **Hook fallback layer** — In `keyword-detector` hook, match `/ulw` at the start of the last user message (regex: `/^\s*\/ulw\b/i`), set `ctx.variant = "max"`, and strip `/ulw` prefix from `ctx.messages` (covers SDK direct calls and other entry points)
- FR-4: Remove `[ultrawork]` and bare `ulw` from the keyword map. Only `/ulw` prefix triggers ULW mode.

### One-shot state: local context extension

- FR-5: Extend `local.model.variant` in `local.tsx` with `setOneShot(value)` and `revertOneShot()` methods, plus an internal `_previousVariant` tracking field
- FR-6: `setOneShot("max")` saves the current variant, then calls `set("max")`
- FR-7: `revertOneShot()` restores the saved previous variant (called after prompt is sent)
- FR-8: Persistent variant via `variant_cycle` keybind uses `set()` directly, not affected by one-shot logic

### Slash command

- FR-9: Add `/ulw` slash command via `command.register()` with description "activate ULW (max variant) for next message"
- FR-10: `/ulw` slash command calls `local.model.variant.setOneShot("max")`. If variant is already `max`, it calls `set(undefined)` to toggle off.
- FR-11: `/ulw` is visible in autocomplete and command palette (not hidden)

## Non-Goals

- No changes to the `variant_cycle` keybind behavior
- No changes to `--variant` CLI flag (already works)
- No config-level default variant for agents (separate feature)
- No changes to how `[analyze-mode]` or `[review-mode]` keywords work
- No visual ULW indicator beyond the existing variant display in the status bar

## Technical Considerations

### Two-layer stripping strategy
- **Layer 1 — Prompt submission (TUI + CLI)**: The primary stripping point. In TUI (`prompt/index.tsx`), detect and strip `/ulw` prefix before calling `sdk.session.prompt()`, simultaneously setting variant. In CLI (`run.ts`), same logic before the prompt call. This ensures the user never sees `/ulw` echoed back as message text.
- **Layer 2 — Hook fallback**: The `keyword-detector` hook in `detection-checking.ts` acts as a safety net for cases where messages arrive via SDK direct calls or other entry points that bypass the TUI/CLI layer. The hook matches `/ulw` at the start of the last user message, sets `ctx.variant`, and strips the prefix from `ctx.messages`.

### One-shot state in local context
- Extend `local.model.variant` object in `local.tsx` with:
  - `_previous: string | undefined` — internal field tracking the variant before one-shot
  - `_isOneShot: boolean` — flag indicating current variant was set via one-shot
  - `setOneShot(value: string)` — saves current variant to `_previous`, calls `set(value)`, sets `_isOneShot = true`
  - `revertOneShot()` — if `_isOneShot`, calls `set(_previous)`, resets flag
- The prompt submission path in `prompt/index.tsx` calls `revertOneShot()` after `sdk.session.prompt()` is invoked
- `variant_cycle` and manual `set()` clear the one-shot flag, so they remain persistent

### Key files to modify
1. `src/cli/cmd/tui/context/local.tsx` — one-shot variant API
2. `src/session/hooks/detection-checking.ts` — stricter matching + message stripping
3. `src/cli/cmd/tui/component/prompt/index.tsx` — inline prefix detection + one-shot revert
4. `src/cli/cmd/tui/routes/session/index.tsx` or `app.tsx` — `/ulw` slash command registration
5. `src/cli/cmd/run.ts` — inline `/ulw` prefix in CLI mode
6. `test/session/hooks/detection-checking.test.ts` — updated tests

## Success Metrics

- Zero false-positive ULW activations from normal messages containing "ulw"
- `/ulw` command discoverable via autocomplete in TUI
- ULW activation requires at most 2 keystrokes (`/ulw` + enter, or `/ulw` prefix in prompt)

## Open Questions

- Should `/ulw` also work for other variants? e.g., `/analyze` as a shortcut for `variant = "analyze"`. If so, this could be generalized to `/variant <name>` or per-variant slash commands. (Out of scope for this PRD but worth considering for future.)
- Should the one-shot revert happen immediately after the message is sent, or after the assistant response completes? (Recommend: after send, since the variant is captured at send time.)
