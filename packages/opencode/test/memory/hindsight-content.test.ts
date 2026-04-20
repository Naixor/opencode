import { describe, expect, test } from "bun:test"
import {
  composeRecallQuery,
  formatCurrentTime,
  formatMemories,
  prepareRetentionTranscript,
  sliceLastTurnsByUserBoundary,
  stripMemoryTags,
  truncateRecallQuery,
} from "../../src/memory/hindsight/content"

describe("MemoryHindsightContent", () => {
  test("strips hindsight memory tags", () => {
    expect(stripMemoryTags("before <hindsight_memories>secret</hindsight_memories> after")).toBe("before  after")
    expect(stripMemoryTags("before <relevant_memories>secret</relevant_memories> after")).toBe("before  after")
    expect(
      stripMemoryTags("<hindsight_memories>a</hindsight_memories> middle <relevant_memories>b</relevant_memories>"),
    ).toBe(" middle ")
  })

  test("formats memories and utc time", () => {
    expect(
      formatMemories([
        { text: "User likes Python", type: "world", mentioned_at: "2025-01-01" },
        { text: "Met at conference" },
      ]),
    ).toBe("- User likes Python [world] (2025-01-01)\n\n- Met at conference")
    expect(formatCurrentTime()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  test("composes recall queries with prior context and without latest duplication", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "What is my name?" },
    ]

    expect(composeRecallQuery("What is my name?", messages, 1)).toBe("What is my name?")

    const result = composeRecallQuery("What is my name?", messages, 3)
    expect(result).toContain("Prior context:")
    expect(result).toContain("user: Hello")
    expect(result).toContain("assistant: Hi there")
    expect(result.match(/What is my name\?/g)?.length).toBe(1)
  })

  test("truncates recall queries by dropping oldest context first", () => {
    expect(truncateRecallQuery("short", "short", 100)).toBe("short")
    expect(truncateRecallQuery("my query", "my query", 5)).toBe("my qu")

    const result = truncateRecallQuery(
      "Prior context:\n\nuser: old\nassistant: older\nuser: recent\n\nlatest",
      "latest",
      50,
    )
    expect(result).toContain("latest")
    expect(result.length).toBeLessThanOrEqual(50)
  })

  test("slices by user-turn boundary", () => {
    const messages = [
      { role: "user", content: "A" },
      { role: "assistant", content: "B" },
      { role: "user", content: "C" },
      { role: "assistant", content: "D" },
      { role: "user", content: "E" },
    ]

    expect(sliceLastTurnsByUserBoundary(messages, 2).map((item) => item.content)).toEqual(["C", "D", "E"])
    expect(sliceLastTurnsByUserBoundary(messages, 10)).toEqual(messages)
    expect(sliceLastTurnsByUserBoundary(messages, 0)).toEqual([])
  })

  test("builds retention transcripts and strips injected memory tags", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you? <hindsight_memories>x</hindsight_memories>" },
      { role: "assistant", content: "I am doing well" },
    ]

    const last = prepareRetentionTranscript(messages)
    expect(last.messageCount).toBe(2)
    expect(last.transcript).toContain("[role: user]")
    expect(last.transcript).toContain("How are you?")
    expect(last.transcript).not.toContain("hindsight_memories")
    expect(last.transcript).not.toContain("Hello")

    const full = prepareRetentionTranscript(messages, true)
    expect(full.messageCount).toBe(4)
    expect(full.transcript).toContain("Hello")
    expect(full.transcript).toContain("[assistant:end]")
  })
})
