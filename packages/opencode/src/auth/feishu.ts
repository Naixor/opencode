import path from "path"
import z from "zod"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import fs from "fs/promises"

export namespace FeishuAuth {
  export const Schema = z.object({
    refresh_token: z.string(),
    expires_at: z.number(),
    name: z.string(),
    email: z.string(),
    wellknown_url: z.string(),
  })

  export type Info = z.infer<typeof Schema>

  const filepath = path.join(Global.Path.data, "feishu-auth.json")

  export async function read(): Promise<Info | null> {
    const data = await Filesystem.readJson(filepath).catch(() => null)
    if (!data) return null
    const parsed = Schema.safeParse(data)
    if (!parsed.success) return null
    return parsed.data
  }

  export async function write(data: Info) {
    const parsed = Schema.parse(data)
    await Filesystem.writeJson(filepath, parsed, 0o600)
  }

  export async function remove() {
    await fs.unlink(filepath).catch(() => {})
  }
}
