# PRD: 飞书 ↔ opencode 桥接服务

## Introduction

构建一个飞书 Bot 桥接服务，使团队成员可以直接在飞书群聊或私聊中与 opencode 交互——发送消息、查看 AI 回复、管理会话、切换模型/Agent、审批权限请求等。

**核心问题**：opencode 目前只能通过 TUI 终端或 CLI 使用，团队成员必须具备终端操作能力且需要 SSH 到部署 opencode 的服务器。对于非工程角色（PM、设计师）或移动端场景，缺乏便捷的访问方式。

**解决方案**：在 opencode monorepo 内新建 `packages/feishu-bridge` 包，通过飞书 WebSocket 长连接接收消息，调用 opencode SDK (`@opencode-ai/sdk`) 转发到远程 opencode server，将流式 AI 回复实时推送回飞书聊天窗口。

## Goals

- 团队成员可在飞书群聊中 @bot 发送编程问题，获得 opencode AI 实时流式回复
- 团队成员可在飞书私聊中与 bot 一对一交互，获得完整的 opencode 体验
- 同一群聊内所有成员共享一个 opencode session，支持团队协作
- 支持完整的 opencode 功能：会话管理、Agent/Model 切换、文件附件、权限确认
- 流式回复延迟 ≤1 秒（从 opencode 产出 token 到飞书消息更新）
- 5-20 人小团队可稳定使用，无需复杂运维

## Phasing

### Phase 1: MVP — 基础对话与流式输出（本 PRD 重点）

核心链路：飞书消息 → opencode prompt → SSE 流式回复 → 飞书消息编辑。支持基本指令 (`/new`, `/abort`, `/help`)，危险操作权限确认卡片。

### Phase 2: 完整交互体验

交互卡片控制面板、完整指令系统、Model/Agent 选择器卡片、文件附件处理、长文本分段、历史记录查看。

### Phase 3: 高级特性

多 opencode 实例路由、用量统计面板、管理后台、监控告警。

## User Stories

### US-001: 项目脚手架与基础配置

**Description:** 作为开发者，我需要在 opencode monorepo 中创建 `packages/feishu-bridge` 包，配置好构建和运行环境。

**Acceptance Criteria:**

- [ ] 在 `packages/feishu-bridge/` 创建新 package，包含 `package.json`、`tsconfig.json`
- [ ] `package.json` 声明依赖：`@larksuiteoapi/node-sdk`、`@opencode-ai/sdk`（workspace 引用）、`drizzle-orm`、`better-sqlite3`
- [ ] 创建入口文件 `src/index.ts`，支持 `bun run packages/feishu-bridge/src/index.ts` 启动
- [ ] 创建配置文件 schema `src/config.ts`，支持从环境变量和 JSON 配置文件加载：
  - `FEISHU_APP_ID` — 飞书应用 App ID
  - `FEISHU_APP_SECRET` — 飞书应用 App Secret
  - `OPENCODE_BASE_URL` — opencode server 地址（如 `http://10.0.0.1:4096`）
  - `OPENCODE_PASSWORD` — opencode server Basic Auth 密码（可选）
  - `OPENCODE_DIRECTORY` — opencode 工作目录
  - `BRIDGE_DB_PATH` — SQLite 数据库路径（默认 `./data/bridge.db`）
  - `BRIDGE_ALLOWED_USERS` — 允许使用的飞书用户 open_id 列表（逗号分隔，空=允许所有）
- [ ] 创建示例配置文件 `feishu-bridge.example.json`
- [ ] Typecheck passes

### US-002: 飞书 WebSocket 连接与消息接收

**Description:** 作为 bridge 服务，我需要通过飞书 WebSocket 长连接接收用户消息，这样不需要公网 IP 就能运行。

**Acceptance Criteria:**

- [ ] 使用 `@larksuiteoapi/node-sdk` 的 `Client` 创建飞书客户端
- [ ] 使用 `WSClient` 建立 WebSocket 长连接，订阅 `im.message.receive_v1` 事件
- [ ] 收到消息后正确解析以下字段：
  - `event.sender.sender_id.open_id` — 发送者 ID
  - `event.message.chat_id` — 所在群/私聊 ID
  - `event.message.chat_type` — `"p2p"`（私聊）或 `"group"`（群聊）
  - `event.message.content` — 消息内容（JSON 字符串，需解析）
  - `event.message.mentions` — @提及列表
- [ ] 群聊中仅当 bot 被 @mention 时才响应，私聊中响应所有消息
- [ ] 群聊消息中正确去除 `@bot` mention 前缀，提取纯文本
- [ ] WebSocket 断开后自动重连（SDK 内置，验证行为）
- [ ] 启动时在 stdout 输出 `feishu bridge connected, app_id: cli_xxx`
- [ ] Typecheck passes

### US-003: opencode SDK 客户端初始化与 SSE 事件订阅

**Description:** 作为 bridge 服务，我需要连接到远程 opencode server 并订阅全局 SSE 事件流，这样才能接收 AI 的流式回复。

**Acceptance Criteria:**

- [ ] 使用 `createOpencodeClient` 创建 opencode SDK 客户端，配置 `baseUrl`、`directory`、Basic Auth headers
- [ ] 启动时调用一个 API（如 `GET /config`）验证 opencode server 连接可达，连接失败时报错退出
- [ ] 建立持久 SSE 连接到 `GET /event` 端点
- [ ] 正确处理 SSE 事件的 JSON 解析，支持以下事件类型：
  - `session.status` — session 状态变化（idle/busy/retry）
  - `message.updated` — 消息更新（含 token 统计）
  - `message.part.delta` — 文本增量（field + delta 字段）
  - `message.part.updated` — part 完整更新（工具调用结果）
  - `permission.asked` — 权限请求
- [ ] SSE 断开时自动重连（指数退避，初始 1s，最大 30s）
- [ ] 心跳超时检测：15 秒无事件视为连接断开，触发重连
- [ ] Typecheck passes

### US-004: SQLite 持久化层 — 会话绑定与消息映射

**Description:** 作为 bridge 服务，我需要持久化存储飞书用户/群与 opencode session 的绑定关系，以及飞书消息 ID 与 opencode 消息的映射。

**Acceptance Criteria:**

- [ ] 使用 Drizzle ORM + better-sqlite3 创建数据库，schema 位于 `src/db.ts`
- [ ] `binding` 表：
  ```
  id: text PK
  user_id: text NOT NULL        — 飞书 open_id（群聊共享时为 "shared"）
  chat_id: text NOT NULL        — 飞书 chat_id
  session_id: text NOT NULL     — opencode session ID
  agent: text                   — 当前 agent 偏好
  model_id: text                — 当前 model 偏好（格式 provider/model）
  created_at: integer NOT NULL
  updated_at: integer NOT NULL
  ```

  - 唯一索引 `binding_user_chat_idx` on `(user_id, chat_id)`
- [ ] `message_map` 表：
  ```
  id: text PK
  lark_msg_id: text NOT NULL    — 飞书消息 ID（bot 回复的那条）
  session_id: text NOT NULL     — opencode session ID
  chat_id: text NOT NULL        — 飞书 chat_id
  created_at: integer NOT NULL
  ```

  - 索引 `message_map_session_idx` on `(session_id)`
- [ ] 提供函数：`findBinding(userId, chatId)`、`upsertBinding(...)`、`saveMessageMap(...)`
- [ ] 数据库文件自动创建（如果不存在）
- [ ] 字段命名遵循 snake_case 规范（与 opencode 项目风格一致）
- [ ] Typecheck passes

### US-005: 核心对话链路 — 消息 → prompt → 流式回复

**Description:** 作为飞书用户，我发送一条文本消息后，应在飞书中实时看到 AI 的流式回复，就像在终端中使用 opencode 一样。

**Acceptance Criteria:**

- [ ] 收到飞书文本消息后：
  1. 通过 `findBinding(userId, chatId)` 查找已有 session 绑定
  2. 如不存在，调用 `client.session.create()` 创建新 session，写入 binding
  3. 如已存在但 session 不可用（404），创建新 session 并更新 binding
- [ ] 调用 opencode SDK 发送 prompt：`client.session.prompt({ path: { id: sessionId }, body: { parts: [{ type: "text", text }] } })`（如 binding 中有 agent/model 偏好，传入对应参数）
- [ ] 立即发送一条飞书占位消息："🤔 正在思考..."，记录返回的 `message_id`
- [ ] 消费 SSE 中匹配当前 session 的 `message.part.delta` 事件：
  - 将 delta 累积到文本 buffer
  - 节流编辑飞书消息（最小间隔 800ms）
  - 编辑时使用 `lark_md` 格式渲染 Markdown（代码块、加粗等）
- [ ] 当 `session.status` 变为 `idle` 时：
  - 执行最终一次 flush，确保所有文本已发送
  - 在最终消息末尾追加统计信息行：`📊 Token: {input}/{output} | ⏱ {duration}s`
- [ ] 群聊中回复以 reply 方式关联到用户的原始消息
- [ ] 同一 session 正在 busy 时收到新消息，回复提示 "⏳ 上一个任务还在执行中，请稍候或使用 /abort 中止"
- [ ] Typecheck passes

### US-006: 基本指令系统 — /new, /abort, /help, /status

**Description:** 作为飞书用户，我想使用斜杠命令来控制 opencode 会话，而不仅仅是发送 prompt。

**Acceptance Criteria:**

- [ ] 消息以 `/` 开头时，路由到指令处理器而非 prompt 流程
- [ ] `/new` — 创建新 opencode session，更新当前 chat 的 binding，回复 "✅ 新会话已创建: `{sessionId}`"
- [ ] `/abort` — 调用 `client.session.abort({ path: { sessionID } })`，回复 "⏹ 当前任务已中止"；如果 session 已 idle，回复 "ℹ️ 当前没有正在执行的任务"
- [ ] `/status` — 展示当前绑定信息：session ID、agent、model、session 状态（idle/busy）
- [ ] `/help` — 发送富文本消息列出所有可用命令及说明
- [ ] 未知指令回复 "❓ 未知命令: `/{cmd}`，输入 /help 查看可用命令"
- [ ] 指令不区分大小写（`/New` 和 `/new` 等价）
- [ ] Typecheck passes

### US-007: 权限确认卡片 — 危险操作审批

**Description:** 作为飞书用户，当 opencode 需要执行危险操作（bash 命令、文件写入等）时，我希望收到一张交互卡片来审批，确保安全。

**Acceptance Criteria:**

- [ ] 监听 SSE `permission.asked` 事件，匹配到当前 chat 绑定的 session 时触发
- [ ] 发送飞书 Interactive Card，包含：
  - 标题：`⚠️ 权限请求`
  - 详情：工具名称（如 `bash`）、操作描述（如命令内容）、工作目录
  - 三个按钮：`✅ 允许`、`✅ 始终允许`、`❌ 拒绝`
  - 每个按钮的 `value` 中携带 `request_id` 和 `reply` 类型
- [ ] 接收卡片按钮回调事件，调用 opencode SDK `POST /permission/:requestID/reply` 提交决定
- [ ] 按钮点击后更新卡片，显示审批结果（如 "✅ 已允许" 灰色文字替代按钮）
- [ ] 群聊中任意成员均可点击审批按钮（群共享 session 场景）
- [ ] 权限请求超时 120 秒无人审批时，自动发送 deny 并更新卡片提示 "⏰ 已超时自动拒绝"
- [ ] Typecheck passes

### US-008: 群聊共享 session 模式

**Description:** 作为团队成员，我希望同一个群聊里所有人共享一个 opencode session，这样大家可以在同一个上下文中协作讨论代码问题。

**Acceptance Criteria:**

- [ ] 群聊场景下，binding 的 `user_id` 字段统一为固定值 `"shared"`（而非每个用户的 open_id）
- [ ] 同一群内所有 @bot 的消息都发送到同一个 opencode session
- [ ] 消息发送前在 prompt 文本开头自动注入发送者标识：`[{sender_name}]: {message}`，使 AI 能区分不同说话者
- [ ] `/new` 命令在群内创建新的共享 session，影响群内所有人
- [ ] 群聊中收到并发消息时（session busy），排队等待上一个 prompt 完成后再发送
- [ ] 私聊场景不受影响，仍然是 per-user session
- [ ] Typecheck passes

### US-009: 用户白名单鉴权

**Description:** 作为 bridge 管理员，我需要限制只有特定飞书用户才能使用 bot，防止未授权访问。

**Acceptance Criteria:**

- [ ] 配置 `BRIDGE_ALLOWED_USERS` 环境变量，逗号分隔的飞书 open_id 列表
- [ ] 配置 `BRIDGE_ALLOWED_GROUPS` 环境变量，逗号分隔的飞书 chat_id 列表
- [ ] 两个列表均为空时，允许所有用户/群使用（开发模式）
- [ ] 列表非空时，仅允许列表中的用户（私聊）或群（群聊）使用
- [ ] 未授权的消息忽略处理（不回复），但在 bridge 日志中记录 `unauthorized attempt from {open_id} in {chat_id}`
- [ ] Typecheck passes

### US-010: 流式输出节流器

**Description:** 作为 bridge 服务，我需要一个节流机制来控制飞书消息编辑频率，避免触发飞书 API 限流。

**Acceptance Criteria:**

- [ ] 实现 `Throttler` 类（`src/throttle.ts`），每个活跃的 prompt 回复维护一个实例
- [ ] `append(delta)` — 将增量文本累积到 buffer
- [ ] 最小编辑间隔 800ms（飞书 API 限制 ~500ms，留 300ms 余量）
- [ ] 首次 flush 时发送新消息（调用飞书 send message API），记录 `message_id`
- [ ] 后续 flush 时编辑已有消息（调用飞书 edit message API）
- [ ] `finalize()` — 清除定时器并执行最后一次 flush（确保最终文本完整发出）
- [ ] 单条消息文本超过 20,000 字符时，finalize 当前消息，创建新消息继续追加（分段发送）
- [ ] 飞书 API 调用失败时重试一次（间隔 1s），仍失败则记录 error 日志但不中断流程
- [ ] Typecheck passes

### US-011: Markdown 渲染适配

**Description:** 作为飞书用户，我希望 AI 的回复在飞书中正确显示代码块、加粗、列表等格式，而不是原始 Markdown 文本。

**Acceptance Criteria:**

- [ ] 实现 `render(text)` 函数（`src/render.ts`），将标准 Markdown 转换为飞书 `lark_md` 兼容格式
- [ ] 代码块（\`\`\`lang ... \`\`\`）保持原样（飞书 lark_md 原生支持）
- [ ] 行内代码（\`code\`）保持原样
- [ ] 加粗（`**text**`）保持原样
- [ ] 斜体（`*text*`）保持原样
- [ ] 无序列表（`- item`）保持原样
- [ ] 有序列表（`1. item`）保持原样
- [ ] 标题（`## heading`）转换为加粗文本（飞书 lark_md 不支持 # 标题语法）
- [ ] 链接（`[text](url)`）转换为飞书超链接格式
- [ ] 超长代码块（>200 行）截断为前 50 行 + `... (共 {n} 行，已截断)`
- [ ] Typecheck passes

### US-012: 优雅启动与关闭

**Description:** 作为运维人员，我需要 bridge 服务能正确启动、运行和关闭，不丢失状态。

**Acceptance Criteria:**

- [ ] 启动流程依次执行：加载配置 → 初始化 SQLite → 连接 opencode server（验证可达）→ 连接飞书 WebSocket → 输出就绪日志
- [ ] 任一步骤失败时输出明确的错误信息并以非零退出码退出
- [ ] 监听 `SIGINT` 和 `SIGTERM` 信号
- [ ] 收到信号后：关闭飞书 WebSocket → finalize 所有活跃的 Throttler → 关闭 SSE 连接 → 关闭 SQLite → 退出
- [ ] 支持 `--port` 参数启动一个健康检查 HTTP 端点 `GET /health`，返回 `{ status: "ok", feishu: true|false, opencode: true|false }`
- [ ] Typecheck passes

### US-013: 完整指令系统 (Phase 2)

**Description:** 作为飞书用户，我需要更丰富的指令来完全控制 opencode，包括会话切换、分叉、模型选择等。

**Acceptance Criteria:**

- [ ] `/sessions` — 调用 `client.session.list()`，以列表形式展示最近 10 个 session（ID、创建时间、消息数）
- [ ] `/switch <session_id>` — 切换当前 chat 绑定到指定 session，回复确认
- [ ] `/fork` — 调用 `client.session.fork()`，将当前 chat 绑定到新 fork 的 session
- [ ] `/model <provider/model>` — 更新 binding 中的 `model_id`，后续 prompt 使用新模型
- [ ] `/models` — 调用 `client.provider.list()`，发送交互卡片展示可用模型列表（provider 分组，下拉选择）
- [ ] `/agent <name>` — 更新 binding 中的 `agent`，后续 prompt 使用新 agent
- [ ] `/agents` — 调用 `client.app.agents()`，发送卡片展示可用 agent 列表
- [ ] `/history [n]` — 获取最近 n 条消息（默认 5），以富文本格式展示摘要
- [ ] `/revert` — 调用 `client.session.revert()`，回滚到上一个用户消息
- [ ] `/share` — 调用 `client.session.share()`，返回分享链接
- [ ] Typecheck passes

### US-014: 控制面板交互卡片 (Phase 2)

**Description:** 作为飞书用户，每次 AI 回复完成后，我希望看到一个操作面板卡片，可以一键执行常用操作。

**Acceptance Criteria:**

- [ ] 当 `session.status` 变为 `idle` 且最终消息发送完成后，追加发送一张 Interactive Card
- [ ] 卡片包含统计信息行：Token 用量（input/output）、耗时、当前 Agent、当前 Model
- [ ] 卡片包含操作按钮：`新会话`、`分叉`、`中止`、`回滚`、`分享`
- [ ] 每个按钮点击后调用对应的 opencode SDK API
- [ ] 按钮点击后卡片更新为操作结果（如 "✅ 已创建新会话: xxx"）
- [ ] Typecheck passes

### US-015: 文件附件处理 (Phase 2)

**Description:** 作为飞书用户，我希望能发送文件或图片给 bot，让 AI 分析文件内容。

**Acceptance Criteria:**

- [ ] 接收飞书文件消息（`msg_type: file`），通过飞书 API 下载到本地临时目录 `/tmp/feishu-bridge/{msg_id}/`
- [ ] 接收飞书图片消息（`msg_type: image`），下载后转为 base64 data URL
- [ ] 将下载的文件/图片作为 prompt parts 发送到 opencode：`{ type: "file", mime, url: "file:///..." }` 或 `{ type: "file", mime: "image/png", url: "data:image/png;base64,..." }`
- [ ] 文件和文本可以同时发送（用户发文件时附带文字描述）
- [ ] 临时文件在 1 小时后自动清理
- [ ] 单文件大小限制 30MB，超出时回复提示
- [ ] Typecheck passes

### US-016: Model/Agent 选择器卡片 (Phase 2)

**Description:** 作为飞书用户，我希望通过交互卡片来可视化地选择模型和 Agent，而不是记忆命令参数。

**Acceptance Criteria:**

- [ ] `/models` 命令触发发送模型选择卡片
- [ ] 卡片包含 `select_static` 下拉组件：Provider 选择（Anthropic、OpenAI 等）
- [ ] 选择 Provider 后动态更新 Model 下拉列表（通过更新卡片实现）
- [ ] "确认切换" 按钮提交选择，更新 binding 中的 model_id
- [ ] `/agents` 命令触发 Agent 选择卡片，展示所有可用 agent 及其描述
- [ ] Typecheck passes

## Functional Requirements

### 飞书连接层

- FR-1: Bridge 使用飞书 `@larksuiteoapi/node-sdk` 的 `WSClient` 建立 WebSocket 长连接，无需公网 IP
- FR-2: 订阅 `im.message.receive_v1` 事件接收用户消息
- FR-3: 群聊中仅当 bot 被 @mention 时才处理消息，私聊中处理所有消息
- FR-4: 通过飞书 `im.v1.message.create` API 发送消息，`im.v1.message.patch` API 编辑消息
- FR-5: 通过飞书 Interactive Card 发送交互卡片，接收卡片按钮回调

### opencode 连接层

- FR-6: 使用 `@opencode-ai/sdk` 的 `createOpencodeClient` 连接远程 opencode server
- FR-7: 支持 Basic Auth 鉴权（`OPENCODE_SERVER_PASSWORD`）
- FR-8: 通过 `x-opencode-directory` header 指定工作目录
- FR-9: 维护持久 SSE 连接到 `GET /event` 端点，消费全局事件流
- FR-10: SSE 断开后自动重连（指数退避：1s → 2s → 4s → ... → 30s max）

### 会话管理

- FR-11: 每个 `(chat_id)` 在群聊场景下绑定一个 opencode session（共享模式，binding 中 `user_id = "shared"`）
- FR-12: 每个 `(user_id)` 在私聊场景下绑定一个 opencode session
- FR-13: 首次消息自动创建 session 并写入 binding
- FR-14: Session 不可用时（404）自动创建新 session 并更新 binding

### 流式输出

- FR-15: 收到飞书消息后立即发送占位消息 "🤔 正在思考..."
- FR-16: 消费 SSE `message.part.delta` 事件，累积文本并节流编辑飞书消息
- FR-17: 编辑间隔不低于 800ms，避免触发飞书 API 限流
- FR-18: 单条飞书消息文本超过 20,000 字符时自动分段到新消息
- FR-19: AI 回复完成后（`session.status: idle`），追加统计信息

### 指令系统

- FR-20: 以 `/` 开头的消息路由到指令处理器
- FR-21: MVP 阶段支持 `/new`、`/abort`、`/status`、`/help` 四个命令
- FR-22: Phase 2 扩展到完整指令集：`/sessions`、`/switch`、`/fork`、`/model`、`/models`、`/agent`、`/agents`、`/history`、`/revert`、`/share`

### 权限控制

- FR-23: 监听 SSE `permission.asked` 事件，发送交互卡片展示权限请求详情
- FR-24: 卡片包含三个选项：允许、始终允许、拒绝
- FR-25: 用户点击后调用 `POST /permission/:requestID/reply` 提交决定
- FR-26: 120 秒无人审批时自动拒绝
- FR-27: 白名单鉴权：`BRIDGE_ALLOWED_USERS` 和 `BRIDGE_ALLOWED_GROUPS` 控制访问权限

### 群聊协作

- FR-28: 群聊中所有成员共享同一 opencode session
- FR-29: prompt 发送前自动注入发送者标识 `[{sender_name}]: {message}`
- FR-30: 群聊中并发消息排队处理（等待上一个 prompt 完成）

## Non-Goals (Out of Scope)

- **不做飞书审批流集成** — 不与飞书审批系统打通，权限确认仅通过卡片按钮
- **不做 Web UI** — 不构建 web 管理界面，所有管理通过命令和配置文件
- **不做多 opencode 实例路由** — MVP 和 Phase 2 仅连接单个 opencode server
- **不做语音/视频消息处理** — 仅处理文本、文件、图片消息
- **不做消息翻译** — 不做多语言翻译，用户和 AI 使用相同语言
- **不做飞书文档集成** — 不读写飞书云文档，仅处理聊天消息
- **不做 opencode PTY/终端转发** — 不在飞书中提供交互式终端
- **不做自动化测试 CI 集成** — bridge 的集成测试需要飞书/opencode 环境，不适合 CI
- **不做按用户的 session 隔离**（群聊场景） — 群聊统一使用共享 session

## Design Considerations

### 消息格式

飞书 `lark_md` 格式与标准 Markdown 有差异：

- 不支持 `#` 标题语法，需要转为 `**加粗文本**`
- 代码块、行内代码、加粗、斜体、列表等基本兼容
- 链接格式为 `[text](url)`，与标准 Markdown 一致

### 交互卡片

飞书 Interactive Card 使用 JSON 描述 UI，支持：

- 按钮（button）、下拉选择（select_static）、表单输入
- 卡片可以在发送后更新（用于按钮点击后的状态变更）
- 卡片回调通过 WebSocket 或 HTTP 回调接收

### 目录结构

```
packages/feishu-bridge/
├── src/
│   ├── index.ts          — 入口，启动流程
│   ├── config.ts         — 配置加载
│   ├── db.ts             — Drizzle schema + 数据库操作
│   ├── lark.ts           — 飞书 SDK 封装（连接、发消息、编辑、下载文件）
│   ├── opencode.ts       — opencode SDK 封装（client、SSE 订阅）
│   ├── router.ts         — 消息路由（群聊/私聊判断、指令/prompt 分发）
│   ├── command.ts        — 指令处理器
│   ├── prompt.ts         — prompt 处理链路（session 查找/创建 → 发送 → 流式输出）
│   ├── throttle.ts       — 流式输出节流器
│   ├── render.ts         — Markdown → lark_md 适配
│   ├── card.ts           — 交互卡片模板（权限确认、控制面板、模型选择器）
│   └── auth.ts           — 白名单鉴权
├── drizzle.config.ts
├── package.json
├── tsconfig.json
└── feishu-bridge.example.json
```

## Technical Considerations

### 依赖关系

- `@opencode-ai/sdk`：通过 workspace 引用（`workspace:*`），与 monorepo 中的 SDK 保持同步
- `@larksuiteoapi/node-sdk`：飞书官方 Node.js SDK，支持 WebSocket 长连接
- `drizzle-orm` + `better-sqlite3`：SQLite ORM，与 opencode 项目风格一致
- 运行时为 Bun（与 opencode 一致）

### 性能约束

| 指标                     | 目标                                              |
| ------------------------ | ------------------------------------------------- |
| 首次回复延迟（占位消息） | < 500ms                                           |
| 流式更新延迟             | < 1.5s（opencode 产出 → 飞书显示，含 800ms 节流） |
| 内存占用                 | < 100MB（20 并发会话）                            |
| SQLite 写入延迟          | < 10ms（binding upsert）                          |

### 飞书 API 限制

| API          | 限制             | 影响                                                   |
| ------------ | ---------------- | ------------------------------------------------------ |
| 消息发送     | ~5 msg/s 全局    | 多个 session 同时回复时可能触发                        |
| 消息编辑     | ~500ms 最小间隔  | 节流器设置 800ms                                       |
| API 总调用量 | 50K/月（免费版） | 20 人团队日均 ~100 次对话，月约 30K 调用（含编辑）安全 |
| 文件下载     | 30MB 限制        | 大文件需提示用户                                       |

### SSE 可靠性

opencode SSE 端点每 10 秒发送心跳。bridge 需要处理：

- 网络抖动导致的断连 → 指数退避重连
- 重连后可能丢失事件 → 通过 `session.status` 同步当前状态
- 如果 session 已 idle 但 bridge 未收到完成事件 → 重连后查询 session 状态补发最终消息

### 并发与竞态

- 群聊共享 session 场景下，多人同时发消息需要排队：维护 per-session 的 Promise 链
- 飞书消息编辑可能与新消息发送竞态：节流器内部用锁保证串行
- SSE 事件分发需要正确匹配 sessionID：维护 `Map<sessionId, Throttler>` 映射

## Success Metrics

- **对话可用性**：飞书发消息后 2 秒内看到 "🤔 正在思考..." 占位消息的成功率 ≥ 99%
- **流式体验**：AI 回复过程中，飞书消息每 0.8-1.5 秒更新一次内容
- **权限响应**：权限确认卡片在 `permission.asked` 事件后 1 秒内发出
- **指令响应**：所有斜杠命令在 1 秒内返回结果（或开始执行）
- **稳定性**：bridge 服务连续运行 7 天无需人工干预重启
- **团队覆盖**：5-20 人团队日均使用不触发飞书 API 限流

## Open Questions

1. **飞书 WebSocket 卡片回调**：飞书 WebSocket 长连接模式是否支持接收卡片按钮回调事件？还是必须配置 HTTP 回调 URL？如果后者，MVP 阶段是否需要额外暴露一个 HTTP 端点？
2. **opencode session 过期策略**：opencode server 是否有 session 自动过期/清理机制？bridge 的 binding 是否需要定期检查 session 有效性？
3. **飞书消息编辑 API 的限制细节**：官方文档未明确编辑频率限制的精确值，800ms 是基于社区经验的估算，是否需要实测确认？
4. **群聊共享 session 的上下文膨胀**：多人往同一个 session 发消息，上下文会快速增长。opencode 的自动 compaction 机制是否足够？是否需要 bridge 侧主动创建新 session？
5. **opencode SDK v2 的 SSE 支持**：`@opencode-ai/sdk` 是否已封装 SSE 订阅？还是需要 bridge 自行通过 `EventSource` 连接 `/event` 端点？
6. **飞书 lark_md 对表格的支持**：AI 回复中可能包含 Markdown 表格，飞书 lark_md 是否支持表格渲染？如不支持，降级方案是什么？
