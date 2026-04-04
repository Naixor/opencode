# PRD: Multi-Main-Agent Swarm Collaboration

## Introduction

当前 opencode 的 Agent 协作模型是**树状委派**：一个 Primary Agent（Sisyphus/Build）通过 `delegate_task` 创建 child session 运行 subagent，subagent 不能再委派。多个 Agent 之间没有共享上下文的能力，协作靠父 Agent 在 prompt 中"口口相传"。

本 PRD 实现 **Swarm 协作模型**——多个 Primary Session 并行工作，通过 SharedBoard（共享看板）交换信息，由内置的 Conductor Agent 自动协调，Dashboard UI 提供全局可视化，Agent 通过 Playbook 和统计数据自我进化。

**核心设计约束**：

- 不改动 Session 核心循环（`prompt.ts` / `processor.ts` / `llm.ts`）
- Worker 是独立 Primary Session，天然支持并行（每个 Session 有自己的 `assertNotBusy` 锁）
- 复用现有 Bus、BackgroundManager、PersistentTask 基础设施
- Conductor 是 Built-in Native Agent，有专门的代码逻辑，不仅靠 prompt
- Conductor 的 model 跟随用户当前选择，用户完全掌控成本
- Worker 用 Sisyphus agent——每个 Worker 本身是完整编排者，可再委派 subagent（Conductor → Sisyphus Worker → subagent 三层结构）
- 禁止 Swarm 嵌套——Worker deny swarm_launch
- Board 数据存 Instance data 目录（与 session.db 同级），不污染项目目录
- scope 重叠时 Conductor 应先创建"解耦"任务，完成后再并行分配后续开发

## Goals

- 支持多个 Primary Agent 同时在独立 Session 中并行工作，协同完成一个复合目标
- 通过 SharedBoard 提供 Agent 间的上下文共享（任务分配、成果物交换、实时信号）
- 通过 Conductor Agent 自动协调 Worker，减少 human-in-the-loop 到仅架构/安全/反复失败场景
- 提供 Web + TUI 两端的 Swarm Dashboard，让人在全局看板上了解所有 Agent 的工作进展
- 从 Phase 1 开始记录 Agent 性能统计，为后续自我进化打基础

## User Stories

### US-001: SharedBoard — Task 管理

**Description:** As a Conductor Agent, I want to create, read, update tasks on a shared board so that I can distribute work to Worker Agents and track progress.

**Acceptance Criteria:**

- [ ] 新增 `src/board/` 模块，提供 `SharedBoard` namespace
- [ ] 在 Instance data 目录下的 `board/<swarm-id>/tasks/` 子目录以 JSON 文件持久化 Task（每个 Swarm 隔离，路径类似 `~/.local/share/opencode/projects/<hash>/board/<swarm-id>/tasks/`）
- [ ] Task schema 扩展自 `PersistentTask.Info`，新增字段：`assignee`（Session ID）、`type`（implement | review | test | investigate | fix）、`scope`（文件路径数组）、`artifacts`（关联 Artifact ID 数组）
- [ ] 提供 CRUD 操作：`SharedBoard.createTask()`、`getTask()`、`listTasks()`、`updateTask()`、`deleteTask()`
- [ ] Task 有 `blockedBy` 字段，`SharedBoard.readyTasks()` 返回所有依赖已完成的 pending 任务
- [ ] 用文件锁（复用 `Lock` 模块）防止并发写冲突
- [ ] Task 变更通过 `Bus.publish(SharedBoard.Event.TaskUpdated, ...)` 广播
- [ ] Typecheck passes

### US-002: SharedBoard — Artifact 管理

**Description:** As a Worker Agent, I want to publish artifacts (analysis results, code change summaries, test reports) to the shared board so that other Agents and the Conductor can read my outputs.

**Acceptance Criteria:**

- [ ] Artifact 持久化在 Instance data 目录的 `board/<swarm-id>/artifacts/` 子目录，每个 Artifact 一个 JSON 文件
- [ ] Artifact schema：`id`（A-uuid）、`type`（analysis | code_change | test_result | decision | finding）、`task_id`、`author`（Agent name + Session ID）、`content`（Markdown 字符串）、`files`（关联文件路径数组）、`created_at`、`supersedes?`（替代旧 Artifact 的 ID）
- [ ] 提供 `SharedBoard.postArtifact()`、`getArtifact()`、`listArtifacts(filter)`
- [ ] `filter` 支持按 `taskID`、`type`、`author` 过滤
- [ ] Artifact 创建后通过 Bus 广播 `SharedBoard.Event.ArtifactCreated`
- [ ] Typecheck passes

### US-003: SharedBoard — Signal 通信

**Description:** As a Worker Agent, I want to send real-time signals (progress, conflict, blocked, done) so that the Conductor can react without polling.

**Acceptance Criteria:**

- [ ] Signal 以 JSONL 格式 append 到 Instance data 目录的 `board/<swarm-id>/signals.jsonl`
- [ ] Signal schema：`id`（uuid）、`channel`（"global" | task_id | agent_name）、`type`（progress | conflict | question | done | blocked | need_review）、`from`（Agent session ID）、`payload`（Record<string, unknown>）、`timestamp`
- [ ] `SharedBoard.signal()` 写入文件并通过 Bus 广播 `SharedBoard.Event.Signal`
- [ ] `SharedBoard.watchSignals(channel, callback)` 订阅指定 channel 的 Signal（基于 Bus.subscribe）
- [ ] `SharedBoard.recentSignals(channel, limit)` 读取最近 N 条 Signal（从 JSONL 尾部读取）
- [ ] Typecheck passes

### US-004: SharedBoard — Board Snapshot

**Description:** As the Conductor Agent, I want to get a full board snapshot so that I can make holistic decisions about task assignment and conflict resolution.

**Acceptance Criteria:**

- [ ] `SharedBoard.snapshot()` 返回 `{ tasks, artifacts, recentSignals, stats }` 的完整对象
- [ ] `stats` 包括：total/pending/running/completed/failed task 计数、active worker 数量、最后更新时间
- [ ] snapshot 结果缓存 5 秒（Conductor 轮询间隔内避免重复磁盘 IO）
- [ ] 缓存在 Bus 收到 TaskUpdated/ArtifactCreated/Signal 事件后自动失效
- [ ] Typecheck passes

### US-005: Board Tools — Agent 操作 Board 的工具集

**Description:** As a developer, I want Board-related tools registered in the ToolRegistry so that Agents can interact with the SharedBoard through normal tool calls.

**Acceptance Criteria:**

- [ ] 新增 `src/tool/board.ts`，定义以下 tools：
  - `board_read`：读取 tasks（支持 filter）、artifacts（支持 filter）、signals（支持 channel + limit）、snapshot
  - `board_write`：创建/更新 task、发布 artifact、发送 signal
  - `board_status`：获取 board snapshot 的摘要统计
- [ ] 每个 tool 的 parameters 使用 Zod schema 定义，description 清晰说明用法
- [ ] tools 在 `registry.ts` 的 `all()` 函数中注册，受 Swarm feature flag 控制（`Flag.OPENCODE_SWARM`）
- [ ] 默认 permission：Conductor agent 拥有 board 全部权限；Worker agent 只有 `board_read: allow` + `board_write` 限制为自己 assignee 的 task
- [ ] Typecheck passes

### US-006: Conductor Agent — Built-in 定义

**Description:** As a developer, I want to define the Conductor as a built-in native agent so that it has proper code-level logic for orchestration, not just prompt engineering.

**Acceptance Criteria:**

- [ ] 在 `src/agent/agent.ts` 的 `state()` 中新增 `conductor` agent 定义
- [ ] mode 为 `"primary"`，native 为 `true`，hidden 为 `false`
- [ ] permission：`board_read: allow`、`board_write: allow`、`board_status: allow`、`delegate_task: allow`、`persistent_task: allow`、`question: allow`（用于 escalation）、`read: allow`、`grep: allow`、`glob: allow`、`bash: allow`；`edit: deny`、`write: deny`（Conductor 不直接改代码）
- [ ] prompt 从 `src/agent/prompt/conductor.txt` 加载
- [ ] **不设置 model override**——Conductor 跟随用户当前选择的 model，用户完全掌控成本
- [ ] temperature 设为 0.1（需要确定性决策）
- [ ] prompt_level 设为 `"full"`（需要完整项目上下文）
- [ ] Typecheck passes

### US-007: Conductor Prompt — Soul + 动态 Strategy

**Description:** As the Conductor Agent, I need a two-layer prompt architecture: a fixed Soul (role identity) and a dynamic Strategy (evolving operational logic) so that I can improve over time while maintaining consistent identity.

**Acceptance Criteria:**

- [ ] 新增 `src/agent/prompt/conductor.txt`，仅包含 **Soul 层**（固定不变的角色定义）：
  - **Identity**：你是 Conductor，协调多个 Worker Agent 完成复合目标的指挥家
  - **Core Values**：准确性优先于速度、先解耦再并行、最小化人类打扰、从经验中学习
  - **Tool Protocol**：board_read/board_write/board_status/delegate_task 的基本用法
  - **Escalation Boundary**：只在架构决策/安全变更/重试耗尽/仲裁失败时召唤人
- [ ] Soul 层 prompt 长度 < 1500 tokens（为 Strategy 留空间）
- [ ] 新增 **Strategy 层**，从 Instance data 目录的 `board/conductor-strategy.md` 加载（如果文件存在）
- [ ] Strategy 层包含动态演进的操作逻辑：
  - **Planning Protocol**：收到目标后，分析代码库，将目标分解为有依赖关系的 Tasks
  - **Assignment Protocol**：根据 Stats 选择最适合的 Worker Agent
  - **Monitoring Protocol**：周期性检查进度，响应 Signal
  - **Scope Decouple Protocol**：scope 重叠时先创建"解耦"任务
  - **Conflict Resolution**：分析冲突双方 Artifact，选择更优方案
  - **Verification Protocol**：所有 Task 完成后运行全局验证
- [ ] Strategy 层首次运行时从内置模板复制到 `board/conductor-strategy.md`
- [ ] **Swarm 启动前确认环节**：Conductor 在正式规划前，先向人展示当前 Strategy 的变更摘要（哪些 Playbook 经验被融入、与上次相比调整了什么），通过 question tool 请人确认或调整，然后再开始执行
- [ ] Conductor 的 retrospective 阶段可更新 Strategy 文件（调整规划风格、escalation 阈值等），但更新后的 Strategy 在下次 Swarm 启动时需要人确认
- [ ] 用户可以通过 `.opencode/agent/conductor.md` 完全覆盖 Soul 层（复用现有 agent 覆盖机制）
- [ ] 每个项目的 Strategy 独立演进——不同项目有不同的 conductor-strategy.md
- [ ] Typecheck passes（conductor.txt 被正确 import）

### US-008: Swarm Lifecycle — 创建与启动

**Description:** As a user, I want to launch a Swarm with a high-level goal so that multiple Agents start working on it automatically.

**Acceptance Criteria:**

- [ ] 新增 `src/session/swarm.ts`，定义 `Swarm` namespace
- [ ] `Swarm.Info` schema：`id`（swarm_uuid）、`goal`（string）、`conductor`（Session ID）、`workers`（数组：{ session_id, agent, task_id, status }）、`board_dir`（SharedBoard 目录路径）、`config`（max_workers, auto_escalate, verify_on_complete）、`time`（created, updated, completed?）、`status`（planning | running | paused | completed | failed）
- [ ] `Swarm.launch({ goal, config? })` 执行以下步骤：
  1. 在 Instance data 目录下创建 `board/<swarm-id>/` 隔离子目录（tasks/, artifacts/, signals.jsonl）。共享目录 `board/playbooks/` 和 `board/stats.json` 在 board 根目录
  2. 创建 Conductor 的独立 Primary Session（`Session.createNext({ ... })`），Conductor 使用用户当前选择的 model
  3. 向 Conductor Session 发送 goal 作为 user message（`SessionPrompt.prompt({ sessionID, parts: [{ type: "text", text: goal }] })`）
  4. 返回 `Swarm.Info`
- [ ] 允许同一项目同时运行多个 Swarm，每个 Swarm 的 tasks/artifacts/signals 在 `board/<swarm-id>/` 下隔离
- [ ] Swarm 注册信息持久化到 Instance data 目录的 `board/swarms.json`（数组，记录所有 Swarm 的 id、goal、status、conductor session ID）
- [ ] Worker 总数跨所有 Swarm 共享 BackgroundManager 的全局并发控制
- [ ] `Swarm.launch()` 不等待 Conductor 完成（异步执行），返回后 Conductor 自主运行
- [ ] 通过 Bus 广播 `Swarm.Event.Created`
- [ ] Typecheck passes

### US-009: Swarm Lifecycle — Worker 启动与管理

**Description:** As the Conductor Agent, I want delegate_task to create independent Primary Sessions (not child sessions) so that Workers can run in full parallel with complete agent capabilities.

**Acceptance Criteria:**

- [ ] 增强 `delegate_task.ts`：当调用来自 Conductor agent 且传入 `swarm_id` 参数时，创建独立 Primary Session（不设 parentID）
- [ ] 新增 `delegate_task` 可选参数：`swarm_id`（string，关联到 Swarm）、`task_id`（string，关联到 Board Task）
- [ ] Worker 使用 **sisyphus** agent——每个 Worker 是完整编排者，可通过 delegate_task 再委派 subagent（形成 Conductor → Sisyphus Worker → subagent 三层结构）
- [ ] Worker Session 的 permission 中自动注入 `board_read: allow` + `board_write: allow` + **`swarm_launch: deny`**（禁止 Swarm 嵌套）
- [ ] Worker Session 创建后，更新 `Swarm.Info.workers[]` 数组并持久化
- [ ] 在 BackgroundManager 中注册 Worker 任务，复用其并发控制（`config.max_workers` 映射到 `defaultConcurrency`）
- [ ] Worker 完成时通过 Signal 通知 Conductor（`board_write signal { type: "done", ... }`）
- [ ] Typecheck passes

### US-009b: Worker Checkpoint 与失败恢复

**Description:** As a Worker Agent, I want to publish checkpoint artifacts at key milestones so that if I fail, the Conductor can restart me from the latest checkpoint instead of from scratch.

**Acceptance Criteria:**

- [ ] Worker 在以下关键节点自动发布 type=`checkpoint` 的 Artifact：
  - 完成一个子任务（delegate_task 返回后）
  - 通过 typecheck（bash 执行 tsc 成功后）
  - 完成文件创建/编辑的一组相关操作后
- [ ] Checkpoint Artifact 的 content 包含：已完成的步骤摘要、当前进展描述、待完成的剩余工作、已修改的文件列表
- [ ] Worker 异常退出时（Session 变 idle 但 Task 未完成），BackgroundManager 的 stale detection（3 分钟无响应）将其标记为 failed
- [ ] Worker 正常失败时（context overflow / doom loop / 工具持续报错）发送 Signal(type=`failed`, payload 包含错误类型)
- [ ] Conductor 收到 Worker failed Signal 或 stale timeout 后，读取该 Task 最新的 checkpoint Artifact
- [ ] Conductor 重试策略：创建新 Worker Session，在 prompt 中注入 checkpoint 内容（"你的前任 Agent 已完成以下工作：{checkpoint.content}，请从此处继续"）
- [ ] 如果同一 Task 重试超过 `Escalation.Policy.max_retries` 次，Conductor 决定：拆分 Task 为更小单元 / reassign 给不同 model / escalate 给人
- [ ] Typecheck passes

### US-010: Swarm Lifecycle — 状态查询与控制

**Description:** As a user or UI, I want to query Swarm status, pause/resume workers, and stop the entire Swarm so that I maintain control over multi-agent execution.

**Acceptance Criteria:**

- [ ] `Swarm.status(id)` 返回最新的 `Swarm.Info`（从 swarm.json + 实时 Session 状态合并）
- [ ] `Swarm.pause(id)` 暂停所有 Worker Sessions（调用 `SessionPrompt.cancel(sessionID)` for each worker）
- [ ] `Swarm.resume(id)` 恢复所有 Worker Sessions（调用 `SessionPrompt.loop({ sessionID, resume_existing: true })`）
- [ ] `Swarm.stop(id)` 终止所有 Worker + Conductor Sessions，标记 Swarm 为 failed
- [ ] `Swarm.intervene(id, message)` 向 Conductor Session 发送人类消息（不影响 Worker）
- [ ] `Swarm.list()` 列出所有 Swarm（读取 Instance data 目录下 `board/swarms.json` 注册表）
- [ ] 所有操作通过 Bus 广播对应事件
- [ ] Typecheck passes

### US-011: Swarm Tools — 用户侧操作工具

**Description:** As a user in a Primary Session (like Sisyphus), I want tools to launch and manage Swarms so that I can start multi-agent work from any session.

**Acceptance Criteria:**

- [ ] 新增 `src/tool/swarm.ts`，定义以下 tools：
  - `swarm_launch`：参数 `{ goal: string, max_workers?: number }`，调用 `Swarm.launch()`
  - `swarm_status`：参数 `{ id: string }`，调用 `Swarm.status()`
  - `swarm_intervene`：参数 `{ id: string, message: string }`，调用 `Swarm.intervene()`
  - `swarm_stop`：参数 `{ id: string }`，调用 `Swarm.stop()`
  - `swarm_list`：无参数，调用 `Swarm.list()`
- [ ] tools 在 `registry.ts` 注册，受 `Flag.OPENCODE_SWARM` 控制
- [ ] 只有 mode 为 `"primary"` 的 Agent 可以调用这些 tools（subagent deny）
- [ ] Typecheck passes

### US-012: Escalation Policy — 减少人类干预

**Description:** As a Conductor, I want a clear escalation policy engine so that I only involve the human when truly necessary.

**Acceptance Criteria:**

- [ ] 新增 `src/board/escalation.ts`，定义 `Escalation` namespace
- [ ] `Escalation.Policy` 是一个规则数组，每条规则包含：`condition`（string 匹配模式）、`action`（"retry" | "arbitrate" | "reassign" | "ask_human"）、`max_retries`（number）
- [ ] 默认策略：
  - task failed + retries < 3 → retry with different strategy hint
  - conflict on same file → Conductor arbitrate
  - test failure on known flaky test → auto retry
  - architecture decision needed → ask human
  - all retries exhausted → ask human
  - security sensitive change detected → ask human
- [ ] `Escalation.evaluate(event, context)` 返回推荐 action
- [ ] 策略可通过 `opencode.jsonc` 的 `swarm.escalation` 字段自定义
- [ ] Conductor prompt 中引用 Escalation 策略作为决策框架
- [ ] Typecheck passes

### US-013: Stats Collection — 基础进化数据

**Description:** As a developer, I want to collect Agent performance statistics from Swarm executions so that future Swarms can make better task assignment decisions.

**Acceptance Criteria:**

- [ ] 新增 `src/board/stats.ts`，定义 `SwarmStats` namespace
- [ ] Stats 持久化在 Instance data 目录的 `board/stats.json`（全局，跨 Swarm 累计）
- [ ] 收集以下指标，按 agent name 聚合：
  - `tasks_completed`：完成的任务数
  - `tasks_failed`：失败的任务数
  - `avg_steps`：平均每个任务的 LLM step 数
  - `avg_duration_ms`：平均任务耗时
  - `retry_rate`：重试率（retries / total attempts）
  - `types_completed`：按 task type 分组的完成数（如 implement:12, test:5）
  - `escalation_count`：被升级到人的次数
- [ ] `SwarmStats.record(event)` 在 Task 完成/失败时调用（通过 Bus 订阅 `SharedBoard.Event.TaskUpdated`）
- [ ] `SwarmStats.get()` 返回当前统计数据
- [ ] `SwarmStats.recommend(taskType)` 根据历史数据返回最适合的 agent name（成功率最高 + 速度最快的加权排序）
- [ ] Conductor prompt 中注入 stats 摘要，辅助任务分配
- [ ] Typecheck passes

### US-014: Playbook — 操作手册

**Description:** As the Conductor Agent, I want to read and update Playbooks so that I can learn from past experiences and improve over time.

**Acceptance Criteria:**

- [ ] Playbook 存储在 Instance data 目录的 `board/playbooks/` 子目录，每个 Playbook 一个 Markdown 文件
- [ ] Playbook 格式：YAML frontmatter（name, trigger, version, success_rate, last_updated）+ Markdown body（Steps, Lessons Learned, Anti-patterns）
- [ ] 新增 `src/board/playbook.ts`，提供 `Playbook.list()`、`Playbook.get(name)`、`Playbook.update(name, content)`
- [ ] Conductor 在分配 Task 时，根据 task type 查找匹配的 Playbook，将 Steps 注入 Worker 的 prompt（通过 `delegate_task` 的 prompt 参数传递）
- [ ] Swarm 完成后，Conductor 执行 retrospective：分析 board 数据，更新相关 Playbook 的 Lessons Learned / Anti-patterns 段落
- [ ] Playbook 的 version 字段在每次更新时自增
- [ ] Typecheck passes

### US-015: Web Dashboard — Swarm 全局视图

**Description:** As a user in the Web App, I want a Swarm Dashboard page so that I can see all Agents' progress, the task graph, and items needing my attention.

**Acceptance Criteria:**

- [ ] 新增 `packages/app/src/pages/swarm/` 目录
- [ ] 新增路由 `/swarm/:id` 显示指定 Swarm 的 Dashboard
- [ ] **SwarmOverview 组件**：顶部显示 Swarm goal、状态、运行时长；下方排列 Worker Agent 卡片（agent name、当前 task、step 进度、状态 indicator）
- [ ] **TaskGraph 组件**：DAG 可视化 Task 依赖关系（节点 = task，边 = blockedBy），用颜色区分状态（green=completed, blue=running, gray=pending, red=failed）
- [ ] **AttentionQueue 组件**：显示所有需要人类决策的 question（来自 Conductor 的 escalation），每个 question 提供选项按钮，人直接在 Dashboard 回答，不需要切换 Session
- [ ] **ActivityFeed 组件**：实时显示 Signal 流（来自 `SharedBoard.Event.Signal`），每条 Signal 格式化为可读文本（如 "14:32 Agent A completed 'DB Schema'"）
- [ ] 点击 Agent 卡片跳转到该 Worker 的 Session 页面
- [ ] 数据来源：通过 SDK 调用 `Swarm.status()` + 订阅 Swarm 相关 Bus 事件
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-016: Web Dashboard — Swarm 列表与入口

**Description:** As a user in the Web App, I want to see all Swarms and launch new ones from the sidebar so that I can manage multi-agent work.

**Acceptance Criteria:**

- [ ] 在 Sidebar 中新增 "Swarm" section（在 Sessions 列表上方），列出活跃的 Swarm（显示 goal 截断 + 状态 + Worker 数量）
- [ ] 点击 Swarm item 跳转到 `/swarm/:id`
- [ ] 提供 "New Swarm" 按钮，弹出 dialog 输入 goal 和 max_workers，调用 `swarm_launch`
- [ ] Swarm 完成/失败后在列表中标记为灰色（不从列表移除）
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-017: Web Dashboard — Swarm 控制操作

**Description:** As a user, I want to pause, resume, stop, and intervene in a Swarm from the Dashboard so that I maintain control.

**Acceptance Criteria:**

- [ ] Dashboard 页面顶部提供控制按钮：Pause（暂停所有 Worker）、Resume（恢复）、Stop（终止）
- [ ] 按钮状态随 Swarm status 变化：running 时显示 Pause/Stop；paused 时显示 Resume/Stop；completed/failed 时按钮禁用
- [ ] "Send Message" 输入框：向 Conductor 发送自由文本消息（调用 `Swarm.intervene()`）
- [ ] 每个 Worker 卡片上提供单独的 Pause/Stop 按钮
- [ ] 操作后 Dashboard 实时刷新（通过 Bus 事件订阅）
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-018: TUI Dashboard — Swarm 状态展示

**Description:** As a user in the TUI, I want to see Swarm status so that I can monitor multi-agent work from the terminal.

**Acceptance Criteria:**

- [ ] 新增 TUI 视图 "Swarm Dashboard"（通过快捷键如 `Ctrl+S` 切换，或在 Session 列表中选择 Swarm item）
- [ ] 展示内容：Swarm goal + status、每个 Worker 一行（agent name、task 标题截断、status emoji：🟢/🟡/🔴/⏳）、待处理的 question 数量
- [ ] 底部显示最近 5 条 Signal（activity feed 简化版）
- [ ] 待处理的 question 内联展示：简单 question（有选项）可直接在 TUI 中按数字键回答；复杂 question（需要查看上下文）显示提示 "Open Web Dashboard for full context" 并提供 URL
- [ ] 按 Enter 进入选中 Worker 的 Session
- [ ] 按 `q` 返回 Session 列表
- [ ] Typecheck passes

### US-019: TUI Dashboard — Swarm 操作

**Description:** As a user in the TUI, I want to launch, intervene, and stop Swarms so that I can manage multi-agent work from the terminal.

**Acceptance Criteria:**

- [ ] 在 TUI 主输入框支持 `/swarm` 命令：
  - `/swarm launch <goal>` — 启动新 Swarm
  - `/swarm status` — 显示当前活跃 Swarm
  - `/swarm stop <id>` — 终止指定 Swarm
  - `/swarm msg <id> <message>` — 向 Conductor 发送消息
- [ ] 命令执行结果在 TUI 中内联显示
- [ ] 有活跃 Swarm 时，TUI 状态栏显示 "🐝 Swarm: X workers active"
- [ ] Typecheck passes

### US-020: SDK API — Swarm 接口

**Description:** As an ACP client or external tool, I want SDK APIs for Swarm management so that external integrations can control multi-agent work.

**Acceptance Criteria:**

- [ ] 在 SDK server routes 中新增以下 endpoints（参考现有 session/message 路由模式）：
  - `POST /swarm` — 创建 Swarm（body: { goal, config? }）
  - `GET /swarm` — 列出所有 Swarm
  - `GET /swarm/:id` — 获取 Swarm 状态
  - `POST /swarm/:id/intervene` — 向 Conductor 发消息
  - `POST /swarm/:id/pause` — 暂停
  - `POST /swarm/:id/resume` — 恢复
  - `POST /swarm/:id/stop` — 终止
- [ ] 新增 SSE 端点 `GET /swarm/:id/events`，推送 Swarm 相关 Bus 事件（TaskUpdated, Signal, Worker status change）
- [ ] 使用与现有 API 一致的 error 处理和 auth 机制
- [ ] 重新生成 JS SDK（运行 `./packages/sdk/js/script/build.ts`）
- [ ] Typecheck passes

### US-021: Feature Flag 与配置

**Description:** As a developer, I want the entire Swarm feature behind a feature flag so that it can be incrementally enabled without affecting existing users.

**Acceptance Criteria:**

- [ ] 新增 `Flag.OPENCODE_SWARM`（环境变量 `OPENCODE_SWARM=1`）
- [ ] 当 flag 关闭时：Conductor agent 不出现在 agent list、Board/Swarm tools 不注册、Dashboard 路由不加载
- [ ] 新增 `opencode.jsonc` 配置段 `swarm`：
  ```jsonc
  {
    "swarm": {
      "max_workers": 4,          // 默认最大 Worker 数
      "auto_escalate": true,     // 自动升级策略开关
      "verify_on_complete": true, // 完成后自动验证
      "escalation": { ... }      // 自定义升级规则
    }
  }
  ```
- [ ] Config schema（`src/config/config.ts`）中增加 `swarm` 字段的 Zod 定义
- [ ] Typecheck passes

### US-022: Conductor 监控循环

**Description:** As a Conductor Agent, I need a monitoring mechanism so that I can continuously watch Worker progress and react to events, not just run once and exit.

**Acceptance Criteria:**

- [ ] 在 `src/session/swarm.ts` 中实现 `Swarm.monitor(swarmID)` 函数
- [ ] monitor 订阅 Board Signal 和 Worker Session 的 status 事件
- [ ] 当收到以下事件时，向 Conductor Session 发送 synthetic user message（触发 Conductor 重新思考）：
  - Worker 完成任务（Signal type=done）
  - Worker 被阻塞（Signal type=blocked）
  - Worker 发生冲突（Signal type=conflict）
  - Worker Session 变为 idle 但 task 未完成（可能卡住）
  - 超过配置的 stale timeout 无进展
- [ ] synthetic message 包含事件摘要和当前 board snapshot
- [ ] Conductor 根据事件和 snapshot 做出决策（unblock task / reassign / escalate）
- [ ] monitor 在 Swarm stop/complete 时自动清理订阅
- [ ] Typecheck passes

### US-023: File Conflict Prevention — 先解耦，再并行

**Description:** As the system, I need to prevent multiple Workers from editing the same file, and when scope overlaps are detected, the Conductor must first decouple shared dependencies before parallel work begins.

**Acceptance Criteria:**

- [ ] 在 `SharedBoard` 中维护文件级 `scope_lock` 机制：当 Task 被分配时，其 `scope` 中的文件路径被锁定给该 Worker
- [ ] Worker 的 edit/write tool 执行前（通过 Hook Chain `pre-tool`），检查目标文件是否被其他 Worker 锁定
- [ ] 如果文件被锁定：拒绝操作，返回错误信息 "File {path} is locked by {agent} for task {task_id}. Send a 'conflict' signal via board_write to request Conductor coordination."
- [ ] Task 完成时自动释放 scope lock
- [ ] Conductor 可以通过 `board_write` 手动释放 lock（用于仲裁后重新分配）
- [ ] **Conductor 规划阶段检查 scope 重叠**：如果两个 Task 的 scope 包含相同文件路径，Conductor 必须先创建一个 type=`refactor` 的"解耦"Task（将共享依赖拆分为独立模块），该 Task 作为重叠 Task 的 `blockedBy` 依赖
- [ ] scope lock 仅作为安全网——主要依靠 Conductor 的智能分配避免 scope 重叠
- [ ] Typecheck passes

## Functional Requirements

- FR-1: SharedBoard 使用文件系统存储（Instance data 目录下 `board/<swarm-id>/`），每个 Swarm 隔离，不污染项目目录，不被 git 追踪
- FR-2: Task/Artifact/Signal 的增删改查通过 `SharedBoard` namespace 提供，底层使用 `Lock` 模块保证并发安全
- FR-3: Board Tools（board_read / board_write / board_status）注册在 ToolRegistry，受 `Flag.OPENCODE_SWARM` 控制
- FR-4: Conductor 是 built-in native agent（在 `agent.ts` state 中定义），拥有 board 全权限，deny edit/write（不直接改代码），**model 跟随用户当前选择**。prompt 采用 Soul（固定 built-in）+ Strategy（动态演进，存 Instance data）两层架构
- FR-5: Worker 使用 **sisyphus** agent 运行在独立 Primary Session（非 child session），可再委派 subagent，通过 BackgroundManager 管理并发
- FR-6: Worker Session 的 permission 中 **deny swarm_launch**（禁止 Swarm 嵌套）
- FR-7: 允许同一项目同时运行多个 Swarm，Worker 总数跨 Swarm 共享 BackgroundManager 全局并发控制
- FR-8: Swarm.launch() 创建 Conductor Session 并异步执行，不阻塞调用者。启动前 Conductor 先向人确认 Strategy 变更
- FR-9: Conductor 通过 monitor 机制持续响应 Worker 事件（Signal → synthetic user message → Conductor 决策）
- FR-10: Escalation Policy 默认只在架构决策/安全变更/重试耗尽/仲裁失败时召唤人
- FR-11: Agent 性能统计（SwarmStats）按 agent name 聚合，跨 Swarm 累计，存 `board/stats.json`（共享）
- FR-12: Playbook 存储在 Instance data 目录的 `board/playbooks/`（共享），Conductor 在分配 Task 时注入匹配的 Playbook 步骤到 Worker prompt
- FR-13: Swarm 完成后 Conductor 自动执行 retrospective，更新 Playbook、Stats 和 Strategy
- FR-14: Worker 在关键节点（子任务完成、typecheck 通过）自动发布 checkpoint Artifact；Conductor 重试 Worker 时注入最新 checkpoint
- FR-15: Web Dashboard 实时显示 Swarm 状态（Worker 卡片 + Task DAG + Attention Queue + Activity Feed）
- FR-16: TUI 提供 Swarm 状态展示和 `/swarm` 命令操作；简单 question 可直接在 TUI 回答，复杂 question 引导到 Web
- FR-17: SDK API 提供完整的 Swarm CRUD + SSE 事件流
- FR-18: 整个功能受 `Flag.OPENCODE_SWARM` 控制，关闭时无任何副作用
- FR-19: 文件级 scope lock 作为安全网，主要依靠 Conductor 智能分配避免 scope 重叠；scope 重叠时先创建"解耦"任务
- FR-20: Board 冗余数据在 Playbook 被用户确认后即可清理（Task/Artifact/Signal），Stats 和 Playbook 永久保留

## Non-Goals

- **不改 Session 核心循环**：prompt.ts / processor.ts / llm.ts 保持不变
- **不实现 Agent 间直接消息传递**：Agent 通过 SharedBoard 间接通信，不引入新的通信协议
- **不实现自动 git merge/rebase**：文件冲突通过 scope lock + 先解耦策略预防，不在运行时自动 merge
- **不实现 Swarm 嵌套**：Worker deny swarm_launch，一个 Swarm 的 Worker 不能启动子 Swarm
- **不实现跨机器分布式 Swarm**：所有 Session 运行在同一 opencode 实例中
- **不实现 Swarm 的暂停/恢复持久化**：进程重启后 running 状态的 Swarm 不会自动恢复（需要手动重启）
- **不实现复杂的 Playbook DSL**：Playbook 是 Markdown，由 Conductor 通过 LLM 理解，不是可执行的脚本
- **不修改 ACP 协议**：SDK API 使用标准 HTTP REST，不在 ACP 中加新 method
- **不将 Board 数据放在项目目录中**：Board 存 Instance data 目录，避免污染代码仓库

## Design Considerations

### UI/UX

- **Swarm Dashboard** 是一个新的顶级页面（`/swarm/:id`），不嵌入 Session 页面
- Sidebar 新增 Swarm section，位置在 Session list 上方，视觉上用蜂巢 icon 区分
- AttentionQueue 是 Dashboard 中最重要的模块——人只需要关注这里
- Agent 卡片用色块表示状态：蓝色=running、绿色=done、灰色=pending/blocked、红色=failed
- TUI 保持极简：用 emoji + 单行文本表示 Agent 状态，不尝试复杂布局

### 复用现有组件

- `PersistentTask` 的 Info schema 和文件存储模式 → SharedBoard Task 的基础
- `BackgroundManager` 的并发控制和 stale detection → Worker 生命周期管理
- `Bus` 的 pub/sub → 所有实时通知
- `Lock` 模块 → 文件并发安全
- `Tool.define()` + `ToolRegistry.register()` → Board/Swarm tool 注册
- `SessionPrompt.prompt()` → 向 Conductor Session 发送消息
- `SessionPrompt.cancel()` → 暂停 Worker Session
- `delegate_task` 的 child session 创建逻辑 → Worker Session 创建（去掉 parentID）

### 关键架构决策

| 决策              | 选择                                      | 理由                                                               |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| Conductor model   | 跟随用户当前 model                        | 用户完全掌控成本，不硬编码 provider                                |
| Conductor prompt  | Soul（固定）+ Strategy（动态演进）        | Soul 保持角色一致性，Strategy 从 Playbook 经验中进化。启动前人确认 |
| Worker agent      | sisyphus                                  | 完整编排能力，可再委派 subagent，形成三层结构                      |
| Worker 失败恢复   | Signal + Stale 检测 + checkpoint Artifact | 检测靠 Signal 和超时，恢复靠 checkpoint 上下文注入                 |
| Swarm 嵌套        | 禁止                                      | 避免复杂度爆炸和成本失控                                           |
| 多 Swarm 并行     | 允许，按 Swarm ID 隔离 Board              | 每个 Swarm 独立子目录，stats/playbooks 共享                        |
| Board 存储位置    | Instance data 目录                        | 不污染项目目录，不被 git 追踪                                      |
| Scope 冲突策略    | 文件级 lock + 先解耦再并行                | lock 是安全网，核心靠 Conductor 智能分配                           |
| Board 数据清理    | Playbook 确认后手动清理                   | Board 和 memory 同为宝贵资源，不自动删除                           |
| TUI question 交互 | 简单题直答 + 复杂题引导 Web               | 兼顾效率和完整上下文                                               |

## Technical Considerations

### 存储

- Board 数据存储在 Instance data 目录（与 session.db 同级），路径：`<Instance.data>/board/`
- 每个 Swarm 隔离在 `board/<swarm-id>/` 下（tasks/、artifacts/、signals.jsonl）
- `board/stats.json` 和 `board/playbooks/` 是跨 Swarm 共享的进化数据，永久保留
- `board/conductor-strategy.md` 是 Conductor 的动态 Strategy，每个项目独立演进
- `board/swarms.json` 是 Swarm 注册表
- 单个 Swarm 的运行时数据（tasks/artifacts/signals）在 Playbook 被用户确认后可清理
- 清理操作由用户手动触发或通过 board_write tool 的 cleanup 操作触发

### 性能

- SharedBoard 是文件 IO，比 SQLite 慢——但 Board 操作低频（秒级），不是瓶颈
- Snapshot 缓存 5 秒，避免 Conductor 轮询时重复磁盘读取
- Worker 并发数通过 BackgroundManager 的 `defaultConcurrency` 控制，防止 API rate limit
- Signal JSONL 文件可能增长过大——定期截断到最近 1000 条

### 依赖

- 不新增外部依赖——所有功能用 Bun 标准 API + 现有模块实现
- Worker Session 使用与 delegate_task 相同的 model 解析逻辑（category → model routing）

### 安全

- Worker 的 scope lock 防止意外的文件修改冲突
- Conductor 不能 edit/write 代码文件，只能通过 Board 协调
- Escalation Policy 确保安全敏感变更必须经人确认
- Board Tools 的 permission 限制：Worker 只能写自己被分配的 task 的 artifact

### 测试策略

- SharedBoard CRUD：单元测试（临时目录）
- Swarm lifecycle：集成测试（mock LLM 返回预设的 Conductor 决策）
- Escalation：单元测试（给定 event/context，验证推荐 action）
- UI 组件：Storybook + dev-browser 视觉验证
- 端到端：手动测试——启动真实 Swarm 完成一个 3-task 目标

## Success Metrics

- 多 Agent 并行工作：Swarm 中 ≥2 个 Worker 能同时执行，总耗时 < 单 Agent 串行的 60%
- 减少人类干预：对于标准特性开发（3-5 个 subtask），人只被召唤 ≤1 次（或 0 次）
- Agent 进化可观测：stats.json 中各 Agent 的指标在 5+ 次 Swarm 后有统计意义
- Dashboard 可用性：人能在 Dashboard 上 10 秒内理解整个 Swarm 的当前状态
- 零回归：关闭 `OPENCODE_SWARM` flag 后，所有现有功能不受影响

## Resolved Questions

以下问题已在讨论中确认：

| #   | 问题                    | 决策                                                                                                                                                                                                    |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Conductor 的 model 选择 | **跟随用户当前 model**。用户完全掌控成本，不硬编码特定 provider                                                                                                                                         |
| 2   | Worker 的 Agent 类型    | **用 Sisyphus**。Worker 有完整编排能力，可再委派 subagent（三层结构）                                                                                                                                   |
| 3   | Swarm 嵌套              | **禁止**。Worker deny swarm_launch，避免复杂度爆炸和成本失控                                                                                                                                            |
| 4   | Board 数据清理          | **存 Instance data 目录**。Board 与 memory 同为宝贵资源，Playbook 确认后清理冗余数据                                                                                                                    |
| 5   | Scope lock 粒度         | **文件级 + Conductor 智能分配**。scope 重叠时先创建"解耦"任务拆分共享依赖，再并行                                                                                                                       |
| 6   | TUI question 交互       | **两种都支持**。简单 question（选择题）可在 TUI 直接回答；复杂 question 引导到 Web Dashboard                                                                                                            |
| 7   | Conductor prompt 迭代   | **Soul + 动态 Strategy 两层架构**。Soul 是固定角色定义（built-in）；Strategy 是动态操作逻辑（存 Instance data，可被 Playbook 经验更新）。每次 Swarm 启动前 Conductor 先向人展示 Strategy 变更并请求确认 |
| 8   | Worker 失败恢复         | **Signal + Stale 做检测，checkpoint Artifact 做恢复**。Worker 在关键节点自动发布 checkpoint，Conductor 重试时注入最新 checkpoint 上下文                                                                 |
| 9   | 多 Swarm 并行           | **允许，Board 按 Swarm ID 隔离**。每个 Swarm 在 `board/<swarm-id>/` 下有独立的 tasks/artifacts/signals，stats 和 playbooks 在 board 根目录共享                                                          |

## Open Questions

（所有关键问题已在讨论中解决，无遗留问题）
