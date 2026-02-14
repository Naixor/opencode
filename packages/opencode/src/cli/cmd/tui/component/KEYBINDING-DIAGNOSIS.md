# Keybinding Diagnosis: Shift+Enter and Newline in TUI

## Investigation Date: 2026-02-14

## Summary

OpenCode enables Kitty keyboard protocol (flags: disambiguate + alternateKeys) via `useKittyKeyboard: {}` in `app.tsx:171`. This means the behavior of modifier keys depends on whether the user's terminal supports the Kitty keyboard protocol.

## ParsedKey Fields for Key Combinations

### Terminals WITH Kitty Keyboard Protocol Support
(Kitty, WezTerm, Ghostty, iTerm2 with CSI u mode enabled)

| Key Press | ParsedKey.name | .ctrl | .shift | .meta | .super | .source |
|-----------|---------------|-------|--------|-------|--------|---------|
| Enter | `"return"` | false | false | false | false | `"kitty"` |
| Shift+Enter | `"return"` | false | **true** | false | false | `"kitty"` |
| Ctrl+Enter | `"return"` | **true** | false | false | false | `"kitty"` |
| Cmd+Enter | `"return"` | false | false | false | **true** | `"kitty"` |
| Alt+Enter | `"return"` | false | false | **true** | false | `"kitty"` |
| Ctrl+J | `"j"` | **true** | false | false | false | `"kitty"` |

Kitty protocol sends enhanced escape sequences (e.g., `\x1b[13;2u` for Shift+Enter) that carry modifier information.

### Terminals WITHOUT Kitty Keyboard Protocol Support
(macOS Terminal.app, older terminal emulators, SSH sessions through non-Kitty terminals)

| Key Press | ParsedKey.name | .ctrl | .shift | .meta | .super | .source |
|-----------|---------------|-------|--------|-------|--------|---------|
| Enter | `"return"` | false | false | false | false | `"raw"` |
| Shift+Enter | `"return"` | false | false | false | false | `"raw"` |
| Ctrl+Enter | `"return"` | false | false | false | false | `"raw"` |
| Cmd+Enter | N/A (intercepted by terminal/OS) | - | - | - | - | - |
| Alt+Enter | `"return"` | false | false | **true** | false | `"raw"` |
| Ctrl+J | `"linefeed"` | false | false | false | false | `"raw"` |

**Critical finding**: In standard terminals, `\r` (0x0D) is sent for both Enter AND Shift+Enter - the terminal does not distinguish them. The Shift modifier is consumed by the terminal emulator.

## Key Findings

### 1. Shift+Enter Behavior
- **Kitty terminals**: Shift+Enter is distinguishable from Enter. The Kitty protocol sends `\x1b[13;2u` which OpenTUI parses to `{ name: "return", shift: true }`.
- **Standard terminals**: Shift+Enter sends the same `\r` (0x0D) byte as plain Enter. They are **indistinguishable** at the application level. The `shift` field will always be `false`.

### 2. Ctrl+J Behavior (Important Bug Found!)
- **Kitty terminals**: Ctrl+J sends a Kitty sequence parsed to `{ name: "j", ctrl: true }`. This **correctly matches** the config binding `ctrl+j` → `{ name: "j", ctrl: true }`.
- **Standard terminals**: Ctrl+J sends `\n` (0x0A, ASCII linefeed). OpenTUI's standard parser maps this to `{ name: "linefeed" }` (NOT `{ name: "j", ctrl: true }`). This means the config binding `ctrl+j` does **NOT match** in standard terminals because `"linefeed"` !== `"j"`.

### 3. Ctrl+Enter and Alt+Enter
- **Kitty terminals**: Both work correctly and produce distinct ParsedKey values.
- **Standard terminals**: Ctrl+Enter typically sends `\r` (indistinguishable from Enter). Alt+Enter sends `\x1b\r` which OpenTUI parses to `{ name: "return", meta: true }` - this works!

### 4. Cmd+Enter (macOS)
- Cmd+Enter is typically intercepted by the terminal emulator itself (e.g., to toggle fullscreen) and never reaches the application. This is true for both Kitty and standard terminals.

## OpenTUI Keybinding Matching

OpenTUI uses `getKeyBindingKey()` to build a lookup key: `"${name}:${ctrl}:${shift}:${meta}:${super}"`.

For the current config `input_newline: "shift+return,ctrl+return,alt+return,ctrl+j"`, these keybindings are generated:
- `{ name: "return", shift: true }` → key: `"return:0:1:0:0"` (matches Shift+Enter in Kitty only)
- `{ name: "return", ctrl: true }` → key: `"return:1:0:0:0"` (matches Ctrl+Enter in Kitty only)
- `{ name: "return", meta: true }` → key: `"return:0:0:1:0"` (matches Alt+Enter in both!)
- `{ name: "j", ctrl: true }` → key: `"j:1:0:0:0"` (matches Ctrl+J in Kitty only)

Plus the hardcoded fallback: `{ name: "return", meta: true }` → `"return:0:0:1:0"` (matches Alt+Enter)

## Conclusions

1. **Shift+Enter newline works in Kitty-protocol terminals** - The config and keybinding pipeline are correct. The limitation is purely at the terminal emulator level.

2. **Ctrl+J does NOT work in standard terminals** - This is a gap. In standard terminals, Ctrl+J produces `ParsedKey { name: "linefeed" }` but the config binding `ctrl+j` maps to `KeyBinding { name: "j", ctrl: true }`. OpenTUI's `buildKeyBindingsMap` would need a key alias mapping `linefeed` → `j` with ctrl to bridge this, or the config needs to also bind `linefeed` as a newline trigger.

3. **Alt+Enter is the most reliable newline shortcut** in standard terminals (works via `\x1b\r` → `{ name: "return", meta: true }`). It also has a hardcoded fallback in `useTextareaKeybindings()`.

4. **For terminals that support neither Kitty protocol nor Alt+Enter**, there is currently no working newline shortcut.

## Shift+Enter Newline Status (US-003)

**Shift+Enter newline WORKS in terminals that support the Kitty keyboard protocol** (Kitty, WezTerm, Ghostty, iTerm2 with CSI u). The existing config default `input_newline: "shift+return,ctrl+return,alt+return,ctrl+j"` correctly generates the keybinding `{ name: "return", shift: true, action: "newline" }` which matches the Kitty-protocol Shift+Enter event.

**Shift+Enter newline DOES NOT WORK in standard terminals** (macOS Terminal.app, etc.) because these terminals send the same byte (`\r`) for both Enter and Shift+Enter. This is a fundamental terminal emulator limitation that cannot be fixed at the application level.

**No code changes are required** for Shift+Enter support. The existing keybinding configuration and mapping pipeline handle it correctly for terminals that can distinguish the keys.

### Verification Details (US-003)

The full end-to-end flow has been verified:

1. **Config default**: `input_newline: "shift+return,ctrl+return,alt+return,ctrl+j"` (config.ts:782-785)
2. **Parsing**: `Keybind.parse("shift+return")` → `{ name: "return", shift: true, ctrl: false, meta: false, leader: false }` (keybind.ts)
3. **Mapping**: `mapTextareaKeybindings()` converts to `{ name: "return", shift: true, action: "newline" }` (textarea-keybindings.ts)
4. **OpenTUI matching**: Key `"return:0:1:0:0"` matches Kitty-protocol Shift+Enter event `{ name: "return", shift: true }`
5. **Textarea behavior**: OpenTUI textarea handles the `"newline"` action natively — inserts `\n` at cursor, expands height (up to `maxHeight={6}`), and moves cursor to new line
6. **Submit preserved**: Hardcoded `{ name: "return", action: "submit" }` maps to `"return:0:0:0:0"` — exact match means plain Enter (no modifiers) always submits

**Terminal compatibility summary:**
- Kitty, WezTerm, Ghostty, iTerm2 (CSI u): Shift+Enter works for newline
- Standard terminals (Terminal.app, etc.): Shift+Enter = Enter (terminal limitation), use Alt+Enter or Ctrl+J instead

## Recommendations

1. **Add `linefeed` as a keybinding alias or additional newline binding** to fix Ctrl+J in standard terminals. Either:
   - Add a key alias in OpenTUI: `{ linefeed: "j" }` (with implied ctrl) - requires OpenTUI change
   - OR add `linefeed` (without modifiers) as an additional newline keybinding in the config defaults or as a hardcoded fallback

2. **Document the terminal compatibility** clearly for users, explaining which terminals support which shortcuts.

3. **Consider adding a hardcoded `linefeed` → `newline` mapping** in `useTextareaKeybindings()` as a fallback, similar to the existing `{ name: "return", meta: true, action: "newline" }` fallback.
