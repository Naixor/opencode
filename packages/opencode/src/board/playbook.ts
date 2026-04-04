import path from "path"
import fs from "fs/promises"
import { Log } from "../util/log"
import { Global } from "../global"
import { Instance } from "../project/instance"

export namespace Playbook {
  const log = Log.create({ service: "board.playbook" })

  function dir(): string {
    return path.join(Global.Path.data, "projects", Instance.project.id, "board", "playbooks")
  }

  async function ensure() {
    await fs.mkdir(dir(), { recursive: true })
  }

  function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) return { meta: {}, body: content }
    const meta: Record<string, unknown> = {}
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":")
      if (idx === -1) continue
      const k = line.slice(0, idx).trim()
      const v = line.slice(idx + 1).trim()
      meta[k] = isNaN(Number(v)) ? v : Number(v)
    }
    return { meta, body: match[2] }
  }

  export async function list(): Promise<Array<{ name: string; trigger: string; version: number }>> {
    await ensure()
    const files = await fs.readdir(dir()).catch(() => [] as string[])
    const result: Array<{ name: string; trigger: string; version: number }> = []
    for (const f of files) {
      if (!f.endsWith(".md")) continue
      const content = await fs.readFile(path.join(dir(), f), "utf-8").catch(() => "")
      const { meta } = parseFrontmatter(content)
      result.push({
        name: (meta.name as string) ?? f.replace(".md", ""),
        trigger: (meta.trigger as string) ?? "",
        version: (meta.version as number) ?? 1,
      })
    }
    return result
  }

  export async function get(name: string): Promise<string> {
    await ensure()
    return fs.readFile(path.join(dir(), `${name}.md`), "utf-8")
  }

  export async function update(name: string, content: string): Promise<void> {
    await ensure()
    const fp = path.join(dir(), `${name}.md`)
    const existing = await fs.readFile(fp, "utf-8").catch(() => "")
    const { meta } = parseFrontmatter(existing)
    const version = ((meta.version as number) ?? 0) + 1
    const { meta: newMeta, body } = parseFrontmatter(content)
    newMeta.version = version
    newMeta.last_updated = new Date().toISOString()
    const header = Object.entries(newMeta)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")
    await Bun.write(fp, `---\n${header}\n---\n${body}`)
  }
}
