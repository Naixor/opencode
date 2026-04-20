export interface RecallResult {
  text: string
  type?: string | null
  mentioned_at?: string | null
}

export interface Message {
  role: string
  content: string
}

export function stripMemoryTags(content: string) {
  return content
    .replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g, "")
    .replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>/g, "")
}

export function formatMemories(results: RecallResult[]) {
  if (results.length === 0) return ""
  return results
    .map((item) => {
      const type = item.type ? ` [${item.type}]` : ""
      const date = item.mentioned_at ? ` (${item.mentioned_at})` : ""
      return `- ${item.text}${type}${date}`
    })
    .join("\n\n")
}

export function formatCurrentTime() {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, "0")
  const d = String(now.getUTCDate()).padStart(2, "0")
  const h = String(now.getUTCHours()).padStart(2, "0")
  const min = String(now.getUTCMinutes()).padStart(2, "0")
  return `${y}-${m}-${d} ${h}:${min}`
}

export function sliceLastTurnsByUserBoundary(messages: Message[], turns: number) {
  if (messages.length === 0 || turns <= 0) return []

  let seen = 0
  let start = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user") continue
    seen++
    if (seen < turns) continue
    start = i
    break
  }

  return start === -1 ? [...messages] : messages.slice(start)
}

export function composeRecallQuery(latest: string, messages: Message[], turns: number) {
  const query = latest.trim()
  if (turns <= 1 || messages.length === 0) return query

  const lines = sliceLastTurnsByUserBoundary(messages, turns).flatMap((item) => {
    const content = stripMemoryTags(item.content).trim()
    if (!content) return []
    if (item.role === "user" && content === query) return []
    return [`${item.role}: ${content}`]
  })

  if (lines.length === 0) return query
  return ["Prior context:", lines.join("\n"), query].join("\n\n")
}

export function truncateRecallQuery(query: string, latest: string, max: number) {
  if (max <= 0 || query.length <= max) return query

  const next = latest.trim()
  const only = next.length > max ? next.slice(0, max) : next
  if (!query.includes("Prior context:")) return only

  const prefix = "Prior context:\n\n"
  const start = query.indexOf(prefix)
  if (start === -1) return only

  const suffix = `\n\n${next}`
  const end = query.lastIndexOf(suffix)
  if (end === -1 || suffix.length >= max) return only

  const lines = query
    .slice(start + prefix.length, end)
    .split("\n")
    .filter(Boolean)

  const kept: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    kept.unshift(lines[i]!)
    if (`${prefix}${kept.join("\n")}${suffix}`.length <= max) continue
    kept.shift()
    break
  }

  if (kept.length === 0) return only
  return `${prefix}${kept.join("\n")}${suffix}`
}

export function prepareRetentionTranscript(messages: Message[], full = false) {
  if (messages.length === 0) {
    return {
      transcript: null,
      messageCount: 0,
    }
  }

  const list = full
    ? messages
    : (() => {
        let start = -1
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role !== "user") continue
          start = i
          break
        }
        return start === -1 ? [] : messages.slice(start)
      })()

  const parts = list.flatMap((item) => {
    const content = stripMemoryTags(item.content).trim()
    if (!content) return []
    return [`[role: ${item.role}]\n${content}\n[${item.role}:end]`]
  })

  if (parts.length === 0) {
    return {
      transcript: null,
      messageCount: 0,
    }
  }

  const transcript = parts.join("\n\n")
  if (transcript.trim().length < 10) {
    return {
      transcript: null,
      messageCount: 0,
    }
  }

  return {
    transcript,
    messageCount: parts.length,
  }
}
