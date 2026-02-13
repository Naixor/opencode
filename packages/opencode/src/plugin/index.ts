import type { Hooks, PluginInput, Plugin as PluginInstance } from "@opencode-ai/plugin"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Server } from "../server/server"
import { BunProc } from "../bun"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { CodexAuthPlugin } from "./codex"
import { Session } from "../session"
import { NamedError } from "@opencode-ai/util/error"
import { CopilotAuthPlugin } from "./copilot"
import { BuiltIn } from "./builtin"

export namespace Plugin {
  const log = Log.create({ service: "plugin" })

  const BUILTIN = ["opencode-anthropic-auth@0.0.13", "@gitlab/opencode-gitlab-auth@1.3.2"]

  // Built-in plugins that are directly imported (not installed from npm)
  const INTERNAL_PLUGINS: PluginInstance[] = [CodexAuthPlugin, CopilotAuthPlugin]

  const INSTALL_TIMEOUT_MS = 10_000

  async function installWithTimeout(pkg: string, version: string): Promise<string> {
    return Promise.race([
      BunProc.install(pkg, version),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`install timed out after ${INSTALL_TIMEOUT_MS}ms for ${pkg}@${version}`)),
          INSTALL_TIMEOUT_MS,
        ),
      ),
    ])
  }

  const state = Instance.state(async () => {
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      // @ts-ignore - fetch type incompatibility
      fetch: async (...args) => Server.App().fetch(...args),
    })
    const config = await Config.get()
    const hooks: Hooks[] = []
    // PluginInput is read-only — safe to share across parallel plugin loads
    const input: PluginInput = {
      client,
      project: Instance.project,
      worktree: Instance.worktree,
      directory: Instance.directory,
      serverUrl: Server.url(),
      $: Bun.$,
      hasBuiltIn: BuiltIn.has,
    }

    // Load internal plugins in parallel
    const internalResults = await Promise.allSettled(
      INTERNAL_PLUGINS.map(async (plugin) => {
        log.info("loading internal plugin", { name: plugin.name })
        return plugin(input)
      }),
    )
    for (const result of internalResults) {
      if (result.status === "fulfilled") {
        hooks.push(result.value)
        continue
      }
      log.error("internal plugin failed", {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      })
    }

    const plugins = [...(config.plugin ?? [])]
    if (!Flag.OPENCODE_DISABLE_DEFAULT_PLUGINS) {
      plugins.push(...BUILTIN)
    }

    // Load external plugins in parallel (install + import + init)
    const externalResults = await Promise.allSettled(
      plugins
        .filter((p) => !p.includes("opencode-openai-codex-auth") && !p.includes("opencode-copilot-auth"))
        .map(async (plugin) => {
          log.info("loading plugin", { path: plugin })
          let resolved = plugin
          if (!plugin.startsWith("file://")) {
            const lastAtIndex = plugin.lastIndexOf("@")
            const pkg = lastAtIndex > 0 ? plugin.substring(0, lastAtIndex) : plugin
            const version = lastAtIndex > 0 ? plugin.substring(lastAtIndex + 1) : "latest"
            const builtin = BUILTIN.some((x) => x.startsWith(pkg + "@"))
            resolved = await installWithTimeout(pkg, version).catch((err) => {
              if (!builtin) throw err

              const message = err instanceof Error ? err.message : String(err)
              log.error("failed to install builtin plugin", {
                pkg,
                version,
                error: message,
              })
              Bus.publish(Session.Event.Error, {
                error: new NamedError.Unknown({
                  message: `Failed to install built-in plugin ${pkg}@${version}: ${message}`,
                }).toObject(),
              })

              return ""
            })
            if (!resolved) return []
          }
          const mod = await import(resolved)
          // Prevent duplicate initialization when plugins export the same function
          // as both a named export and default export (e.g., `export const X` and `export default X`).
          const seen = new Set<PluginInstance>()
          const pluginHooks: Hooks[] = []
          for (const [_name, fn] of Object.entries<PluginInstance>(mod)) {
            if (seen.has(fn)) continue
            seen.add(fn)
            pluginHooks.push(await fn(input))
          }
          return pluginHooks
        }),
    )

    for (const result of externalResults) {
      if (result.status === "fulfilled") {
        hooks.push(...result.value)
        continue
      }
      log.error("plugin loading failed", {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      })
    }

    return {
      hooks,
      input,
    }
  })

  export async function trigger<
    Name extends Exclude<keyof Required<Hooks>, "auth" | "event" | "tool">,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(name: Name, input: Input, output: Output): Promise<Output> {
    if (!name) return output
    for (const hook of await state().then((x) => x.hooks)) {
      const fn = hook[name]
      if (!fn) continue
      // @ts-expect-error if you feel adventurous, please fix the typing, make sure to bump the try-counter if you
      // give up.
      // try-counter: 2
      await fn(input, output)
    }
    return output
  }

  export async function list() {
    return state().then((x) => x.hooks)
  }

  export async function init() {
    const hooks = await state().then((x) => x.hooks)
    const config = await Config.get()
    for (const hook of hooks) {
      // @ts-expect-error this is because we haven't moved plugin to sdk v2
      await hook.config?.(config)
    }
    Bus.subscribeAll(async (input) => {
      const hooks = await state().then((x) => x.hooks)
      for (const hook of hooks) {
        hook["event"]?.({
          event: input,
        })
      }
    })
  }
}
