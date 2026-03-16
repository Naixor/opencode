# PRD: Remote Attach Session 全局数据共享

## Introduction

当 `opencode serve` 启动一个 headless server 后，多个 client 可以通过 `opencode attach <url>` 连接同一个 server。目前的架构中，同一 directory 的多个 attach client **已经共享** 同一个 Instance（Bus + DB），但存在以下问题：

1. **写权限无隔离**：多个 client 都能向同一 session 发送 prompt，但 `assertNotBusy` 只做了"先到先得"的粗粒度控制，没有 owner 概念
2. **SSE 事件无会话过滤**：所有连接同一 directory 的 client 收到全部事件，包括其他 client 发起的 session 操作
3. **client 身份缺失**：server 不知道有哪些 client 连接，无法区分"主控者"和"观察者"
4. **断线重连无身份恢复**：client 重连后获得新 clientID，丢失 owner 身份
5. **TUI 未适配观察者模式**：attach 端的 TUI 和本地 TUI 行为完全一致，没有"只读观察"的 UI 模式

本特性旨在建立完善的"单 server 多 client"协作机制：整个 Instance（per-directory）有且仅有一个 owner（可读写），其他 client 作为 observer（只读，实时观看），所有 client 共享全部实时数据。

### 核心设计原则

1. **TUI = Serve + Attach**：本地 `opencode` TUI 本质上是先启动 HTTP server（默认 `localhost:随机端口`），然后本地 attach 到这个 server。所有 TUI（本地、远端）统一走 HTTP/SSE，消除 in-process RPC 和 HTTP 双代码路径。用户需要远程访问时通过 `--hostname 0.0.0.0` 暴露网络端口
2. **Instance 级 ownership**：owner 是 per-instance（per-directory）的，不是 per-session 的。owner 拥有整个 instance 的写权限，包括所有 session 及其 child session（如 ultrawork loop、subagent task）
3. **有 client 连接时，有且仅有一个 owner**：第一个连接的 client 自动成为 owner。所有 client 断开**且 grace period 超时**后，ownerClientID 重置为 null，下一个连接的 client 重新成为 owner。Grace period 内新 client 连接时作为 observer 加入（原 owner 可能重连恢复）。Ownership 仅通过 takeover 或所有 client 断开（含 grace period 超时）来转移/重置
4. **统一超时常量**：所有超时场景（grace period、activity 超时、idle 后 takeover 可用）复用同一个可配置常量（默认 60s）
5. **Reconnect Token**：支持断线后身份恢复，owner 重连后无缝恢复 ownership

## Current State

以下是与本特性相关的代码现状，供实现者参考：

### SSE 事件系统

- **`server.connected`** 已通过 `BusEvent.define("server.connected", z.object({}))` 注册（`server/event.ts`），schema 为空。但**发送方式是内联**：在 `Bus.subscribeAll()` 之前通过 `stream.writeSSE()` 直接写入当前连接（`server.ts`），不经过 `Bus.publish()`，因此不会广播到其他 SSE 连接。**`server.heartbeat`** 未通过 `BusEvent.define()` 注册，同样通过 `stream.writeSSE()` 内联发送
- `server.connected` 事件当前返回 **空 properties `{}`**，没有 `clientID` 字段。本特性需要扩展其 schema（`BusEvent.define` 和内联发送处同步更新），在 properties 中增加 `clientID`、`reconnectToken`、`role`、`ownerClientID` 字段。发送方式保持内联不变（连接级事件，不应广播）
- Server 没有任何 client 追踪基础设施：无 `clientID` 分配、无 client 注册表、无 `client.disconnected` 事件
- Bus 广播级事件（如 `message.updated`、`session.status`）通过 `BusEvent.define()` + `Bus.publish()` 注册和发布，同一 Instance 下所有 SSE subscriber 自动收到

### Session 状态

- `SessionStatus.Info` 有三种类型：`idle`、`busy`、**`retry`**（含 `attempt`、`message`、`next` 字段）
- `SessionPrompt.state()` 结构为 `Record<string, { abort: AbortController, callbacks: Array<{ resolve, reject }> }>`，其中 `callbacks` 是排队等待的 resolve/reject 回调对数组（非 Promise 对象）
- `assertNotBusy(sessionID)` 检查 sessionID 是否在 state 中存在，存在则抛出 `Session.BusyError`

### Session 层级模型

- Session 支持 parent-child 层级关系，通过 `parent_id` 字段关联
- **Task Tool（subagent）** 调用 `Session.create({ parentID: ctx.sessionID })` 创建 child session
- **Ralph/Ultrawork Loop** 每次迭代创建新的 child session：`Session.create({ parentID: loopState.originSessionID })`
- Child session 的 prompt 由 server 端代码自动发起，不经过 client HTTP API
- 这意味着 ownership 不能是 per-session 的——child session 的写入不携带 clientID，必须在更高层面（instance 级）控制权限

### SDK Client

- SDK 是自动生成的（`packages/sdk/js/script/build.ts`），自定义逻辑放在 wrapper 层 `v2/client.ts`
- 当前 SDK wrapper 层（`v2/client.ts`）仅注入 `x-opencode-directory` header；`x-opencode-workspace` 由 server 端从请求 header 或 query param 中读取，SDK 不主动发送。**不存在 `X-OpenCode-Client-ID`**
- SSE 重连已有指数退避：初始 3s → 6s → 12s → ... → 30s max，支持 `sseMaxRetryAttempts` 限制。注意：基准延迟可被 server SSE 响应中的 `retry:` 字段覆盖
- 重连时发送 `Last-Event-ID` header（标准 SSE 机制）

### TUI 架构（双代码路径问题）

- 本地 TUI 默认使用 **in-process RPC**（Worker subprocess + `createWorkerFetch()`），不经过 HTTP
- 当指定 `--port` 时，TUI 切换为 HTTP 模式（Worker 启动 HTTP server，TUI 通过 SSE 通信）
- `sdk.tsx` 已有完善的抽象层，支持 RPC 和 HTTP 两种后端，TUI 组件不直接访问 Instance
- **双代码路径** 导致 ownership 模型需要同时处理 RPC client（无 clientID）和 HTTP client（有 clientID）

### TUI Worker 重连

- `worker.ts` 中有独立的 SSE 重连循环（`while(true)`），固定 250ms 重试，**无指数退避**
- 与 SDK 端的重连逻辑重复且行为不一致

### CLI `--attach` 模式

- 通过 `createOpencodeClient({ baseUrl, directory })` 连接远程 server
- 有远程 agent 校验逻辑：校验本地指定的 `--agent` 是否存在于远程 server 的 agent 列表中
- 当前不区分 owner/observer，session busy 时抛出 `BusyError`

### Bootstrap 触发链路

- `sync.tsx` 的 `onMount` 直接调用 `bootstrap()` 完成首次全量加载
- `sync.tsx` 监听 `server.instance.disposed` 事件 → 调用 `bootstrap()` 重新初始化
- **`sync.tsx` 不监听 `server.connected` 事件**，当前没有 SSE 重连后自动 bootstrap 的机制。SSE 断线重连由 `sdk.tsx` 的 `while(true)` 循环处理（重新调用 `sdk.event.subscribe()`），但不触发 `bootstrap()`。本特性需要在 SSE 重连成功后（收到新的 `server.connected` 事件时）触发 `bootstrap()` 全量刷新，补偿断线期间丢失的事件

## Goals

- 统一 TUI 架构为 "serve + attach" 模式：本地 `opencode` 启动时自动创建 HTTP server（`localhost:随机端口`），TUI 作为第一个 attach client 连接，消除 in-process RPC 代码路径
- 引入 client 注册机制，server 追踪所有已连接的 client，支持断线重连身份恢复（reconnect token）
- 实现 **Instance 级别**的 owner/observer 角色模型：整个 instance 同一时刻只有一个 owner 可写入，其他 client 只读观察
- Owner 拥有 instance 下所有 session（含 child session）的写权限，child session 的自动执行不受 ownership 检查影响
- 确保所有 sync.tsx 中的实时数据（message、part、session status、permission、question、todo、diff、LSP、MCP、formatter、sandbox、vcs）在所有 client 间实时同步
- attach client 断开重连后能通过 reconnect token 恢复身份，或通过全量 API 拉取恢复完整状态
- TUI 在观察者模式下有清晰的视觉提示并禁用写操作
- 支持 observer 在 takeover 条件满足时接管 instance ownership
- CLI（`opencode run --attach`）与 TUI 统一遵守 owner/observer 规则
- 提供 typing 状态广播，让 observer 知道 owner 正在输入
- 当 server 通过 `--hostname` 暴露网络端口时，提供 shared secret token 认证机制防止未授权访问

## User Stories

### US-001: Client 注册与连接追踪

**Description:** 作为 server 管理员，我需要知道当前有哪些 client 连接到了 server，并支持 client 断线重连后身份恢复。

**Acceptance Criteria:**

- [ ] Client 连接 SSE `/event` 时，server 为其分配唯一 `clientID`（UUID）并记录
- [ ] Server 同时生成 `reconnectToken`（UUID），随 `clientID` 一起在连接级 `server.connected` 内联事件的 `properties` 中返回，同时包含 `role`（`"owner"` 或 `"observer"`）、`ownerClientID` 和 `timeout`（统一超时常量，毫秒）
- [ ] Client 重连时通过请求头 `X-OpenCode-Reconnect-Token` 发送 token，server 验证后**复用旧 `clientID`**，owner 身份无缝恢复
- [ ] Reconnect token 一次性使用：重连成功后 server 签发新 token 并在 `server.connected` 事件中返回
- [ ] Server 维护内存态的 `clients` Map，记录每个 client 的 `clientID`、连接时间、directory、reconnectToken、`type`（`"tui"` | `"cli"`）、来源 IP 地址
- [ ] Client SSE 连接断开后，server **不立即清理** client 记录，进入 grace period（复用统一超时常量，默认 60s。注意：该常量可配置但建议不超过 60s，因为 grace period 同时决定 takeover 条件 C 的等待时间，过长会导致 owner 断线后其他 client 长时间无法操作 instance）
- [ ] Grace period 内收到合法 reconnect token → 恢复身份，取消清理
- [ ] Grace period 超时且无 reconnect → 清理 client 记录，广播 `client.disconnected` 事件
- [ ] 新增 `GET /clients` API 返回当前同 directory 下所有已连接 client 列表。响应 schema：
  ```typescript
  // GET /clients
  // 响应 200：
  {
    ownerClientID: string | null,       // 当前 owner 的 clientID，无 owner 时为 null
    takeoverAvailable: boolean,          // 当前是否可 takeover
    clients: Array<{
      clientID: string,                  // client 唯一标识
      role: "owner" | "observer",        // 角色
      type: "tui" | "cli",              // client 类型
      remoteIP: string,                  // 来源 IP
      connectedAt: number,               // 连接开始时间戳（毫秒）
      duration: number,                  // 连接持续时间（毫秒，server 端计算）
    }>
  }
  ```
- [ ] 新增**广播级** Bus 事件 `client.connected` 和 `client.disconnected`（通过 `BusEvent.define()` 注册 + `Bus.publish()` 发布），广播给同 directory 的所有 client
- [ ] `server.connected` 事件保持为连接级内联事件，在其 `properties` 中返回 `clientID`、`reconnectToken`、`role`（`"owner"` | `"observer"`）、`ownerClientID` 和 `timeout`（统一超时常量，毫秒）
- [ ] 第一个连接的 client 自动成为 instance 的 owner
- [ ] Typecheck 通过

**依赖关系：** US-012（统一 HTTP/SSE 架构）。US-004、US-002 依赖本 US 的产出。US-008 依赖本 US 和 US-015。

### US-002: Instance 级 Owner/Observer 角色模型

**Description:** 作为 attach client 用户，我需要知道自己在当前 instance 中是 owner 还是 observer，这样我就明白自己能做什么。

**前置依赖：** US-001（clientID 分配）

**Acceptance Criteria:**

- [ ] Instance 增加 `ownerClientID` 字段（内存态，非持久化），记录当前拥有写权限的 client
- [ ] 第一个连接 instance 的 client 自动成为 owner（与 US-001 联动）
- [ ] Owner 拥有 instance 下所有 session 的写权限，包括 child session（ultrawork loop、subagent task 等自动创建的 session）
- [ ] Child session 的 prompt 由 server 内部发起，不经过 ownership 检查
- [ ] 有 client 连接时，有且仅有一个 owner。所有 client 断开**且 grace period 超时**后 ownerClientID 重置为 null，下一个连接的 client 重新成为 owner。Grace period 内新 client 连接时作为 observer 加入（原 owner 可能重连恢复）。Ownership 仅通过 takeover 或所有 client 断开（含 grace period 超时）来转移/重置
- [ ] 新增**广播级** Bus 事件 `instance.owner.changed`（通过 `BusEvent.define()` 注册），包含 `ownerClientID`
- [ ] 所有 client 通过 SSE 实时收到 owner 变更通知
- [ ] Typecheck 通过

### US-003: Observer 客户端的写操作拦截

**Description:** 作为 observer，当我尝试发送消息时，系统应该明确告诉我无法操作而不是返回不明确的错误。

**前置依赖：** US-002（owner 模型）

**Acceptance Criteria:**

- [ ] 当请求方 clientID 不是 instance owner 时，所有写操作（prompt、permission reply、question reply 等）返回 HTTP 423 Locked
- [ ] 错误响应包含 `ownerClientID` 信息，让 client 知道谁在操作
- [ ] `assertNotBusy` 逻辑增强为 `assertCanWrite(clientID)`：先检查 instance ownership（非 owner 返回 423），再沿用现有 `assertNotBusy` 的 busy/retry 判断逻辑（不改变现有行为——retry 状态下 owner 的行为与当前实现保持一致）
- [ ] Observer 的请求**直接返回 423，不进入 callback 排队队列**
- [ ] Child session 的内部 prompt（server 自动发起）不经过 `assertCanWrite` 检查
- [ ] Typecheck 通过

### US-004: 请求头传递 Client ID

**Description:** 作为 server，我需要通过 HTTP 请求识别发起操作的 client，以便做权限和角色判断。

**前置依赖：** US-001（clientID 分配和 `server.connected` 事件返回 clientID）

**Acceptance Criteria:**

- [ ] `server.connected` 事件的拦截与 clientID 存储分两层协作：
  - **`sdk.tsx` 层**：在 SSE 事件流中识别 `server.connected` 事件，提取 `clientID`、`reconnectToken`、`role`、`ownerClientID`，写入 SDK context 的共享状态（如 `clientState` signal）。这是事件流的自然处理位置，与其他事件（`message.updated` 等）在同一 event listener 中处理
  - **SDK wrapper 层（`v2/client.ts`）**：`createOpencodeClient` 接受一个可选的 `getClientID` / `getReconnectToken` 回调（或 reactive getter），用于动态注入 `X-OpenCode-Client-ID` 和 `X-OpenCode-Reconnect-Token` header。当前 `config.headers` 是创建时一次性设置的静态值，无法满足动态需求，需扩展为支持函数形式的 header 值
  - 不修改自动生成的代码（`gen/` 目录）
- [ ] SDK client 在后续所有请求中通过 `X-OpenCode-Client-ID` header 传递 `clientID`
- [ ] SDK client 在 SSE 连接（含首次连接和重连）时同时通过 `X-OpenCode-Client-ID` header 传递已存储的 `clientID`（首次连接时无值则不发送），用于 server 重启后的身份恢复
- [ ] SDK client 在 SSE 连接时通过 `X-OpenCode-Client-Type` header 上报 client 类型（`tui` 或 `cli`），server 同时从请求中提取来源 IP
- [ ] SDK client 在 SSE 重连请求中通过 `X-OpenCode-Reconnect-Token` header 传递 reconnectToken
- [ ] SDK wrapper 层实现 ready gate：写操作（非 GET 请求）自动等待 `clientID` 就绪（即首次 `server.connected` 事件到达并写入共享状态）后再发送。读操作（GET 请求）不受 gate 影响，可在 `clientID` 就绪前发出（bootstrap 场景）
- [ ] 未携带 `X-OpenCode-Client-ID` 的**写操作**请求返回 HTTP 400，提示升级 SDK 版本（不做向后兼容）
- [ ] 读操作（GET 请求）不强制要求 `clientID`，以便调试和监控工具访问
- [ ] Typecheck 通过

### US-005: Observer 超时接管

**Description:** 作为 observer，当 owner 长时间不活跃或断线时，我可以接管 instance 的 owner 权限。

**前置依赖：** US-002（owner 模型）、US-003（写操作拦截）

**Acceptance Criteria:**

- [ ] Owner 端每 10s 向 server 发送 `POST /instance/activity`（instance 级，非 per-session），携带 `active` 布尔字段表示用户是否有近期活动（如输入、操作等）。使用独立 POST 而非复用 SSE，因为 SSE 是单向通道（server → client），无法承载 client → server 的上行数据；使用独立端点而非推断 owner 最后请求时间，因为需要区分"用户在看屏幕但未操作"（`active: true`，TUI 有焦点和输入事件）和"用户已离开"（`active: false`）
- [ ] Server 记录 owner 的最近一次 activity 上报时间和活动状态（内存态）
- [ ] 新增 `POST /instance/takeover` 端点，允许 observer 接管 instance ownership
- [ ] Takeover 可用条件（满足任一即可无条件 takeover）：
  - 条件 A：owner activity **上报**超时——`Date.now() - lastReport > TIMEOUT`，即 owner 完全停止了 activity 上报（TUI 崩溃、网络异常等）
  - 条件 B：instance 下所有 session 均为 idle 且 owner **最后一次活跃**超时——`allSessionsIdle() && Date.now() - lastActiveReport > TIMEOUT`，即 owner 仍在上报但最后一次 `active: true` 距今超过 TIMEOUT（用户离开了电脑）。注意：`lastReport` 是任意上报的时间戳，`lastActiveReport` 是最后一次 `active: true` 上报的时间戳，两者不同
  - 条件 C：owner 断线且 grace period 超时
- [ ] Takeover 条件不满足时返回 HTTP 409 Conflict（含 `ownerClientID` 信息，告知 owner 仍活跃或已被其他 client 接管）
- [ ] 当 instance 下有正在执行的 session（busy/retry）时，takeover 请求需携带 `force: true` 参数才能执行；未携带 `force` 时返回 HTTP 409 + `{ reason: "active_sessions", sessions: [...] }`，提示有活跃 session
- [ ] 当 instance 下所有 session 均为 idle 时，takeover 直接成功，无需 `force` 参数
- [ ] Takeover 成功后（含 force）：abort 所有正在执行的 session prompt，将 `ownerClientID` 切换为请求方
- [ ] 被 abort 的 prompt 的 assistant message 标记为 incomplete
- [ ] Takeover 成功后发布 `instance.owner.changed` 事件，所有 client 收到通知
- [ ] Takeover 成功后进入冷却期（复用统一超时常量，默认 60s），冷却期内 instance 不可被再次 takeover（包括原 owner，不做豁免——防止 ownership 频繁乒乓切换）
- [ ] 两个 observer 同时 takeover 时，先到者成功，后到者收到 409（告知 ownership 已被其他 client 接管）
- [ ] Owner 自身在 takeover 条件满足后可 takeover 自己（用于 reconnect token 过期后恢复身份）。注意：此规则同样受冷却期约束——冷却期内任何人（包括原 owner）都不可 takeover
- [ ] TUI 在 observer 模式下显示 "Takeover" 按钮（仅在 takeover 条件满足后可用）
- [ ] TUI 中 takeover 操作在检测到活跃 session 时弹出确认提示（"There are N active sessions. Force takeover will abort them. Continue?"）
- [ ] Server 在 `takeoverAvailable` 状态发生变化（`false→true` 或 `true→false`）时，发布**广播级** Bus 事件 `takeover.available`（通过 `BusEvent.define()` 注册），包含 `available: boolean` 和 `ownerClientID`
- [ ] Typecheck 通过

**Takeover 判断流程伪代码：**

```typescript
function handleTakeover(requestClientID: string, force?: boolean) {
  // Step 1: 检查冷却期
  if (Date.now() - lastTakeoverTime < TIMEOUT) return 409 // 冷却期内不可 takeover

  // Step 2: 检查 takeover 条件（满足任一即可）
  const conditionA = Date.now() - ownerState.lastReport > TIMEOUT
  const conditionB = allSessionsIdle() && Date.now() - ownerState.lastActiveReport > TIMEOUT
  const conditionC = !clients.has(ownerState.clientID) // owner 断线且 grace period 已超时

  if (!conditionA && !conditionB && !conditionC) return 409 // { ownerClientID, reason: "owner_active" }

  // Step 3: 检查是否有活跃 session（busy/retry）
  const active = getActiveSessions() // busy 或 retry 状态的 session
  if (active.length > 0 && !force) return 409 // { reason: "active_sessions", sessions: active }

  // Step 4: 执行 takeover
  if (active.length > 0) abortAllActiveSessions() // abort + 标记 incomplete

  ownerState.clientID = requestClientID
  lastTakeoverTime = Date.now()
  publish("instance.owner.changed", { ownerClientID: requestClientID })
  return 200
}
```

**API Schema：**

```typescript
// POST /instance/activity
// 请求：
{ active: boolean }
// 响应 200：
{ ok: true }
// 响应 403：非 owner 调用时

// POST /instance/takeover
// 请求：
{ force?: boolean }
// 响应 200（成功）：
{ ownerClientID: string }
// 响应 409（冷却期内）：
{ reason: "cooldown", ownerClientID: string, retryAfter: number } // retryAfter: 剩余冷却毫秒数
// 响应 409（条件不满足）：
{ reason: "owner_active", ownerClientID: string }
// 响应 409（有活跃 session 但未传 force）：
{ reason: "active_sessions", ownerClientID: string, sessions: Array<{ sessionID: string, status: "busy" | "retry" }> }
// 响应 409（已被其他 client 抢先 takeover）：
{ reason: "owner_changed", ownerClientID: string } // ownerClientID 是新 owner
```

**关于 `retry` 状态：** 详见 Technical Considerations → Owner 状态模型中的"活跃 session"定义。

### US-006: TUI 观察者模式 UI

**Description:** 作为 attach 的观察者用户，我能看到 session 的实时进展，界面清晰提示我处于观察模式。

**前置依赖：** US-001（`GET /clients` API、`client.connected`/`client.disconnected` 事件）、US-002（owner 模型）

**Acceptance Criteria:**

- [ ] TUI 侧边栏显示当前角色：`Owner` 或 `Observer`
- [ ] TUI 侧边栏显示已连接 client 列表及各自状态（clientID 缩写、角色）
- [ ] Observer 模式下 prompt 输入框变为 disabled 状态，显示"Instance in use by another client"提示
- [ ] Takeover 条件满足时，Observer 的输入框区域显示可用的 "Takeover" 操作
- [ ] Owner/Observer 状态变化有视觉过渡（如颜色闪烁）
- [ ] Typecheck 通过

### US-007: Commands 面板 Client 详情

**Description:** 作为用户，我可以通过 Commands 面板（Ctrl+P）查看所有已连接 client 的完整信息。

**前置依赖：** US-001（`GET /clients` API）

**Acceptance Criteria:**

- [ ] Commands 面板新增 "Show Connected Clients" 命令
- [ ] 命令打开 dialog，展示每个 client 的完整信息：clientID、角色（owner/observer）、client 类型（TUI/CLI）、来源 IP、连接开始时间、连接持续时间
- [ ] Client 列表实时更新（有新 client 连接或断开时自动刷新）
- [ ] 当前 client 在列表中高亮标记（如 "You" 标签）
- [ ] Typecheck 通过

### US-008: 全量数据同步与断线 UI

**Description:** 作为 attach client，我在首次连接或断线重连时需要拉取完整的 session 状态，包括所有 sync.tsx 中管理的数据。断线期间 UI 应有明确的视觉提示。

**前置依赖：** US-001（client 注册）、US-009（SSE 重连机制）、US-015（`update_seq` 基础设施）

**Acceptance Criteria:**

- [ ] SSE 连接断开后，TUI 立即显示全屏半透明 overlay，提示 "Reconnecting..."，并显示重连倒计时（基于 SDK 指数退避的当前间隔）
- [ ] Overlay 期间 TUI 冻结所有用户交互（prompt 输入、快捷键等），防止操作丢失
- [ ] 重连成功后 overlay 自动消失，TUI 恢复交互
- [ ] 重连成功后触发 `bootstrap()` 全量刷新，拉取以下数据：
  - 所有 session 列表及状态（含 child session）
  - 当前 session 的 message 和 part 数据
  - Permission 和 question 待处理项
  - Todo 列表
  - LSP、MCP、formatter、sandbox、vcs 状态
  - 已连接 client 列表（`GET /clients`，放在 non-blocking 阶段——角色信息已从 `server.connected` 事件的 `role` 字段获取，client 列表仅用于侧边栏展示，不阻塞 TUI 交互恢复）
- [ ] **重连时 reset store**：SSE 重连成功后，client 立即清空本地 store（所有缓存数据及其 `update_seq`），然后触发 `bootstrap()` 全量拉取。这确保 bootstrap 数据能无条件写入，并解决 server 重启后计数器归零的兼容性问题
- [ ] Bootstrap 数据和 SSE 增量事件均携带 `update_seq` 字段，client 端 store 更新时统一执行版本检查：仅当 `incoming.update_seq > stored.update_seq` 时才应用（详见 Technical Considerations → Bootstrap 与 SSE 事件竞态）
- [ ] 全量刷新完成后 TUI 恢复完整状态，用户无需手动操作
- [ ] Typecheck 通过

**注意：** 现有 `session.sync()`、`bootstrap()`、`server.connected` → `bootstrap()` 触发链路、`server.instance.disposed` → `bootstrap()` 触发链路的正确性验证已纳入 Testing Requirements 的 "SSE 重连" 测试部分。

### US-009: SSE 重连机制增强

**Description:** 作为 attach client，当 SSE 连接因网络问题断开时，系统应该自动重连并恢复状态和身份。

**Acceptance Criteria:**

- [ ] 移除 `worker.ts` 的 RPC 事件转发和冗余重连循环（新架构下 TUI 直接通过 HTTP/SSE 连接 Worker）
- [ ] 网络错误的重连由 SDK 内层指数退避处理（`serverSentEvents.gen.ts`，3s → 6s → 12s → ... → 30s max），`sseMaxRetryAttempts` 保持 `undefined`（无限重试）
- [ ] SSE stream 正常结束（server 主动关闭连接）后的重新 subscribe 由 `sdk.tsx` 的 `while(true)` 外层循环处理。注意：当前 `sdk.tsx` 的 `sdk.event.subscribe()` 调用缺少异常捕获，subscribe 本身抛异常时会终止循环导致不可恢复。需增加 `.catch()` 保护（参考现有 `worker.ts` 的 `Promise.resolve(...).catch(() => undefined)` 模式）
- [ ] 重连时 SDK 自动附带 `X-OpenCode-Reconnect-Token` header
- [ ] Server 收到合法 reconnect token 后复用旧 clientID，owner 身份无缝恢复
- [ ] Reconnect token 过期（grace period 已超时）时，server 分配新 clientID，client 作为新 observer 加入
- [ ] 重连成功后 server 发送 `server.connected` 事件（含 `clientID` + 新 `reconnectToken`），client 触发 `bootstrap()` 全量刷新
- [ ] 重连期间的事件丢失通过全量刷新补偿
- [ ] Typecheck 通过

### US-010: Permission 和 Question 请求的观察者广播

**Description:** 作为 observer，我能实时看到 owner 正在处理的 permission 请求和 question 交互。

**Acceptance Criteria:**

- [ ] `permission.asked` 和 `permission.replied` 事件广播到所有 client（已有，验证工作正常）
- [ ] `question.asked` 和 `question.replied` 事件广播到所有 client（已有，验证工作正常）
- [ ] **Client 端防护**：Observer 端显示 permission/question 对话框但不绑定交互快捷键（仅查看），UI 有明确的"View Only"标记
- [ ] **Server 端防护**：permission reply 和 question reply 接口校验请求方 `clientID` 是否为 owner，非 owner 返回 HTTP 423 Locked
- [ ] Typecheck 通过

### US-011: Typing 状态广播

**Description:** 作为 observer，我想知道 owner 正在输入 prompt，这样我对即将到来的新消息有心理预期。

**Acceptance Criteria:**

- [ ] TUI 在用户输入 prompt 时，以 300ms 节流频率向 server 发送 `POST /session/:sessionID/typing` 请求。Server 返回 `{ ok: true }`（200）或 403（非 owner）。Server 不校验 sessionID 存在性——如果 session 已被删除，仍返回 200 静默处理（广播事件后 observer 端找不到该 session 自然不显示）
- [ ] Typing 事件**仅在用户已进入一个已存在的 session 时发送**；新建 session（session 尚不存在）和 session 列表页不发送
- [ ] Typing 事件仅由 owner 发送（observer 的 prompt 是 disabled 状态，无需处理）
- [ ] Server 收到 typing 请求后发布 `session.typing` **广播级** Bus 事件（通过 `BusEvent.define()` 注册），包含 `sessionID` 和 `clientID`
- [ ] Observer 端收到事件后，在消息列表底部或 prompt 区域显示 "Owner is typing..." 提示
- [ ] Typing 提示在 2s 无新 typing 事件后自动消失
- [ ] Observer 仅在当前查看的 session 与 typing 事件的 sessionID 匹配时才显示提示，跨 session 的 typing 事件不显示
- [ ] 仅在有其他 client 连接时才发送 typing 事件（避免单 client 场景的无意义开销）。Client 数量通过本地维护的计数器获取（监听 `client.connected` / `client.disconnected` 广播事件递增/递减，bootstrap 时从 `GET /clients` 初始化）
- [ ] Typecheck 通过

**已知限制：** 新建 session 时，session 在发送第一条 prompt 后才在服务端创建。因此 owner 在新 session 中输入第一条 prompt 的过程中，observer 看不到 typing 提示。仅在已存在的 session 中追加 prompt 时 typing 提示可见。

### US-012: TUI 架构统一为 Serve + Attach

**Description:** 作为开发者，我需要本地 `opencode` TUI 与远端 attach TUI 使用同一条代码路径（HTTP/SSE），这样 ownership 模型可以统一工作，且本地 TUI 天然支持被远端 attach。

**Acceptance Criteria:**

- [ ] Worker 进程 per-directory 全局唯一，以 detached 后台进程方式运行（`Bun.spawn()` + `detached: true` + `stdio: "ignore"`）
- [ ] Worker 启动后创建 lock file（路径和格式见 Technical Considerations → Lock File 规格），TUI 通过 lock file 发现已有 Worker
- [ ] `opencode`（本地 TUI）启动时，检查 lock file：无 Worker 则启动新 Worker；已有 Worker 则验证进程存活（`kill -0 PID`）后直接连接；进程不存在则清理 stale lock file 并启动新 Worker
- [ ] Lock file 由 Worker 进程创建（非 TUI 进程）。Worker 启动时**先绑定随机端口并启动 HTTP server**，获得确定的 port 后，再使用原子创建（`O_EXCL` 或等效机制）写入**内容完整的** lock file（含 pid、port、token、createdAt），防止 TOCTOU 竞态。两个 TUI 同时启动时，两个 Worker 都先启动各自的 HTTP server，然后竞争原子创建 lock file，仅一个成功，另一个检测到文件已存在后**关闭自己的 HTTP server 并自行退出**。TUI 等待 lock file 出现后读取端口并连接——由于 lock file 内容在创建时即完整，TUI 读取时无需轮询等待 port 字段
- [ ] Worker 启动 HTTP server（默认绑定 `localhost:随机端口`）
- [ ] 本地 TUI 通过 HTTP/SSE 连接到 Worker 的 HTTP server（即本地 TUI 就是第一个 attach client）
- [ ] 移除 `createWorkerFetch()` 和 `createEventSource()` 的 in-process RPC 代码路径
- [ ] `sdk.tsx` 简化为仅使用 SSE 回退路径（移除 custom event source 分支）
- [ ] 用户通过 `--hostname 0.0.0.0` 暴露网络端口，允许远端 attach（默认仅 localhost）
- [ ] 本地 TUI 作为第一个连接的 client 自动成为 owner
- [ ] 远端 client 通过 `opencode attach <ip:port>` 连接后作为 observer 加入
- [ ] TUI 退出不影响 Worker 运行；`--mode=auto` 模式下，所有 client 断开且 grace period 超时后 Worker 自动关闭并清理 lock file
- [ ] Worker 支持 `--mode=auto|serve` 启动参数。TUI 自动启动 Worker 时传 `--mode=auto`；`opencode serve` 启动的 Worker 不传此参数，默认为 `serve` 模式。`auto` 模式下无客户端时自动退出，`serve` 模式永不自动退出
- [ ] **Idle watchdog 兜底**：Worker 维护 idle watchdog 定时器，当无任何活跃 SSE 连接且无活跃 session（busy/retry）超过 5 分钟后，Worker 自行退出并清理 lock file。此机制作为 grace period 之外的最终兜底，防止异常情况（SSE 连接状态脏、TCP 半开连接、事件循环阻塞等）导致 Worker 成为永久运行的孤儿进程。仅在 `--mode=auto` 模式下启用
- [ ] `opencode stop` 读取 lock file 获取 PID，发送 SIGTERM，Worker 优雅关闭
- [ ] Worker 注册 SIGTERM / SIGINT handler，确保退出时清理 lock file
- [ ] 本地延迟从 ~0.1ms（RPC）增加到 ~1-2ms（HTTP），对用户无感知
- [ ] Typecheck 通过

**依赖关系：** 无前置依赖。建议作为 Phase 0 最先实施，为后续所有 ownership 功能提供统一的架构基础。

### US-013: CLI `run --attach` Owner/Observer 适配

**Description:** 作为 CLI 用户，当我通过 `opencode run --attach` 连接远程 server 时，如果我不是 owner，应该收到明确的错误信息并退出。

**前置依赖：** US-002（owner 模型）、US-003（写操作拦截）

**Acceptance Criteria:**

- [ ] CLI `opencode run --attach` 连接远程 server 后，先进行 agent 校验（已有逻辑）
- [ ] Agent 校验通过后，检查当前 client 的 role（从 `server.connected` 事件获取）
- [ ] 如果 role 为 observer，输出明确的错误信息（含 ownerClientID）并以非零退出码退出
- [ ] 如果 role 为 owner，正常执行 prompt
- [ ] 执行过程中如果 ownership 被 takeover（收到 `instance.owner.changed` 事件），当前 prompt 被 abort 后以非零退出码退出
- [ ] 不做 `--wait` 阻塞等待功能（已在 Non-Goals 中声明）
- [ ] Typecheck 通过

### US-014: 网络暴露时的 Shared Secret Token 认证

**Description:** 作为 server 管理员，当我通过 `--hostname 0.0.0.0` 暴露网络端口时，我需要一个简单的认证机制防止未授权访问。

**Acceptance Criteria:**

- [ ] Server 启动时，如果 `--hostname` 不是 `localhost` / `127.0.0.1` / `::1`，自动生成一个随机 auth token（UUID）并打印到终端
- [ ] 用户也可通过 `--auth-token <token>` 参数自行指定 auth token
- [ ] Auth token 写入 lock file（`{ pid, port, token }`），lock file 权限设为 `0600`（仅当前用户可读）。本地 TUI 启动时从 lock file 读取 token 自动认证，无需用户手动提供
- [ ] Client 连接时通过 `Authorization: Bearer <token>` header 传递 auth token
- [ ] Server 验证 auth token，不匹配时 SSE 连接和 REST 请求均返回 HTTP 401 Unauthorized
- [ ] 当 `--hostname` 为 `localhost` / `127.0.0.1` / `::1` 时，不启用认证（不生成 token，lock file 中 token 字段为空）
- [ ] 注意：当 `--hostname 0.0.0.0` 时，所有连接（包括本地 `127.0.0.1`）都需要 auth token。Auth 判断基于 server 的 bind hostname，不基于客户端来源 IP。本地 TUI 通过 lock file 自动获取 token，对用户透明
- [ ] `opencode attach <url>` 支持 `--auth-token <token>` 参数，远端 attach 时手动携带 token
- [ ] Auth token 校验作为 middleware 实现，在 clientID 校验之前执行
- [ ] Typecheck 通过

**依赖关系：** 无前置依赖。建议与 US-012 同步实施。

### US-015: `update_seq` 基础设施

**Description:** 作为系统基础设施，需要为可变实体（session、message、part）提供单调递增的版本号，用于 client 端防止旧数据覆盖新数据。

**Acceptance Criteria:**

- [ ] Session、message、part 表各新增 `update_seq` integer 列（DB migration，默认值为 **0**）
- [ ] 每个实体独立维护自己的 `update_seq`（per-entity 计数器，非全局共享），每次写入时递增
- [ ] 所有 REST API 响应均携带实体的 `update_seq` 字段
- [ ] 所有 SSE 广播事件（如 `message.updated`、`session.status` 等）均携带实体的 `update_seq` 字段
- [ ] 非持久化状态（client 列表、ownership 等）由 server 内存态维护 per-entity 递增计数器
- [ ] Server 重启后，持久化实体的 `update_seq` 从 DB 恢复（`SELECT MAX(update_seq) FROM <table> WHERE id = ?`）；非持久化状态的计数器从 0 开始（配合 client 端重连 reset store 策略，不会导致版本不一致）
- [ ] Typecheck 通过

**依赖关系：** 无前置依赖。US-008 依赖本 US 的产出。

## Functional Requirements

- FR-1: Server 维护内存态的 `ConnectedClients` Map，key 为 `clientID`（UUID），value 包含 `{ directory, connectedAt, reconnectToken, role, type, remoteIP }`
- FR-2: SSE `/event` 连接建立时分配 `clientID` 和 `reconnectToken`，在连接级 `server.connected` 内联事件中返回（properties 包含 `clientID`、`reconnectToken`、`role`、`ownerClientID`、`timeout`）；重连时通过 `X-OpenCode-Reconnect-Token` header 验证并复用旧 `clientID`
- FR-3: Client 断线后进入 grace period（复用统一超时常量，默认 60s），期间接受 reconnect token 恢复身份；超时后清理记录并广播 `client.disconnected`
- FR-4: 新增 `GET /clients` 端点，返回当前同 directory 下所有已连接 client 列表（含 clientID、角色、连接开始时间、持续时间、`takeoverAvailable` 状态、client 类型、来源 IP——由 server 端计算，作为 single source of truth）
- FR-5: Instance 维护内存态 `ownerClientID` 字段（可为 null），第一个连接的 client 自动成为 owner。有 client 连接时有且仅有一个 owner，所有 client 断开**且 grace period 超时**后 ownerClientID 重置为 null。Grace period 内新 client 连接时作为 observer 加入
- FR-6: `assertNotBusy()` 增强为 `assertCanWrite(clientID)`：检查请求方是否为 instance owner。Observer 请求直接返回 HTTP 423 Locked 不进入 callback 排队队列。Child session 的内部 prompt（server 自动发起）绕过此检查
- FR-7: Owner 端每 10s 发送 `POST /instance/activity`（含 `active` 布尔字段表示用户近期活动状态）；新增 `POST /instance/takeover` 端点：当 takeover 条件满足时（activity 超时 / 全部 idle + owner 无活动超时 / owner 断线超时），observer 可接管 ownership。当有活跃 session（busy/retry）时需携带 `force: true` 才能执行 takeover 并 abort 所有正在执行的 session；无活跃 session 时直接成功
- FR-8: Takeover 竞态：先到者成功，后到者收到 409 Conflict（含新 ownerClientID）。Owner 可 takeover 自己（用于 reconnect token 过期后恢复身份）。Takeover 成功后进入冷却期（复用统一超时常量），冷却期内不可被再次 takeover。当有活跃 session 时需携带 `force: true` 参数
- FR-9: SDK client 从连接级 `server.connected` 事件获取 `clientID`、`reconnectToken`、`role` 和 `ownerClientID`，存储为内部状态，后续请求通过 `X-OpenCode-Client-ID` header 传递，重连时同时通过 `X-OpenCode-Reconnect-Token` 和 `X-OpenCode-Client-ID` header 传递（后者用于 server 重启后的身份恢复）。Header 注入在 SDK wrapper 层（`v2/client.ts`）实现，不修改自动生成代码。Server 收到 `X-OpenCode-Client-ID` 后，校验该 clientID 在 `ConnectedClients` Map 中存在且未过期，否则返回 HTTP 403 Forbidden（与 auth token 的 401 Unauthorized 区分：401 表示认证失败需重新提供 token，403 表示已认证但 clientID 无效需重新建立 SSE 连接）。未携带 clientID 的写操作返回 HTTP 400
- FR-10: TUI 侧边栏显示当前角色和已连接 client 列表；Commands 面板（Ctrl+P）提供 "Show Connected Clients" 命令展示完整详情
- FR-11: Observer 模式下 TUI 的 prompt 输入框 disabled，显示提示信息；takeover 条件满足后显示 Takeover 操作
- FR-12: SSE 重连统一使用 SDK 端指数退避逻辑（3s → 6s → ... → 30s max），移除 TUI worker 端冗余重连循环。重连时附带 reconnect token 恢复身份。重连后收到 `server.connected` 事件触发 `bootstrap()` 全量刷新
- FR-13: Bus 广播级事件（message.updated、message.part.updated、session.status、todo.updated、session.diff 等）继续使用现有广播机制，无需额外改动（同 Instance 下已自动广播到所有 SSE client）
- FR-14: Server 为可变实体（session、message、part 等）维护单调递增的 `update_seq` 字段（per-entity 独立计数器，非全局共享，非时间戳；注意 session 表现有 `version` 列存储的是软件版本号不可复用），REST API 响应和 SSE 事件均携带该字段。Client 端采用"重连 reset + 统一版本检查"策略：SSE 重连时先清空 store，然后 bootstrap 和 SSE 增量事件统一执行 per-entity 版本比较（`incoming.update_seq > stored.update_seq`），防止竞态导致旧数据覆盖新数据，同时解决 server 重启后计数器归零的兼容性问题
- FR-15: Permission reply 和 question reply 接口增加 server 端 owner 校验，非 owner 返回 423 Locked；TUI observer 端对话框不绑定交互快捷键（双重防护）
- FR-16: TUI 在用户输入时以 300ms 节流发送 typing 事件（仅在已存在的 session 中、仅 owner 发送、仅有其他 client 连接时）；observer 端仅在当前查看的 session 与 typing 事件的 sessionID 匹配时显示 "Owner is typing..." 提示，2s 无更新后消失
- FR-17: CLI（`opencode run --attach`）遵守 owner/observer 规则：agent 校验 → 从 `server.connected` 事件获取 role → observer 时输出错误信息（含 ownerClientID）并以非零退出码退出；执行中被 takeover 时 prompt 被 abort 后以非零退出码退出
- FR-18: 本地 `opencode` TUI 统一为 "serve + attach" 架构：Worker 作为 per-directory 全局唯一的 detached 后台进程运行，支持 `--mode=auto|serve` 启动参数（TUI 自动启动传 `--mode=auto`，`opencode serve` 默认 `serve` 模式）。Worker 启动 HTTP server（`localhost:随机端口`），通过 lock file（含 PID + 端口）供 TUI 发现和连接。TUI 通过 HTTP/SSE 连接 Worker。移除 `createWorkerFetch()` 和 `createEventSource()` 的 in-process RPC 路径。`auto` 模式下无客户端时自动退出（含 idle watchdog 兜底：无活跃连接+无活跃 session 超过 5 分钟后退出），`serve` 模式永不自动退出。`--hostname 0.0.0.0` 暴露网络端口供远端 attach。`opencode stop` 通过 lock file 获取 PID 并发送 SIGTERM 终止 Worker
- FR-19: `GET /clients` 响应包含 `takeoverAvailable` 字段，由 server 端计算（single source of truth）。Server 在 `takeoverAvailable` 状态变化时发布 `takeover.available` 广播级事件（含 `available` 和 `ownerClientID`），client 不需自行维护定时器或轮询
- FR-20: 当 `--hostname` 不是 `localhost` / `127.0.0.1` / `::1` 时，server 自动生成 auth token（或通过 `--auth-token` 指定）并打印到终端。Client 通过 `Authorization: Bearer <token>` header 认证，不匹配返回 401。Auth token 校验作为 middleware 在 clientID 校验之前执行。本地连接不启用认证

## Non-Goals

- 不做多 server 实例间的数据同步（分布式场景）
- 不做 SSE 事件的增量补发（断线重连用全量刷新 + reconnect token 身份恢复替代）
- 不做完整的 client 状态持久化（仅持久化 ownerClientID 用于 server 重启后原 owner 优先恢复）
- 不做细粒度 ACL 授权（client 角色仅由 instance ownership 决定）。网络暴露时通过 shared secret token 做基础认证（见 US-014）
- 不做 clientID 防伪造（已认证 client 之间互相信任）。Trust boundary 在 auth token 层：未认证的外部请求被 401 拦截；已认证的 client 理论上可伪造其他 client 的 `X-OpenCode-Client-ID` header，但这属于协作者间的信任问题，不在本特性的威胁模型内
- 不做多 client 同时写入（始终是单写多读模型）
- 不做 observer 的 prompt 排队功能（observer 需等待 takeover 后才能操作）
- 不做 prompt 输入内容的实时预览（仅广播 typing 状态，不广播具体文本）
- 不做最大 client 连接数限制（简化实现，避免 SSE 层 vs REST 层不一致问题）
- 不做 CLI `run --attach` 的 `--wait` 阻塞等待功能（直接退出，调用方自行重试）
- 不保留 in-process RPC 代码路径（统一为 HTTP/SSE，接受 ~1-2ms 本地延迟增加）
- 不做 TLS/HTTPS 传输加密——当前为内部团队协作场景使用，网络安全由基础设施（SSH tunnel、VPN 等）保障。后续按需添加

## Technical Considerations

### 统一超时常量

所有超时场景复用同一个可配置常量，由 server 统一提供，避免多处硬编码不一致：

```typescript
const TIMEOUT = 60_000 // 默认 60s，可通过 server 配置调整
```

| 使用场景      | 说明                                                             |
| ------------- | ---------------------------------------------------------------- |
| Grace period  | Client 断线后等待 reconnect token 回来的时间窗口                 |
| Activity 超时 | Owner activity 上报停止后，判定 owner 不活跃的阈值               |
| Idle 超时     | 所有 session idle 且 owner 无活动后，takeover 变为可用的等待时间 |
| Takeover 冷却 | Takeover 成功后的保护期，期间 instance 不可被再次 takeover       |

超时常量由 server 配置并通过 `server.connected` 事件下发给 client，确保所有参与方使用同一值。

**已知 Trade-off：** 四个场景共用同一常量意味着调整任一场景会连带影响其他场景。例如缩短 grace period（更快检测断线）会同时缩短 takeover 冷却期（减弱防乒乓保护）。当前为简化实现选择统一，后续如发现特定场景需要独立调优，可拆分为多个常量。

### Reconnect Token 机制

```
首次连接:
  Client → SSE /event
  Server → 分配 clientID + reconnectToken，确定 role
  Server → server.connected { clientID, reconnectToken, role, ownerClientID }

断线重连:
  Client → SSE /event + X-OpenCode-Reconnect-Token: <token>
  Server → 验证 token → 复用旧 clientID → 签发新 reconnectToken → 保持原 role
  Server → server.connected { clientID(旧), reconnectToken(新), role, ownerClientID }

Token 过期（grace period 超时）:
  Client → SSE /event + X-OpenCode-Reconnect-Token: <expired-token> + X-OpenCode-Client-ID: <旧clientID>
  Server → token 无效 → 检查 X-OpenCode-Client-ID 是否匹配持久化的 ownerClientID
    → 匹配且 server 处于重启后 grace period → 复用旧 clientID，恢复为 owner
    → 不匹配或非重启场景 → 分配新 clientID → 作为 observer 加入
  Server → server.connected { clientID, reconnectToken(新), role, ownerClientID }
  若作为 observer 加入，原 owner 可通过 /instance/takeover 恢复 ownership（自己 takeover 自己）
```

### Owner 状态模型

Owner 不会被自动释放，只会在特定条件下变为"可被 takeover"：

```typescript
interface OwnerState {
  clientID: string | null // 当前 owner 的 clientID，所有 client 断开后为 null
  lastReport: number // 最近一次 activity 上报时间戳（不论 active 值）
  lastActiveReport: number // 最近一次 active: true 上报的时间戳
  takeoverAvailable: boolean // 是否可被无条件 takeover
}
```

Takeover 可用条件（满足任一）：

1. Owner activity 上报超时（`Date.now() - lastReport > TIMEOUT`）——owner 完全停止了上报
2. 所有 session 均为 idle 且 owner 最后一次活跃超时（`allSessionsIdle() && Date.now() - lastActiveReport > TIMEOUT`）——owner 仍在上报但持续处于 `active: false`
3. Owner 断线且 grace period 超时（client 记录已清理）

**"活跃 session" 定义：** `retry` 状态在本特性的所有判断逻辑中**一律等同 `busy`**。即：只要有任何 session 处于 `busy` 或 `retry`，就存在活跃 session，不算"全部 idle"。这影响 takeover 条件 B 的判断和 takeover 是否需要 `force` 参数。

### 事件分类

系统中存在两种不同性质的事件，实现时必须区分：

| 类别           | 传递方式                                        | 示例                                                                                                                      | 说明                                                  |
| -------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **连接级事件** | `stream.writeSSE()` 直接写入当前 SSE 连接       | `server.connected`、`server.heartbeat`                                                                                    | 仅发给当前连接的 client，不经过 Bus，不广播到其他连接 |
| **广播级事件** | `BusEvent.define()` 注册 + `Bus.publish()` 发布 | `message.updated`、`session.status`、`client.connected`、`instance.owner.changed`、`session.typing`、`takeover.available` | 同一 Instance 下所有 SSE subscriber 自动收到          |

**本特性新增的事件：**

- `client.connected` — **广播级**，通知所有 client 有新 client 加入
- `client.disconnected` — **广播级**，通知所有 client 有 client 断开（grace period 超时后才发）
- `instance.owner.changed` — **广播级**，通知 owner 变更
- `takeover.available` — **广播级**，`takeoverAvailable` 状态发生变化时广播（`false→true` 或 `true→false`），包含 `available` 和 `ownerClientID`
- `session.typing` — **广播级**，owner 正在输入 prompt

### 现有架构优势

当前架构中，同一 `opencode serve` 实例的多个 attach client 如果传递相同的 `directory`，已经自然共享：

- **同一个 SQLite 数据库**（`Global.Path.data/opencode.db`）——消息、session 持久化数据已共享
- **同一个 Bus Instance**（通过 `Instance.state()` 基于 directory 复用）——广播级事件已自动广播到所有 SSE subscriber
- **同一个 `Instance.provide()` 上下文**（通过 `cache` Map 去重）——Bootstrap 只执行一次

### TUI 架构统一：Serve + Attach

当前本地 TUI 有两条代码路径（in-process RPC 和 HTTP/SSE），本特性将其统一为 HTTP/SSE：

```
当前架构（双路径）:
  opencode (local) → Worker(子进程) → createWorkerFetch() → Server.App() [in-process RPC]
  opencode (local --port) → Worker(子进程) → Server.listen() → HTTP [HTTP/SSE]
  opencode attach → SDK client → Remote Server [HTTP/SSE]

目标架构（单路径）:
  Worker(detached 后台进程，全局唯一) → Server.listen(localhost:随机端口) → lock file
  opencode (local TUI) → 启动 Worker --mode=auto → 读取 lock file → HTTP/SSE 连接 Worker [client]
  opencode serve → 启动 Worker --mode=serve → Server.listen(localhost:port) → lock file [headless]
  opencode (local --hostname 0.0.0.0) → Worker → Server.listen(0.0.0.0:port) [client]
  opencode attach → SDK client → Remote Worker [client]
  opencode stop → 读取 lock file → SIGTERM Worker
```

移除 `createWorkerFetch()` 和 `createEventSource()`，简化 `sdk.tsx`，Worker 默认启动 HTTP server。`sdk.tsx` 的抽象层已到位，TUI 组件无需改动。

### 需要新增的部分

| 组件                | 当前状态  | 需要改动                                                                                                                      |
| ------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| TUI 架构统一        | ⚠️ 双路径 | 移除 in-process RPC，统一为 HTTP/SSE。Worker 默认启动 HTTP server（`localhost:随机端口`）                                     |
| 数据库同步          | ✅ 已共享 | 无需改动                                                                                                                      |
| Bus 事件广播        | ✅ 已广播 | 需新增广播级事件：`client.connected`、`client.disconnected`、`instance.owner.changed`、`takeover.available`、`session.typing` |
| Client 追踪         | ❌ 不存在 | 新增 `ConnectedClients` 模块，含 reconnect token 和 grace period                                                              |
| Instance Owner      | ❌ 不存在 | 新增 instance 级 `OwnerState` 模块                                                                                            |
| Owner Activity      | ❌ 不存在 | 新增 `POST /instance/activity` 端点，owner 每 10s 上报                                                                        |
| Takeover 机制       | ❌ 不存在 | 新增 `POST /instance/takeover` 端点，基于三个条件判断                                                                         |
| SDK Client ID       | ❌ 不存在 | SDK wrapper 层（`v2/client.ts`）注入 clientID + reconnectToken，不修改自动生成代码                                            |
| TUI Observer 模式   | ❌ 不存在 | TUI 新增角色判断、侧边栏 client 列表、Commands 面板详情                                                                       |
| Permission 双重防护 | ❌ 不存在 | Server 端 owner 校验 + TUI observer 端禁用交互                                                                                |
| Typing 广播         | ❌ 不存在 | TUI 输入端 + server 广播 + observer 端提示（仅已存在 session + 仅 owner）                                                     |
| SSE 重连统一        | ⚠️ 不一致 | 移除 TUI worker 端冗余重连循环，统一使用 SDK 端指数退避，增加 reconnect token                                                 |

### 关键文件改动范围

- `packages/opencode/src/cli/cmd/tui/thread.ts` — 移除 `createWorkerFetch()` 和 `createEventSource()`，统一为 HTTP/SSE 连接。Worker 默认调用 `rpc.server()` 启动 HTTP server
- `packages/opencode/src/cli/cmd/tui/context/sdk.tsx` — 移除 custom event source 分支，简化为仅 SSE 路径；接收并存储 clientID
- `packages/opencode/src/cli/cmd/tui/context/worker.ts` — 重构为 detached 后台进程模型：lock file 管理（写入 PID + 端口、启动时检测 stale lock、退出时清理）；默认启动 HTTP server（`localhost:随机端口`）；移除冗余 SSE 重连循环，依赖 SDK 端重连
- `packages/opencode/src/server/server.ts` — `/event` 路由增加 clientID 分配、reconnect token 验证、client 追踪、grace period 管理；`server.connected` 内联事件 properties 增加 clientID + reconnectToken；新增 `/instance/activity`、`/instance/takeover`、`/clients` 端点
- `packages/opencode/src/session/prompt.ts` — `assertNotBusy` → `assertCanWrite`，增加 instance owner 检查；child session 的内部调用绕过检查
- `packages/opencode/src/bus/bus-event.ts` — 注册广播级事件：`client.connected`、`client.disconnected`、`instance.owner.changed`、`takeover.available`、`session.typing`
- `packages/sdk/js/v2/client.ts` — wrapper 层增加 clientID + reconnectToken 内部状态存储 + header 注入
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx` — 处理新事件类型，管理 owner 状态、client 列表、typing 状态
- `packages/opencode/src/cli/cmd/tui/component/prompt/` — Observer 模式 UI、typing 状态提示
- `packages/opencode/src/cli/cmd/tui/component/` — 侧边栏 client 列表、Commands 面板 "Show Connected Clients" 命令
- `packages/opencode/src/cli/cmd/run.ts` — CLI attach 模式适配 owner/observer 规则：agent 校验 → owner 检查 → 423 错误时直接退出

### clientID 作用域

clientID 为 per-SSE-connection。每条 SSE 连接分配独立的 clientID，绑定到特定的 directory Instance。同一用户通过多个终端连接多个 directory 时拥有多个独立的 clientID，互不关联。

### Worker 进程模型与生命周期管理

Worker 进程是 per-directory 全局唯一的后台进程，负责运行 HTTP server 和 Instance 逻辑。TUI 和 CLI 都是连接到 Worker 的 client 进程，生命周期独立于 Worker。

**资源开销说明：** per-directory Worker 模型意味着用户同时操作多个项目时会有多个后台进程。现有缓解机制：1) `--mode=auto` 下 TUI 退出后 grace period（60s）超时自动关闭 Worker；2) Idle watchdog 兜底——无活跃连接+无活跃 session 超过 5 分钟后自动退出。正常使用下不活跃的 Worker 会在分钟级别内自动回收。

**进程关系：**

```
Worker 进程（全局唯一，后台运行）
  └── HTTP Server (localhost:port)
        ├── TUI 进程（client，attach 到 Worker）
        ├── 远端 attach client
        └── CLI run --attach client
```

**Lock File 规格：**

Lock file 是 Worker 与 client 之间的发现机制，由 Worker 进程创建和管理。

- **路径**：`$XDG_DATA_HOME/opencode/<dir-hash>/worker.lock`，其中 `<dir-hash>` 使用**路径直接编码**——将目录绝对路径中的 `/` 替换为 `_`（如 `/Users/foo/project` → `_Users_foo_project`）。如果编码后路径超过文件系统限制（通常 255 字节），截断并附加原始路径的 SHA-256 前 8 字符作为后缀
- **格式**：JSON，包含以下字段：
  ```json
  {
    "pid": 12345, // Worker 进程 PID
    "port": 38291, // HTTP server 端口号
    "token": "uuid-...", // Auth token（仅 --hostname 非 localhost 时存在，否则为 null）
    "createdAt": 1710000000000 // Worker 启动时间戳（毫秒）
  }
  ```
- **权限**：`0600`（仅当前用户可读写），防止其他用户读取 auth token
- **创建时序**：Worker **先绑定随机端口并启动 HTTP server**，获得确定的 port 后，再原子创建 lock file（`O_EXCL` 或等效机制）并写入完整内容。这确保 lock file 出现时内容始终完整（含有效 port），TUI 读取时无需轮询等待。竞态场景下败者 Worker 关闭已启动的 HTTP server 并自行退出
- **清理**：Worker 正常退出时删除 lock file；异常退出后由下次启动的 TUI 通过 `kill -0 PID` 检测并清理 stale lock file

**Worker 启动与发现：**

1. `opencode`（本地 TUI）启动时，先检查当前 directory 是否已有 Worker 运行（通过 lock file）
2. **无 Worker 运行**：以 detached 子进程方式启动 Worker。Worker 先启动 HTTP server（绑定随机端口），再原子写入完整 lock file（含 port）。TUI 等待 lock file 出现后读取端口和 token 并连接
3. **已有 Worker 运行**：读取 lock file 获取端口和 token，验证 Worker 进程存活（kill -0 PID），使用 token 自动认证并直接连接
4. TUI 作为第一个 attach client 通过 HTTP/SSE 连接到 Worker

**Worker 进程隔离：**

- Worker 通过 `Bun.spawn()` 以 `detached: true` + `stdio: "ignore"` 启动，与 TUI 父进程完全解耦
- TUI 退出（正常退出或崩溃）不影响 Worker 运行
- Worker 进程启动后调用 `process.unref()`（如适用），确保不阻塞父进程退出

**生命周期规则：**

Worker 通过启动参数 `--mode=auto|serve` 区分生命周期行为。TUI 自动启动 Worker 时传 `--mode=auto`，`opencode serve` 不传此参数默认为 `serve` 模式。

- **TUI 退出时**：如果还有其他 client（远端 attach）连接，Worker 继续运行
- **`--mode=auto`（TUI 自动启动）**：所有 client 断开后，Worker 在 grace period 超时（确认无重连）后自动关闭，清理 lock file。此外 idle watchdog 作为兜底：无活跃 SSE 连接且无活跃 session 超过 5 分钟后 Worker 自行退出
- **`--mode=serve`（`opencode serve` 启动）**：`opencode serve` 等价于以前台方式启动一个 Worker 进程（写 lock file、监听端口），但不自动 attach TUI。Worker 始终保持运行，不受 client 连接状态影响（headless 模式）。不启用 idle watchdog。之后用户可通过 `opencode`（本地 TUI）或 `opencode attach` 连接。注意：`opencode serve` 是 **per-directory** 的（与新架构一致），每次运行绑定当前目录；仍支持 `--port` 参数指定端口（如 `opencode serve --port 8080`）；作为前台进程运行，自身注册 SIGINT/SIGTERM handler 清理 lock file
- **互斥保护**：同一 directory 下 `opencode serve` 和 `opencode`（TUI 自动启动的 Worker）互斥：TUI 启动时检测到 lock file 已存在且进程存活，直接 attach 到已有 Worker，不再启动新的

**Worker 终止：**

- `opencode stop`：读取 lock file 获取 PID，发送 SIGTERM 信号，Worker 优雅关闭（断开所有 SSE 连接、清理 lock file）
- Worker 启动时注册 SIGTERM / SIGINT handler，确保清理 lock file
- 异常退出（crash）后 lock file 残留：下次启动时通过 `kill -0 PID` 检测到进程不存在，清理 stale lock file 并启动新 Worker

### Server 重启行为

Server 进程重启后，内存态（ConnectedClients、reconnect tokens）重置，但 `ownerClientID` 持久化在 SQLite 中（或本地文件），重启后读取。Client 的 SSE 连接断开后触发自动重连（SDK 指数退避），reconnect token 失效，重连后作为新 client 加入。

**原 owner 优先恢复机制：** Server 重启后进入 grace period，期间收到的 client 连接如果携带 `X-OpenCode-Client-ID` header 且其值与持久化的 `ownerClientID` 匹配，该 client 自动恢复为 owner（复用旧 clientID）。此时 reconnect token 已失效（内存态随重启丢失），身份恢复完全依赖 clientID 匹配。Grace period 超时后仍无原 owner 重连，则第一个连接的 client 成为新 owner，清除持久化记录。Session 数据（消息、状态等）持久化在 SQLite 中不受影响。

**⚠️ 安全说明：** 此机制依赖已认证 client 之间的互信。由于 `X-OpenCode-Client-ID` header 不做防伪造校验（见 Non-Goals），任何已通过 auth token 认证的 client 理论上可以在 server 重启后伪造原 owner 的 clientID 来窃取 owner 身份。这在团队内部协作场景下风险可控（协作者之间互相信任），但不适用于对抗性环境。Trust boundary 在 auth token 层，而非 clientID 层。

### Bootstrap 与 SSE 事件竞态

重连后 `bootstrap()` 通过多个 REST API 拉取全量状态，同时 SSE 连接已恢复并持续推送增量事件。两者可能产生竞态：

```
时序示例：
  t1: bootstrap 调用 GET /sessions → server 快照 session A = busy (update_seq 3)
  t2: SSE 推送 session.status { sessionID: A, status: idle, update_seq: 4 }
  t3: client 收到 SSE 事件，更新 store: session A = idle (update_seq 4)
  t4: bootstrap 响应到达，session A = busy (update_seq 3)
  ❌ 如果无版本控制，t4 会用旧数据覆盖 t3 的新数据
```

**解决方案：`update_seq` 机制**

Server 为每个可变实体（session、message、part 等）维护单调递增的 `update_seq` 字段（per-entity 独立计数器，非时间戳）。该字段同时出现在：

- REST API 响应中（bootstrap 拉取的数据）
- SSE 广播事件中（增量推送的数据）

Client 端采用 **重连 reset + 统一版本检查** 策略：

1. **SSE 重连时**：client 立即 **reset store**（清空所有缓存数据及其 `update_seq`）。这确保后续 bootstrap 数据能无条件写入（stored 不存在），同时解决 server 重启后内存态计数器归零导致的版本不一致问题
2. **所有数据写入**（bootstrap 和 SSE 增量事件统一逻辑）：**仅当 `incoming.update_seq > stored.update_seq` 时才应用更新**，否则丢弃。由于 reset 后 stored 不存在，bootstrap 数据必然写入成功；后续 SSE 事件如果携带更高 `update_seq` 则正确覆盖

这确保无论 bootstrap 响应和 SSE 事件的到达顺序如何，client 始终持有最新数据。

```typescript
// SSE 重连时
function onReconnect() {
  store.clear() // reset 所有缓存数据及 update_seq
  bootstrap() // 全量拉取
}

// client 端统一更新逻辑（bootstrap 和 SSE 事件共用）
function update(id: string, incoming: { update_seq: number; data: T }) {
  const stored = store.get(id)
  if (stored && incoming.update_seq <= stored.update_seq) return // 丢弃旧数据
  store.set(id, incoming)
}
```

Version 字段的实现方式（字段统一命名为 `update_seq`，per-entity 单调递增整数，非时间戳）：

- **Session**：session 表新增 `update_seq` integer 列（注意：现有 `version` 列存储的是 opencode 软件版本号如 `"0.0.3"`，不可复用）。DB migration 默认值为 **0**。每次 session 数据变更时递增
- **Message / Part**：message 表和 part 表各新增 `update_seq` integer 列。DB migration 默认值为 **0**。现有 `time_updated`（`Date.now()` 毫秒）不可复用，因同毫秒内多次写入时间戳相同，无法保证单调递增
- **非持久化状态**（client 列表、ownership 等）：server 内存态维护 per-entity 递增计数器
- **计数器策略**：使用 per-entity 独立计数器（每个 session/message/part 各自维护自己的 `update_seq` 序列）。Client 端 store 更新时按实体 ID 做版本比较，不需要跨实体版本对比。此策略避免了全局计数器在高并发写入（ultrawork loop、多 subagent 同时运行）时的争抢问题，且 server 重启后只需 `SELECT MAX(update_seq) FROM <table> WHERE id = ?` 即可恢复

### 并发安全

`OwnerState` 和 `ConnectedClients` 是内存态 Map/Object，在单进程 Bun runtime 中是线程安全的（JavaScript 单线程事件循环）。Owner 检查和设置在 `assertCanWrite()` 的同步代码段中完成，不存在竞态条件。Takeover 操作同样在单线程中执行，abort + owner 切换是原子性的。Activity 时间戳更新也是同步操作，无竞态风险。两个 observer 同时 takeover 时，先被事件循环处理的请求成功，后到的请求看到已更新的 ownerClientID，返回 409。

## Implementation Plan

### Phase 0 — 架构统一

| 顺序 | User Story | 内容                                           | 说明                                                                |
| ---- | ---------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| 0    | US-012     | TUI 架构统一为 serve + attach（移除 RPC 路径） | 前置基础，消除双代码路径，为 ownership 模型提供统一的 HTTP/SSE 架构 |
| 0.5  | US-014     | 网络暴露时 shared secret token 认证            | 与 US-012 同步实施，保障网络安全                                    |

### Phase 1 — 基础设施

| 顺序 | User Story | 内容                                                 | 说明                                   |
| ---- | ---------- | ---------------------------------------------------- | -------------------------------------- |
| 1    | US-015     | `update_seq` 基础设施（DB migration + API/SSE 携带） | 数据同步基础，US-008 依赖              |
| 2    | US-001     | Client 注册 + 追踪 + reconnect token + grace period  | 核心基础设施，后续所有 US 依赖         |
| 3    | US-004     | SDK clientID 获取 + header 注入                      | 与 US-001 联动                         |
| 4    | US-009     | SSE 重连统一（移除 worker 冗余重连）                 | 清理技术债，为后续功能提供可靠的连接层 |

### Phase 2 — Owner 模型

| 顺序 | User Story | 内容                         | 说明                |
| ---- | ---------- | ---------------------------- | ------------------- |
| 5    | US-002     | Instance 级 owner 模型       | 依赖 US-001         |
| 6    | US-003     | 写操作拦截（assertCanWrite） | 依赖 US-002         |
| 7    | US-005     | Heartbeat + takeover         | 依赖 US-002、US-003 |

### Phase 3 — UI + 体验（可并行）

| 顺序 | User Story | 内容                                  | 说明                                  |
| ---- | ---------- | ------------------------------------- | ------------------------------------- |
| 8    | US-006     | TUI observer 模式 UI                  | 可与 US-007 并行                      |
| 9    | US-007     | Commands 面板 client 详情             | 可与 US-006 并行                      |
| 10   | US-010     | Permission/Question observer 双重防护 | 可与 US-006/007 并行                  |
| 11   | US-011     | Typing 广播                           | 可与 US-006/007 并行                  |
| 12   | US-008     | 全量数据同步验证                      | 验证现有链路 + 增加 reconnecting 提示 |

### Phase 4 — CLI

| 顺序 | User Story | 内容                    | 说明                    |
| ---- | ---------- | ----------------------- | ----------------------- |
| 13   | US-013     | CLI `run --attach` 适配 | 独立，依赖 Phase 2 完成 |

## Testing Requirements

核心路径必须有对应的集成测试，关键逻辑需保证测试覆盖率。测试从 `packages/opencode` 目录运行（不从 repo root 运行）。

### 集成测试（必须覆盖）

#### Client 注册与身份恢复

| 测试场景               | 验证内容                                                                        |
| ---------------------- | ------------------------------------------------------------------------------- |
| 首次连接               | SSE 连接建立后收到 `server.connected` 事件，包含 `clientID` 和 `reconnectToken` |
| 多 client 连接         | 第二个 client 连接后，两个 client 都收到 `client.connected` 广播事件            |
| Client 断开            | 断开后 grace period 超时，其他 client 收到 `client.disconnected` 广播事件       |
| Reconnect token 恢复   | 断线后在 grace period 内重连，复用旧 `clientID`，owner 身份保持                 |
| Reconnect token 过期   | 断线后超过 grace period 重连，分配新 `clientID`，身份变为 observer              |
| Reconnect token 一次性 | 使用过的 token 不能再次使用，重连后获得新 token                                 |
| `GET /clients`         | 返回正确的 client 列表、角色、`takeoverAvailable` 状态                          |

#### Ownership 模型

| 测试场景               | 验证内容                                                            |
| ---------------------- | ------------------------------------------------------------------- |
| 首个 client 成为 owner | 第一个连接的 client 自动成为 owner                                  |
| Owner 写操作           | Owner 发送 prompt 成功                                              |
| Observer 写操作被拒    | Observer 发送 prompt 返回 HTTP 423 Locked，响应包含 `ownerClientID` |
| Observer 不进队列      | Observer 的请求直接返回 423，不进入 callback 排队队列               |
| Child session 绕过检查 | Server 内部发起的 child session prompt 不触发 ownership 检查        |
| Permission reply 拦截  | Observer 的 permission reply 请求返回 423                           |
| Question reply 拦截    | Observer 的 question reply 请求返回 423                             |

#### Heartbeat 与 Takeover

| 测试场景                  | 验证内容                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------- |
| Activity 正常             | Owner 发送 activity 后，takeover 请求返回 409                                         |
| Activity 超时后 takeover  | Owner activity 上报超时后，observer takeover 成功，收到 `instance.owner.changed` 事件 |
| 全部 idle 超时后 takeover | 所有 session idle 超过统一超时常量后，observer takeover 成功                          |
| Owner 断线后 takeover     | Owner 断线且 grace period 超时后，observer takeover 成功                              |
| Takeover 竞态             | 两个 observer 同时 takeover，先到者成功，后到者收到 409（含新 ownerClientID）         |
| Owner 自我 takeover       | Owner reconnect token 过期后用新 clientID takeover 自己成功                           |
| Takeover abort            | Takeover 成功后正在执行的 session prompt 被 abort                                     |
| Takeover force            | 有活跃 session 时不带 `force` 返回 409 + active_sessions；带 `force: true` 成功       |
| Takeover 无活跃 session   | 所有 session idle 时 takeover 直接成功，无需 force                                    |
| Takeover 冷却期           | Takeover 成功后冷却期内再次 takeover 返回 409                                         |
| `takeoverAvailable` 状态  | `GET /clients` 返回的 `takeoverAvailable` 准确反映当前条件                            |

#### SSE 重连

| 测试场景     | 验证内容                                                        |
| ------------ | --------------------------------------------------------------- |
| 重连身份恢复 | SSE 断线重连后通过 reconnect token 恢复 clientID 和 owner 身份  |
| 重连全量刷新 | 重连后收到 `server.connected` 事件，触发 `bootstrap()` 全量刷新 |
| 重连事件补偿 | 重连期间丢失的事件通过全量刷新补偿                              |

#### Typing 广播

| 测试场景         | 验证内容                                                  |
| ---------------- | --------------------------------------------------------- |
| Typing 事件广播  | Owner 发送 typing 后，observer 收到 `session.typing` 事件 |
| 仅已存在 session | 无 sessionID 时 typing 请求被忽略或拒绝                   |
| 仅有多 client 时 | 只有一个 client 时不发送 typing 事件                      |

### 单元测试（关键逻辑覆盖）

| 模块                 | 测试内容                                                   |
| -------------------- | ---------------------------------------------------------- |
| `assertCanWrite`     | 各种状态组合下的权限判断：owner/observer × idle/busy/retry |
| Takeover 条件计算    | 三个条件的独立和组合判断逻辑                               |
| Grace period 定时器  | 定时器启动、取消（reconnect）、超时触发的正确性            |
| Reconnect token 验证 | 有效 token、无效 token、过期 token 的处理                  |
| 统一超时常量         | 所有使用超时的场景共享同一个配置值                         |

## Success Metrics

- 多个 attach client 连接同一 serve 实例后，observer 能实时看到 owner 发起的全部对话流（消息、tool 调用、status 变化、child session 进展）
- Observer 尝试任何写操作时收到明确的 423 Locked 错误和友好 TUI 提示
- Observer 在 takeover 条件满足后可接管 instance ownership
- Owner 断线重连后通过 reconnect token 无缝恢复 ownership（grace period 内）
- Owner 断线超时后重连可通过 takeover 自己恢复 ownership
- Observer 能看到 "Owner is typing..." 提示，对即将到来的新消息有预期
- Observer 能看到 permission/question 对话框（只读），server 端拒绝 observer 的回复请求
- TUI 侧边栏实时显示角色和 client 列表，Commands 面板可查看完整 client 详情
- Attach client 断线重连后在 5s 内恢复完整状态显示
- CLI `opencode run --attach` 非 owner 时返回明确错误并直接退出
- 不引入额外的 SQLite 读写或 Bus 开销（利用现有共享机制）
