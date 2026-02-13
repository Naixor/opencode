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

    phases.push(await measure("plugin", () => Plugin.init()))
    phases.push(await measure("share", () => Share.init()))
    phases.push(await measure("share-next", () => ShareNext.init()))
    phases.push(await measure("format", () => Format.init()))
    phases.push(await measure("lsp", () => LSP.init()))
    phases.push(await measure("file-watcher", () => FileWatcher.init()))
    phases.push(await measure("file", () => File.init()))
    phases.push(await measure("vcs", () => Vcs.init()))
    phases.push(await measure("snapshot", () => Snapshot.init()))
    phases.push(await measure("truncate", () => Truncate.init()))
    phases.push(await measure("security", () => SecurityConfig.loadSecurityConfig(Instance.directory)))

    const total = Math.round(performance.now() - start)
    state().timing = { total, phases }

    Log.Default.info("bootstrap complete", { total, phases })
    StartupTrace.end("instance-bootstrap")

    Bus.subscribe(Command.Event.Executed, async (payload) => {
      if (payload.properties.name === Command.Default.INIT) {
        await Project.setInitialized(Instance.project.id)
      }
    })
  }
}

export const InstanceBootstrap = Bootstrap.run
