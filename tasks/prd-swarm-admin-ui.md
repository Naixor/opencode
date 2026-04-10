# PRD: Swarm Admin UI

## Introduction

当前 Swarm 模式已经具备 Conductor、Worker、SharedBoard、Discussion Round 等核心能力，但对人类管理员来说仍然偏“黑盒”：很难快速知道某个 Conductor 制定了什么计划、拆成了哪些任务、由哪些 Agent 认领、当前卡在哪里，以及讨论是否已经达成一致。

本 PRD 定义一个对人类管理员友好的 Swarm 管理 UI。它优先展示 **Conductor 总览**，并支持管理员在 30 秒内定位异常任务和责任人、在 1 分钟内理解一次 Swarm 从规划到讨论结论的完整过程。首期范围以 **只读观察** 为主，但允许管理员执行两个安全控制动作：`stop swarm` 和 `delete swarm`。

## Goals

- 让管理员优先看到每个 Conductor 的计划、阶段、进度、风险和最近动作
- 让管理员快速理解任务拆分结果、依赖关系、认领关系和阻塞原因
- 让管理员清晰查看讨论中的争议点、各角色立场、是否达成一致，并可下钻查看原文
- 将原始信号、原始发言、原始 Artifact 默认折叠，避免信息噪音
- 提供只读控制台体验，不允许直接改计划、改任务、改讨论内容
- 允许管理员安全地停止或删除一个 Swarm，而不引入更高风险的人工编辑能力

## User Stories

### US-001: 查看 Swarm 总览列表

**Description:** As an administrator, I want to see all Swarms in one place so that I can quickly find active, blocked, failed, or completed work.

**Acceptance Criteria:**

- [ ] 提供 Swarm 总览页，按项目列出最近和当前运行中的 Swarm
- [ ] 每个 Swarm 卡片或表格行显示：`swarm_id`、goal 摘要、Conductor 标识、状态、当前阶段、最近更新时间
- [ ] 每个 Swarm 显示任务统计：pending、running、blocked、failed、completed
- [ ] 每个 Swarm 显示讨论统计：进行中的 discussion 数、已达成一致数、未达成一致数
- [ ] blocked 或 failed 的 Swarm 在总览中有显著视觉标记
- [ ] 支持按状态筛选：All | Running | Blocked | Failed | Completed | Deleted
- [ ] 支持 `Needs Attention` 快速筛选，至少覆盖 blocked、failed、stale、no consensus 四类情况
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-002: 查看 Conductor 计划与阶段总览

**Description:** As an administrator, I want the Conductor plan to be the first thing I see so that I can understand the intended execution path before reading low-level details.

**Acceptance Criteria:**

- [ ] Swarm 详情页顶部首先展示 Conductor 摘要区，而不是任务或日志列表
- [ ] 摘要区显示：目标、当前阶段、计划摘要、风险摘要、最后一次 Conductor 决策时间
- [ ] 如果 Conductor 已经拆分任务，页面显示规划阶段时间线，例如 planning -> assigning -> running -> verifying -> completed
- [ ] 页面展示 Conductor 最近 5 条关键动作摘要，例如“创建任务”“重新分配”“等待讨论结束”“判定共识未达成”
- [ ] 当计划信息缺失时，页面明确显示“暂无可展示计划”，而不是空白区域
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-003: 查看任务拆分、依赖和认领关系

**Description:** As an administrator, I want to inspect task breakdown and ownership so that I can understand what work exists and who is responsible for it.

**Acceptance Criteria:**

- [ ] 详情页提供任务视图，列出所有 BoardTask
- [ ] 每个任务显示：`task_id`、title 或 summary、type、status、blockedBy、创建时间、最近更新时间
- [ ] 每个任务显示 assignee 信息；未认领任务明确显示“unassigned”
- [ ] 支持按 assignee、status、type 过滤任务
- [ ] 支持查看任务依赖关系，至少以缩进树、关系标签或侧边详情中的依赖列表形式展示
- [ ] blocked 任务必须显示阻塞原因摘要
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-004: 查看 Agent 认领情况与执行状态

**Description:** As an administrator, I want a per-agent view so that I can quickly tell which Agent is working, idle, blocked, or has failed.

**Acceptance Criteria:**

- [ ] 详情页提供 Agent 视图，列出 Conductor 和全部 Worker
- [ ] 每个 Agent 显示：角色名或 agent 名、session_id、当前状态、关联任务数、最近活动时间
- [ ] Worker 显示当前认领任务和最近一次进度信号摘要
- [ ] 如果 Agent 处于 blocked 或 failed 状态，页面显示最近原因摘要
- [ ] 可以从 Agent 视图跳转到该 Agent 关联的任务列表和讨论列表
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-005: 查看讨论摘要、争议点和共识状态

**Description:** As an administrator, I want discussion views to highlight disagreement and consensus so that I can understand the decision process without reading every message.

**Acceptance Criteria:**

- [ ] 详情页提供 Discussion 视图，按 discussion channel 列出所有讨论主题
- [ ] 每个讨论显示：topic 或 channel、当前 round、max_rounds、参与角色、状态、最终 tally
- [ ] 讨论默认展示“争议点摘要”与“当前共识状态”，而不是原始全文
- [ ] 争议点摘要至少覆盖：谁支持、谁反对、谁要求修改、主要分歧点
- [ ] 对于已结束讨论，页面明确显示“已达成一致”“部分一致”“未达成一致”三种状态之一
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-006: 下钻查看原始讨论和原始记录

**Description:** As an administrator, I want to drill into original records only when needed so that I can audit details without overwhelming the default view.

**Acceptance Criteria:**

- [ ] 每个讨论支持展开查看每一轮的原始 signal 和原始摘要
- [ ] 原始内容默认折叠，管理员手动展开后才显示详细文本
- [ ] 可以从争议点摘要跳转到对应角色、对应轮次的原始内容
- [ ] 可以查看与讨论相关的 Artifact，例如 proposal、summary、decision、review_comment
- [ ] 原始记录区域明确标注来源类型：signal、artifact、summary、decision
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-007: 停止和删除 Swarm

**Description:** As an administrator, I want limited control actions so that I can stop runaway work or remove stale entries without gaining full editing powers.

**Acceptance Criteria:**

- [ ] UI 提供 `Stop Swarm` 动作，适用于 running 或 blocked 状态的 Swarm
- [ ] 触发 stop 前显示确认对话框，明确说明会停止 Conductor 和 Worker 的后续执行
- [ ] stop 成功后，Swarm 状态立即更新为 stopped 或 failed，并显示操作时间
- [ ] UI 提供 `Delete Swarm` 动作，但仅允许对非运行中 Swarm 执行
- [ ] 触发 delete 前显示二次确认，明确说明删除后该 Swarm 不再出现在默认列表
- [ ] delete 采用安全删除语义：默认列表隐藏该 Swarm，但保留其 board、artifact、signal、discussion 数据
- [ ] 删除不会赋予管理员编辑任务、编辑计划、编辑讨论的能力
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-008: 为 UI 提供聚合读模型和实时更新

**Description:** As a developer, I want one aggregated read model for Swarm admin pages so that the UI can render plan, tasks, agents, and discussions without stitching many low-level files in the browser.

**Acceptance Criteria:**

- [ ] 提供一个聚合读取接口，返回单个 Swarm 的 overview、tasks、agents、discussions、recent signals
- [ ] 聚合结果复用现有 `Swarm`、`SharedBoard`、`Discussion` 数据，不新增重复持久化源
- [ ] 聚合结果包含可直接渲染的摘要字段，例如 `plan_summary`、`risk_summary`、`conflict_summary`、`consensus_state`
- [ ] `plan_summary` 优先使用 Conductor artifact；若缺失，则按固定规则从 tasks、signals、discussion 数据推导
- [ ] 支持实时刷新或事件驱动刷新，保证总览页和详情页能看到最新状态
- [ ] 当底层记录缺失或部分损坏时，聚合接口返回可展示的降级字段，而不是整个页面报错
- [ ] Typecheck passes

## Functional Requirements

1. FR-1: 系统必须提供一个 Swarm 总览页，用于查看当前项目下的全部 Swarm。
2. FR-2: 总览页必须优先展示 Conductor 级别信息，包括目标、阶段、风险和最近动作。
3. FR-3: 系统必须支持从总览进入单个 Swarm 详情页。
4. FR-4: 详情页必须包含至少四类可切换信息区域：Conductor、Tasks、Agents、Discussions。
5. FR-5: 系统必须展示 Conductor 创建的计划摘要和阶段时间线。
6. FR-6: 系统必须展示每个任务的状态、依赖、认领者和阻塞原因。
7. FR-7: 系统必须展示每个 Agent 当前状态、最近活动和关联任务。
8. FR-8: 系统必须展示每个 discussion channel 的轮次状态、参与者和共识 tally。
9. FR-9: 系统必须优先显示讨论中的争议点摘要，而不是默认显示原始全文。
10. FR-10: 系统必须允许管理员按需展开原始 signal、artifact 和摘要内容。
11. FR-11: 系统必须对 blocked、failed、未达成一致等异常状态提供显著视觉提示。
12. FR-12: 系统必须支持按状态、assignee、task type、discussion state 进行筛选。
13. FR-13: 系统必须提供 `Needs Attention` 快速筛选，至少覆盖 blocked、failed、stale、no consensus 四类情况。
14. FR-14: 系统必须支持从任务跳转到 assignee，从 Agent 跳转到关联任务，从讨论摘要跳转到对应原文。
15. FR-15: 系统必须提供 `Stop Swarm` 操作，并在执行前展示明确确认信息。
16. FR-16: 系统必须提供 `Delete Swarm` 操作，但只能针对非运行中 Swarm，且语义为安全删除而非物理删除。
17. FR-17: 被安全删除的 Swarm 默认不出现在总览页，但系统必须保留其底层记录，并支持通过 `include_deleted` 或等价筛选重新查看。
18. FR-18: 首期实现必须是只读 Web 管理界面，不包含 TUI 只读视图，也不包含编辑计划、重排任务、改写讨论、重新指派 Agent 等能力。
19. FR-19: 聚合读取层必须复用现有 Swarm 和 SharedBoard 数据结构，不新增第二套业务真相源。
20. FR-20: `plan_summary`、`risk_summary`、`consensus_state` 等字段必须由聚合读模型稳定输出；不得依赖页面渲染时的临时 LLM 总结。
21. FR-21: 页面必须在数据不完整时提供明确降级展示和错误提示。
22. FR-22: 界面必须对管理员友好，默认减少日志噪音，强调摘要、关系和异常。

## Non-Goals

- 不提供管理员直接编辑 Conductor 计划的能力
- 不提供管理员直接修改任务拆分、依赖关系或任务内容的能力
- 不提供管理员直接改写讨论内容、伪造共识或手工补写 signal 的能力
- 不提供管理员直接重新分配 Agent 或强制 claim 任务的能力
- 不在本期实现永久物理清除所有历史记录的“硬删除”治理能力
- 不在本期实现跨项目统一大盘或组织级汇总分析
- 不在本期实现复杂告警系统、通知编排或自动升级策略编辑器
- 不在本期实现 TUI 管理界面；首期只交付 Web 管理 UI

## Design Considerations

- 信息层级必须符合用户优先级：先看 Conductor，再看任务、Agent、讨论细节
- 默认视图应突出“计划是什么”“现在卡在哪”“谁负责”“是否达成一致”四个问题
- 讨论区应采用“摘要在前，原文折叠”的展示方式，减少长文本干扰
- 对 blocked、failed、conflict、no consensus 使用统一且显眼的状态样式
- 推荐使用总览页 + 详情页结构，而不是把全部信息挤在单个页面
- 详情页内部可采用标签页或分栏，但首屏必须能看到 Conductor 摘要和关键风险
- 删除和停止按钮必须放在明显但有保护的位置，避免误触

## Technical Considerations

- 优先复用现有 `Swarm.status()`、`Swarm.list()`、`SharedBoard.snapshot()`、`Discussion.status()`、`Discussion.tally()`、signals、artifacts 数据
- 增加一层面向 UI 的聚合读模型，而不是让前端直接拼装底层 JSON 文件结构
- 聚合读模型需要把 Conductor 最近动作、任务摘要、争议点摘要、共识状态整理为稳定字段，降低前端复杂度
- 需要明确 stopped 和 deleted 的状态流转，并与现有 Swarm 生命周期兼容
- 删除能力建议首期采用安全删除语义：从默认列表移除，避免破坏审计和底层会话记录
- 需要兼容实时更新，优先复用 Bus 或现有会话状态更新机制
- UI 应遵循现有 Web 界面的渐进披露和实时同步模式，避免引入风格割裂的新控制台
- `Delete Swarm` 首期定义为安全删除：写入 `deleted_at` 或等价标记，使其默认不出现在列表中，但底层 board、artifacts、signals、discussion 记录仍保留，必要时可通过 `include_deleted` 或等价筛选查看
- 首期只实现 Web 管理 UI；TUI 仅保留后续扩展空间，不纳入当前交付范围
- `plan_summary` 和 `risk_summary` 采用确定性聚合策略：优先读取 Conductor 产生的 decision/summary/proposal artifact；若缺失，则从任务图、recent signals、discussion tally 中按固定规则生成摘要字段，不在页面渲染时临时调用 LLM
- 总览页增加 `Needs Attention` 筛选，命中条件至少包括：存在 blocked task、failed task、stale worker、或 discussion 状态为 no consensus

## Success Metrics

- 90% 的管理员测试者可以在 30 秒内定位一个 blocked 或 failed 任务以及对应负责人
- 90% 的管理员测试者可以在 1 分钟内说清楚某个 Swarm 的目标、当前阶段、关键任务、主要争议点和最终结论
- 在管理员回访中，关于“这个 Swarm 现在在做什么”的手动追问次数明显下降
- 在已结束的 discussion 中，管理员无需展开原文即可从摘要判断是否达成一致的比例达到 80% 以上

## Resolved Decisions

- `Delete Swarm` 在首期采用安全删除语义：从默认列表隐藏，但保留底层执行记录和审计数据，不做物理硬删除
- 首期只交付 Web 管理 UI，不包含 TUI 只读视图；后续若需要，可基于同一聚合读模型再补 TUI
- Conductor 计划摘要不是假设“天然已有完整结构化字段”，而是明确由聚合读模型生成：优先使用已有 artifact，缺失时从 tasks、signals、discussion 状态中按固定规则推导
- 总览页必须提供 `Needs Attention` 筛选，用于快速聚焦 blocked、failed、stale、no consensus 等需要人工关注的 Swarm
