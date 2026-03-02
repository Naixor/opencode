# PRD Docker Sandbox 讨论记录

## 当前进度：全部讨论完成 ✅

---

## 问题 #1: Allowlist 配置与 Mount 映射的边界情况

**状态：已完成 ✅**

**问题描述：**
US-002 说 glob 模式（如 `src/**`）需要"解析为实际的目录/文件列表后再 mount"，但推荐方案是"mount 整个 `src/` + tmpfs 遮盖 deny 路径"。两者矛盾——如果用 mount + tmpfs 方案，glob 不需要展开为文件列表，直接 mount 匹配的顶层目录即可。

**待明确：** `src/**` 是 mount 整个 `src/` 目录，还是 readdir 后逐个 mount？

**结论：采用"mount 整个目录 + tmpfs 遮盖 deny 路径"方案。**

glob 模式只需提取顶层目录，做一次 bind mount。deny 路径用 tmpfs 覆盖。不需要展开 glob 为文件列表。

**映射规则：**

1. `type: "directory"` 的 glob 模式（如 `src/**`）→ 提取顶层目录 `src/`，做一次 bind mount
2. `type: "file"` 的模式（如 `package.json`）→ 单文件 bind mount
3. deny rule 的路径 → 在已 mount 的目录上叠加 tmpfs，遮盖该子路径

**完整示例：**

假设项目结构：
```
/home/user/myproject/
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

**转换过程：**

**读写权限规则：所有 allowlist 条目一律 rw，不区分读写。** 不在 allowlist 中的文件不 mount，deny 路径用 tmpfs 遮盖。

Step 1 — 解析 allowlist，提取 mount 源（全部 rw）：
- `src/**` → mount 目录 `/home/user/myproject/src` → `/project/src`
- `docs/**` → mount 目录 `/home/user/myproject/docs` → `/project/docs`
- `package.json` → mount 文件 `/home/user/myproject/package.json` → `/project/package.json`
- `tsconfig.json` → mount 文件 `/home/user/myproject/tsconfig.json` → `/project/tsconfig.json`

Step 2 — 解析 deny rules，生成 tmpfs 覆盖：
- `src/auth/secrets/**` → tmpfs 覆盖 `/project/src/auth/secrets`

Step 3 — 生成最终 docker run 命令：
```bash
docker run \
  --name opencode-sandbox-session-abc123 \
  -v /home/user/myproject/src:/project/src \
  -v /home/user/myproject/docs:/project/docs \
  -v /home/user/myproject/package.json:/project/package.json \
  -v /home/user/myproject/tsconfig.json:/project/tsconfig.json \
  --tmpfs /project/src/auth/secrets:size=1m,mode=0000 \
  --network none \
  --memory 2g \
  --cpus 2 \
  --security-opt no-new-privileges \
  --user $(id -u):$(id -g) \
  -w /project \
  opencode-sandbox:latest \
  sleep infinity
```

**容器内效果：**
```
/project/
├── src/
│   ├── index.ts          ✅ 可读可写（bind mount）
│   ├── utils/            ✅ 可读可写
│   └── auth/
│       └── secrets/      ❌ 空目录（tmpfs 遮盖，mode=0000 禁止访问）
├── docs/
│   └── guide.md          ✅ 可读可写（bind mount）
├── package.json          ✅ 可读可写（bind mount）
├── tsconfig.json         ✅ 可读可写（bind mount）
├── .env                  ❌ 不存在（未 mount）
```

LLM 无论用什么手段（bash、python、node 脚本）都无法访问 `.env` 和 `src/auth/secrets/` 下的文件。

---

## 问题 #2: Docker vs OS 原生沙箱

**状态：已完成 ✅**

**讨论演变：** 最初问题是"Docker API vs Docker CLI"，但讨论中发现更根本的问题——Docker 方案无法支持 iOS/macOS 原生开发（Xcode、Simulator 等在 Linux 容器中跑不了），与 Cursor 拒绝 Docker 的理由一致。

**结论：放弃 Docker 方案，改用 OS 原生沙箱。**

**实施计划：拆分为两个任务**

1. **Phase 1: macOS Seatbelt 沙箱** — `sandbox-exec` + 动态生成 sandbox profile
2. **Phase 2: Linux Landlock + seccomp 沙箱** — Landlock 做文件系统限制，seccomp 拦截危险 syscall
3. **Windows：架构预留，v1 不实现**

**关键约束：macOS 和 Linux 共用一份测试（尤其是集成测试）。**
- Executor 接口统一，测试面向接口编写
- 集成测试验证的是"沙箱行为"（能访问 allowlist 文件、不能访问 deny 文件），不关心底层实现
- 平台特定的单元测试可以分开

**架构影响：**
- `Executor` 接口不变，但实现从 `DockerExecutor` 变为 `SeatbeltExecutor` / `LandlockExecutor`
- 不再需要 Dockerfile、镜像管理、容器生命周期模块
- 文件隔离从 bind mount 变为 sandbox profile 的 file access policy
- deny 路径处理从 tmpfs 覆盖变为 profile 中的 deny 规则
- 网络隔离从 `--network none` 变为 profile 中的网络 deny 规则

---

## PRD 与新方向的冲突点清单

以下是原 PRD 中需要重写的部分：

| PRD 章节 | 冲突内容 | 状态 |
|----------|---------|------|
| **标题** | "基于 Docker 的沙箱执行环境" → 应改为 OS 原生沙箱 | 需重写 |
| **Introduction** | 全篇围绕 Docker 容器描述 | 需重写 |
| **Goals** | Docker 容器、volume mount、Docker Desktop、镜像构建 | 需重写 |
| **US-001** | 配置 schema 含 Docker 特有字段（image、buildContext、mounts、resources） | 需重写 |
| **US-002** | allowlist → Docker mount 映射 → 应改为 allowlist → sandbox profile 策略 | 需重写 |
| **US-003** | Docker 容器生命周期管理 → 不再需要，sandbox-exec 是 per-command 的 | **删除** |
| **US-004** | Docker 镜像构建 | **删除** |
| **US-005** | bash 通过 docker exec → 应改为通过 sandbox-exec 执行 | 需重写 |
| **US-006** | 文件读写通过容器 → OS 原生沙箱下文件在宿主机，由 profile 控制访问 | 需重写 |
| **US-007** | MCP 在容器内运行 → 应改为 MCP 进程在 sandbox profile 下运行 | 需重写 |
| **US-008** | Docker 环境检测 → 应改为 macOS 版本 / sandbox-exec 可用性检测 | 需重写 |
| **US-009** | 远程服务器场景 → Phase 2（Linux Landlock），v1 不包含 | **移至 Phase 2** |
| **US-010** | Executor 接口 → 接口设计仍有效，实现改为 SeatbeltExecutor / LandlockExecutor | 部分保留 |
| **US-011** | Docker bind mount 文件同步 → OS 原生沙箱无此问题，文件就在宿主机 | **删除** |
| **US-012** | TUI 状态展示 → 仍需要，但去掉镜像构建进度等 Docker 特有状态 | 需简化 |
| **US-013** | 集成测试 → 仍需要，但用例需去除 Docker 特有场景 | 需重写 |
| **FR 全部** | 16 条 FR 大部分是 Docker 特有的 | 需重写 |
| **Non-Goals** | Docker/K8s/容器相关的 non-goals 不再适用 | 需重写 |
| **Technical Considerations** | 架构图、模块表、配置示例、代码示例全部是 Docker 的 | **全部重写** |
| **Success Metrics** | 容器启动时间、镜像大小等 Docker 指标 | 需重写 |
| **Open Questions** | 4 个问题中 3 个是 Docker 特有的 | 需重写 |

**结论：PRD 几乎需要全部重写，只有核心动机（allowlist 绕过问题）和 Executor 接口设计思路可以保留。**

---

## 以下为基于新方向（OS 原生沙箱）重新整理的待讨论问题

---

## 问题 #3: sandbox-exec 进程模型

**状态：已完成 ✅**

**问题描述：**
macOS Seatbelt 的使用方式是 `sandbox-exec -f profile.sb command`，即用 sandbox profile 包裹一个命令的执行。这与 Docker 的"长生命周期容器"模型不同。

**结论：方案 A + 思路 Y**

1. **bash 命令**：per-command sandbox-exec 包裹。每次 bash 调用 `sandbox-exec -f profile.sb bash -c "command"`。开销 ~7ms/次，可忽略。（Cursor 也是这么做的）
2. **MCP 工具**：MCP server 进程启动时用 sandbox-exec 包裹（per-process）
3. **文件工具（read/write/glob/grep）**：走应用层 allowlist 检查，不走 sandbox。理由：这些工具的代码由我们控制，LLM 无法绕过；真正的绕过风险来自 bash 和 MCP（LLM 可执行任意脚本）

**此结论已写入 AGENTS.md 和 MEMORY.md 作为后续迭代准则。**

---

## 问题 #4: Seatbelt profile 中 deny 路径的处理

**状态：已完成 ✅**

**结论：SBPL 的 deny 规则比 Docker tmpfs 更简洁灵活。**

**映射规则：**

1. allowlist `type: "directory"` glob（如 `src/**`）→ `(allow file-read* file-write* (subpath "/abs/path/src"))`
2. allowlist `type: "file"`（如 `package.json`）→ `(allow file-read* file-write* (literal "/abs/path/package.json"))`
3. deny rule 目录 → `(deny file-read* file-write* (subpath "/abs/path/src/auth/secrets"))`
4. deny rule 文件 → `(deny file-read* file-write* (literal "/abs/path/src/config.env"))`
5. 通配符（如 `*.json`）→ `(regex "...")`

**规则优先级：SBPL 中后声明的优先（last match wins），deny 规则写在 allow 之后即可正确覆盖。**

**注意事项：**
- symlink 必须 `realpath()` 解析后再写入 profile（macOS 上 `/tmp` → `/private/tmp`）
- 比 Docker tmpfs 方案更灵活：可以 deny 单个文件（Docker tmpfs 只能覆盖目录）

**示例 profile 片段：**
```scheme
; --- allowlist（全部 rw）---
(allow file-read* file-write* (subpath "/home/user/myproject/src"))
(allow file-read* file-write* (subpath "/home/user/myproject/docs"))
(allow file-read* file-write* (literal "/home/user/myproject/package.json"))
(allow file-read* file-write* (literal "/home/user/myproject/tsconfig.json"))

; --- deny rules（写在 allow 之后，优先级更高）---
(deny file-read* file-write* (subpath "/home/user/myproject/src/auth/secrets"))
```

---

## 问题 #5: sandbox-exec 的 deprecation 风险

**状态：已完成 ✅**

**结论：风险可接受，不需要额外行动，记录在 PRD 的 Technical Considerations 即可。**

- sandbox-exec 标记 deprecated 已 ~10 年，每个 macOS 版本仍正常工作
- Chrome、Cursor、OpenAI Codex、Bazel 都依赖它，Apple 移除会破坏大量应用
- macOS 系统自身大量使用底层 Seatbelt 机制
- Executor 接口抽象了平台实现，即使 API 变化只需替换 SeatbeltExecutor
- 社区替代方案（如 Alcoholless）可作为 fallback

---

## 问题 #6: 网络隔离在 Seatbelt 中的实现

**状态：已完成 ✅**

**结论：v1 默认允许网络，不做网络隔离。** sandbox 核心目标是文件系统隔离，防止 LLM 绕过 allowlist。网络限制如果有需求，单独拆 PRD 处理。

---

## 问题 #7: node_modules、.git 等特殊目录的处理

**状态：已完成 ✅**

**结论：内置一组通用白名单 + 允许用户额外声明。**

sandbox profile 默认放行以下"开发必需路径"（内置白名单），无需用户手动配置：
- `node_modules/` — 依赖安装
- `.git/` — 版本控制操作
- `/tmp`（`/private/tmp`）— 临时文件
- 系统库路径（`/usr/lib`、`/System/Library` 等）— 基础运行时

用户可通过配置额外声明其他需要放行的路径。

**注意：`.git/` 放行意味着 LLM 可以通过 `git show` 访问历史版本中的受保护文件。这是已知的 trade-off——sandbox 保护的是文件系统当前状态，git 历史的保护不在 v1 scope 内。**

---

## 问题 #8: 跨平台测试策略

**状态：已完成 ✅**

**结论：三层测试 + 平台条件跳过。**

| 层级 | 内容 | 平台相关？ |
|------|------|-----------|
| Executor 接口测试（集成） | 验证沙箱行为：能访问 allowlist 文件、不能访问 deny 文件、bash 命令受限 | 否，跨平台共用 |
| Profile 生成测试（单元） | allowlist → .sb profile 转换正确性 | 是，macOS 专有 |
| Landlock 规则测试（单元） | allowlist → Landlock 规则转换正确性 | 是，Linux 专有 |

- CI：macOS 测试用 `macos-latest` runner，Linux 测试用 `ubuntu-latest` runner
- Windows / 不支持沙箱的平台：`process.platform` 判断，跳过沙箱相关测试，不需要 mock executor
