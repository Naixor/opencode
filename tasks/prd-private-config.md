# PRD: `.opencode/` 目录配置安全字段保护

## Introduction

`.opencode/` 目录是用户的私域配置空间（类似 `.claude/`），其中的 `opencode.json{,c}` 已经可以被加载并覆盖项目根目录的 `opencode.json`。用户可以将 `.opencode/` 加入 `.gitignore`，在其中存放个人隐私配置（如 API Key、provider endpoint、model 偏好等），无需引入新的配置文件格式。

但当前存在安全隐患：`.opencode/opencode.json` 可以覆盖项目级别的安全相关配置（permission、sandbox 等），这意味着开发者可以绕过团队统一的安全策略。本 PRD 的核心目标是**保护 project config 中已定义的安全字段不被 `.opencode dir` layer 覆盖**，同时允许 project config 未设置安全字段时由 `.opencode/` 补充。

## Goals

- 保护项目级安全策略：当 project `opencode.json` 已定义安全相关字段时，`.opencode/opencode.json{,c}` 不可覆盖
- 允许补充：当 project `opencode.json` 未定义某安全字段时，`.opencode/opencode.json{,c}` 中的该字段可以生效
- 检测到覆盖冲突时给出明确的用户提示和日志警告
- 非安全字段不受影响，行为与当前完全一致

## Design Decisions

以下设计决策已在讨论中确认：

1. **顶层整体保护**：安全字段按顶层 key 判定，不做子字段级 deep merge 保护。即 project 定义了 `sandbox: { enabled: true }`，`.opencode/` 的整个 `sandbox` 都被忽略，即使其中有 project 未设置的子字段。
2. **数组字段整体保护**：`instructions`、`plugin` 等数组类型安全字段不允许 concat 追加。project 已定义则 `.opencode/` 整体忽略。
3. **"已定义"判定规则**：字段 key 存在于 project config 解析结果中即视为已定义，不论值是空对象 `{}`、空数组 `[]` 还是 `null`。用户显式写了字段即代表有意图。被忽略时会通过 TUI 提示，用户可据此调整。
4. **仅对比 project layer 原始值**：安全字段保护仅检查 project `opencode.json` 文件本身的内容，不检查 remote/global/custom 等其他 layer 的合并结果。组织要强制安全策略应使用 managed config（最高优先级）。
5. **`mcp`、`agent`、`command` 不在安全字段列表中**：MCP 偏向工具扩展，用户连接本地 MCP server 是常见需求；agent 和 command 的权限受底层 security 配置约束，修改不会绕过安全策略。
6. **多层 `.opencode/` 目录只对 project config 判定**：安全字段保护仅对比 project config（layer 4），`.opencode/` 层之间不互相保护，后加载的可以覆盖前加载的。加载顺序由 `Filesystem.up()` 决定，从深到浅（子目录 → 父目录），后加载的覆盖先加载的，即父目录优先级更高。
7. **仅保护 JSON config 字段**：本次 scope 仅限 `opencode.json` 中的字段保护，`.opencode/agents/`、`.opencode/commands/`、`.opencode/plugins/` 等目录加载不在本次保护范围内，后续迭代再考虑。`.opencode/` 是用户私域目录，能写入该目录说明已有本地权限，威胁模型不覆盖此场景。
8. **保护范围仅限项目级 `.opencode/`**：安全字段保护仅作用于项目级 `.opencode/` 目录（`Instance.directory` 到 `worktree` 范围内通过 `Filesystem.up()` 找到的）。`~/.opencode/` 和 `OPENCODE_CONFIG_DIR` 不受限制，用户在自己的全局私域可以覆盖任何字段。威胁模型是防止项目仓库内的 `.opencode/` 绕过团队策略，而非限制用户自己的全局配置。
9. **`env` 字段不加入安全字段列表，但黑名单过滤特定 key**：项目级 `.opencode/` 的 `env` 中禁止设置能影响配置加载的环境变量。黑名单初始列表：`OPENCODE_DISABLE_PROJECT_CONFIG`、`OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`、`OPENCODE_CONFIG_CONTENT`。被过滤的 key 同样输出 warn 日志。黑名单可按需扩展。黑名单不扩展到 provider 相关 key（如 `ANTHROPIC_API_KEY`）或其他安全相关 env 变量，因为这些变量由 runtime flag 直接读取，不经过 config 合并流程，在 config 层面过滤无效也无必要。
10. **TUI 提示采用无条件 publish**：不检查是否处于 TUI 模式，直接 `Bus.publish(TuiEvent.ToastShow, ...)`。非 TUI 模式下没有订阅者，publish 是 no-op，无副作用。避免配置加载阶段的时序问题。
11. **`unique()` 去重保留最后出现**：`directories()` 返回的目录列表去重时保留最后一次出现的条目（而非常见的保留首次出现）。这确保当同一路径出现在多个位置时（如 `OPENCODE_CONFIG_DIR` 指向项目级 `.opencode/` 同一路径），高优先级位置的条目不会被低优先级的抢占。

## User Stories

### US-001: 安全字段覆盖保护

**Description:** As a team lead, I want security-related fields defined in project `opencode.json` to be protected from being overridden by `.opencode/opencode.json`, so that individual developers cannot bypass team security policies.

**Acceptance Criteria:**
- [ ] 定义安全字段列表：`permission`、`sandbox`、`plugin`、`instructions`、`skills`
- [ ] `ConfigPaths.directories()` 返回值包含 `source` 标记，区分 `project` / `home` / `custom`，用于判定目录是否为项目级 `.opencode/`
- [ ] 当 project `opencode.json` 中**已定义**某安全字段时，`.opencode/opencode.json` 中的同名字段被忽略
- [ ] 被忽略的字段通过 `Log.warn()` 输出日志，格式为 `".opencode config: ignoring field '[field]' - already defined in project config, cannot override security policy"`
- [ ] 通过 `Bus.publish(TuiEvent.ToastShow, ...)` 提示用户（无条件 publish，非 TUI 模式下无副作用）
- [ ] Typecheck passes
- [ ] 单元测试覆盖以下场景：
  - project 定义 `sandbox: { enabled: true }`，`.opencode/` 定义 `sandbox: { enabled: false }` → `.opencode/` 的 `sandbox` 被忽略，最终 `enabled: true`
  - project 定义 `sandbox: { enabled: true }`，`.opencode/` 定义 `sandbox: { enabled: false, network: "bridge" }` → `.opencode/` 的 `sandbox` 整体被忽略（包括 project 未设置的 `network` 子字段）
  - project 定义 `permission: { allow: ["read"] }`，`.opencode/` 定义 `permission: { allow: ["read", "write"] }` → `.opencode/` 的 `permission` 被忽略
  - project 定义 `instructions: ["rule1"]`，`.opencode/` 定义 `instructions: ["rule2"]` → `.opencode/` 的 `instructions` 被忽略（不做 concat 追加），最终只有 `["rule1"]`
  - project 定义 `plugin: ["pluginA"]`，`.opencode/` 定义 `plugin: ["pluginB"]` → `.opencode/` 的 `plugin` 被忽略，最终只有 `["pluginA"]`
  - project 定义 `sandbox: {}`（空对象），`.opencode/` 定义 `sandbox: { enabled: true }` → `.opencode/` 的 `sandbox` 被忽略（空对象视为已定义）
  - project 定义 `plugin: []`（空数组），`.opencode/` 定义 `plugin: ["pluginA"]` → `.opencode/` 的 `plugin` 被忽略（空数组视为已定义）
  - 同时定义多个安全字段冲突时，每个被忽略的字段都有独立的 warn 日志
  - `~/.opencode/opencode.json` 定义安全字段 → 不受保护限制，正常生效（保护仅限项目级 `.opencode/`）

### US-002: 安全字段补充生效

**Description:** As a developer, when the project config has not defined a security field, I want my `.opencode/opencode.json` to be able to set it so that I can configure my local security preferences.

**Acceptance Criteria:**
- [ ] 当 project `opencode.json` 中**未定义** `sandbox` 时，`.opencode/opencode.json` 中的 `sandbox` 正常生效
- [ ] 当 project `opencode.json` 中**未定义** `permission` 时，`.opencode/opencode.json` 中的 `permission` 正常生效
- [ ] 其他安全字段同理
- [ ] Typecheck passes
- [ ] 单元测试覆盖以下场景：
  - project 未定义 `sandbox`，`.opencode/` 定义 `sandbox: { enabled: true }` → `sandbox` 正常生效
  - project 未定义 `permission`，`.opencode/` 定义 `permission: { allow: ["read"] }` → `permission` 正常生效
  - project 未定义 `instructions`，`.opencode/` 定义 `instructions: ["rule1"]` → `instructions` 正常生效
  - project 未定义任何安全字段，`.opencode/` 定义全部安全字段 → 全部正常生效，无 warn 日志
  - project 定义了 `sandbox` 但未定义 `permission`，`.opencode/` 同时定义两者 → `sandbox` 被忽略、`permission` 正常生效（部分冲突部分补充）

### US-003: 非安全字段正常覆盖

**Description:** As a developer, I want my `.opencode/opencode.json` to still override project config for non-security fields so that I can customize my local environment.

**Acceptance Criteria:**
- [ ] provider 级别覆盖正确（如设置 `provider.anthropic.options.apiKey` 能覆盖 project config 中的值）
- [ ] model、theme、env 等非安全字段正常覆盖
- [ ] `mcp`、`agent`、`command` 字段正常覆盖（不在安全字段列表中）
- [ ] 合并策略与现有 `mergeConfigConcatArrays` 一致：安全字段在未被保护时（project 未定义），`plugin`、`instructions` 走 concat 追加，其余走 deep merge。例如：project 未定义 `plugin`，`.opencode/` 定义 `plugin: ["myPlugin"]`，全局定义 `plugin: ["globalPlugin"]` → 最终 `["globalPlugin", "myPlugin"]`
- [ ] Typecheck passes
- [ ] 单元测试覆盖以下场景：
  - project 定义 `provider.anthropic.options.apiKey: "sk-proj"`，`.opencode/` 定义 `provider.anthropic.options.apiKey: "sk-personal"` → 最终 `"sk-personal"`
  - project 定义 `mcp: { "teamServer": { "command": "npx", "args": ["team-mcp"] } }`，`.opencode/` 定义 `mcp: { "localServer": { "command": "npx", "args": ["local-mcp"] } }` → `mcp` 正常 deep merge，两个 server 都存在
  - project 和 `.opencode/` 同时定义非安全字段和安全字段 → 非安全字段正常覆盖，安全字段按保护规则处理

### US-004: 多层 `.opencode/` 目录

**Description:** As a developer working in a monorepo, I want the security field protection to only check against project config, so that nested `.opencode/` directories can override each other freely for security fields not defined in project config.

**Acceptance Criteria:**
- [ ] 安全字段保护仅对比 project config（layer 4），不对比其他 `.opencode/` 层
- [ ] 多个 `.opencode/` 层之间的安全字段可以互相覆盖
- [ ] Typecheck passes
- [ ] 单元测试覆盖以下场景：
  - project 未定义 `sandbox`，子目录 `.opencode/` 定义 `sandbox: { enabled: true }`，父目录 `.opencode/` 定义 `sandbox: { enabled: false }` → 最终 `enabled: false`（父目录后加载，覆盖子目录）
  - project 定义 `sandbox: { enabled: true }`，两层项目级 `.opencode/` 都定义了 `sandbox` → 两层的 `sandbox` 都被忽略
  - `OPENCODE_CONFIG_DIR` 指向项目级 `.opencode/` 同一路径时，该目录以 `custom` source 身份生效（最高优先级，不受安全字段保护），`unique()` 去重保留最后出现的高优先级条目

### US-005: `env` 字段黑名单过滤

**Description:** As a team lead, I want certain security-sensitive environment variable keys in project-level `.opencode/opencode.json` to be blocked, so that developers cannot bypass security policies by setting config-affecting env vars.

**Acceptance Criteria:**
- [ ] 定义 env 黑名单常量 `ENV_BLACKLIST`：`OPENCODE_DISABLE_PROJECT_CONFIG`、`OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`、`OPENCODE_CONFIG_CONTENT`
- [ ] 项目级 `.opencode/opencode.json` 的 `env` 中包含黑名单 key 时，该 key 被移除（`env` 中其他 key 保留）
- [ ] 被移除的 key 通过 `Log.warn()` 输出日志
- [ ] `~/.opencode/opencode.json` 中的 `env` 不受黑名单限制
- [ ] Typecheck passes
- [ ] 单元测试覆盖以下场景：
  - 项目级 `.opencode/` 定义 `env: { "OPENCODE_DISABLE_PROJECT_CONFIG": "true", "MY_VAR": "value" }` → `OPENCODE_DISABLE_PROJECT_CONFIG` 被移除，`MY_VAR` 保留
  - 项目级 `.opencode/` 定义 `env: { "OPENCODE_CONFIG": "/tmp/evil.json" }` → `OPENCODE_CONFIG` 被移除
  - `~/.opencode/` 定义 `env: { "OPENCODE_DISABLE_PROJECT_CONFIG": "true" }` → 正常生效，不受黑名单限制

### US-006: 确认 `OPENCODE_DISABLE_PROJECT_CONFIG` 现有行为

**Description:** 确认 `OPENCODE_DISABLE_PROJECT_CONFIG` 环境变量已正确禁用项目级 `.opencode/` 目录配置加载，并补充单元测试覆盖。当此环境变量启用时，安全字段保护也无需生效（因为项目级 `.opencode/` 整体被跳过）。

**注意：** 经代码确认，此行为已在 `ConfigPaths.directories()`（`paths.ts:25`）中实现。本 US 仅需补充测试，无需新功能开发。

**配置方式：** 环境变量 `OPENCODE_DISABLE_PROJECT_CONFIG=true`（或任何 truthy 值），运行时动态读取（`flag.ts` 中通过 `Object.defineProperty` getter 实现）。

**Acceptance Criteria:**
- [ ] 确认现有行为：`OPENCODE_DISABLE_PROJECT_CONFIG` 启用时，项目级 `.opencode/` 目录配置不被加载
- [ ] 确认现有行为：全局级 `~/.config/opencode/` 和 `~/.opencode/` 不受影响
- [ ] 单元测试覆盖以下场景：
  - `OPENCODE_DISABLE_PROJECT_CONFIG=true`，项目级 `.opencode/opencode.json` 存在 → 不被加载
  - `OPENCODE_DISABLE_PROJECT_CONFIG=true`，`~/.config/opencode/opencode.json` 存在 → 正常加载
  - `OPENCODE_DISABLE_PROJECT_CONFIG` 未设置，项目级 `.opencode/opencode.json` 存在 → 正常加载

## Functional Requirements

- FR-1: 定义安全字段常量 `SECURITY_FIELDS`，包含：`permission`、`sandbox`、`plugin`、`instructions`、`skills`
- FR-2: 定义 env 黑名单常量 `ENV_BLACKLIST`，包含：`OPENCODE_DISABLE_PROJECT_CONFIG`、`OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`、`OPENCODE_CONFIG_CONTENT`
- FR-3: 在项目级 `.opencode dir` layer 的配置加载后、`mergeConfigConcatArrays()` 调用前，检查安全字段是否与 project config 冲突
- FR-4: 冲突判定逻辑：对于 `SECURITY_FIELDS` 中的每个字段，若 project `opencode.json` 原始解析结果中该字段 key **存在**（不论值为何），则从 `.opencode dir` 配置中移除该字段
- FR-5: env 黑名单过滤：对于项目级 `.opencode dir` 配置中的 `env` 字段，移除 `ENV_BLACKLIST` 中的 key
- FR-6: 对每个被移除的安全字段和被过滤的 env key 输出 `Log.warn()` 日志
- FR-7: 无条件通过 `Bus.publish(TuiEvent.ToastShow, ...)` 提示用户被忽略的字段（非 TUI 模式下无副作用）
- FR-8: 过滤逻辑仅作用于项目级 `.opencode dir` layer（`Instance.directory` 到 `worktree` 范围内），不影响 `~/.opencode/`、`OPENCODE_CONFIG_DIR` 及其他 layer（remote、global、project、inline、managed）
- FR-9: 安全字段保护仅对比 project `opencode.json` 原始解析结果（layer 4），不对比其他 layer 的合并结果，`.opencode/` 层之间不互相保护
- FR-10: `unique()` 去重逻辑改为保留最后出现的条目，确保高优先级位置不被低优先级抢占

## Non-Goals

- 不引入新的配置文件（如 `opencode.private.json`）——直接使用现有 `.opencode/opencode.json`
- 不修改现有配置加载顺序和优先级
- 不做子字段级 deep merge 保护——按顶层 key 整体保护
- 不保护 `.opencode/agents/`、`.opencode/commands/`、`.opencode/plugins/` 等目录加载——本次仅限 JSON config 字段，目录加载保护后续迭代。`.opencode/` 是用户私域目录，能写入该目录说明已有本地权限，威胁模型不覆盖此场景
- 不自动创建 `.opencode/` 目录或模板文件
- 不自动修改 `.gitignore`
- 不提供 TUI 界面编辑 `.opencode/` 配置
- 不提供 `config list --private` 子命令（后续迭代可考虑）

## Technical Considerations

- 主要修改文件：`packages/opencode/src/config/config.ts`
- **project config 原始值获取**：在 project config 加载循环（line 125-128）中，额外保存一份原始解析结果 `projectRaw`：
  ```ts
  let projectRaw: Info = {}
  for (const file of await ConfigPaths.projectFiles(...)) {
    const parsed = await loadFile(file)
    projectRaw = mergeConfigConcatArrays(projectRaw, parsed)
    result = mergeConfigConcatArrays(result, parsed)
  }
  ```
- **过滤逻辑插入点**：`.opencode dir` layer 中 `loadFile()` 返回后、`mergeConfigConcatArrays()` 调用前，拆分为：
  ```ts
  const opencodeConfig = await loadFile(path.join(dir, file))
  const filtered = filterSecurityFields(opencodeConfig, projectRaw, dir)
  result = mergeConfigConcatArrays(result, filtered)
  ```
  其中 `filterSecurityFields` 负责：检查 `projectRaw` 中安全字段是否已定义、移除冲突字段、过滤 env 黑名单 key、输出 warn 日志。
- **项目级 `.opencode/` 判定**：需要区分目录是否在 `Instance.directory` 到 `worktree` 范围内。`ConfigPaths.directories()` 返回的数组中，项目级 `.opencode/` 来自第二段（`Filesystem.up({ start: directory, stop: worktree })`），`~/.opencode/` 来自第三段（`Filesystem.up({ start: home, stop: home })`）。可通过目录路径前缀判断，或在 `directories()` 返回值中标记来源。
- `SECURITY_FIELDS` 和 `ENV_BLACKLIST` 常量建议导出，便于测试和未来扩展
- `OPENCODE_DISABLE_PROJECT_CONFIG` 已在 `ConfigPaths.directories()` 中实现项目级 `.opencode/` 跳过，无需额外修改

## Success Metrics

- project `opencode.json` 设置了 `sandbox` 时，`.opencode/opencode.json` 中的 `sandbox` 被忽略并有日志警告
- project `opencode.json` 未设置 `sandbox` 时，`.opencode/opencode.json` 中的 `sandbox` 正常生效
- `.opencode/opencode.json` 中设置 provider apiKey、model、mcp、agent、command 等非安全字段能正常覆盖项目配置
- 不影响现有配置加载行为，所有现有测试通过

## Open Questions

（无）

## Resolved Questions

- `env` 黑名单不扩展 provider 相关 key（如 `ANTHROPIC_API_KEY`），仅过滤影响配置加载机制的 key。其他安全相关 env 变量由 runtime flag 直接读取，不经过 config 合并流程，在 config 层面过滤无效也无必要
- 项目级 `.opencode/` 判定方式：改 `ConfigPaths.directories()` 返回值带来源标记（如 `{ path, source: "project" | "home" | "custom" }`），而非路径前缀判断
- `.opencode/plugins/` 等目录加载不保护：`.opencode/` 是用户私域目录，能写入说明已有本地权限，威胁模型是防止仓库内配置绕过团队策略，不覆盖本地权限场景
- `unique()` 去重保留最后出现：当同一路径出现在多个位置时（如 `OPENCODE_CONFIG_DIR` 指向项目级 `.opencode/`），保留高优先级（后出现）的条目，避免去重导致优先级降低或 source 标记错误
