import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "../global"
import { Instance } from "../project/instance"

export namespace SwarmCleanup {
  export const Report = z.object({
    dry_run: z.boolean(),
    ready: z.boolean(),
    root: z.string(),
    removed: z.array(z.string()),
    stats: z.object({
      files: z.number(),
      dirs: z.number(),
      total: z.number(),
    }),
    at: z.number(),
  })
  export type Report = z.infer<typeof Report>

  function root() {
    return path.join(Global.Path.data, "projects", Instance.project.id, "board")
  }

  function marker() {
    return path.join(root(), "v2-cleanup.json")
  }

  function registry() {
    return path.join(root(), "swarms.json")
  }

  async function targets() {
    const dir = root()
    const items: string[] = []
    if (await Bun.file(registry()).exists()) items.push(registry())
    for (const entry of await fs.readdir(dir).catch(() => [] as string[])) {
      if (entry.startsWith("SW-")) items.push(path.join(dir, entry))
    }
    return items.toSorted()
  }

  async function post() {
    if (await Bun.file(registry()).exists()) return false
    return !(await fs.readdir(root()).catch(() => [] as string[])).some((entry) => entry.startsWith("SW-"))
  }

  export async function ready() {
    const file = Bun.file(marker())
    if (!(await file.exists())) return false
    const data = await file.json().catch(() => undefined)
    return Report.safeParse(data).success && (data as Report).ready
  }

  export async function assertReady() {
    if (await ready()) return
    throw new Error(
      "Swarm v2 rollout is blocked until cleanup completes. Run `opencode swarm-cleanup --dry-run` and then `opencode swarm-cleanup --confirm purge-legacy-swarms`.",
    )
  }

  export async function run(input: { dry_run: boolean; confirm?: string }) {
    const removed = await targets()
    if (!input.dry_run && input.confirm !== "purge-legacy-swarms") {
      throw new Error("Pass `--confirm purge-legacy-swarms` to delete legacy swarm data")
    }
    if (!input.dry_run) {
      await Promise.all(removed.map((item) => fs.rm(item, { recursive: true, force: true })))
    }
    await fs.mkdir(root(), { recursive: true })
    const report = Report.parse({
      dry_run: input.dry_run,
      ready: input.dry_run ? false : await post(),
      root: root(),
      removed,
      stats: {
        files: removed.filter((item) => path.basename(item).includes(".")).length,
        dirs: removed.filter((item) => !path.basename(item).includes(".")).length,
        total: removed.length,
      },
      at: Date.now(),
    })
    if (!input.dry_run) await Bun.write(marker(), JSON.stringify(report, null, 2))
    return report
  }
}
