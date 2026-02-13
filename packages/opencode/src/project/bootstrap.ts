import { Plugin } from "../plugin"
import { Share } from "../share/share"
import { Format } from "../format"
import { LSP } from "../lsp"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Vcs } from "./vcs"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"
import { Snapshot } from "../snapshot"
import { Truncate } from "../tool/truncation"
import { SecurityConfig } from "../security/config"
import { StartupTrace } from "@/util/startup-trace"
import z from "zod"

export namespace Bootstrap {
  export const Phase = z.object({
    name: z.string(),
    duration: z.number(),
  })
  export type Phase = z.infer<typeof Phase>

  export const Timing = z.object({
    total: z.number(),
    phases: Phase.array(),
  })
  export type Timing = z.infer<typeof Timing>

  const state = Instance.state(() => ({
    timing: undefined as Timing | undefined,
  }))

  export function timing() {
    return state().timing
  }

  async function measure(name: string, fn: () => unknown) {
    const start = performance.now()
    await fn()
    const duration = Math.round(performance.now() - start)
    StartupTrace.record(name, duration)
    return { name, duration }
  }

  export async function run() {
    StartupTrace.begin("instance-bootstrap")
    const start = performance.now()
    Log.Default.info("bootstrapping", { directory: Instance.directory })

    const phases: Phase[] = []

    // Group A: serial, zero-cost initialization
    phases.push(await measure("share", () => Share.init()))
    phases.push(await measure("share-next", () => ShareNext.init()))
    phases.push(await measure("snapshot", () => Snapshot.init()))
    phases.push(await measure("truncate", () => Truncate.init()))

    // Group B (Plugin, Format, Security) and Group C (File, Vcs) run concurrently
    // LSP and FileWatcher deferred to background — not needed for TUI first-frame
    const [groupB, groupC] = await Promise.all([
      Promise.all([
        measure("plugin", () => Plugin.init()),
        measure("format", () => Format.init()),
        measure("security", () => SecurityConfig.loadSecurityConfig(Instance.directory)),
      ]),
      Promise.all([
        measure("file", () => File.init()),
        measure("vcs", () => Vcs.init()),
      ]),
    ])
    phases.push(...groupB, ...groupC)

    const total = Math.round(performance.now() - start)
    state().timing = { total, phases }

    Log.Default.info("bootstrap complete", { total, phases })
    StartupTrace.end("instance-bootstrap")

    // Pre-warm LSP and FileWatcher in background after bootstrap completes
    // LSP servers only spawn on first tool invocation (getClients), init just registers server configs
    // FileWatcher.init() is sync (kicks off async state factory internally, already fire-and-forget)
    queueMicrotask(() => {
      LSP.init().catch((err) => Log.Default.error("background lsp init failed", { error: err }))
      FileWatcher.init()
    })

    Bus.subscribe(Command.Event.Executed, async (payload) => {
      if (payload.properties.name === Command.Default.INIT) {
        await Project.setInitialized(Instance.project.id)
      }
    })
  }
}

export const InstanceBootstrap = Bootstrap.run
