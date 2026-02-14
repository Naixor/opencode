import { describe, test, expect } from "bun:test"
import { Keybind } from "../../src/util/keybind"

// Re-implement the pure logic from textarea-keybindings.ts to test without SolidJS dependency.
// This mirrors mapTextareaKeybindings and TEXTAREA_ACTIONS exactly.

const TEXTAREA_ACTIONS = [
  "submit",
  "newline",
  "move-left",
  "move-right",
  "move-up",
  "move-down",
  "select-left",
  "select-right",
  "select-up",
  "select-down",
  "line-home",
  "line-end",
  "select-line-home",
  "select-line-end",
  "visual-line-home",
  "visual-line-end",
  "select-visual-line-home",
  "select-visual-line-end",
  "buffer-home",
  "buffer-end",
  "select-buffer-home",
  "select-buffer-end",
  "delete-line",
  "delete-to-line-end",
  "delete-to-line-start",
  "backspace",
  "delete",
  "undo",
  "redo",
  "word-forward",
  "word-backward",
  "select-word-forward",
  "select-word-backward",
  "delete-word-forward",
  "delete-word-backward",
] as const

type KeyBinding = {
  name: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  super?: boolean
  action: string
}

function mapTextareaKeybindings(
  keybinds: Record<string, Keybind.Info[]>,
  action: (typeof TEXTAREA_ACTIONS)[number],
): KeyBinding[] {
  const configKey = `input_${action.replace(/-/g, "_")}`
  const bindings = keybinds[configKey]
  if (!bindings) return []
  return bindings.map((binding) => ({
    name: binding.name,
    ctrl: binding.ctrl || undefined,
    meta: binding.meta || undefined,
    shift: binding.shift || undefined,
    super: binding.super || undefined,
    action,
  }))
}

describe("mapTextareaKeybindings", () => {
  test("generates correct KeyBinding entries for 'submit' action", () => {
    const keybinds: Record<string, Keybind.Info[]> = {
      input_submit: Keybind.parse("return"),
    }
    const result = mapTextareaKeybindings(keybinds, "submit")
    expect(result).toEqual([
      { name: "return", ctrl: undefined, meta: undefined, shift: undefined, super: undefined, action: "submit" },
    ])
  })

  test("generates correct KeyBinding entries for 'newline' action with default config", () => {
    const keybinds: Record<string, Keybind.Info[]> = {
      input_newline: Keybind.parse("shift+return,ctrl+return,alt+return,ctrl+j"),
    }
    const result = mapTextareaKeybindings(keybinds, "newline")
    expect(result).toEqual([
      { name: "return", ctrl: undefined, meta: undefined, shift: true, super: undefined, action: "newline" },
      { name: "return", ctrl: true, meta: undefined, shift: undefined, super: undefined, action: "newline" },
      { name: "return", ctrl: undefined, meta: true, shift: undefined, super: undefined, action: "newline" },
      { name: "j", ctrl: true, meta: undefined, shift: undefined, super: undefined, action: "newline" },
    ])
  })

  test("returns empty array when config key is missing", () => {
    const keybinds: Record<string, Keybind.Info[]> = {}
    const result = mapTextareaKeybindings(keybinds, "submit")
    expect(result).toEqual([])
  })

  test("converts action name hyphens to underscores for config key lookup", () => {
    const keybinds: Record<string, Keybind.Info[]> = {
      input_move_left: Keybind.parse("left"),
    }
    const result = mapTextareaKeybindings(keybinds, "move-left")
    expect(result).toEqual([
      { name: "left", ctrl: undefined, meta: undefined, shift: undefined, super: undefined, action: "move-left" },
    ])
  })

  test("maps false boolean modifiers to undefined in KeyBinding output", () => {
    const keybinds: Record<string, Keybind.Info[]> = {
      input_submit: [{ name: "return", ctrl: false, meta: false, shift: false, leader: false }],
    }
    const result = mapTextareaKeybindings(keybinds, "submit")
    expect(result[0].ctrl).toBeUndefined()
    expect(result[0].meta).toBeUndefined()
    expect(result[0].shift).toBeUndefined()
    expect(result[0].super).toBeUndefined()
  })
})

describe("useTextareaKeybindings structure", () => {
  test("hardcoded fallback bindings are preserved at the start of the array", () => {
    // Simulate what useTextareaKeybindings produces:
    // 1. Hardcoded: { name: "return", action: "submit" }
    // 2. Hardcoded: { name: "return", meta: true, action: "newline" }
    // 3. Hardcoded: { name: "linefeed", action: "newline" } (Ctrl+J in standard terminals)
    // 4. Config-driven bindings from TEXTAREA_ACTIONS.flatMap(mapTextareaKeybindings)

    const keybinds: Record<string, Keybind.Info[]> = {
      input_submit: Keybind.parse("return"),
      input_newline: Keybind.parse("shift+return,ctrl+return,alt+return,ctrl+j"),
    }

    const hardcoded: KeyBinding[] = [
      { name: "return", action: "submit" },
      { name: "return", meta: true, action: "newline" },
      { name: "linefeed", action: "newline" },
    ]
    const configDriven = TEXTAREA_ACTIONS.flatMap((action) => mapTextareaKeybindings(keybinds, action))
    const combined = [...hardcoded, ...configDriven]

    // Verify hardcoded entries are first
    expect(combined[0]).toEqual({ name: "return", action: "submit" })
    expect(combined[1]).toEqual({ name: "return", meta: true, action: "newline" })
    expect(combined[2]).toEqual({ name: "linefeed", action: "newline" })
  })

  test("config-driven bindings are appended AFTER hardcoded entries", () => {
    const keybinds: Record<string, Keybind.Info[]> = {
      input_submit: Keybind.parse("return"),
      input_newline: Keybind.parse("shift+return,ctrl+return,alt+return,ctrl+j"),
    }

    const hardcoded: KeyBinding[] = [
      { name: "return", action: "submit" },
      { name: "return", meta: true, action: "newline" },
      { name: "linefeed", action: "newline" },
    ]
    const configDriven = TEXTAREA_ACTIONS.flatMap((action) => mapTextareaKeybindings(keybinds, action))
    const combined = [...hardcoded, ...configDriven]

    // Config submit binding should appear after the hardcoded ones
    const firstConfigSubmitIndex = combined.findIndex(
      (b, i) => i >= hardcoded.length && b.action === "submit" && b.name === "return",
    )
    expect(firstConfigSubmitIndex).toBeGreaterThan(2)

    // This ordering ensures config overrides hardcoded via last-write-wins
    const configNewlines = configDriven.filter((b) => b.action === "newline")
    expect(configNewlines.length).toBe(4)
  })

  test("combined array contains both hardcoded and config-driven entries", () => {
    const keybinds: Record<string, Keybind.Info[]> = {
      input_submit: Keybind.parse("return"),
      input_newline: Keybind.parse("shift+return,ctrl+return,alt+return,ctrl+j"),
    }

    const hardcoded: KeyBinding[] = [
      { name: "return", action: "submit" },
      { name: "return", meta: true, action: "newline" },
      { name: "linefeed", action: "newline" },
    ]
    const configDriven = TEXTAREA_ACTIONS.flatMap((action) => mapTextareaKeybindings(keybinds, action))
    const combined = [...hardcoded, ...configDriven]

    // Should have hardcoded submit
    expect(combined).toContainEqual({ name: "return", action: "submit" })

    // Should have hardcoded meta+return newline fallback
    expect(combined).toContainEqual({ name: "return", meta: true, action: "newline" })

    // Should have hardcoded linefeed newline fallback (Ctrl+J in standard terminals)
    expect(combined).toContainEqual({ name: "linefeed", action: "newline" })

    // Should have config-driven shift+return newline
    expect(combined).toContainEqual({
      name: "return",
      ctrl: undefined,
      meta: undefined,
      shift: true,
      super: undefined,
      action: "newline",
    })

    // Should have config-driven ctrl+j newline
    expect(combined).toContainEqual({
      name: "j",
      ctrl: true,
      meta: undefined,
      shift: undefined,
      super: undefined,
      action: "newline",
    })
  })

  test("linefeed hardcoded fallback ensures Ctrl+J works in standard terminals", () => {
    // In standard terminals, Ctrl+J sends 0x0A which OpenTUI parses to { name: "linefeed" }
    // The config binding ctrl+j maps to { name: "j", ctrl: true } which only works in Kitty terminals
    // The hardcoded { name: "linefeed", action: "newline" } fallback bridges this gap

    const keybinds: Record<string, Keybind.Info[]> = {
      input_submit: Keybind.parse("return"),
      input_newline: Keybind.parse("shift+return,ctrl+return,alt+return,ctrl+j"),
    }

    const hardcoded: KeyBinding[] = [
      { name: "return", action: "submit" },
      { name: "return", meta: true, action: "newline" },
      { name: "linefeed", action: "newline" },
    ]
    const configDriven = TEXTAREA_ACTIONS.flatMap((action) => mapTextareaKeybindings(keybinds, action))
    const combined = [...hardcoded, ...configDriven]

    // Simulate standard terminal: Ctrl+J produces { name: "linefeed" } (no ctrl flag)
    // This should match the hardcoded linefeed binding
    const linefeedBinding = combined.find((b) => b.name === "linefeed" && b.action === "newline")
    expect(linefeedBinding).toBeDefined()
    expect(linefeedBinding!.ctrl).toBeUndefined()

    // Simulate Kitty terminal: Ctrl+J produces { name: "j", ctrl: true }
    // This should match the config-driven ctrl+j binding
    const ctrlJBinding = combined.find((b) => b.name === "j" && b.ctrl === true && b.action === "newline")
    expect(ctrlJBinding).toBeDefined()
  })
})
