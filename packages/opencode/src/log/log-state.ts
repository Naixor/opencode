import { Instance } from "../project/instance"

// Shared state for LLM log tracking, used by both capture.ts and hooks/index.ts
// Extracted to avoid circular imports between hooks/index.ts <-> capture.ts

export const currentLlmLogState = Instance.state(() => new Map<string, { logId: string; timeStart: number }>())

export function getCurrentLogId(sessionID: string): string | undefined {
  return currentLlmLogState().get(sessionID)?.logId
}
