import fs from "fs/promises"
import path from "path"
import os from "os"
import { Global } from "@/global"

async function realpath(p: string): Promise<string> {
  const resolved = await fs.realpath(p).catch(() => null)
  if (resolved) return resolved
  const parent = path.dirname(p)
  if (parent === p) return p
  const resolvedParent = await realpath(parent)
  return path.join(resolvedParent, path.basename(p))
}

async function findGitRoot(from: string): Promise<string | null> {
  let dir = from
  while (true) {
    const gitDir = path.join(dir, ".git")
    const stat = await fs.stat(gitDir).catch(() => null)
    if (stat) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function subpath(p: string): string {
  return `(subpath "${p}")`
}

/**
 * Generate built-in sandbox rules.
 *
 * Strategy: (allow default) lets system operations (process, mach, sysctl, etc.)
 * work without enumerating every low-level capability.
 * We then deny all writes globally and selectively re-allow writes to
 * project-relevant directories (allowlist, tmp, node_modules, .git).
 * Deny rules for sensitive paths block both reads and writes.
 */
export async function generateBuiltins(projectRoot: string): Promise<string> {
  const lines: string[] = []
  const resolvedRoot = await realpath(projectRoot)

  // --- Global write deny ---
  // Block all file writes by default; specific paths re-allow below
  lines.push(";; --- Deny all writes globally ---")
  lines.push(`(deny file-write* ${subpath("/")})`)
  lines.push("")

  // --- Writable: project node_modules and .git ---
  lines.push(";; --- Project node_modules and .git (rw) ---")
  lines.push(`(allow file-write* ${subpath(path.join(resolvedRoot, "node_modules"))})`)
  const gitRoot = await findGitRoot(resolvedRoot)
  const gitDir = path.join(gitRoot ?? resolvedRoot, ".git")
  lines.push(`(allow file-write* ${subpath(await realpath(gitDir))})`)
  lines.push("")

  // --- Writable: temp directories ---
  lines.push(";; --- Temp directories (rw) ---")
  const resolvedTmp = await realpath("/tmp")
  lines.push(`(allow file-write* ${subpath(resolvedTmp)})`)
  const runtimeTmp = await realpath(os.tmpdir())
  if (runtimeTmp !== resolvedTmp) {
    lines.push(`(allow file-write* ${subpath(runtimeTmp)})`)
  }
  lines.push("")

  // --- Writable: opencode internal directories ---
  // Config/skill directories that opencode needs read-write access to:
  // project-level: .lark-opencode/, .opencode/, .claude/, .agents/
  // global home: ~/.lark-opencode/, ~/.opencode/, ~/.claude/, ~/.agents/
  // XDG dirs: data, config, state, cache (DB, auth, plans, logs, etc.)
  lines.push(";; --- opencode internal directories (rw) ---")
  const home = Global.Path.home
  for (const dir of [".lark-opencode", ".opencode", ".claude", ".agents"]) {
    lines.push(`(allow file-write* ${subpath(await realpath(path.join(resolvedRoot, dir)))})`)
    const global = path.join(home, dir)
    if (global !== path.join(resolvedRoot, dir)) {
      lines.push(`(allow file-write* ${subpath(await realpath(global))})`)
    }
  }
  for (const dir of [Global.Path.data, Global.Path.config, Global.Path.state, Global.Path.cache]) {
    lines.push(`(allow file-write* ${subpath(await realpath(dir))})`)
  }
  lines.push("")

  // --- Writable: /dev devices ---
  lines.push(";; --- /dev devices (rw) ---")
  for (const p of ["/dev/null", "/dev/zero", "/dev/ptmx", "/dev/urandom", "/dev/random"]) {
    lines.push(`(allow file-write* (literal "${p}"))`)
  }
  lines.push(`(allow file-write* (regex "^/dev/ttys[0-9]+"))`)
  lines.push("")

  return lines.join("\n")
}
