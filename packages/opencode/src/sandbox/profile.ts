import fs from "fs/promises"
import path from "path"
import type { SecuritySchema } from "../security/schema"
import { generateBuiltins } from "./builtins"

export interface ProfileInput {
  projectRoot: string
  allowlist: SecuritySchema.AllowlistEntry[]
  deny: SecuritySchema.Rule[]
  extraPaths: string[]
}

async function realpath(p: string): Promise<string> {
  const resolved = await fs.realpath(p).catch(() => null)
  if (resolved) return resolved
  // Path doesn't exist — resolve the deepest existing ancestor and append the rest
  const parent = path.dirname(p)
  if (parent === p) return p
  const resolvedParent = await realpath(parent)
  return path.join(resolvedParent, path.basename(p))
}

function sbplSubpath(p: string): string {
  return `(subpath "${p}")`
}

function sbplLiteral(p: string): string {
  return `(literal "${p}")`
}

function allowWrite(filter: string): string {
  return `(allow file-write* ${filter})`
}

function denyRW(filter: string): string {
  return `(deny file-read* file-write* ${filter})`
}

async function resolveAllowlistEntry(
  entry: SecuritySchema.AllowlistEntry,
  projectRoot: string,
): Promise<string> {
  const pattern = entry.pattern.replace(/\/\*\*$/, "").replace(/\*\*/g, "")
  const abs = path.isAbsolute(pattern) ? pattern : path.resolve(projectRoot, pattern)
  const resolved = await realpath(abs)

  // Reads are globally allowed; allowlist grants write access
  if (entry.type === "directory") return allowWrite(sbplSubpath(resolved))
  return allowWrite(sbplLiteral(resolved))
}

async function resolveDenyEntry(
  rule: SecuritySchema.Rule,
  projectRoot: string,
): Promise<string> {
  const pattern = rule.pattern.replace(/\/\*\*$/, "").replace(/\*\*/g, "")
  const abs = path.isAbsolute(pattern) ? pattern : path.resolve(projectRoot, pattern)
  const resolved = await realpath(abs)

  if (rule.type === "directory") return denyRW(sbplSubpath(resolved))
  return denyRW(sbplLiteral(resolved))
}

export async function generateProfile(input: ProfileInput): Promise<string> {
  const lines: string[] = [
    "(version 1)",
    "(allow default)",
    "",
    ";; --- Allowlist write rules ---",
  ]

  const allowRules = await Promise.all(
    input.allowlist.map((entry) => resolveAllowlistEntry(entry, input.projectRoot)),
  )
  lines.push(...allowRules)

  if (input.extraPaths.length > 0) {
    lines.push("")
    lines.push(";; --- User-configured extra paths (rw) ---")
    for (const p of input.extraPaths) {
      const resolved = await realpath(path.isAbsolute(p) ? p : path.resolve(input.projectRoot, p))
      lines.push(allowWrite(sbplSubpath(resolved)))
    }
  }

  if (input.deny.length > 0) {
    lines.push("")
    lines.push(";; --- Deny rules (block read+write) ---")
    const denyRules = await Promise.all(
      input.deny.map((rule) => resolveDenyEntry(rule, input.projectRoot)),
    )
    lines.push(...denyRules)
  }

  lines.push("")
  return lines.join("\n") + "\n"
}

export async function generateFullProfile(input: ProfileInput): Promise<string> {
  const header = ["(version 1)", "(allow default)", ""]
  const builtins = await generateBuiltins(input.projectRoot)
  const userRules = await generateProfile(input)
  // Strip the version+allow header from userRules since we already have it
  const userBody = userRules.replace("(version 1)\n(allow default)\n\n", "")
  return header.join("\n") + "\n" + builtins + "\n" + userBody
}
