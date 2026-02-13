import z from "zod"
import path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./glob.txt"
import { Ripgrep } from "../file/ripgrep"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { SecurityAccess } from "../security/access"
import { SecurityConfig } from "../security/config"
import { SecurityUtil } from "../security/util"
import { Log } from "../util/log"

const securityLog = Log.create({ service: "security-glob" })

export const GlobTool = Tool.define("glob", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z
      .string()
      .optional()
      .describe(
        `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
      ),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "glob",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
      },
    })

    let search = params.path ?? Instance.directory
    search = path.isAbsolute(search) ? search : path.resolve(Instance.directory, search)
    await assertExternalDirectory(ctx, search, { kind: "directory" })

    const limit = 100
    const files = []
    let truncated = false
    for await (const file of Ripgrep.files({
      cwd: search,
      glob: [params.pattern],
      signal: ctx.abort,
    })) {
      if (files.length >= limit) {
        truncated = true
        break
      }
      const full = path.resolve(search, file)
      const stats = await Bun.file(full)
        .stat()
        .then((x) => x.mtime.getTime())
        .catch(() => 0)
      files.push({
        path: full,
        mtime: stats,
      })
    }
    files.sort((a, b) => b.mtime - a.mtime)

    // Security access control: filter out protected files
    const config = SecurityConfig.getSecurityConfig()
    const currentRole = SecurityUtil.getDefaultRole(config)
    const originalCount = files.length

    const allowedFiles = files.filter((f) => {
      const accessResult = SecurityAccess.checkAccess(f.path, "read", currentRole)
      return accessResult.allowed
    })

    const filteredCount = originalCount - allowedFiles.length
    if (filteredCount > 0) {
      securityLog.debug("filtered protected files from glob results", {
        filteredCount,
        role: currentRole,
      })
    }

    const output = []
    if (allowedFiles.length === 0) output.push("No files found")
    if (allowedFiles.length > 0) {
      output.push(...allowedFiles.map((f) => f.path))
      if (truncated) {
        output.push("")
        output.push("(Results are truncated. Consider using a more specific path or pattern.)")
      }
    }

    return {
      title: path.relative(Instance.worktree, search),
      metadata: {
        count: allowedFiles.length,
        truncated,
      },
      output: output.join("\n"),
    }
  },
})

