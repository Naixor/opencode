import { cmd } from "../cmd"
import { bootstrap } from "../../bootstrap"
import { SecurityConfig } from "../../../security/config"
import { z } from "zod"
import fs from "fs"

const DEFAULT_LOG_PATH = ".opencode-security-audit.log"
const DEFAULT_TAIL = 20

const AuditLogEntry = z.object({
  timestamp: z.string(),
  role: z.string(),
  operation: z.string(),
  path: z.string(),
  result: z.enum(["allowed", "denied"]),
  reason: z.string().optional(),
  ruleTriggered: z.string().optional(),
  contentHash: z.string().optional(),
})

type AuditLogEntry = z.infer<typeof AuditLogEntry>

function formatEntry(entry: AuditLogEntry): string {
  const time = entry.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z")
  const icon = entry.result === "denied" ? "DENIED" : "ALLOWED"
  const line = `[${time}] ${icon} ${entry.operation.toUpperCase()} ${entry.path} (role: ${entry.role})`

  if (entry.reason) {
    return `${line}\n  reason: ${entry.reason}`
  }
  return line
}

function parseLogLines(content: string): AuditLogEntry[] {
  return content
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      const jsonResult = z.string().transform((s) => JSON.parse(s)).pipe(AuditLogEntry).safeParse(line)
      if (!jsonResult.success) return []
      return [jsonResult.data]
    })
}

export const SecurityLogsCommand = cmd({
  command: "logs",
  describe: "view recent security audit log entries",
  builder: (yargs) =>
    yargs
      .option("tail", {
        alias: "n",
        type: "number",
        describe: "number of entries to show",
        default: DEFAULT_TAIL,
      })
      .option("filter", {
        type: "string",
        describe: "filter by result type (denied)",
        choices: ["denied"] as const,
      }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const config = SecurityConfig.getSecurityConfig()
      const logPath = config.logging?.path ?? DEFAULT_LOG_PATH

      if (!fs.existsSync(logPath)) {
        console.log(`No audit log found at ${logPath}`)
        console.log("Security events are logged when security rules are active.")
        return
      }

      const content = fs.readFileSync(logPath, "utf-8")
      const entries = parseLogLines(content)

      if (entries.length === 0) {
        console.log("Audit log is empty.")
        return
      }

      const filtered = args.filter === "denied" ? entries.filter((e) => e.result === "denied") : entries

      if (filtered.length === 0) {
        console.log(`No ${args.filter ?? ""} entries found.`)
        return
      }

      const tail = Math.max(1, args.tail ?? DEFAULT_TAIL)
      const shown = filtered.slice(-tail)

      console.log(`=== Security Audit Log (${shown.length} of ${filtered.length} entries) ===\n`)
      for (const entry of shown) {
        console.log(formatEntry(entry))
      }
    })
  },
})
