import path from "path"
import matter from "gray-matter"
import { Filesystem } from "@/util/filesystem"

import DEFAULT_RECALL from "./default/recall.txt"
import DEFAULT_EXTRACT from "./default/extract.txt"
import DEFAULT_INJECT from "./default/inject.txt"
import DEFAULT_OPTIMIZER from "./default/optimizer.txt"
import DEFAULT_REMEMBER from "./default/remember.txt"
import DEFAULT_FORGET from "./default/forget.txt"
import DEFAULT_LIST from "./default/list.txt"

const NAMES = ["recall", "extract", "inject", "optimizer", "remember", "forget", "list"] as const
export type PromptName = (typeof NAMES)[number]

const defaults: Record<PromptName, string> = {
  recall: DEFAULT_RECALL,
  extract: DEFAULT_EXTRACT,
  inject: DEFAULT_INJECT,
  optimizer: DEFAULT_OPTIMIZER,
  remember: DEFAULT_REMEMBER,
  forget: DEFAULT_FORGET,
  list: DEFAULT_LIST,
}

/**
 * Load a memory prompt by name from the directory chain.
 * Scans directories from first to last; last match wins (highest priority).
 * Falls back to built-in default when no user file is found.
 */
export async function load(name: PromptName, dirs: string[]): Promise<string> {
  let content: string | undefined

  for (const dir of dirs) {
    const file = path.join(dir, "memory", `${name}.md`)
    const text = await Filesystem.readText(file).catch(() => undefined)
    if (text !== undefined) content = text
  }

  if (content === undefined || content === "") return defaults[name]

  try {
    const md = matter(content)
    const body = md.content.trim()
    return body || defaults[name]
  } catch {
    return content
  }
}

/**
 * Parse extract.md into system and analysis sections by heading.
 * Falls back per-section: missing heading → that section uses default.
 */
export function sections(content: string): { system: string; analysis: string } {
  const heading = /^#\s+(system|analysis)\s*$/im
  const lines = content.split("\n")
  let current: "system" | "analysis" | undefined
  const parts: Record<string, string[]> = { system: [], analysis: [] }

  for (const line of lines) {
    const match = line.match(heading)
    if (match) {
      current = match[1].toLowerCase() as "system" | "analysis"
      continue
    }
    if (current) parts[current].push(line)
  }

  const sys = parts.system.join("\n").trim()
  const analysis = parts.analysis.join("\n").trim()

  const defaults_extract = fallback()

  return {
    system: sys || defaults_extract.system,
    analysis: analysis || defaults_extract.analysis,
  }
}

function fallback() {
  return raw(defaults.extract)
}

function raw(content: string): { system: string; analysis: string } {
  const heading = /^#\s+(system|analysis)\s*$/im
  const lines = content.split("\n")
  let current: "system" | "analysis" | undefined
  const parts: Record<string, string[]> = { system: [], analysis: [] }

  for (const line of lines) {
    const match = line.match(heading)
    if (match) {
      current = match[1].toLowerCase() as "system" | "analysis"
      continue
    }
    if (current) parts[current].push(line)
  }

  return {
    system: parts.system.join("\n").trim(),
    analysis: parts.analysis.join("\n").trim(),
  }
}

/**
 * Parse inject.md into memory injection and conflict warning sections.
 */
export function injectSections(content: string): { injection: string; conflict: string } {
  const heading = /^#\s+(memory injection|conflict warning)\s*$/im
  const lines = content.split("\n")
  let current: "injection" | "conflict" | undefined
  const parts: Record<string, string[]> = { injection: [], conflict: [] }

  for (const line of lines) {
    const match = line.match(heading)
    if (match) {
      current = match[1].toLowerCase().startsWith("memory") ? "injection" : "conflict"
      continue
    }
    if (current) parts[current].push(line)
  }

  return {
    injection: parts.injection.join("\n").trim(),
    conflict: parts.conflict.join("\n").trim(),
  }
}
