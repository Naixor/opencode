/**
 * fs_usage output parser
 *
 * Parses macOS `fs_usage -f filesystem -w` output lines into structured AccessEvent objects.
 * Maps kernel syscalls to high-level operations (read/write/create/delete/rename).
 */

import { minimatch } from "minimatch"
import type { AccessEvent, AccessOperation, MonitorConfig } from "./types"

const READ_SYSCALLS = new Set([
  "open",
  "read",
  "stat",
  "stat64",
  "lstat",
  "lstat64",
  "readlink",
  "access",
  "pread",
  "getattrlist",
  "getxattr",
  "listxattr",
  "fstat",
  "fstat64",
  "open_nocancel",
  "read_nocancel",
  "pread_nocancel",
])

const WRITE_SYSCALLS = new Set([
  "write",
  "pwrite",
  "truncate",
  "ftruncate",
  "write_nocancel",
  "pwrite_nocancel",
  "fsetxattr",
  "setattrlist",
])

const CREATE_SYSCALLS = new Set([
  "creat",
  "mkdir",
  "symlink",
  "link",
  "mkdirat",
  "symlinkat",
  "linkat",
  "open_nocancel",
])

const DELETE_SYSCALLS = new Set(["unlink", "rmdir", "unlinkat", "removexattr"])

const RENAME_SYSCALLS = new Set(["rename", "renameat", "renameatx_np", "exchangedata"])

function classifySyscall(syscall: string): AccessOperation | undefined {
  if (READ_SYSCALLS.has(syscall)) return "read"
  if (WRITE_SYSCALLS.has(syscall)) return "write"
  if (CREATE_SYSCALLS.has(syscall)) return "create"
  if (DELETE_SYSCALLS.has(syscall)) return "delete"
  if (RENAME_SYSCALLS.has(syscall)) return "rename"
  return undefined
}

/**
 * fs_usage output format (typical lines):
 *   timestamp  syscall                  (path)    PID  process
 *
 * Examples:
 *   18:30:45.123456  open              /path/to/file    12345  bun
 *   18:30:45.123457  read              F=5               12345  bun
 *   18:30:45.123458  stat64            /path/to/file    12345  bun
 *
 * The format is column-based but not strictly delimited. We use regex to extract fields.
 */
const FS_USAGE_LINE_RE = /^\s*(\d{2}:\d{2}:\d{2}\.\d+)\s+(\w+)\s+(.+?)\s+(\d+)\s+(\S+)\s*$/

const PATH_EXTRACT_RE = /\/([\w./-]+)/

export function parseFsUsageLine(line: string, config: MonitorConfig): AccessEvent | undefined {
  const match = FS_USAGE_LINE_RE.exec(line)
  if (!match) return undefined

  const [, timestampStr, syscall, detail, pidStr, process] = match
  const operation = classifySyscall(syscall)
  if (!operation) return undefined

  const pathMatch = PATH_EXTRACT_RE.exec(detail)
  if (!pathMatch) return undefined

  const filePath = "/" + pathMatch[1]
  const pid = parseInt(pidStr, 10)

  if (config.pid && pid !== config.pid) return undefined

  const flaggedAsProtected = config.protectedPatterns.some((pattern) => minimatch(filePath, pattern, { dot: true }))

  const baseDate = new Date()
  const [h, m, rest] = timestampStr.split(":")
  const [s, us] = rest.split(".")
  baseDate.setHours(parseInt(h, 10), parseInt(m, 10), parseInt(s, 10), parseInt(us.slice(0, 3), 10))

  return {
    timestamp: baseDate.getTime(),
    pid,
    process,
    syscall,
    path: filePath,
    operation,
    flaggedAsProtected,
    result: "observed",
  }
}

export function isProtectedPath(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(filePath, pattern, { dot: true }))
}
