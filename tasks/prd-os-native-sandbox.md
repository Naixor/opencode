# PRD: 基于 OS 原生沙箱的安全执行环境

## Introduction

为 OpenCode 增加基于 OS 原生沙箱的安全执行能力，解决当前 allowlist 权限系统的根本性绕过问题。

当前 allowlist 系统基于模式匹配和命令解析来限制 LLM 对受保护内容的访问。然而，LLM 可以通过编写任意脚本（Python、Node.js、shell 等）来绕过这些检查——例如 `python3 -c "print(open('secrets/key.pem').read())"` 或生成一个 `.js` 文件再执行。这类绕过无法通过扩展 bash scanner 的命令列表来完全解决，因为脚本语言的表达能力是无限的。

OS 原生沙箱通过操作系统内核级别的访问控制来解决这个问题：在沙箱中执行的进程根本无法访问受保护的文件，无论 LLM 使用什么手段。sandbox 作为 allowlist 的可选强化模式存在——当用户为某些路径配置了 allowlist 后，可以选择启用 sandbox 来提供真正不可绕过的隔离。

与 Docker 容器方案相比，OS 原生沙箱可以完整支持 macOS 原生工具链（Xcode、iOS Simulator 等），启动开销接近零，且无需额外安装 Docker。这也是 Cursor、Chrome、OpenAI Codex 等工具采用的方案。

## Goals

- 通过 OS 原生沙箱机制（macOS Seatbelt / Linux Landlock+seccomp）对 bash 和 MCP 工具的执行进行文件系统级隔离
- 根据 allowlist 和 deny rules 自动生成沙箱策略，精确控制进程可访问的文件
- 对用户透明：启用 sandbox 后使用体验不变，macOS 原生工具链（Xcode、Swift、Simulator 等）正常可用
- 不替代现有 allowlist 系统，而是作为其可选的内核级强制执行层
- 跨平台架构：Phase 1 支持 macOS，Phase 2 支持 Linux，Windows 架构预留

## Phasing

### Phase 1: macOS Seatbelt 沙箱（本 PRD 范围）

使用 macOS 的 Seatbelt 机制（`sandbox-exec` + SBPL profile）实现沙箱。

### Phase 2: Linux Landlock + seccomp 沙箱（后续 PRD）

使用 Linux 的 Landlock（文件系统限制）和 seccomp（syscall 过滤）实现沙箱。与 Phase 1 共用 Executor 接口和集成测试。

### Windows：架构预留

Executor 接口预留 Windows 实现的扩展点，v1 不实现。

## User Stories

### US-001: Sandbox 配置 schema 定义
**Description:** 作为项目管理者，我需要在配置文件中声明 sandbox 模式。

**Acceptance Criteria:**
- [ ] 在 `packages/opencode/src/config/config.ts` 中扩展配置 schema，新增 `sandbox` 字段
- [ ] `sandbox` schema 包含：
  - `enabled: boolean` — 是否启用 sandbox
  - `paths?: string[]` — 额外放行的路径（补充内置白名单）
- [ ] 当 `sandbox.enabled = true` 但当前平台不支持沙箱时，启动阶段报错并给出提示
- [ ] 配置向后兼容：无 `sandbox` 字段时行为不变
- [ ] Typecheck passes

### US-002: Allowlist 到 Seatbelt profile 的映射逻辑
**Description:** 作为开发者，我需要将 `.opencode-security.json` 中的 allowlist/deny 配置自动转换为 Seatbelt sandbox profile（.sb 文件），确保沙箱内进程只能访问允许的文件。

**Acceptance Criteria:**
- [ ] 新建 `packages/opencode/src/sandbox/profile.ts`，实现 allowlist → SBPL profile 生成
- [ ] 映射规则：
  - `type: "directory"` 的 glob（如 `src/**`）→ 提取顶层目录，生成 `(allow file-read* file-write* (subpath "/abs/path/src"))`
  - `type: "file"`（如 `package.json`）→ 生成 `(allow file-read* file-write* (literal "/abs/path/package.json"))`
  - deny rule 目录 → 生成 `(deny file-read* file-write* (subpath "/abs/path/..."))`
  - deny rule 文件 → 生成 `(deny file-read* file-write* (literal "/abs/path/..."))`
  - 通配符模式（如 `*.json`）→ 生成 `(regex "...")`
- [ ] 所有 allowlist 条目一律 rw，不区分读写权限
- [ ] SBPL 中 deny 规则写在 allow 规则之后（last match wins），确保 deny 优先
- [ ] 所有路径通过 `realpath()` 解析后写入 profile（处理 symlink，如 `/tmp` → `/private/tmp`）
- [ ] 内置通用白名单自动放行（只读），无需用户配置：
  - 系统二进制路径（`/usr/bin`、`/bin`、`/usr/sbin`、`/sbin`）— 系统命令执行
  - 系统库路径（`/usr/lib`、`/usr/share`、`/System/Library`、`/Library/Frameworks`）
  - Homebrew 路径（`/opt/homebrew`、`/usr/local`）— Apple Silicon / Intel Homebrew 工具
  - Xcode 工具链（`/Applications/Xcode.app`、`/Library/Developer`）— iOS/macOS 开发
  - `/private/tmp` — 临时文件（读写）
- [ ] 内置通用白名单自动放行（读写），无需用户配置：
  - `node_modules/` — 依赖安装
  - `.git/` — 版本控制操作
  - `/private/tmp` — 临时文件
- [ ] 自动检测并放行（只读）用户级工具链安装路径：
  - `~/.bun/` — Bun
  - `~/.nvm/` — nvm 管理的 Node.js
  - `~/.cargo/` — Rust 工具链
  - `~/.pyenv/` — pyenv 管理的 Python
  - 其他常见工具链路径通过环境变量（如 `$PATH`）动态发现
- [ ] 用户可通过 `sandbox.paths` 配置额外放行的路径
- [ ] profile 包含基础进程能力：`process-exec`、`process-fork`、`signal`、`pseudo-tty`、`mach-lookup`（必要系统服务）
- [ ] profile 默认允许网络（`(allow network*)`）
- [ ] 当 allowlist 为空数组时，沙箱内进程除内置白名单和系统路径外无任何项目文件可访问
- [ ] 生成的 profile 写入临时文件供 `sandbox-exec -f` 使用
- [ ] 单元测试覆盖各种 allowlist/deny 配置到 SBPL 规则的转换
- [ ] Typecheck passes

**完整示例：**

假设项目结构：
```
/Users/dev/myproject/
├── src/
│   ├── index.ts
│   ├── utils/
│   └── auth/
│       └── secrets/
│           ├── key.pem
│           └── token.json
├── docs/
│   └── guide.md
├── .env
├── package.json
└── tsconfig.json
```

`.opencode-security.json` 配置：
```json
{
  "version": "1.0",
  "allowlist": [
    { "pattern": "src/**", "type": "directory" },
    { "pattern": "docs/**", "type": "directory" },
    { "pattern": "package.json", "type": "file" },
    { "pattern": "tsconfig.json", "type": "file" }
  ],
  "rules": [
    {
      "pattern": "src/auth/secrets/**",
      "type": "directory",
      "deniedOperations": ["read", "write", "llm"]
    }
  ]
}
```

生成的 Seatbelt profile：
```scheme
(version 1)
(deny default)

; --- 基础进程能力 ---
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow pseudo-tty)
(allow sysctl-read)
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.logger"))

; --- 系统二进制和库（内置白名单，只读）---
(allow file-read* (subpath "/usr/bin"))
(allow file-read* (subpath "/usr/sbin"))
(allow file-read* (subpath "/bin"))
(allow file-read* (subpath "/sbin"))
(allow file-read* (subpath "/usr/lib"))
(allow file-read* (subpath "/usr/share"))
(allow file-read* (subpath "/System/Library"))
(allow file-read* (subpath "/Library/Frameworks"))

; --- Homebrew（Apple Silicon + Intel）---
(allow file-read* (subpath "/opt/homebrew"))
(allow file-read* (subpath "/usr/local"))

; --- Xcode 工具链 ---
(allow file-read* (subpath "/Applications/Xcode.app"))
(allow file-read* (subpath "/Library/Developer"))

; --- 用户级工具链（动态检测，只读）---
(allow file-read* (subpath "/Users/dev/.bun"))
(allow file-read* (subpath "/Users/dev/.nvm"))
(allow file-read* (subpath "/Users/dev/.cargo"))

; --- /dev 设备 ---
(allow file-read* file-write* (literal "/dev/null"))
(allow file-read* file-write* (literal "/dev/zero"))
(allow file-read* file-write* (regex "^/dev/ttys[0-9]+"))
(allow file-read* file-write* (literal "/dev/ptmx"))

; --- 临时文件（内置白名单）---
(allow file-read* file-write* (subpath "/private/tmp"))

; --- 开发必需路径（内置白名单）---
(allow file-read* file-write* (subpath "/Users/dev/myproject/node_modules"))
(allow file-read* file-write* (subpath "/Users/dev/myproject/.git"))

; --- 网络（v1 默认允许）---
(allow network*)

; --- allowlist 路径（全部 rw）---
(allow file-read* file-write* (subpath "/Users/dev/myproject/src"))
(allow file-read* file-write* (subpath "/Users/dev/myproject/docs"))
(allow file-read* file-write* (literal "/Users/dev/myproject/package.json"))
(allow file-read* file-write* (literal "/Users/dev/myproject/tsconfig.json"))

; --- deny rules（写在 allow 之后，优先级更高）---
(deny file-read* file-write* (subpath "/Users/dev/myproject/src/auth/secrets"))
```

沙箱内效果：
```
/Users/dev/myproject/
├── src/
│   ├── index.ts          ✅ 可读可写
│   ├── utils/            ✅ 可读可写
│   └── auth/
│       └── secrets/      ❌ 访问被内核拒绝（Operation not permitted）
├── docs/
│   └── guide.md          ✅ 可读可写
├── node_modules/         ✅ 可读可写（内置白名单）
├── .git/                 ✅ 可读可写（内置白名单）
├── package.json          ✅ 可读可写
├── tsconfig.json         ✅ 可读可写
├── .env                  ❌ 访问被内核拒绝（Operation not permitted）
```

### US-003: Bash 工具的 sandbox 执行适配
**Description:** 作为用户，我希望 bash 命令在 sandbox 启用时自动在沙箱内执行。

**Acceptance Criteria:**
- [ ] 修改 `packages/opencode/src/tool/bash.ts`，检测 sandbox 模式
- [ ] sandbox 模式下，bash 命令通过 `sandbox-exec -f <profile.sb> bash -c "<command>"` 执行（per-command 模式）
- [ ] 命令的 stdout/stderr 正确回传
- [ ] 命令的 exit code 正确回传
- [ ] 命令超时机制同样生效
- [ ] 命令的工作目录为项目根目录
- [ ] sandbox 模式下跳过 bash scanner 的安全检查（沙箱本身提供了更强的 OS 级隔离）
- [ ] 沙箱拒绝访问时的错误信息清晰：提示文件不在 allowlist 范围内
- [ ] 交互式 bash（`interactive_bash`）同样通过 sandbox-exec 包裹
- [ ] Typecheck passes

### US-004: MCP 工具的 sandbox 执行适配
**Description:** 作为用户，我希望 MCP 服务器在 sandbox 模式下也运行在沙箱内，防止通过 MCP 工具绕过沙箱。

**Acceptance Criteria:**
- [ ] MCP 服务器进程启动时通过 `sandbox-exec -f <profile.sb>` 包裹（per-process 模式）
- [ ] MCP 服务器的 stdio 管道正常工作
- [ ] MCP 服务器的文件访问受限于沙箱 profile
- [ ] `enforced` 策略的 MCP 服务器始终在沙箱内运行
- [ ] `trusted` 策略的 MCP 服务器不走沙箱——这是用户明确声明的信任，由用户承担风险
- [ ] 文档中说明：用户应只对完全信任的 MCP server 使用 `trusted` 策略，该策略下 MCP server 不受沙箱限制
- [ ] Typecheck passes

### US-005: 文件工具的 allowlist 检查（不走 sandbox）
**Description:** 作为开发者，文件工具（read/write/glob/grep）在 sandbox 模式下仍走应用层 allowlist 检查，不需要通过沙箱执行。

**Acceptance Criteria:**
- [ ] read/write/glob/grep 工具在 sandbox 模式下继续使用现有的应用层 allowlist 检查
- [ ] 不通过 sandbox-exec 执行——这些工具的代码由 OpenCode 控制，LLM 无法绕过
- [ ] 确认现有 allowlist 检查逻辑对这些工具的覆盖是完整的
- [ ] Typecheck passes

### US-006: Sandbox 执行层抽象
**Description:** 作为开发者，我需要一个统一的沙箱执行层抽象，支持跨平台扩展。

**Acceptance Criteria:**
- [ ] 新建 `packages/opencode/src/sandbox/index.ts`，定义 `Sandbox` 接口
- [ ] `Sandbox` 接口包含：
  - `wrap(command: string[], options?: SandboxOptions): string[]` — 将命令包裹为沙箱内执行的命令（如 `["bash", "-c", "ls"]` → `["sandbox-exec", "-f", "profile.sb", "bash", "-c", "ls"]`）
  - `isAvailable(): Promise<boolean>` — 检测当前平台是否支持沙箱
  - `generatePolicy(config: SecurityConfig): Promise<string>` — 从 allowlist/deny 配置生成沙箱策略文件，返回策略文件路径
- [ ] 实现 `SeatbeltSandbox`：macOS Seatbelt 实现（Phase 1）
- [ ] 预留 `LandlockSandbox`：Linux Landlock + seccomp 实现（Phase 2）
- [ ] 提供 `getSandbox()` 工厂函数，根据 `process.platform` 返回对应实现
- [ ] 不支持沙箱的平台返回 `null`，调用方回退到无沙箱执行
- [ ] Typecheck passes

### US-007: Sandbox 初始化流程与 UI 引导
**Description:** 作为用户，当我首次启用 sandbox 时，我希望系统自动完成初始化，并在 TUI 中引导我完成整个过程；初始化失败时我需要看到清晰的错误信息。

**Acceptance Criteria:**
- [ ] session 启动时检测 `sandbox.enabled = true`，触发初始化流程
- [ ] 初始化步骤（按顺序执行）：
  1. **平台检测**：检查当前 OS 是否支持沙箱（macOS: `sandbox-exec` 可用性；Linux: 内核版本 >= 5.13）
  2. **环境验证**：检查 macOS 版本、SIP 状态等
  3. **策略生成**：从 allowlist/deny 配置生成 sandbox profile
  4. **沙箱验证**：用生成的 profile 执行一个简单命令（如 `sandbox-exec -f profile.sb /usr/bin/true`）验证 profile 有效
- [ ] TUI 中显示初始化进度（如 `[Sandbox] Initializing...`、`[Sandbox] Ready`）
- [ ] 任意步骤失败时，在 TUI 中显示具体错误信息和修复建议，例如：
  - 平台不支持：`Sandbox is not supported on this platform. Sandbox requires macOS with sandbox-exec or Linux kernel >= 5.13.`
  - profile 生成失败：`Failed to generate sandbox profile: [具体原因]`
  - 验证失败：`Sandbox profile validation failed: [sandbox-exec 的 stderr 输出]`
- [ ] 初始化失败时 sandbox 自动禁用，session 继续以非沙箱模式运行，但 TUI 中持续显示警告
- [ ] 初始化结果缓存在 session 级别，同一 session 内不重复初始化（除非 allowlist 配置变更）
- [ ] Typecheck passes

### US-008: 平台环境检测与诊断
**Description:** 作为用户，我需要一个独立的诊断命令来检测沙箱环境状态。

**Acceptance Criteria:**
- [ ] 新建 `packages/opencode/src/sandbox/doctor.ts`，实现环境检测
- [ ] macOS 检测项目：
  - `sandbox-exec` 命令是否可用
  - macOS 版本是否满足要求
  - SIP（System Integrity Protection）状态（SIP 关闭可能影响沙箱行为）
- [ ] 检测失败时给出明确的修复指引
- [ ] 提供 CLI 命令 `opencode sandbox doctor` 手动触发诊断（不需要启动 TUI）
- [ ] Linux 上内核版本 < 5.13 不支持 Landlock 时，同样提示不支持（不提供降级方案）
- [ ] Typecheck passes

### US-009: Sandbox 状态展示
**Description:** 作为用户，我希望在 TUI 中看到当前 sandbox 的状态信息。

**Acceptance Criteria:**
- [ ] TUI 状态栏显示 sandbox 状态：`[Sandbox: ON]`、`[Sandbox: OFF]`、`[Sandbox: FAILED]`
- [ ] sandbox 相关错误在 TUI 中清晰展示，包含修复建议
- [ ] `opencode sandbox status` CLI 命令显示详细信息：平台、沙箱类型、初始化状态、allowlist 路径、内置白名单
- [ ] Typecheck passes

### US-010: 集成测试
**Description:** 作为开发者，我需要验证 sandbox 模式下各工具的正确性和安全性。

**Acceptance Criteria:**
- [ ] 集成测试面向 Sandbox 接口编写，macOS 和 Linux 共用同一份
- [ ] 测试：sandbox 模式下 bash 命令无法读取不在 allowlist 中的文件
- [ ] 测试：sandbox 模式下 `python3 -c "open('secrets/key.pem').read()"` 因访问被拒绝而失败
- [ ] 测试：sandbox 模式下 bash 命令可以正常读写 allowlist 中的文件
- [ ] 测试：sandbox 模式下 deny rule 路径即使在 allowlist 范围内也无法访问
- [ ] 测试：sandbox 模式下内置白名单路径（node_modules、.git、/tmp）可正常访问
- [ ] 测试：sandbox 模式下用户额外配置的路径可正常访问
- [ ] 测试：不支持沙箱的平台上正确降级（跳过沙箱，使用应用层检查）
- [ ] macOS 专有单元测试：SBPL profile 生成正确性
- [ ] 不支持沙箱的平台通过 `process.platform` 跳过沙箱相关测试
- [ ] 所有测试通过 `bun test --cwd packages/opencode`
- [ ] Typecheck passes

## Functional Requirements

- FR-1: 新增 `sandbox` 配置字段到 `opencode.json` schema，包含 `enabled` 和 `paths` 子字段
- FR-2: 当 `sandbox.enabled = true` 时，bash 命令和 MCP 进程通过 OS 原生沙箱执行
- FR-3: 文件工具（read/write/glob/grep）不走沙箱，继续使用应用层 allowlist 检查
- FR-4: 沙箱策略从 allowlist + deny rules 自动生成，allowlist 条目一律 rw
- FR-5: deny rules 在策略中的优先级高于 allow rules（SBPL 中通过声明顺序保证）
- FR-6: 内置通用白名单自动放行：系统二进制路径、系统库、Homebrew、Xcode 工具链（只读）；`node_modules/`、`.git/`、`/tmp`（读写）；用户级工具链路径动态检测（只读）
- FR-7: 用户可通过 `sandbox.paths` 配置额外放行的路径
- FR-8: v1 默认允许网络，不做网络隔离
- FR-9: sandbox 模式下 bash scanner 安全检查被跳过，因为沙箱提供了更强的 OS 级隔离
- FR-10: MCP 服务器在 sandbox 模式下默认在沙箱内运行，`trusted` 策略可配置例外
- FR-11: sandbox 初始化流程在 session 启动时自动执行：平台检测 → 环境验证 → 策略生成 → 沙箱验证
- FR-12: 初始化失败时 sandbox 自动禁用并在 TUI 显示警告，session 继续以非沙箱模式运行
- FR-13: TUI 展示 sandbox 状态信息（ON / OFF / FAILED）
- FR-14: 提供 `opencode sandbox doctor` 和 `opencode sandbox status` CLI 命令
- FR-15: macOS 和 Linux 共用一份集成测试，面向 Sandbox 接口编写

## Non-Goals

- 不替代现有的 allowlist/permission 系统——sandbox 是可选的强化层
- 不做网络隔离——v1 只关注文件系统隔离，网络限制需求单独拆 PRD
- 不在 v1 支持 Linux（Phase 2）和 Windows（架构预留）
- 不保护 git 历史——`.git/` 在内置白名单中，LLM 可通过 `git show` 访问历史版本文件
- 不修改 LLM provider 调用链——provider API 调用仍在宿主机进行
- 不支持运行时动态修改沙箱策略——需要重启 session
- 不提供沙箱逃逸检测——依赖 OS 内核的安全模型
- 不支持多 sandbox profile（如 "开发" vs "CI"）——沙箱策略从 allowlist 自动生成，差异化在 allowlist 配置层面解决
- 不为低版本 Linux 内核（< 5.13）提供降级方案——不支持时提示用户，sandbox 本身是可选功能

## Technical Considerations

### 架构概览

```
┌───────────────────────────────────────────────────────────────┐
│  OpenCode Process (宿主机)                                     │
│                                                                │
│  ┌──────────┐   ┌───────────┐   ┌──────────────────────────┐ │
│  │ Session   │──▶│ Tool      │──▶│ Sandbox                  │ │
│  │ Processor │   │ Executor  │   │ ┌────────────────────┐   │ │
│  └──────────┘   └───────────┘   │ │ SeatbeltSandbox    │   │ │
│       │              │           │ │ (macOS, Phase 1)   │   │ │
│       │              │           │ ├────────────────────┤   │ │
│       │         ┌────┴────┐     │ │ LandlockSandbox    │   │ │
│       │         │ 文件工具 │     │ │ (Linux, Phase 2)   │   │ │
│       │         │ (应用层  │     │ └────────────────────┘   │ │
│       │         │ allowlist│     └──────────────────────────┘ │
│       │         │  检查)   │          │                       │
│       │         └─────────┘          │                       │
│       │                              ▼                       │
│  ┌────┴─────┐              ┌─────────────────┐              │
│  │ LLM      │              │ sandbox-exec     │              │
│  │ Provider  │              │ -f profile.sb    │              │
│  │ (宿主机)  │              │   bash -c "cmd"  │              │
│  └──────────┘              │                   │              │
│                            │ 子进程自动继承沙箱  │              │
│                            │ 无法逃逸           │              │
│                            └─────────────────┘              │
└───────────────────────────────────────────────────────────────┘
```

### 核心模块

| 模块 | 文件路径 | 职责 |
|------|---------|------|
| 配置 | `sandbox/config.ts` | sandbox 配置 schema 和验证 |
| 策略生成 | `sandbox/profile.ts` | allowlist/deny → Seatbelt SBPL profile 生成 |
| 沙箱接口 | `sandbox/index.ts` | `Sandbox` 接口定义 + `getSandbox()` 工厂函数 |
| macOS 实现 | `sandbox/seatbelt.ts` | `SeatbeltSandbox` 实现 |
| 环境检测 | `sandbox/doctor.ts` | 平台沙箱环境诊断 |

### 新增文件目录结构

```
packages/opencode/src/sandbox/
├── index.ts              # Sandbox 接口 + getSandbox() 工厂
├── config.ts             # 配置 schema
├── profile.ts            # Allowlist → SBPL profile 生成
├── seatbelt.ts           # macOS SeatbeltSandbox 实现
└── doctor.ts             # 环境检测与诊断
```

### 配置示例

```jsonc
// opencode.json
{
  "sandbox": {
    "enabled": true,
    "paths": [
      "/usr/local/share/ca-certificates"
    ]
  }
}
```

```jsonc
// .opencode-security.json
{
  "version": "1.0",
  "allowlist": [
    { "pattern": "src/**", "type": "directory" },
    { "pattern": "docs/**", "type": "directory" },
    { "pattern": "package.json", "type": "file" },
    { "pattern": "tsconfig.json", "type": "file" }
  ],
  "rules": [
    {
      "pattern": "src/auth/secrets/**",
      "type": "directory",
      "deniedOperations": ["read", "write", "llm"]
    }
  ]
}
```

### Seatbelt 命令执行方式

```typescript
// per-command 沙箱执行
const sandbox = getSandbox()
const policyPath = await sandbox.generatePolicy(securityConfig)

// bash 工具调用
const wrapped = sandbox.wrap(["bash", "-c", userCommand])
// → ["sandbox-exec", "-f", "/tmp/opencode-sandbox-xxxx.sb", "bash", "-c", userCommand]
const result = Bun.spawn(wrapped, { cwd: projectRoot })

// MCP server 启动
const wrapped = sandbox.wrap(["node", "mcp-server.js"])
// → ["sandbox-exec", "-f", "/tmp/opencode-sandbox-xxxx.sb", "node", "mcp-server.js"]
const mcpProcess = Bun.spawn(wrapped, { stdio: ["pipe", "pipe", "pipe"] })
```

### Allowlist → SBPL 映射规则

| Allowlist 配置 | SBPL 规则 |
|---------------|-----------|
| `{ pattern: "src/**", type: "directory" }` | `(allow file-read* file-write* (subpath "/abs/path/src"))` |
| `{ pattern: "package.json", type: "file" }` | `(allow file-read* file-write* (literal "/abs/path/package.json"))` |
| deny rule 目录 `src/auth/secrets/**` | `(deny file-read* file-write* (subpath "/abs/path/src/auth/secrets"))` |
| deny rule 文件 `src/config.env` | `(deny file-read* file-write* (literal "/abs/path/src/config.env"))` |
| 通配符 `*.json` | `(allow file-read* file-write* (regex "^/abs/path/.*\\.json$"))` |

**规则优先级：SBPL 中后声明的优先（last match wins）。deny 规则始终写在 allow 规则之后。**

### 性能考虑

- **sandbox-exec 开销**：Apple Silicon 上约 ~7ms/次调用，可忽略
- **子进程继承**：沙箱限制自动继承到所有子进程（fork/exec），无额外开销
- **文件工具**：不走沙箱，零额外开销
- **策略生成**：一次性生成，session 内复用

### 安全模型

```
安全检查层级（从外到内）：

1. PermissionNext（用户审批层）
   ├── allowlist/deny 规则评估
   ├── 用户 allow/deny/ask 决策
   └── 通过后进入工具执行

2. Security Access Control（应用层）
   ├── 文件路径模式匹配（文件工具）
   ├── bash command scanner（非 sandbox 模式）
   ├── segment 保护
   └── LLM 内容扫描

3. OS Native Sandbox（内核层）★ 新增
   ├── 文件系统访问控制（Seatbelt / Landlock）
   ├── 子进程自动继承，无法逃逸
   └── 仅覆盖 bash 和 MCP 工具

sandbox 是最内层也是最强的保障——即使应用层检查被绕过，
沙箱内进程在内核层面无法访问受保护文件，从根本上消除绕过可能。
```

### sandbox-exec deprecation 说明

Apple 已将 `sandbox-exec` CLI 和 `sandbox_init()` C API 标记为 deprecated（~2016 年起）。但底层 Seatbelt 内核机制并未 deprecated，macOS 系统自身大量使用。Chrome、Cursor、OpenAI Codex、Bazel 等项目均依赖此机制，Apple 移除将破坏大量应用。标记 deprecated 已 ~10 年，每个 macOS 版本仍正常工作。

缓解措施：Sandbox 接口抽象了平台实现，即使 Apple 未来修改 API，只需替换 `SeatbeltSandbox` 实现。社区替代方案（如 Alcoholless）可作为 fallback。

### 与现有安全层的关系

| 工具类型 | 非 sandbox 模式 | sandbox 模式 |
|---------|----------------|-------------|
| bash | bash scanner + 用户审批 | **sandbox-exec 内核级隔离**（跳过 bash scanner） |
| MCP | 用户审批 | **sandbox-exec 内核级隔离** |
| read/write/glob/grep | 应用层 allowlist 检查 | 应用层 allowlist 检查（不变） |
| LLM provider | 宿主机直接调用 | 宿主机直接调用（不变） |

### 已知限制

- `.git/` 在内置白名单中，LLM 可通过 `git show` 等命令访问历史版本中的受保护文件内容。sandbox 保护的是文件系统当前状态，git 历史的保护不在 v1 scope 内。
- macOS 上 `/tmp` 是 `/private/tmp` 的 symlink，sandbox profile 中必须使用真实路径。所有路径需 `realpath()` 解析。

## Success Metrics

- sandbox 模式下，所有在 `prd-security-bypass-cases.md` 中记录的脚本绕过攻击（CASE-BASH-009、CASE-BASH-010、CASE-BASH-011 等）均无法获取受保护文件内容
- sandbox-exec 每次调用额外延迟 < 10ms
- 无额外依赖安装（macOS 系统自带 sandbox-exec）
- 所有 macOS 原生工具链（Xcode、Swift、iOS Simulator）在 sandbox 模式下正常工作
- 不支持沙箱的平台上错误信息有 100% 的用户可理解性（包含具体修复步骤）
- 所有现有测试在 sandbox 模式关闭时继续通过（零回归）
- macOS 和 Linux 共用同一份集成测试，无平台特定的测试分支

