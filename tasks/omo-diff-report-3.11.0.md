# OMO Upstream Diff Report

- **Baseline version:** 3.10.0
- **Latest version:** 3.11.0
- **Source:** local
- **Date:** 2026-03-11

## Summary

Total components: 145
- New: 52
- Modified: 89
- Removed: 4

By category:
- Backport recommended: 52
- Review needed: 74
- Skip (diverged): 19

## Tools

| Name | Status | Category | Files | Details |
|------|--------|----------|-------|---------|
| interactive-bash | modified | review needed | 4 | tool 'interactive-bash' may have changes (4 files) |
| ast-grep | modified | review needed | 13 | tool 'ast-grep' may have changes (13 files) |
| background-task | modified | review needed | 16 | tool 'background-task' may have changes (16 files) |
| skill | modified | review needed | 4 | tool 'skill' may have changes (4 files) |
| slashcommand | modified | skip (diverged) | 4 | tool 'slashcommand' may have changes (4 files) |
| delegate-task | modified | review needed | 31 | tool 'delegate-task' may have changes (31 files) |
| session-manager | modified | review needed | 6 | tool 'session-manager' may have changes (6 files) |
| lsp | modified | review needed | 28 | tool 'lsp' may have changes (28 files) |
| grep | modified | review needed | 7 | tool 'grep' may have changes (7 files) |
| skill-mcp | modified | review needed | 4 | tool 'skill-mcp' may have changes (4 files) |
| hashline-edit | modified | review needed | 19 | tool 'hashline-edit' may have changes (19 files) |
| call-omo-agent | modified | skip (diverged) | 14 | tool 'call-omo-agent' may have changes (14 files) |
| task | modified | review needed | 7 | tool 'task' may have changes (7 files) |
| look-at | modified | review needed | 10 | tool 'look-at' may have changes (10 files) |
| glob | modified | review needed | 6 | tool 'glob' may have changes (6 files) |

### Review Needed

**interactive-bash:**
- `packages/opencode/src/tool/interactive-bash.txt`
- `packages/opencode/src/tool/interactive-bash.ts`

**ast-grep:**
- `packages/opencode/src/tool/ast-grep-search.txt`
- `packages/opencode/src/tool/ast-grep-replace.txt`
- `packages/opencode/src/tool/ast-grep.ts`

**background-task:**
- `packages/opencode/src/tool/background-task.ts`

**skill:**
- `packages/opencode/src/tool/skill-mcp.ts`
- `packages/opencode/src/tool/skill-mcp.txt`
- `packages/opencode/src/tool/skill.ts`

**delegate-task:**
- `packages/opencode/src/tool/delegate-task.ts`
- `packages/opencode/src/tool/delegate-task.txt`

**session-manager:**
- `packages/opencode/src/tool/session-manager.ts`

**lsp:**
- `packages/opencode/src/tool/lsp-hover.txt`
- `packages/opencode/src/tool/lsp-rename.txt`
- `packages/opencode/src/tool/lsp-find-references.txt`
- `packages/opencode/src/tool/lsp-goto-definition.txt`
- `packages/opencode/src/tool/lsp.txt`
- `packages/opencode/src/tool/lsp-tools-extended.ts`
- `packages/opencode/src/tool/lsp.ts`
- `packages/opencode/src/tool/lsp-diagnostics.txt`
- `packages/opencode/src/tool/lsp-call-hierarchy.txt`
- `packages/opencode/src/tool/lsp-tools.ts`
- `packages/opencode/src/tool/lsp-symbols.txt`
- `packages/opencode/src/tool/lsp-prepare-rename.txt`
- `packages/opencode/src/tool/lsp-implementation.txt`

**grep:**
- `packages/opencode/src/tool/grep.txt`
- `packages/opencode/src/tool/grep.ts`

**skill-mcp:**
- `packages/opencode/src/tool/skill-mcp.ts`
- `packages/opencode/src/tool/skill-mcp.txt`

**hashline-edit:**
- `packages/opencode/src/tool/hashline-edit.ts`

**task:**
- `packages/opencode/src/tool/task.txt`
- `packages/opencode/src/tool/task.ts`

**look-at:**
- `packages/opencode/src/tool/look-at.txt`
- `packages/opencode/src/tool/look-at.ts`

**glob:**
- `packages/opencode/src/tool/glob.txt`
- `packages/opencode/src/tool/glob.ts`

## Hooks

| Name | Status | Category | Files | Details |
|------|--------|----------|-------|---------|
| context-window-monitor | modified | review needed | 1 | hook 'context-window-monitor' may have changes (1 files) |
| think-mode | modified | review needed | 5 | hook 'think-mode' may have changes (5 files) |
| auto-slash-command | modified | skip (diverged) | 6 | hook 'auto-slash-command' may have changes (6 files) |
| session-recovery | modified | review needed | 24 | hook 'session-recovery' may have changes (24 files) |
| directory-readme-injector | modified | review needed | 6 | hook 'directory-readme-injector' may have changes (6 files) |
| directory-agents-injector | modified | review needed | 6 | hook 'directory-agents-injector' may have changes (6 files) |
| todo-continuation-enforcer | modified | review needed | 13 | hook 'todo-continuation-enforcer' may have changes (13 files) |
| no-hephaestus-non-gpt | modified | skip (diverged) | 2 | hook 'no-hephaestus-non-gpt' may have changes (2 files) |
| unstable-agent-babysitter | modified | review needed | 3 | hook 'unstable-agent-babysitter' may have changes (3 files) |
| runtime-fallback | modified | review needed | 12 | hook 'runtime-fallback' may have changes (12 files) |
| model-fallback | modified | review needed | 1 | hook 'model-fallback' may have changes (1 files) |
| task-resume-info | modified | review needed | 2 | hook 'task-resume-info' may have changes (2 files) |
| write-existing-file-guard | modified | review needed | 2 | hook 'write-existing-file-guard' may have changes (2 files) |
| interactive-bash-session | modified | review needed | 9 | hook 'interactive-bash-session' may have changes (9 files) |
| prometheus-md-only | modified | skip (diverged) | 6 | hook 'prometheus-md-only' may have changes (6 files) |
| anthropic-context-window-limit-recovery | modified | review needed | 24 | hook 'anthropic-context-window-limit-recovery' may have changes (24 files) |
| compaction-todo-preserver | modified | review needed | 2 | hook 'compaction-todo-preserver' may have changes (2 files) |
| session-notification-utils | new | backport recommended | 1 | New hook 'session-notification-utils' in OMO 3.11.0 (1 files) |
| background-notification | modified | skip (diverged) | 3 | hook 'background-notification' may have changes (3 files) |
| session-todo-status | new | backport recommended | 1 | New hook 'session-todo-status' in OMO 3.11.0 (1 files) |
| compaction-context-injector | modified | review needed | 2 | hook 'compaction-context-injector' may have changes (2 files) |
| question-label-truncator | modified | review needed | 2 | hook 'question-label-truncator' may have changes (2 files) |
| tasks-todowrite-disabler | modified | skip (diverged) | 3 | hook 'tasks-todowrite-disabler' may have changes (3 files) |
| auto-update-checker | modified | skip (diverged) | 24 | hook 'auto-update-checker' may have changes (24 files) |
| anthropic-effort | modified | review needed | 2 | hook 'anthropic-effort' may have changes (2 files) |
| read-image-resizer | modified | review needed | 5 | hook 'read-image-resizer' may have changes (5 files) |
| edit-error-recovery | modified | review needed | 2 | hook 'edit-error-recovery' may have changes (2 files) |
| agent-usage-reminder | modified | skip (diverged) | 5 | hook 'agent-usage-reminder' may have changes (5 files) |
| thinking-block-validator | modified | review needed | 2 | hook 'thinking-block-validator' may have changes (2 files) |
| comment-checker | modified | review needed | 7 | hook 'comment-checker' may have changes (7 files) |
| stop-continuation-guard | modified | review needed | 2 | hook 'stop-continuation-guard' may have changes (2 files) |
| no-sisyphus-gpt | modified | skip (diverged) | 2 | hook 'no-sisyphus-gpt' may have changes (2 files) |
| session-notification-scheduler | new | backport recommended | 1 | New hook 'session-notification-scheduler' in OMO 3.11.0 (1 files) |
| session-notification-sender | new | backport recommended | 1 | New hook 'session-notification-sender' in OMO 3.11.0 (1 files) |
| json-error-recovery | modified | review needed | 2 | hook 'json-error-recovery' may have changes (2 files) |
| empty-task-response-detector | modified | review needed | 1 | hook 'empty-task-response-detector' may have changes (1 files) |
| start-work | modified | skip (diverged) | 4 | hook 'start-work' may have changes (4 files) |
| delegate-task-retry | modified | review needed | 4 | hook 'delegate-task-retry' may have changes (4 files) |
| session-notification | modified | review needed | 1 | hook 'session-notification' may have changes (1 files) |
| keyword-detector | modified | review needed | 15 | hook 'keyword-detector' may have changes (15 files) |
| sisyphus-junior-notepad | modified | skip (diverged) | 3 | hook 'sisyphus-junior-notepad' may have changes (3 files) |
| category-skill-reminder | modified | skip (diverged) | 3 | hook 'category-skill-reminder' may have changes (3 files) |
| rules-injector | modified | review needed | 15 | hook 'rules-injector' may have changes (15 files) |
| non-interactive-env | modified | skip (diverged) | 5 | hook 'non-interactive-env' may have changes (5 files) |
| atlas | modified | skip (diverged) | 17 | hook 'atlas' may have changes (17 files) |
| preemptive-compaction | modified | review needed | 1 | hook 'preemptive-compaction' may have changes (1 files) |
| ralph-loop | modified | skip (diverged) | 19 | hook 'ralph-loop' may have changes (19 files) |
| tool-output-truncator | modified | review needed | 1 | hook 'tool-output-truncator' may have changes (1 files) |
| task-reminder | modified | review needed | 2 | hook 'task-reminder' may have changes (2 files) |
| hashline-edit-diff-enhancer | modified | skip (diverged) | 1 | hook 'hashline-edit-diff-enhancer' may have changes (1 files) |
| hashline-read-enhancer | modified | skip (diverged) | 2 | hook 'hashline-read-enhancer' may have changes (2 files) |
| session-notification-formatting | new | backport recommended | 1 | New hook 'session-notification-formatting' in OMO 3.11.0 (1 files) |
| claude-code-hooks | modified | skip (diverged) | 22 | hook 'claude-code-hooks' may have changes (22 files) |
| iterative-error-recovery | removed | review needed | 0 | hook 'iterative-error-recovery' was in baseline but not found in OMO 3.11.0 |
| grep-output-truncator | removed | review needed | 0 | hook 'grep-output-truncator' was in baseline but not found in OMO 3.11.0 |
| subagent-question-blocker | removed | review needed | 0 | hook 'subagent-question-blocker' was in baseline but not found in OMO 3.11.0 |

### New Components

**session-notification-utils** (hook):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/hooks/session-notification-utils.ts`
Potential target in OpenCode:
- `packages/opencode/src/session/hooks/`

**session-todo-status** (hook):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/hooks/session-todo-status.ts`
Potential target in OpenCode:
- `packages/opencode/src/session/hooks/`

**session-notification-scheduler** (hook):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/hooks/session-notification-scheduler.ts`
Potential target in OpenCode:
- `packages/opencode/src/session/hooks/`

**session-notification-sender** (hook):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/hooks/session-notification-sender.ts`
Potential target in OpenCode:
- `packages/opencode/src/session/hooks/`

**session-notification-formatting** (hook):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/hooks/session-notification-formatting.ts`
Potential target in OpenCode:
- `packages/opencode/src/session/hooks/`

### Review Needed

**context-window-monitor:**
- `packages/opencode/src/session/hooks/`

**think-mode:**
- `packages/opencode/src/session/hooks/`

**session-recovery:**
- `packages/opencode/src/session/hooks/`

**directory-readme-injector:**
- `packages/opencode/src/session/hooks/`

**directory-agents-injector:**
- `packages/opencode/src/session/hooks/`

**todo-continuation-enforcer:**
- `packages/opencode/src/session/hooks/`

**unstable-agent-babysitter:**
- `packages/opencode/src/session/hooks/`

**runtime-fallback:**
- `packages/opencode/src/session/hooks/`

**model-fallback:**
- `packages/opencode/src/session/hooks/`

**task-resume-info:**
- `packages/opencode/src/session/hooks/`

**write-existing-file-guard:**
- `packages/opencode/src/session/hooks/`

**interactive-bash-session:**
- `packages/opencode/src/session/hooks/`

**anthropic-context-window-limit-recovery:**
- `packages/opencode/src/session/hooks/`

**compaction-todo-preserver:**
- `packages/opencode/src/session/hooks/`

**compaction-context-injector:**
- `packages/opencode/src/session/hooks/`

**question-label-truncator:**
- `packages/opencode/src/session/hooks/`

**anthropic-effort:**
- `packages/opencode/src/session/hooks/`

**read-image-resizer:**
- `packages/opencode/src/session/hooks/`

**edit-error-recovery:**
- `packages/opencode/src/session/hooks/`

**thinking-block-validator:**
- `packages/opencode/src/session/hooks/`

**comment-checker:**
- `packages/opencode/src/session/hooks/`

**stop-continuation-guard:**
- `packages/opencode/src/session/hooks/`

**json-error-recovery:**
- `packages/opencode/src/session/hooks/`

**empty-task-response-detector:**
- `packages/opencode/src/session/hooks/`

**delegate-task-retry:**
- `packages/opencode/src/session/hooks/`

**session-notification:**
- `packages/opencode/src/session/hooks/`

**keyword-detector:**
- `packages/opencode/src/session/hooks/`

**rules-injector:**
- `packages/opencode/src/session/hooks/`

**preemptive-compaction:**
- `packages/opencode/src/session/hooks/`

**tool-output-truncator:**
- `packages/opencode/src/session/hooks/`

**task-reminder:**
- `packages/opencode/src/session/hooks/`

## Agents

| Name | Status | Category | Files | Details |
|------|--------|----------|-------|---------|
| metis | modified | review needed | 1 | agent 'metis' may have changes (1 files) |
| momus | modified | review needed | 1 | agent 'momus' may have changes (1 files) |
| builtin-agents | new | backport recommended | 9 | New agent 'builtin-agents' in OMO 3.11.0 (9 files) |
| sisyphus-junior | modified | review needed | 7 | agent 'sisyphus-junior' may have changes (7 files) |
| oracle | modified | review needed | 1 | agent 'oracle' may have changes (1 files) |
| agent-builder | new | backport recommended | 1 | New agent 'agent-builder' in OMO 3.11.0 (1 files) |
| sisyphus | modified | review needed | 1 | agent 'sisyphus' may have changes (1 files) |
| explore | new | backport recommended | 1 | New agent 'explore' in OMO 3.11.0 (1 files) |
| hephaestus | modified | review needed | 5 | agent 'hephaestus' may have changes (5 files) |
| multimodal-looker | modified | review needed | 1 | agent 'multimodal-looker' may have changes (1 files) |
| custom-agent-summaries | new | backport recommended | 1 | New agent 'custom-agent-summaries' in OMO 3.11.0 (1 files) |
| librarian | modified | review needed | 1 | agent 'librarian' may have changes (1 files) |
| dynamic-agent-prompt-builder | new | backport recommended | 1 | New agent 'dynamic-agent-prompt-builder' in OMO 3.11.0 (1 files) |
| env-context | new | backport recommended | 1 | New agent 'env-context' in OMO 3.11.0 (1 files) |
| prometheus | modified | review needed | 10 | agent 'prometheus' may have changes (10 files) |
| atlas | modified | review needed | 6 | agent 'atlas' may have changes (6 files) |
| omo-explore | removed | review needed | 0 | agent 'omo-explore' was in baseline but not found in OMO 3.11.0 |

### New Components

**builtin-agents** (agent):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/agents/builtin-agents/general-agents.ts`
- `../../../../../tmp/oh-my-openagent/src/agents/builtin-agents/available-skills.ts`
- `../../../../../tmp/oh-my-openagent/src/agents/builtin-agents/atlas-agent.ts`
- `../../../../../tmp/oh-my-openagent/src/agents/builtin-agents/model-resolution.ts`
- `../../../../../tmp/oh-my-openagent/src/agents/builtin-agents/sisyphus-agent.ts`
- `../../../../../tmp/oh-my-openagent/src/agents/builtin-agents/resolve-file-uri.ts`
- `../../../../../tmp/oh-my-openagent/src/agents/builtin-agents/agent-overrides.ts`
- `../../../../../tmp/oh-my-openagent/src/agents/builtin-agents/hephaestus-agent.ts`
- `../../../../../tmp/oh-my-openagent/src/agents/builtin-agents/environment-context.ts`
Potential target in OpenCode:
- `packages/opencode/src/agent/`

**agent-builder** (agent):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/agents/agent-builder.ts`
Potential target in OpenCode:
- `packages/opencode/src/agent/`

**explore** (agent):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/agents/explore.ts`
Potential target in OpenCode:
- `packages/opencode/src/agent/prompt/explore.txt`

**custom-agent-summaries** (agent):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/agents/custom-agent-summaries.ts`
Potential target in OpenCode:
- `packages/opencode/src/agent/`

**dynamic-agent-prompt-builder** (agent):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/agents/dynamic-agent-prompt-builder.ts`
Potential target in OpenCode:
- `packages/opencode/src/agent/`

**env-context** (agent):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/agents/env-context.ts`
Potential target in OpenCode:
- `packages/opencode/src/agent/`

### Review Needed

**metis:**
- `packages/opencode/src/agent/prompt/metis.txt`

**momus:**
- `packages/opencode/src/agent/prompt/momus.txt`

**sisyphus-junior:**
- `packages/opencode/src/agent/prompt/sisyphus-junior.txt`

**oracle:**
- `packages/opencode/src/agent/prompt/oracle.txt`

**sisyphus:**
- `packages/opencode/src/agent/sisyphus.ts`
- `packages/opencode/src/agent/prompt/sisyphus-junior.txt`
- `packages/opencode/src/agent/prompt/sisyphus.txt`

**hephaestus:**
- `packages/opencode/src/agent/prompt/hephaestus.txt`

**multimodal-looker:**
- `packages/opencode/src/agent/prompt/multimodal-looker.txt`

**librarian:**
- `packages/opencode/src/agent/prompt/librarian.txt`

**prometheus:**
- `packages/opencode/src/agent/prompt/prometheus.txt`

**atlas:**
- `packages/opencode/src/agent/prompt/atlas.txt`

## Features

| Name | Status | Category | Files | Details |
|------|--------|----------|-------|---------|
| claude-tasks | new | backport recommended | 3 | New feature 'claude-tasks' in OMO 3.11.0 (3 files) |
| hook-message-injector | new | backport recommended | 4 | New feature 'hook-message-injector' in OMO 3.11.0 (4 files) |
| claude-code-plugin-loader | new | backport recommended | 10 | New feature 'claude-code-plugin-loader' in OMO 3.11.0 (10 files) |
| boulder-state | new | backport recommended | 4 | New feature 'boulder-state' in OMO 3.11.0 (4 files) |
| task-toast-manager | new | backport recommended | 3 | New feature 'task-toast-manager' in OMO 3.11.0 (3 files) |
| background-agent | new | backport recommended | 19 | New feature 'background-agent' in OMO 3.11.0 (19 files) |
| claude-code-mcp-loader | new | backport recommended | 5 | New feature 'claude-code-mcp-loader' in OMO 3.11.0 (5 files) |
| tmux-subagent | new | backport recommended | 24 | New feature 'tmux-subagent' in OMO 3.11.0 (24 files) |
| mcp-oauth | new | backport recommended | 9 | New feature 'mcp-oauth' in OMO 3.11.0 (9 files) |
| claude-code-session-state | new | backport recommended | 2 | New feature 'claude-code-session-state' in OMO 3.11.0 (2 files) |
| builtin-skills | new | backport recommended | 10 | New feature 'builtin-skills' in OMO 3.11.0 (10 files) |
| context-injector | new | backport recommended | 4 | New feature 'context-injector' in OMO 3.11.0 (4 files) |
| opencode-skill-loader | new | backport recommended | 25 | New feature 'opencode-skill-loader' in OMO 3.11.0 (25 files) |
| run-continuation-state | new | backport recommended | 4 | New feature 'run-continuation-state' in OMO 3.11.0 (4 files) |
| claude-code-command-loader | new | backport recommended | 3 | New feature 'claude-code-command-loader' in OMO 3.11.0 (3 files) |
| tool-metadata-store | new | backport recommended | 2 | New feature 'tool-metadata-store' in OMO 3.11.0 (2 files) |
| skill-mcp-manager | new | backport recommended | 10 | New feature 'skill-mcp-manager' in OMO 3.11.0 (10 files) |
| builtin-commands | new | backport recommended | 9 | New feature 'builtin-commands' in OMO 3.11.0 (9 files) |
| claude-code-agent-loader | new | backport recommended | 3 | New feature 'claude-code-agent-loader' in OMO 3.11.0 (3 files) |

### New Components

**claude-tasks** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/claude-tasks/storage.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-tasks/types.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-tasks/session-storage.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

**hook-message-injector** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/hook-message-injector/types.ts`
- `../../../../../tmp/oh-my-openagent/src/features/hook-message-injector/injector.ts`
- `../../../../../tmp/oh-my-openagent/src/features/hook-message-injector/constants.ts`
- `../../../../../tmp/oh-my-openagent/src/features/hook-message-injector/index.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

**claude-code-plugin-loader** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-plugin-loader/command-loader.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-plugin-loader/skill-loader.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-plugin-loader/agent-loader.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-plugin-loader/mcp-server-loader.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-plugin-loader/loader.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-plugin-loader/plugin-path-resolver.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-plugin-loader/hook-loader.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-plugin-loader/types.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-plugin-loader/discovery.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-plugin-loader/index.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

**boulder-state** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/boulder-state/storage.ts`
- `../../../../../tmp/oh-my-openagent/src/features/boulder-state/types.ts`
- `../../../../../tmp/oh-my-openagent/src/features/boulder-state/constants.ts`
- `../../../../../tmp/oh-my-openagent/src/features/boulder-state/index.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

**task-toast-manager** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/task-toast-manager/manager.ts`
- `../../../../../tmp/oh-my-openagent/src/features/task-toast-manager/types.ts`
- `../../../../../tmp/oh-my-openagent/src/features/task-toast-manager/index.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

**background-agent** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/background-agent/state.ts`
- `../../../../../tmp/oh-my-openagent/src/features/background-agent/manager.ts`
- `../../../../../tmp/oh-my-openagent/src/features/background-agent/task-poller.ts`
- `../../../../../tmp/oh-my-openagent/src/features/background-agent/compaction-aware-message-resolver.ts`
- `../../../../../tmp/oh-my-openagent/src/features/background-agent/session-idle-event-handler.ts`
- `../../../../../tmp/oh-my-openagent/src/features/background-agent/task-history.ts`
- `../../../../../tmp/oh-my-openagent/src/features/background-agent/spawner.ts`
- `../../../../../tmp/oh-my-openagent/src/features/background-agent/opencode-client.ts`
- `../../../../../tmp/oh-my-openagent/src/features/background-agent/duration-formatter.ts`
- `../../../../../tmp/oh-my-openagent/src/features/background-agent/fallback-retry-handler.ts`
- ... and 9 more
Potential target in OpenCode:
- `packages/opencode/src/`

**claude-code-mcp-loader** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-mcp-loader/transformer.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-mcp-loader/loader.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-mcp-loader/env-expander.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-mcp-loader/types.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-mcp-loader/index.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

**tmux-subagent** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/tmux-subagent/manager.ts`
- `../../../../../tmp/oh-my-openagent/src/features/tmux-subagent/spawn-target-finder.ts`
- `../../../../../tmp/oh-my-openagent/src/features/tmux-subagent/event-handlers.ts`
- `../../../../../tmp/oh-my-openagent/src/features/tmux-subagent/polling.ts`
- `../../../../../tmp/oh-my-openagent/src/features/tmux-subagent/session-ready-waiter.ts`
- `../../../../../tmp/oh-my-openagent/src/features/tmux-subagent/polling-manager.ts`
- `../../../../../tmp/oh-my-openagent/src/features/tmux-subagent/session-created-handler.ts`
- `../../../../../tmp/oh-my-openagent/src/features/tmux-subagent/action-executor-core.ts`
- `../../../../../tmp/oh-my-openagent/src/features/tmux-subagent/session-deleted-handler.ts`
- `../../../../../tmp/oh-my-openagent/src/features/tmux-subagent/grid-planning.ts`
- ... and 14 more
Potential target in OpenCode:
- `packages/opencode/src/`

**mcp-oauth** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/mcp-oauth/dcr.ts`
- `../../../../../tmp/oh-my-openagent/src/features/mcp-oauth/schema.ts`
- `../../../../../tmp/oh-my-openagent/src/features/mcp-oauth/storage.ts`
- `../../../../../tmp/oh-my-openagent/src/features/mcp-oauth/step-up.ts`
- `../../../../../tmp/oh-my-openagent/src/features/mcp-oauth/oauth-authorization-flow.ts`
- `../../../../../tmp/oh-my-openagent/src/features/mcp-oauth/resource-indicator.ts`
- `../../../../../tmp/oh-my-openagent/src/features/mcp-oauth/discovery.ts`
- `../../../../../tmp/oh-my-openagent/src/features/mcp-oauth/provider.ts`
- `../../../../../tmp/oh-my-openagent/src/features/mcp-oauth/callback-server.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

**claude-code-session-state** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-session-state/state.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-session-state/index.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

**builtin-skills** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/builtin-skills/types.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-skills/index.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-skills/skills.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-skills/skills/git-master.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-skills/skills/git-master-skill-metadata.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-skills/skills/frontend-ui-ux.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-skills/skills/dev-browser.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-skills/skills/playwright-cli.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-skills/skills/index.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-skills/skills/playwright.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

**context-injector** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/context-injector/types.ts`
- `../../../../../tmp/oh-my-openagent/src/features/context-injector/injector.ts`
- `../../../../../tmp/oh-my-openagent/src/features/context-injector/collector.ts`
- `../../../../../tmp/oh-my-openagent/src/features/context-injector/index.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

**opencode-skill-loader** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/opencode-skill-loader/merger.ts`
- `../../../../../tmp/oh-my-openagent/src/features/opencode-skill-loader/skill-deduplication.ts`
- `../../../../../tmp/oh-my-openagent/src/features/opencode-skill-loader/skill-content.ts`
- `../../../../../tmp/oh-my-openagent/src/features/opencode-skill-loader/allowed-tools-parser.ts`
- `../../../../../tmp/oh-my-openagent/src/features/opencode-skill-loader/skill-resolution-options.ts`
- `../../../../../tmp/oh-my-openagent/src/features/opencode-skill-loader/config-source-discovery.ts`
- `../../../../../tmp/oh-my-openagent/src/features/opencode-skill-loader/loaded-skill-template-extractor.ts`
- `../../../../../tmp/oh-my-openagent/src/features/opencode-skill-loader/discover-worker.ts`
- `../../../../../tmp/oh-my-openagent/src/features/opencode-skill-loader/blocking.ts`
- `../../../../../tmp/oh-my-openagent/src/features/opencode-skill-loader/loader.ts`
- ... and 15 more
Potential target in OpenCode:
- `packages/opencode/src/`

**run-continuation-state** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/run-continuation-state/storage.ts`
- `../../../../../tmp/oh-my-openagent/src/features/run-continuation-state/types.ts`
- `../../../../../tmp/oh-my-openagent/src/features/run-continuation-state/constants.ts`
- `../../../../../tmp/oh-my-openagent/src/features/run-continuation-state/index.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

**claude-code-command-loader** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-command-loader/loader.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-command-loader/types.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-command-loader/index.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

**tool-metadata-store** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/tool-metadata-store/index.ts`
- `../../../../../tmp/oh-my-openagent/src/features/tool-metadata-store/store.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

**skill-mcp-manager** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/skill-mcp-manager/manager.ts`
- `../../../../../tmp/oh-my-openagent/src/features/skill-mcp-manager/connection.ts`
- `../../../../../tmp/oh-my-openagent/src/features/skill-mcp-manager/cleanup.ts`
- `../../../../../tmp/oh-my-openagent/src/features/skill-mcp-manager/types.ts`
- `../../../../../tmp/oh-my-openagent/src/features/skill-mcp-manager/oauth-handler.ts`
- `../../../../../tmp/oh-my-openagent/src/features/skill-mcp-manager/env-cleaner.ts`
- `../../../../../tmp/oh-my-openagent/src/features/skill-mcp-manager/stdio-client.ts`
- `../../../../../tmp/oh-my-openagent/src/features/skill-mcp-manager/index.ts`
- `../../../../../tmp/oh-my-openagent/src/features/skill-mcp-manager/connection-type.ts`
- `../../../../../tmp/oh-my-openagent/src/features/skill-mcp-manager/http-client.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

**builtin-commands** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/builtin-commands/commands.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-commands/types.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-commands/index.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-commands/templates/start-work.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-commands/templates/init-deep.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-commands/templates/stop-continuation.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-commands/templates/ralph-loop.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-commands/templates/handoff.ts`
- `../../../../../tmp/oh-my-openagent/src/features/builtin-commands/templates/refactor.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

**claude-code-agent-loader** (feature):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-agent-loader/loader.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-agent-loader/types.ts`
- `../../../../../tmp/oh-my-openagent/src/features/claude-code-agent-loader/index.ts`
Potential target in OpenCode:
- `packages/opencode/src/`

## Plugin System

| Name | Status | Category | Files | Details |
|------|--------|----------|-------|---------|
| skill-context | new | backport recommended | 1 | New plugin 'skill-context' in OMO 3.11.0 (1 files) |
| tool-execute-before | new | backport recommended | 1 | New plugin 'tool-execute-before' in OMO 3.11.0 (1 files) |
| ultrawork-model-override | new | backport recommended | 1 | New plugin 'ultrawork-model-override' in OMO 3.11.0 (1 files) |
| chat-headers | new | backport recommended | 1 | New plugin 'chat-headers' in OMO 3.11.0 (1 files) |
| messages-transform | new | backport recommended | 1 | New plugin 'messages-transform' in OMO 3.11.0 (1 files) |
| tool-registry | new | backport recommended | 1 | New plugin 'tool-registry' in OMO 3.11.0 (1 files) |
| available-categories | new | backport recommended | 1 | New plugin 'available-categories' in OMO 3.11.0 (1 files) |
| recent-synthetic-idles | new | backport recommended | 1 | New plugin 'recent-synthetic-idles' in OMO 3.11.0 (1 files) |
| chat-message | new | backport recommended | 1 | New plugin 'chat-message' in OMO 3.11.0 (1 files) |
| ultrawork-db-model-override | new | backport recommended | 1 | New plugin 'ultrawork-db-model-override' in OMO 3.11.0 (1 files) |
| session-status-normalizer | new | backport recommended | 1 | New plugin 'session-status-normalizer' in OMO 3.11.0 (1 files) |
| hooks | new | backport recommended | 6 | New plugin 'hooks' in OMO 3.11.0 (6 files) |
| system-transform | new | backport recommended | 1 | New plugin 'system-transform' in OMO 3.11.0 (1 files) |
| unstable-agent-babysitter | new | backport recommended | 1 | New plugin 'unstable-agent-babysitter' in OMO 3.11.0 (1 files) |
| tool-execute-after | new | backport recommended | 1 | New plugin 'tool-execute-after' in OMO 3.11.0 (1 files) |
| event | new | backport recommended | 1 | New plugin 'event' in OMO 3.11.0 (1 files) |
| session-agent-resolver | new | backport recommended | 1 | New plugin 'session-agent-resolver' in OMO 3.11.0 (1 files) |
| chat-params | new | backport recommended | 1 | New plugin 'chat-params' in OMO 3.11.0 (1 files) |

### New Components

**skill-context** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/skill-context.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**tool-execute-before** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/tool-execute-before.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**ultrawork-model-override** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/ultrawork-model-override.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**chat-headers** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/chat-headers.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**messages-transform** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/messages-transform.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**tool-registry** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/tool-registry.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**available-categories** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/available-categories.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**recent-synthetic-idles** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/recent-synthetic-idles.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**chat-message** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/chat-message.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**ultrawork-db-model-override** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/ultrawork-db-model-override.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**session-status-normalizer** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/session-status-normalizer.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**hooks** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/hooks/create-session-hooks.ts`
- `../../../../../tmp/oh-my-openagent/src/plugin/hooks/create-core-hooks.ts`
- `../../../../../tmp/oh-my-openagent/src/plugin/hooks/create-skill-hooks.ts`
- `../../../../../tmp/oh-my-openagent/src/plugin/hooks/create-tool-guard-hooks.ts`
- `../../../../../tmp/oh-my-openagent/src/plugin/hooks/create-transform-hooks.ts`
- `../../../../../tmp/oh-my-openagent/src/plugin/hooks/create-continuation-hooks.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**system-transform** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/system-transform.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**unstable-agent-babysitter** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/unstable-agent-babysitter.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**tool-execute-after** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/tool-execute-after.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**event** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/event.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**session-agent-resolver** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/session-agent-resolver.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

**chat-params** (plugin):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/plugin/chat-params.ts`
Potential target in OpenCode:
- `packages/opencode/src/plugin/`

## MCP

| Name | Status | Category | Files | Details |
|------|--------|----------|-------|---------|
| grep-app | new | backport recommended | 1 | New mcp 'grep-app' in OMO 3.11.0 (1 files) |
| context7 | new | backport recommended | 1 | New mcp 'context7' in OMO 3.11.0 (1 files) |
| websearch | new | backport recommended | 1 | New mcp 'websearch' in OMO 3.11.0 (1 files) |

### New Components

**grep-app** (mcp):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/mcp/grep-app.ts`
Potential target in OpenCode:
- `packages/opencode/src/mcp/`

**context7** (mcp):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/mcp/context7.ts`
Potential target in OpenCode:
- `packages/opencode/src/mcp/`

**websearch** (mcp):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/mcp/websearch.ts`
Potential target in OpenCode:
- `packages/opencode/src/mcp/`

## Config

| Name | Status | Category | Files | Details |
|------|--------|----------|-------|---------|
| schema | new | backport recommended | 1 | New config 'schema' in OMO 3.11.0 (1 files) |

### New Components

**schema** (config):
OMO source files:
- `../../../../../tmp/oh-my-openagent/src/config/schema.ts`

## Dependencies

| Name | Status | Category | Files | Details |
|------|--------|----------|-------|---------|
| @ast-grep/cli | modified | review needed | 0 | Dependency '@ast-grep/cli@^0.40.0' |
| @ast-grep/napi | modified | review needed | 0 | Dependency '@ast-grep/napi@^0.40.0' |
| @clack/prompts | modified | review needed | 0 | Dependency '@clack/prompts@^0.11.0' |
| @code-yeongyu/comment-checker | modified | review needed | 0 | Dependency '@code-yeongyu/comment-checker@^0.7.0' |
| @modelcontextprotocol/sdk | modified | review needed | 0 | Dependency '@modelcontextprotocol/sdk@^1.25.2' |
| @opencode-ai/plugin | modified | review needed | 0 | Dependency '@opencode-ai/plugin@^1.2.16' |
| @opencode-ai/sdk | modified | review needed | 0 | Dependency '@opencode-ai/sdk@^1.2.17' |
| commander | modified | review needed | 0 | Dependency 'commander@^14.0.2' |
| detect-libc | modified | review needed | 0 | Dependency 'detect-libc@^2.0.0' |
| diff | modified | review needed | 0 | Dependency 'diff@^8.0.3' |
| js-yaml | modified | review needed | 0 | Dependency 'js-yaml@^4.1.1' |
| jsonc-parser | modified | review needed | 0 | Dependency 'jsonc-parser@^3.3.1' |
| picocolors | modified | review needed | 0 | Dependency 'picocolors@^1.1.1' |
| picomatch | modified | review needed | 0 | Dependency 'picomatch@^4.0.2' |
| vscode-jsonrpc | modified | review needed | 0 | Dependency 'vscode-jsonrpc@^8.2.0' |
| zod | modified | review needed | 0 | Dependency 'zod@^4.1.8' |

### Review Needed

**@ast-grep/cli:**
- `packages/opencode/package.json`

**@ast-grep/napi:**
- `packages/opencode/package.json`

**@clack/prompts:**
- `packages/opencode/package.json`

**@code-yeongyu/comment-checker:**
- `packages/opencode/package.json`

**@modelcontextprotocol/sdk:**
- `packages/opencode/package.json`

**@opencode-ai/plugin:**
- `packages/opencode/package.json`

**@opencode-ai/sdk:**
- `packages/opencode/package.json`

**commander:**
- `packages/opencode/package.json`

**detect-libc:**
- `packages/opencode/package.json`

**diff:**
- `packages/opencode/package.json`

**js-yaml:**
- `packages/opencode/package.json`

**jsonc-parser:**
- `packages/opencode/package.json`

**picocolors:**
- `packages/opencode/package.json`

**picomatch:**
- `packages/opencode/package.json`

**vscode-jsonrpc:**
- `packages/opencode/package.json`

**zod:**
- `packages/opencode/package.json`

