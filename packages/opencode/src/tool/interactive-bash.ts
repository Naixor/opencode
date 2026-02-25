import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { BashScanner } from "../security/bash-scanner"
import { SecurityAccess } from "../security/access"
import { SecurityAudit } from "../security/audit"
import { Instance } from "../project/instance"
import import_description from "./interactive-bash.txt"

const BLOCKED_SUBCOMMANDS = new Set(["send-keys", "send", "type", "paste-buffer"])

function extractTmuxSubcommand(command: string): string | undefined {
  const trimmed = command.trim()
  const parts = trimmed.split(/\s+/)
  return parts[0]?.toLowerCase()
}

function extractFilePathsFromArgs(command: string, cwd: string): string[] {
  const paths: string[] = []
  // Extract paths from BashScanner (handles piped/chained commands)
  paths.push(...BashScanner.scanBashCommand(`tmux ${command}`, cwd))
  // Also scan the tmux arguments directly for file-like paths
  const tokens = command.trim().split(/\s+/)
  for (const token of tokens) {
    const stripped = token.replace(/^['"]|['"]$/g, "")
    if (stripped.startsWith("/") || stripped.startsWith("./") || stripped.startsWith("../") || stripped.includes("/")) {
      if (stripped.startsWith("-")) continue
      const resolved = path.isAbsolute(stripped) ? stripped : path.resolve(cwd, stripped)
      paths.push(resolved)
    }
  }
  return [...new Set(paths)]
}

async function checkTmuxAvailable(): Promise<boolean> {
  const proc = Bun.spawn(["which", "tmux"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const code = await proc.exited
  return code === 0
}

export const InteractiveBashTool = Tool.define<z.ZodObject<{ tmux_command: z.ZodString }>, { [key: string]: unknown }>(
  "interactive_bash",
  async () => ({
    description: import_description,
    parameters: z.object({
      tmux_command: z
        .string()
        .describe("The tmux subcommand and arguments to execute (e.g., 'list-sessions', 'new-session -s work -d')"),
    }),
    async execute(params, ctx): Promise<{ title: string; metadata: { [key: string]: unknown }; output: string }> {
      // Security checks run first — before tmux availability — to ensure
      // policy enforcement and audit logging regardless of environment.
      const subcommand = extractTmuxSubcommand(params.tmux_command)
      if (!subcommand) {
        return {
          title: "invalid command",
          metadata: { error: true },
          output: "No tmux subcommand provided. Please specify a tmux subcommand (e.g., 'list-sessions').",
        }
      }

      if (BLOCKED_SUBCOMMANDS.has(subcommand)) {
        return {
          title: "blocked subcommand",
          metadata: { error: true, blocked: true, subcommand },
          output: `The tmux subcommand '${subcommand}' is blocked for security reasons. This subcommand could be used to bypass shell injection protections. Blocked subcommands: ${[...BLOCKED_SUBCOMMANDS].join(", ")}.`,
        }
      }

      const cwd = Instance.worktree ?? Instance.directory
      const filePaths = extractFilePathsFromArgs(params.tmux_command, cwd)

      for (const filePath of filePaths) {
        const access = SecurityAccess.checkAccess(filePath, "read", "agent")
        if (!access.allowed) {
          SecurityAudit.logSecurityEvent({
            role: "agent",
            path: filePath,
            operation: "read",
            allowed: false,
            reason: access.reason ?? "Security policy denied access",
          })
          return {
            title: "access denied",
            metadata: { error: true, blocked: true, path: filePath },
            output: `Security policy denied access to file path in tmux command: ${filePath}. Reason: ${access.reason ?? "access denied"}`,
          }
        }
      }

      const available = await checkTmuxAvailable()
      if (!available) {
        return {
          title: "tmux not available",
          metadata: { error: true },
          output: "tmux is not installed or not found in PATH. Install tmux to use this tool.",
        }
      }

      const args = ["tmux", ...params.tmux_command.trim().split(/\s+/)]
      const proc = Bun.spawn(args, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      })

      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      const exitCode = await proc.exited

      const output = [stdout.trim() ? stdout.trim() : "", stderr.trim() ? `stderr: ${stderr.trim()}` : ""]
        .filter(Boolean)
        .join("\n")

      if (exitCode !== 0) {
        return {
          title: `tmux ${subcommand} (exit ${exitCode})`,
          metadata: { exitCode, subcommand, error: true },
          output: output || `tmux command failed with exit code ${exitCode}`,
        }
      }

      return {
        title: `tmux ${subcommand}`,
        metadata: { exitCode, subcommand },
        output: output || "(no output)",
      }
    },
  }),
)
