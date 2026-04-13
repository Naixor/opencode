import { Plugin } from "../plugin"
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
import { LlmLogScheduler } from "../log/scheduler"
import { SecurityConfig } from "../security/config"
import { SecurityAccess } from "../security/access"
import { initSandbox, refreshSandboxPolicy } from "../sandbox/init"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { recoveryExtract } from "@/memory/hooks/auto-extract"

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  ShareNext.init()
  Format.init()
  await LSP.init()
  FileWatcher.init()
  File.init()
  Vcs.init()
  Snapshot.init()
  Truncate.init()
  await LlmLogScheduler.init()
  SecurityAccess.setProjectRoot(Instance.directory)
  await SecurityConfig.loadSecurityConfig(Instance.directory)
  SecurityConfig.watchForChanges()

  // Initialize sandbox after security config is loaded (needs allowlist/deny rules)
  Bus.publish(TuiEvent.ToastShow, {
    message: "Initializing sandbox...",
    variant: "info",
    duration: 3000,
  })
  const sandboxResult = await initSandbox()
  if (sandboxResult.status === "active") {
    Bus.publish(TuiEvent.ToastShow, {
      message: "Sandbox initialized",
      variant: "success",
      duration: 2000,
    })
  } else if (sandboxResult.status === "failed") {
    Log.Default.warn("sandbox init failed, continuing without sandbox", { error: sandboxResult.error })
    Bus.publish(TuiEvent.ToastShow, {
      message: `Sandbox init failed: ${sandboxResult.error}. Run 'opencode doctor' for details.`,
      variant: "warning",
      duration: 5000,
    })
  }

  // Re-generate sandbox policy when security config changes at runtime
  SecurityConfig.onReload(async () => {
    const result = await refreshSandboxPolicy()
    if (result.status === "active") {
      Bus.publish(TuiEvent.ToastShow, {
        message: "Security config updated, sandbox policy refreshed",
        variant: "success",
        duration: 3000,
      })
    } else if (result.status === "failed") {
      Bus.publish(TuiEvent.ToastShow, {
        message: `Sandbox policy refresh failed: ${result.error}. Run 'opencode doctor' for details.`,
        variant: "warning",
        duration: 5000,
      })
    }
  })

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })

  // Async memory recovery: extract memories from historical sessions
  // that were never auto-extracted (e.g. user closed terminal before compaction).
  // Fire-and-forget — does not block startup.
  recoveryExtract().catch((err) => {
    Log.Default.warn("memory recovery extraction failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  })
}
