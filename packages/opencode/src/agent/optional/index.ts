import { Agent } from "../agent"
import { Config } from "../../config/config"
import { PermissionNext } from "@/permission/next"
import { Truncate } from "../../tool/truncation"
import { Global } from "@/global"
import { Instance } from "../../project/instance"
import path from "path"

import PROMPT_HEPHAESTUS from "../prompt/hephaestus.txt"
import PROMPT_PROMETHEUS from "../prompt/prometheus.txt"
import PROMPT_ATLAS from "../prompt/atlas.txt"
import PROMPT_LIBRARIAN from "../prompt/librarian.txt"
import PROMPT_METIS from "../prompt/metis.txt"

export namespace OptionalAgents {
  interface OptionalAgentDef {
    name: string
    description: string
    mode: Agent.Info["mode"]
    prompt: string
    temperature?: number
    permission: (defaults: PermissionNext.Ruleset, user: PermissionNext.Ruleset) => PermissionNext.Ruleset
    replaces?: string
  }

  const definitions: Record<string, OptionalAgentDef> = {
    hephaestus: {
      name: "hephaestus",
      description: "Full-access builder agent for hands-on implementation tasks.",
      mode: "subagent",
      prompt: PROMPT_HEPHAESTUS,
      permission: (defaults, user) =>
        PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
          }),
          user,
        ),
    },
    atlas: {
      name: "atlas",
      description: "Analysis-focused agent for deep codebase investigation and structural understanding.",
      mode: "subagent",
      prompt: PROMPT_ATLAS,
      permission: (defaults, user) =>
        PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            task: "deny",
            delegate_task: "deny",
          }),
          user,
        ),
    },
    librarian: {
      name: "librarian",
      description: "Documentation and knowledge retrieval agent. Read-only codebase exploration.",
      mode: "subagent",
      prompt: PROMPT_LIBRARIAN,
      permission: (defaults, user) =>
        PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            read: "allow",
            lsp: "allow",
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
            external_directory: {
              [Truncate.GLOB]: "allow",
            },
          }),
          user,
        ),
    },
    metis: {
      name: "metis",
      description: "Strategic analysis agent for evaluating trade-offs and planning approaches. Read-only.",
      mode: "subagent",
      prompt: PROMPT_METIS,
      permission: (defaults, user) =>
        PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            read: "allow",
            lsp: "allow",
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
            external_directory: {
              [Truncate.GLOB]: "allow",
            },
          }),
          user,
        ),
    },
    prometheus: {
      name: "prometheus",
      description: "Strategic planning agent. Replaces plan agent when enabled.",
      mode: "primary",
      prompt: PROMPT_PROMETHEUS,
      temperature: 0.1,
      replaces: "plan",
      permission: (defaults, user) =>
        PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_exit: "allow",
            external_directory: {
              [path.join(Global.Path.data, "plans", "*")]: "allow",
            },
            edit: {
              "*": "deny",
              [path.join(".opencode", "plans", "*.md")]: "allow",
              [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
            },
          }),
          user,
        ),
    },
  }

  export function resolve(
    cfg: Config.Info,
    defaults: PermissionNext.Ruleset,
    user: PermissionNext.Ruleset,
  ): { agents: Record<string, Agent.Info>; replacements: Record<string, string> } {
    const agents: Record<string, Agent.Info> = {}
    const replacements: Record<string, string> = {}

    for (const [key, def] of Object.entries(definitions)) {
      const agentConfig = cfg.agent?.[key]
      if (!agentConfig) continue
      // Check for explicit `enabled: true` in agent options — optional agents must be explicitly enabled
      const enabled = agentConfig.options?.enabled === true
      if (!enabled) continue

      const info: Agent.Info = {
        name: def.replaces ?? def.name,
        description: def.description,
        mode: def.mode,
        prompt: def.prompt,
        temperature: def.temperature,
        permission: def.permission(defaults, user),
        options: {},
        native: true,
      }

      if (def.replaces) {
        replacements[def.replaces] = key
        agents[def.replaces] = info
      } else {
        agents[key] = info
      }
    }

    return { agents, replacements }
  }

  export function list(): string[] {
    return Object.keys(definitions)
  }

  export function get(name: string): OptionalAgentDef | undefined {
    return definitions[name]
  }
}
