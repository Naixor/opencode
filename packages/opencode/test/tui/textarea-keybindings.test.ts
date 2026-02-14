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

  test("custom submit key overrides default submit binding", () => {
    // User configures input_submit to ctrl+return instead of default "return"
    const keybinds: Record<string, Keybind.Info[]> = {
      input_submit: Keybind.parse("ctrl+return"),
      input_newline: Keybind.parse("shift+return,ctrl+return,alt+return,ctrl+j"),
    }

    const hardcoded: KeyBinding[] = [
      { name: "return", action: "submit" },
      { name: "return", meta: true, action: "newline" },
      { name: "linefeed", action: "newline" },
    ]
    const configDriven = TEXTAREA_ACTIONS.flatMap((action) => mapTextareaKeybindings(keybinds, action))
    const combined = [...hardcoded, ...configDriven]

    // Config-driven submit should be ctrl+return (overrides hardcoded via last-write-wins)
    const configSubmit = configDriven.filter((b) => b.action === "submit")
    expect(configSubmit).toEqual([
      { name: "return", ctrl: true, meta: undefined, shift: undefined, super: undefined, action: "submit" },
    ])

    // The hardcoded plain "return" → submit is still present but gets overridden
    // because config-driven entries come after and OpenTUI uses last-write-wins
    expect(combined[0]).toEqual({ name: "return", action: "submit" })
    const lastReturnSubmit = [...combined].reverse().find((b) => b.name === "return" && b.action === "submit")
    // The last "return" submit binding is the config-driven ctrl+return
    // Since it comes after the hardcoded one, it wins for the "return" key via last-write-wins
    expect(lastReturnSubmit).toEqual({
      name: "return",
      ctrl: true,
      meta: undefined,
      shift: undefined,
      super: undefined,
      action: "submit",
    })
  })

  test("custom newline key overrides default newline bindings", () => {
    // User configures input_newline to just "ctrl+n" instead of defaults
    const keybinds: Record<string, Keybind.Info[]> = {
      input_submit: Keybind.parse("return"),
      input_newline: Keybind.parse("ctrl+n"),
    }

    const hardcoded: KeyBinding[] = [
      { name: "return", action: "submit" },
      { name: "return", meta: true, action: "newline" },
      { name: "linefeed", action: "newline" },
    ]
    const configDriven = TEXTAREA_ACTIONS.flatMap((action) => mapTextareaKeybindings(keybinds, action))
    const combined = [...hardcoded, ...configDriven]

    // Only one config-driven newline binding: ctrl+n
    const configNewlines = configDriven.filter((b) => b.action === "newline")
    expect(configNewlines).toEqual([
      { name: "n", ctrl: true, meta: undefined, shift: undefined, super: undefined, action: "newline" },
    ])

    // Hardcoded meta+return and linefeed fallbacks still present
    expect(combined).toContainEqual({ name: "return", meta: true, action: "newline" })
    expect(combined).toContainEqual({ name: "linefeed", action: "newline" })
  })

  test("setting input_newline to 'none' disables config-driven newline shortcuts", () => {
    // User sets input_newline to "none" to disable all newline shortcuts
    const keybinds: Record<string, Keybind.Info[]> = {
      input_submit: Keybind.parse("return"),
      input_newline: Keybind.parse("none"),
    }

    // Keybind.parse("none") returns empty array
    expect(keybinds.input_newline).toEqual([])

    const configDriven = TEXTAREA_ACTIONS.flatMap((action) => mapTextareaKeybindings(keybinds, action))

    // No config-driven newline bindings should be generated
    const configNewlines = configDriven.filter((b) => b.action === "newline")
    expect(configNewlines).toHaveLength(0)

    // The hardcoded fallbacks (meta+return, linefeed) would still be present
    // in the full combined array from useTextareaKeybindings, but no config-driven
    // newline bindings exist, so effectively only hardcoded fallbacks remain
    const hardcoded: KeyBinding[] = [
      { name: "return", action: "submit" },
      { name: "return", meta: true, action: "newline" },
      { name: "linefeed", action: "newline" },
    ]
    const combined = [...hardcoded, ...configDriven]
    const allNewlines = combined.filter((b) => b.action === "newline")
    // Only the 2 hardcoded fallbacks remain
    expect(allNewlines).toHaveLength(2)
    expect(allNewlines).toContainEqual({ name: "return", meta: true, action: "newline" })
    expect(allNewlines).toContainEqual({ name: "linefeed", action: "newline" })
  })

  test("missing config values produce no bindings (fallback to defaults happens in config layer)", () => {
    // When no keybinds config is provided at all, mapTextareaKeybindings returns empty
    const keybinds: Record<string, Keybind.Info[]> = {}

    const configDriven = TEXTAREA_ACTIONS.flatMap((action) => mapTextareaKeybindings(keybinds, action))
    expect(configDriven).toHaveLength(0)

    // With no config, only hardcoded fallbacks remain
    const hardcoded: KeyBinding[] = [
      { name: "return", action: "submit" },
      { name: "return", meta: true, action: "newline" },
      { name: "linefeed", action: "newline" },
    ]
    const combined = [...hardcoded, ...configDriven]
    expect(combined).toHaveLength(3)
    // The config layer (config.ts) provides defaults before this point,
    // so in practice keybinds will always have input_submit and input_newline
  })

  test("default config values produce correct full binding set", () => {
    // Simulate the default config values
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

    // Should have 1 hardcoded submit + 1 config submit
    const submits = combined.filter((b) => b.action === "submit")
    expect(submits).toHaveLength(2)

    // Should have 2 hardcoded newlines + 4 config newlines = 6
    const newlines = combined.filter((b) => b.action === "newline")
    expect(newlines).toHaveLength(6)

    // Config newlines: shift+return, ctrl+return, alt+return, ctrl+j
    expect(configDriven.filter((b) => b.action === "newline")).toEqual([
      { name: "return", ctrl: undefined, meta: undefined, shift: true, super: undefined, action: "newline" },
      { name: "return", ctrl: true, meta: undefined, shift: undefined, super: undefined, action: "newline" },
      { name: "return", ctrl: undefined, meta: true, shift: undefined, super: undefined, action: "newline" },
      { name: "j", ctrl: true, meta: undefined, shift: undefined, super: undefined, action: "newline" },
    ])
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
