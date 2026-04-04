# PRD: Swarm Discussion Mode

## 问题

当前 Swarm 是一个 **任务分发系统**：Conductor 拆解目标为独立子任务，每个 Worker 独立执行后汇报。Worker 之间没有交互。

用户需要一种 **角色辩论模式**：Conductor 创建 PM、RD、QA 等不同角色的 Worker，围绕一个议题进行多轮结构化讨论，最终达成共识或由 Conductor 裁决。

## 核心设计决策

### 决策 1：Worker 都是 sisyphus，角色由 prompt 定义

不引入新 agent 类型。每个 Worker 都使用 sisyphus agent，通过 system prompt 注入角色身份（PM 视角、RD 视角、QA 视角）。`roles` 配置中的 `name` 字段（如 `"PM"`、`"RD"`、`"QA"`）是参与者的唯一标识。

**原因**：多个角色如果用 `oracle` agent，`agent.name` 不唯一，无法作为轮次追踪的 key。用角色 `name` 作为 key 天然唯一。

### 决策 2：`role_name` 是 Discussion 系统的唯一标识

`Discussion.join(swarm, channel, role_name)` 和 `Discussion.record(swarm, channel, role_name, round)` 的参与者标识一律使用 `role_name`。

Worker 发 signal 时 `from` 字段填 `role_name`（不是 agent name 或 session_id）。这要求 Conductor 在 delegate_task 的 prompt 中告知 Worker 自己的 role_name，Worker 发 signal 时用该 name。

### 决策 3：`advance_round` 放在 board_write

语义上 advance_round 是控制流操作，但为了减少 tool 数量，作为 board_write 的一个 operation。

### 决策 4：`record()` 使用 write lock 保证原子性

当前 `record()` 分两步：`load()`（read lock）和 `save()`（write lock），并发时可能丢失。改为全程持 write lock。

### 决策 5：Monitor round complete 消息包含结构化轮次信息

Monitor 在报告 round complete 时附上 `round`、`max_rounds`、`is_final` 信息，让 Conductor 不需要靠记忆判断当前进度。

`max_rounds` 存储在 Discussion tracker 中（start 时传入）。

---

## 现状分析

### 已有的基础设施

| 组件                                                           | 状态      | 说明                                    |
| -------------------------------------------------------------- | --------- | --------------------------------------- |
| `delegate_task` 的 `session_id` 参数                           | ✅ 已支持 | 可复用已有 session 继续对话             |
| `delegate_task` 的 `run_in_background` 参数                    | ✅ 已支持 | Worker 可后台执行，Conductor 不阻塞     |
| `delegate_task` 的 `discussion_channel` 参数                   | ✅ 已支持 | 传递 channel 到 Worker session metadata |
| `BoardTask.Type` 包含 `discuss`                                | ✅ 已有   | 讨论任务类型                            |
| `BoardSignal.Type` 包含 `proposal/opinion/objection/consensus` | ✅ 已有   | 讨论信号类型                            |
| `BoardArtifact.Type` 包含 `proposal/review_comment/summary`    | ✅ 已有   | 讨论产物类型                            |
| `BoardSignal.thread()`                                         | ✅ 已有   | 读取 channel 完整信号历史               |
| `Discussion` 模块 (round tracker, tally)                       | ✅ 已有   | 轮次追踪、共识计票                      |
| `conductor-discussion.txt` prompt                              | ✅ 已有   | 讨论协议 prompt（需要重写）             |
| `swarm-hooks.ts` discussion-thread-injector                    | ✅ 已有   | 注入讨论线程到 Worker context           |
| `swarm-hooks.ts` conductor strategy + discussion inject        | ✅ 已有   | 注入讨论协议到 Conductor                |
| `Swarm.discuss()`                                              | ✅ 已有   | 便捷启动器（需要修改 roles schema）     |
| Monitor 处理讨论信号                                           | ✅ 已有   | 转发、轮次检测、tally                   |

### 关键缺陷

#### 缺陷 1：`Discussion.expected` 在启动时为空数组

```typescript
// swarm.ts:241
await Discussion.start(info.id, channel, []) // expected 是空的！
```

`Discussion.record()` 中 `complete = expected.length > 0 && received.length >= expected.length`。
因为 `expected.length === 0`，`complete` 永远是 `false`。Monitor 永远不会报告 "round complete"。

#### 缺陷 2：没有 `Discussion.join()` 让 Worker 注册

Worker 被创建后，没有机制将自己的 `role_name` 注册到 `expected[]`。

#### 缺陷 3：`record()` 有并发竞态

`load()` 用 read lock，`save()` 用 write lock，中间不原子。两个并发 record 可能丢失。

#### 缺陷 4：Discussion tracker 不存储 `max_rounds`

Monitor 报告 round complete 时无法告知 Conductor "这是最后一轮"。Conductor 要靠 LLM 记忆追踪轮次进度。

#### 缺陷 5：Conductor prompt 不知道关键操作参数

`conductor-discussion.txt` 未提到：

- 用 `run_in_background=true` 并行发起
- 用 `session_id` 复用 Worker session
- 等 Monitor 报告 "round complete" 再推进
- 用 `board_write advance_round` 推进轮次
- Worker 发 signal 的 `from` 必须用 `role_name`

#### 缺陷 6：roles schema 缺少 `name` 字段

`Swarm.discuss()` 的 `roles` 是 `Array<{ agent: string, perspective: string }>`，没有 `name`（角色名）字段。`name` 是 Discussion 系统的唯一标识。

---

## 设计方案

### Roles Schema

```typescript
roles: Array<{
  name: string // "PM", "RD", "QA" — 唯一标识，用于 join/record/signal.from
  perspective: string // "关注用户价值和 scope 控制" — 注入 Worker system prompt
}>
```

不再有 `agent` 字段。所有 Worker 一律使用 sisyphus agent，角色差异完全来自 perspective prompt。

### Discussion.Round schema 增加 max_rounds

```typescript
Round = {
  round: number,
  channel: string,
  swarm_id: string,
  max_rounds: number,     // 新增
  expected: string[],     // role_name 列表
  received: string[],     // 本轮已发言的 role_name
  complete: boolean,
}
```

### 完整讨论流程

```
用户: "PM、RD、QA 讨论是否应该使用 GraphQL 替代 REST API"
  │
  ▼
Swarm.discuss({
  topic: "是否应该使用 GraphQL 替代 REST API",
  roles: [
    { name: "PM", perspective: "关注用户价值、scope 控制和产品市场匹配" },
    { name: "RD", perspective: "关注实现可行性、性能和技术债" },
    { name: "QA", perspective: "关注边界情况、错误处理、测试策略和安全" },
  ],
  max_rounds: 3,
})
  │
  ├── Swarm.launch(goal)  — 创建 Conductor session + 初始化 SharedBoard
  ├── Discussion.start(swarm_id, channel, [], max_rounds=3)
  │   — 初始化轮次追踪器（expected 暂为空，Worker 创建时通过 join 填入）
  │
  ▼
Conductor 收到结构化目标 + 讨论协议 prompt（通过 hook 注入）
  │
  ═══ ROUND 1: 提案 ═══
  │
  Conductor:
  │ 1. board_write → 创建 discuss 任务，channel="discuss-xxx"
  │
  │ 2. delegate_task(
  │      description="PM discusses",
  │      prompt="你的角色名是 PM。你的视角：关注用户价值...
  │             读取 channel discuss-xxx，然后发一条 proposal signal。
  │             signal 的 from 字段必须填 'PM'，payload 必须包含
  │             { round: 1, summary: '你的提案内容' }",
  │      discussion_channel="discuss-xxx",
  │      run_in_background=true)
  │    → 返回 { session_id: "sess-PM", task_id: "bg-1" }
  │    → delegate_task 内部：Discussion.join(swarm, channel, "PM")
  │      → expected 变为 ["PM"]
  │
  │ 3. delegate_task(同上, role_name="RD") → sess-RD
  │    → Discussion.join → expected=["PM","RD"]
  │
  │ 4. delegate_task(同上, role_name="QA") → sess-QA
  │    → Discussion.join → expected=["PM","RD","QA"]
  │
  │ 5. Conductor 记录 session 映射:
  │    PM → sess-PM, RD → sess-RD, QA → sess-QA
  │    然后 **停下来等待 Monitor 报告 Round Complete**
  │
  三个 Worker 后台并行执行:
  │
  ├── PM Worker (sess-PM):
  │   pre-llm hook → discussion-thread-injector → channel 为空（第一轮）
  │   执行 prompt → 调用 board_write signal:
  │     { type: "proposal", channel: "discuss-xxx",
  │       from: "PM",   ← 必须是 role_name
  │       payload: { round: 1, summary: "建议用 GraphQL，统一查询接口..." } }
  │   session 空闲
  │
  ├── RD Worker → 发 proposal signal (from: "RD")
  ├── QA Worker → 发 proposal signal (from: "QA")
  │
  ─── Monitor 逐个收到 signal ───
  │
  │ PM signal → Discussion.record(swarm, channel, "PM", round=1)
  │   → expected: ["PM","RD","QA"], received: ["PM"] → complete: false
  │   → 转发给 Conductor: "[Discussion] PM posted proposal: 建议用GraphQL..."
  │
  │ RD signal → Discussion.record(..., "RD", 1)
  │   → received: ["PM","RD"] → complete: false
  │
  │ QA signal → Discussion.record(..., "QA", 1)
  │   → received: ["PM","RD","QA"] → complete: true ✓
  │   → 转发给 Conductor:
  │     "[Discussion Round 1 Complete — round 1/3]
  │      All 3 roles have spoken:
  │        [PM] proposal: 建议用GraphQL，统一查询接口...
  │        [RD] proposal: GraphQL 增加复杂度，建议先评估...
  │        [QA] proposal: 关注 N+1 查询问题和缓存策略...
  │      Next action: call board_write advance_round, then prompt each role for round 2."
  │
  ═══ ROUND 2: 回应 ═══
  │
  Conductor 收到 Round 1 Complete 消息:
  │ 1. board_write({ operation: "advance_round", swarm_id, data: { channel } })
  │    → round=2, received=[], complete=false
  │
  │ 2. delegate_task(session_id="sess-PM", run_in_background=true,
  │      prompt="Round 2: 回应 RD 关于复杂度的担忧和 QA 关于 N+1 的问题。
  │             读取 channel，然后发 opinion 或 objection signal。
  │             from 填 'PM'，payload 包含 { round: 2, summary: '...' }")
  │
  │ 3. delegate_task(session_id="sess-RD", ...)
  │ 4. delegate_task(session_id="sess-QA", ...)
  │ 5. 停下来等待 Monitor 报告 Round 2 Complete
  │
  Worker 在各自 session 中继续（保留 Round 1 上下文）:
  │
  ├── PM Worker (sess-PM):
  │   pre-llm hook → 注入 Round 1 全部 3 条 proposal 到 system prompt
  │   收到 Conductor 的 Round 2 prompt
  │   发 opinion signal: { from: "PM", round: 2, summary: "接受 RD 的分阶段建议..." }
  │
  ├── RD → 发 objection signal
  ├── QA → 发 opinion signal
  │
  ─── Monitor: Round 2 complete ───
  │ "[Discussion Round 2 Complete — round 2/3, FINAL ROUND NEXT]
  │  ...(摘要)...
  │  Next action: advance to final round. Instruct each role to post consensus signal
  │  with payload { position: agree|disagree|modify, summary: reasoning }."
  │
  ═══ ROUND 3（最终轮）: 表态 ═══
  │
  Conductor:
  │ 1. board_write advance_round → round=3
  │ 2. delegate_task 每个角色:
  │    prompt="最终轮: 发 consensus signal。
  │           payload 中 position 填 agree/disagree/modify,
  │           summary 填你的最终立场和理由。
  │           from 填你的角色名。"
  │ 3. 等待 Monitor
  │
  Worker 发 consensus signal:
  │ PM: { from: "PM", position: "agree", summary: "同意分阶段引入 GraphQL" }
  │ RD: { from: "RD", position: "modify", summary: "同意，但建议先 POC" }
  │ QA: { from: "QA", position: "agree", summary: "同意，要求 POC 含 N+1 测试" }
  │
  ─── Monitor: Round 3 (final) complete ───
  │ Discussion.tally() → { agree: 2, modify: 1, disagree: 0, unanimous: false }
  │ "[Discussion Round 3 Complete — round 3/3, FINAL]
  │  ...(摘要)...
  │  Consensus tally: 2 agree, 0 disagree, 1 modify (NOT unanimous)
  │  All rounds exhausted. Make final decision and post decision artifact."
  │
  Conductor 裁决:
  │ 多数同意 + modify 可兼容 → 采纳
  │ board_write artifact: { type: "decision", content: "决定分阶段引入 GraphQL，
  │   先做 POC 验证性能和 N+1 问题。" }
  │ board_write task status → completed
  │ Swarm status → completed
```

### 改动清单

#### 改动 1：`Discussion.Round` schema 增加 `max_rounds`

```typescript
export const Round = z.object({
  round: z.number(),
  channel: z.string(),
  swarm_id: z.string(),
  max_rounds: z.number(), // 新增
  expected: z.array(z.string()),
  received: z.array(z.string()),
  complete: z.boolean(),
})
```

`Discussion.start()` 签名改为 `start(swarm, channel, workers, max_rounds)`。

#### 改动 2：`Discussion.join()` — 动态注册参与者

```typescript
export async function join(swarm: string, channel: string, role: string): Promise<Round> {
  using _ = await Lock.write(key(swarm, channel))  // 全程 write lock
  const current = await loadRaw(swarm, channel)
  if (!current) throw new Error(...)
  if (!current.expected.includes(role)) {
    current.expected.push(role)
  }
  await saveRaw(current)
  return current
}
```

#### 改动 3：`Discussion.record()` 改用全程 write lock

```typescript
export async function record(swarm: string, channel: string, from: string, round: number): Promise<Round> {
  using _ = await Lock.write(key(swarm, channel))  // 改为 write lock
  const current = await loadRaw(swarm, channel)     // loadRaw 不加锁
  if (!current) throw new Error(...)
  if (current.round !== round) return current
  if (!current.received.includes(from)) {
    current.received.push(from)
  }
  current.complete = current.expected.length > 0 && current.received.length >= current.expected.length
  await saveRaw(current)
  return current
}
```

需要拆出 `loadRaw()`/`saveRaw()` 内部函数（不加锁），外部函数负责锁。

#### 改动 4：`Swarm.discuss()` roles schema 改为 `{ name, perspective }`

```typescript
export async function discuss(input: {
  topic: string
  roles: Array<{ name: string; perspective: string }> // agent 字段移除
  max_rounds?: number
  config?: Partial<Info["config"]>
}): Promise<Info>
```

goal 构建时每个角色列为 `{i}. Role: "{name}" — Perspective: {perspective}`。

`Discussion.start()` 调用改为传入 `max_rounds`。

#### 改动 5：`delegate_task` 注册时调用 `Discussion.join()`

在 `delegate-task.ts` Swarm worker 注册块中，当 `discussion_channel` 存在时：

```typescript
if (isSwarm && params.discussion_channel) {
  // role_name 从 prompt 或 description 中提取，或新增 role_name 参数
  import("../board/discussion")
    .then(({ Discussion }) =>
      Discussion.join(params.swarm_id!, params.discussion_channel!, roleNameFromParams))
    .catch(...)
}
```

需要在 `delegateParameters` 中新增 `role_name?: string` 可选参数。Conductor 在 delegate_task 时传入。

#### 改动 6：Monitor round complete 消息包含结构化轮次信息

```typescript
// 当 roundState.complete 时
text = `[Discussion Round ${round} Complete — round ${round}/${roundState.max_rounds}${round >= roundState.max_rounds ? ", FINAL" : ""}]
All ${roundState.expected.length} roles have spoken:
${opinions}
${
  round >= roundState.max_rounds
    ? "All rounds exhausted. Make final decision and post decision artifact."
    : "Next action: call board_write advance_round, then prompt each role for round " + (round + 1) + "."
}`
```

#### 改动 7：`board_write` 新增 `advance_round` operation

```typescript
if (params.operation === "advance_round") {
  const channel = params.data.channel as string
  if (!channel) return { title: "Error", metadata: {}, output: "Missing channel in data" }
  const round = await Discussion.advance(params.swarm_id, channel)
  return {
    title: `Advanced to round ${round.round}`,
    metadata: { round: round.round, max_rounds: round.max_rounds },
    output: JSON.stringify(round, null, 2),
  }
}
```

#### 改动 8：`board_read` 新增 `discussion` operation

```typescript
if (params.operation === "discussion") {
  const channel = params.filter?.channel as string
  if (!channel) return { title: "Error", metadata: {}, output: "Missing channel in filter" }
  const [thread, round] = await Promise.all([
    BoardSignal.thread(params.swarm_id, channel),
    Discussion.status(params.swarm_id, channel),
  ])
  return {
    title: `Discussion ${channel}`,
    metadata: { round: round?.round, complete: round?.complete },
    output: JSON.stringify({ round, thread }, null, 2),
  }
}
```

#### 改动 9：重写 `conductor-discussion.txt`

新 prompt 必须包含：

**Round 1 协议：**

1. 创建 discuss task with channel
2. 对每个角色：`delegate_task(description="<name> discusses", prompt="你的角色名是 <name>。视角：<perspective>。读取 channel <channel>，发一条 proposal signal。from 必须填 '<name>'，payload 包含 { round: 1, summary: '你的提案' }", discussion_channel="<channel>", role_name="<name>", run_in_background=true)`
3. 记录返回的 `session_id` 对应每个角色
4. **停下来。不要做任何事。等待系统发送 "[Discussion Round 1 Complete]" 消息。**

**Round 2+ 协议：**

1. 收到 "Round N Complete" 后，调 `board_write({ operation: "advance_round", data: { channel } })`
2. 对每个角色：`delegate_task(session_id="<saved id>", prompt="Round <N+1>: 回应其他人的观点。读取 channel，发 opinion 或 objection signal。from 填 '<name>'，payload 包含 { round: <N+1>, summary: '...' }", run_in_background=true)`
3. **停下来等待 Round Complete。**

**最终轮协议：**

1. 收到 "Round N Complete" 且消息中包含 "FINAL ROUND NEXT"
2. advance_round
3. 对每个角色 prompt 要求发 `consensus` signal: `{ position: "agree"/"disagree"/"modify", summary: "最终立场" }`
4. 等待 Round Complete + tally

**裁决协议：**

- 全票 agree → 发 decision artifact 并完成
- 非全票 → Conductor 综合各方意见做最终决定，在 decision artifact 中记录分歧

#### 改动 10：`swarm_discuss` tool + REST route + TUI 命令

tool 参数：

```typescript
{
  topic: string,
  roles: Array<{ name: string, perspective: string }>,
  max_rounds?: number, // default 3
}
```

REST: `POST /swarm/discuss` with same body。

TUI `/swarm discuss <topic>` 默认角色：

```typescript
;[
  { name: "PM", perspective: "关注用户价值、scope 控制和产品市场匹配" },
  { name: "RD", perspective: "关注实现可行性、性能和技术债" },
  { name: "QA", perspective: "关注边界情况、错误处理、测试策略和安全" },
]
```

#### 改动 11：ActivityFeed 讨论信号格式化

识别 proposal/opinion/objection/consensus 类型的 signal，格式化为：

```
R1: [PM] proposal: 建议用 GraphQL...
R2: [RD] objection: N+1 查询问题严重...
R3: [QA] consensus (agree): 同意分阶段方案...
```

颜色：proposal=蓝, opinion=灰, objection=橙, consensus=绿。

#### 改动 12：`GET /swarm/:id/discussion` REST 端点

返回结构化的讨论摘要，供 Web UI 和 intervene 工作流使用。

```typescript
// 响应结构
{
  topic: string | null,          // discuss task 的 subject
  channel: string,
  round: {
    current: number,
    max: number,
    complete: boolean,
  },
  participants: Array<{
    name: string,                // role_name
    spoken: boolean,             // 本轮是否已发言
  }>,
  thread: Array<{
    round: number,
    from: string,                // role_name
    type: string,                // proposal/opinion/objection/consensus
    summary: string,
  }>,
  decision: string | null,       // decision artifact content, or null
}
```

#### 改动 13：Web Discussion Thread 面板

当 Swarm 含有 `discuss` 任务时，Dashboard 主区域替换为专用 Discussion Thread 组件：

```
┌─────────────────────────────────────────────────┐
│ Discussion: 是否用 GraphQL 替代 REST API         │
│ Round 2 / 3  ·  PM ✓  RD ✓  QA ⏳               │
│ ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ │
│                                                  │
│ ── Round 1: Proposals ──────────────────────── │
│  🔵 PM  proposal                                │
│  建议用 GraphQL，统一查询接口...                  │
│  ⚪ RD  proposal                                │
│  GraphQL 增加复杂度，建议先评估...                │
│  🟠 QA  proposal                                │
│  关注 N+1 查询问题和缓存策略...                   │
│                                                  │
│ ── Round 2: Responses ─────────────────────── │
│  🔵 PM  opinion                                 │
│  接受 RD 的分阶段建议...                         │
│  🟠 RD  objection                               │
│  POC scope 要包含分页和批量查询场景...           │
│  ⏳ QA  等待发言...                              │
│                                                  │
│ ── Decision ─── (全部轮次完成后出现) ─────── │
│  ✅ 决定：分阶段引入 GraphQL                     │
│  投票: 2 agree · 1 modify · 0 disagree          │
└─────────────────────────────────────────────────┘
```

**关键信息：**

- 顶部：议题 + 当前轮次/总轮次 + 每个参与者的发言状态
- 每轮分组，每条发言显示角色标签 + 类型徽章 + 全文
- 未发言的角色显示 ⏳ 占位
- 最终决议置底高亮，包含投票结果

**Dashboard 集成：**

- 检测 Swarm 是否有 `discuss` 类型的任务
- 有 → 主区域替换为 Discussion Thread，保留 Worker Cards 和控制按钮
- 无 → 保持原有 TaskGraph + ActivityFeed 布局

**数据来源：**

- 初始数据：`GET /swarm/:id/discussion`
- 实时更新：SSE `/swarm/:id/events` 的 signal 事件触发 refetch

---

## 约束

- **Worker 一律 sisyphus** — 角色差异来自 prompt，不引入新 agent
- **role_name 是唯一标识** — 用于 join/record/signal.from/tally
- **不引入新通信通道** — 复用 SharedBoard Signal + channel
- **不引入 Worker 直连** — Worker 通过 board 读写，Monitor 转发给 Conductor
- **不修改 Swarm.launch()** — `discuss()` 是 `launch()` 的上层封装
- **Flag 复用** — 沿用 `OPENCODE_SWARM` flag

## 不做的事

- Worker 之间直接聊天
- 嵌套讨论
- 投票权重
- 动态增删角色（讨论开始后角色固定）
