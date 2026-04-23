import type { ToolPart } from "@opencode-ai/sdk/v2"
import { createMemo, For } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import { workflowtoolview } from "./workflow-tool-view"

export function WorkflowTool(props: {
  input: {
    name?: string
  }
  metadata?: Record<string, unknown>
  part: ToolPart
}) {
  const { theme } = useTheme()
  const dim = useTerminalDimensions()
  const width = createMemo(() => Math.max(40, dim().width - 3))
  const view = createMemo(() => workflowtoolview({ ...props, width: width() }))
  const err = createMemo(() => view().error?.trim())

  return (
    <box
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background}
    >
      <text paddingLeft={3} fg={theme.textMuted}>
        {view().title}
      </text>
      <box flexDirection="column" gap={1}>
        <For each={view().lines}>
          {(line, index) => <text fg={index() === 0 ? theme.text : theme.textMuted}>{line}</text>}
        </For>
      </box>
      {err() ? <text fg={theme.error}>{err()}</text> : undefined}
    </box>
  )
}
