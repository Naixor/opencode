# PRD: Swarm State Machine

## Introduction

当前 `opencode` 已有 Swarm、SharedBoard、Discussion、Admin UI 和 SSE 能力，但状态定义分散在多个模块中：`Swarm.Info.status`、`SwarmAdmin.Status`、`WorkerStatus`、`BoardTask.Status`、Discussion round 状态和 UI 推导状态并不完全一致。

这会导致异常状态难以识别和修复，例如 Worker 已空闲但任务仍是 `in_progress`、Swarm 进入 `completed` 但 verify 未执行、Discussion 已结束但任务未收敛、Admin UI 显示 `blocked` 但底层 Swarm 仍是 `running`。本 PRD 定义一套完整的 Swarm 状态机，作为 Swarm 生命周期、Worker 生命周期、BoardTask 链接规则、讨论流程、验证流程、SSE 事件语义、自动修复和兼容迁移的统一真相源，避免系统进入不可解释或不可恢复的状态。

本 PRD 基于已确认的全范围决策编写，按最强约束落地：状态机覆盖顶层 Swarm、Worker、BoardTask、Discussion、Verify、Admin/UI/SSE、自动 repair 与 inspection、兼容迁移和验收指标。

## Goals

- 为 Swarm 建立唯一且可验证的状态机模型，消除模块间状态分叉
- 明确 Swarm、Worker、BoardTask、Discussion、Verify 的合法状态和合法迁移
- 让 SSE、Admin UI、Web UI、TUI 基于同一状态语义展示，而不是各自推导
- 让系统在检测到异常状态时优先自动修复，并给出可审计的 repair 记录
- 为已有 Swarm 数据提供向前兼容读取和渐进迁移方案
- 为后续多 Worker 协作、Discussion、Admin 观测和 verify gate 提供稳定基础

## User Stories

### US-001: 定义顶层状态枚举

**Description:** As a developer, I want one canonical Swarm state enum so that every module reads the same top-level lifecycle.

**Acceptance Criteria:**

- [ ] 新增统一 `SwarmState` 枚举，至少包含 `planning`、`dispatching`、`running`、`discussing`、`verifying`、`repairing`、`paused`、`blocked`、`completed`、`failed`、`stopped`、`deleted`
- [ ] `packages/opencode/src/session/swarm.ts` 不再使用独立的简化状态集合
- [ ] `packages/opencode/src/session/swarm-admin.ts` 直接复用 canonical 状态定义或由其映射生成
- [ ] 所有状态都有文字定义、进入条件和退出条件
- [ ] Typecheck passes

### US-002: 定义 Swarm 合法迁移表

**Description:** As a developer, I want explicit allowed transitions so that invalid status jumps are rejected deterministically.

**Acceptance Criteria:**

- [ ] 提供 `SwarmStateMachine.canTransition(from, to, ctx)` 能力
- [ ] 提供状态迁移表，禁止 `planning -> completed`、`running -> deleted`、`completed -> running` 等非法跳转
- [ ] `paused` 只允许恢复到进入前的活跃态或进入 `stopped`
- [ ] `deleted` 为终态，不允许再迁移
- [ ] 非法迁移会返回结构化错误，包含 `from`、`to`、`reason`
- [ ] Typecheck passes

### US-003: 定义 Worker 状态枚举

**Description:** As a developer, I want one worker state model so that session runtime, BoardTask and admin views stay in sync.

**Acceptance Criteria:**

- [ ] 新增统一 `WorkerState` 枚举，至少包含 `queued`、`starting`、`running`、`waiting`、`blocked`、`verifying`、`done`、`failed`、`cancelled`、`stopped`
- [ ] 现有 `active`、`idle`、`done`、`failed` 语义被映射到新模型
- [ ] Worker 状态定义明确区分“无输出等待中”和“真正阻塞”
- [ ] 每个 Worker 状态都定义允许的前置状态
- [ ] Typecheck passes

### US-004: 关联 Worker 与 BoardTask

**Description:** As a developer, I want worker state changes to update linked board tasks so that ownership and execution progress are consistent.

**Acceptance Criteria:**

- [ ] Worker 必须绑定 `swarm_id` 和 `task_id`
- [ ] Worker 进入 `running` 时，关联 `BoardTask.status` 自动变为 `in_progress`
- [ ] Worker 进入 `done` 时，关联 `BoardTask.status` 自动变为 `completed`，除非 verify gate 未通过
- [ ] Worker 进入 `blocked` 或 `failed` 时，关联任务不能保持 `pending`
- [ ] 如果一个 task 被重新分配，新 Worker 接管前旧 Worker 必须进入终止态
- [ ] Typecheck passes

### US-005: 增加 BoardTask 扩展状态

**Description:** As a developer, I want board tasks to represent execution and verify phases more precisely so that swarm progress is observable.

**Acceptance Criteria:**

- [ ] `BoardTask.Status` 扩展为至少包含 `pending`、`ready`、`in_progress`、`blocked`、`verifying`、`completed`、`failed`、`cancelled`
- [ ] `ready` 表示依赖已满足但尚未分配
- [ ] `verifying` 表示任务代码工作已完成但验证未完成
- [ ] `blocked` 表示存在明确外部阻塞原因，不再由 UI 侧猜测
- [ ] 现有 `pending` 数据在读取时可兼容映射到 `pending` 或 `ready`
- [ ] Typecheck passes

### US-006: 定义任务依赖收敛规则

**Description:** As a conductor, I want task readiness to be computed deterministically so that dispatching never picks illegal work.

**Acceptance Criteria:**

- [ ] `BoardTask.ready()` 仅返回 `status in [pending, ready]` 且全部依赖为 `completed`
- [ ] 任务一旦存在未完成依赖，不允许进入 `in_progress`
- [ ] 被取消的依赖会阻止下游任务自动变为 `ready`
- [ ] 失败依赖会让下游任务进入显式 `blocked` 或等待 repair 决策
- [ ] Typecheck passes

### US-007: 定义 Discussion 状态机

**Description:** As a developer, I want discussion to have a first-class lifecycle so that round progression and closure are predictable.

**Acceptance Criteria:**

- [ ] 新增 `DiscussionState`，至少包含 `idle`、`collecting`、`round_complete`、`consensus_ready`、`decided`、`exhausted`、`failed`
- [ ] 每个 discussion channel 记录 `current_round`、`max_rounds`、`state`
- [ ] `advance_round` 只能从 `round_complete` 进入下一轮 `collecting`
- [ ] 最后一轮完成且有共识信号后可进入 `consensus_ready`
- [ ] 达到 `max_rounds` 且未完成决议时进入 `exhausted`
- [ ] Typecheck passes

### US-008: 链接 Discussion 与 Swarm 顶层状态

**Description:** As a developer, I want swarm top-level state to reflect active discussions so that UI and automation understand why execution paused.

**Acceptance Criteria:**

- [ ] 任一活跃 `DiscussionState=collecting` 时，Swarm 顶层可进入 `discussing`
- [ ] `discussing` 不要求所有 Worker 停止，但要求 Conductor 当前主控逻辑等待讨论结果
- [ ] Discussion 进入 `decided` 后，Swarm 可恢复到 `dispatching` 或 `running`
- [ ] Discussion `failed` 或 `exhausted` 会触发 repair/escalation 判定
- [ ] Typecheck passes

### US-009: 引入 verify gate

**Description:** As a developer, I want a dedicated verify stage so that swarm completion means verified completion, not just worker quietness.

**Acceptance Criteria:**

- [ ] 当所有可执行任务进入工作完成态后，Swarm 必须进入 `verifying`
- [ ] verify 可产出 `pass`、`fail`、`partial` 三类结果
- [ ] verify `pass` 后 Swarm 才能进入 `completed`
- [ ] verify `fail` 时 Swarm 必须进入 `repairing` 或 `failed`
- [ ] verify 结果必须持久化为 artifact 或等价记录
- [ ] Typecheck passes

### US-010: 定义 repair 流程

**Description:** As a conductor, I want failed verification or stale execution to enter a formal repair flow so that the system can recover automatically.

**Acceptance Criteria:**

- [ ] 新增 `repairing` 顶层状态
- [ ] verify 失败、worker stale、task linkage 不一致都可触发 repair
- [ ] repair 会创建结构化 inspection 结果，至少包含问题类型、受影响实体、建议动作
- [ ] repair 可以执行 `retry_task`、`replace_worker`、`reopen_task`、`ask_human`
- [ ] 超过最大 repair 次数后，Swarm 进入 `failed`
- [ ] Typecheck passes

### US-011: 增加 inspection 读模型

**Description:** As an administrator, I want anomaly inspection output so that I can understand why the swarm is unhealthy.

**Acceptance Criteria:**

- [ ] 提供 `inspect` 读模型，列出状态不一致、孤儿 worker、孤儿 task、卡死 discussion、verify 未收敛等异常
- [ ] 每条 inspection 都包含 `severity`、`kind`、`summary`、`suggested_action`
- [ ] inspection 可被 Admin UI 和 API 直接消费
- [ ] 当无异常时，inspection 返回空数组而不是报错
- [ ] Typecheck passes

### US-012: 统一 SSE 事件语义

**Description:** As a frontend developer, I want normalized swarm events so that UI does not infer state by stitching raw signals.

**Acceptance Criteria:**

- [ ] SSE 事件新增统一 envelope，至少包含 `entity_type`、`entity_id`、`prev_state`、`next_state`、`reason`、`timestamp`
- [ ] 状态迁移事件与普通 activity 信号分开命名
- [ ] UI 可仅根据状态事件重建当前页面状态
- [ ] Discussion round 完成、verify 开始、repair 开始必须有独立事件
- [ ] 向后兼容保留旧事件流至少一个版本窗口
- [ ] Typecheck passes

### US-013: 提供 Admin 聚合状态模型

**Description:** As an administrator, I want admin pages to render from one aggregated state model so that blocked and failed semantics are stable.

**Acceptance Criteria:**

- [ ] `SwarmAdmin` 聚合结果直接消费 canonical state machine 输出
- [ ] `current_phase` 不再用零散规则猜测，而是由状态机和 stage 数据共同产出
- [ ] 总览与详情使用同一 `status` 和 `attention` 判定逻辑
- [ ] `blocked`、`repairing`、`verifying`、`discussing` 在 UI 中都有独立展示
- [ ] Typecheck passes

### US-014: 展示 Web 状态页

**Description:** As a user, I want the Web UI to show canonical swarm and worker states so that I can trust what the dashboard says.

**Acceptance Criteria:**

- [ ] Web Dashboard 显示顶层 Swarm 状态徽章，覆盖 `verifying`、`repairing`、`blocked`、`discussing`
- [ ] Worker 列表显示 canonical Worker 状态，不再只显示 `active/idle/done/failed`
- [ ] Task 列表显示 `ready`、`blocked`、`verifying` 等扩展状态
- [ ] 页面在收到 SSE 状态迁移事件后可无刷新更新
- [ ] Verify 或 repair 中的原因摘要在 UI 可见
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-015: 展示 Admin 控制台

**Description:** As an administrator, I want the admin console to explain abnormal states and repair actions so that I can audit swarm behavior.

**Acceptance Criteria:**

- [ ] Admin UI 可显示 inspection 列表
- [ ] Admin UI 可区分“逻辑阻塞”“等待输入”“验证中”“修复中”
- [ ] 异常卡片显示最近状态迁移、关联 task、关联 worker
- [ ] 已自动修复的异常显示 repair 结果和时间
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-016: 兼容旧数据读取

**Description:** As a developer, I want legacy swarm records to load safely so that existing users do not lose visibility after the new state machine ships.

**Acceptance Criteria:**

- [ ] 读取旧 `Swarm.Info.status` 时支持 `planning`、`running`、`paused`、`completed`、`failed` 映射
- [ ] 读取旧 `WorkerStatus` 时支持 `active`、`idle`、`done`、`failed` 映射
- [ ] 缺失 `stage`、`verify`、`inspection` 字段的数据可以按默认值降级
- [ ] 旧数据不会因缺少新字段而读取失败
- [ ] Typecheck passes

### US-017: 提供迁移脚本与回填

**Description:** As a developer, I want a deterministic migration path so that persisted board data can be upgraded incrementally.

**Acceptance Criteria:**

- [ ] 提供一次性 migration 或 lazy backfill 机制
- [ ] migration 会为 Swarm、Worker、BoardTask、Discussion 回填必要状态字段
- [ ] migration 支持 dry-run 输出统计
- [ ] migration 失败不会破坏原始文件，可回滚或重试
- [ ] Typecheck passes

### US-018: 增加状态机测试矩阵

**Description:** As a developer, I want transition and anomaly tests so that regressions are caught before release.

**Acceptance Criteria:**

- [ ] 覆盖顶层 Swarm 合法迁移和非法迁移
- [ ] 覆盖 Worker 与 BoardTask 链接规则
- [ ] 覆盖 Discussion round 生命周期
- [ ] 覆盖 verify fail -> repair -> completed/failed 分支
- [ ] 覆盖 legacy 数据兼容读取
- [ ] Typecheck passes

## Functional Requirements

1. FR-1: 系统必须为 Swarm、Worker、BoardTask、Discussion、Verify 定义 canonical 状态枚举与状态迁移规则。
2. FR-2: 系统必须提供一个统一状态机模块，供 `swarm.ts`、`swarm-admin.ts`、server routes、SSE 和 UI 共用。
3. FR-3: `SwarmState` 至少支持 `planning`、`dispatching`、`running`、`discussing`、`verifying`、`repairing`、`paused`、`blocked`、`completed`、`failed`、`stopped`、`deleted`。
4. FR-4: `WorkerState` 至少支持 `queued`、`starting`、`running`、`waiting`、`blocked`、`verifying`、`done`、`failed`、`cancelled`、`stopped`。
5. FR-5: `BoardTask.Status` 至少支持 `pending`、`ready`、`in_progress`、`blocked`、`verifying`、`completed`、`failed`、`cancelled`。
6. FR-6: `DiscussionState` 至少支持 `idle`、`collecting`、`round_complete`、`consensus_ready`、`decided`、`exhausted`、`failed`。
7. FR-7: 系统必须拒绝非法状态迁移，并返回可读的结构化原因。
8. FR-8: Worker 的状态变更必须同步更新关联 BoardTask，除非当前动作为只读检查。
9. FR-9: BoardTask 的 `ready` 只允许在依赖全部 `completed` 时出现。
10. FR-10: 被阻塞、失败或取消的依赖不得让下游任务直接进入 `ready` 或 `in_progress`。
11. FR-11: Swarm 只有在所有必要任务完成且 verify `pass` 后才可进入 `completed`。
12. FR-12: verify 必须是显式阶段，而不是由“无运行中 worker”隐式推断。
13. FR-13: verify 失败时系统必须进入 `repairing` 或 `failed`，不得直接保持 `completed`。
14. FR-14: repair 必须产生 inspection 或等价审计记录。
15. FR-15: inspection 必须覆盖至少以下异常：孤儿 Worker、孤儿 Task、非法状态组合、Discussion 卡死、Verify 未结束、Task/Worker 失联。
16. FR-16: SSE 必须发布规范化状态迁移事件，且事件包含前后状态和原因。
17. FR-17: Web UI、Admin UI、TUI 的状态展示必须基于同一 canonical 状态或同一映射层。
18. FR-18: Admin `blocked`、`running`、`verifying`、`repairing`、`deleted` 语义必须由底层状态机稳定导出，不得只由 UI 猜测。
19. FR-19: Discussion 完成一轮后必须显式进入 `round_complete`，只有收到推进动作才进入下一轮。
20. FR-20: 最终轮结束且 Conductor 已产出决议后，Discussion 才能进入 `decided`。
21. FR-21: Discussion 达到最大轮次且没有决议时必须进入 `exhausted`，并触发 repair 或 escalation 评估。
22. FR-22: 系统必须保留旧 Swarm 和旧 Worker 状态值的读取兼容。
23. FR-23: 系统必须提供 migration 或 lazy upgrade 策略，把旧记录升级到新状态模型。
24. FR-24: 兼容期内旧 API 字段可以保留，但新读模型必须输出 canonical 状态。
25. FR-25: 成功、失败、停止、删除都必须是可审计终态，且 `deleted` 为不可逆终态。
26. FR-26: `paused` 必须可恢复到中断前的活跃阶段，而不是固定恢复为 `running`。
27. FR-27: 系统必须记录 Swarm 当前 `stage_reason` 或等价字段，用于解释为何处于该状态。
28. FR-28: 自动 repair 必须有最大次数、重试策略和升级边界。
29. FR-29: 对同一异常不得无限循环 repair；达到阈值后必须升级为 `failed` 或 `ask_human`。
30. FR-30: 所有状态机变更必须具备测试覆盖和类型检查覆盖。

## Non-Goals

- 不在本期引入跨机器分布式 Swarm 状态同步
- 不在本期实现任意自定义状态或用户定义状态图
- 不在本期重做 Session 核心循环或 LLM 推理框架
- 不在本期实现复杂工作流编排 DSL
- 不在本期让 UI 直接写底层状态文件
- 不在本期实现自动合并代码冲突或自动 git 恢复
- 不在本期改变已有 Swarm 的业务目标拆分策略，只聚焦状态一致性和恢复能力

## Design Considerations

- 状态名称要表达“系统正在做什么”，不是“UI 看起来像什么”。
- `running` 与 `dispatching`、`discussing`、`verifying`、`repairing` 必须分开，避免一个状态承载太多语义。
- `waiting` 与 `blocked` 必须区分，前者表示正常等待事件，后者表示存在异常或外部依赖。
- UI 默认展示 canonical 状态、最近迁移原因和下一步动作，减少管理员自行推断。
- Admin 总览里的 `Needs Attention` 应直接消费 inspection，而不是再次拼规则。
- 讨论视图中要明确展示“本轮收集中”“本轮完成待推进”“最终轮已耗尽”等状态，避免把 discussion 只当作 signal 列表。
- verify 与 repair 需要可视化时间线，帮助用户知道 Swarm 是否真的接近完成。

## Technical Considerations

- 建议新增独立模块，如 `packages/opencode/src/session/swarm-state.ts`，承载状态枚举、迁移规则、导出函数和兼容映射。
- 现有 `packages/opencode/src/session/swarm.ts`、`packages/opencode/src/session/swarm-admin.ts`、`packages/opencode/src/board/task.ts`、`packages/opencode/src/board/discussion.ts` 需要改为依赖该模块，而不是各自声明状态。
- 当前代码中 `Swarm.Info.status` 与 `SwarmAdmin.Status`、`WorkerStatus`、`BoardTask.Status` 已出现分叉，本期需要收口为单一真相源。
- 建议在 `Swarm.Info` 中增加 `stage`、`stage_reason`、`repair_count`、`verify`、`inspection` 等字段，避免 Admin 侧重复推导。
- 建议为 Worker 增加 `prev_state`、`task_id`、`last_event_at`、`blocked_reason` 等字段，减少 stale 和 blocked 判定歧义。
- 建议为 BoardTask 增加 `state_reason`、`verify_required`、`verify_result`、`reopened_from` 等字段，支持 repair 和 reopen。
- 建议为 Discussion tracker 增加 `state`、`decision_artifact_id`、`exhausted_at` 字段，避免通过 signal 反推生命周期。
- SSE 需要新增状态迁移事件类型，例如 `swarm.state_changed`、`worker.state_changed`、`task.state_changed`、`discussion.state_changed`、`verify.finished`、`repair.performed`。
- 兼容策略建议采用“两阶段”：
- 第 1 阶段：读取时兼容映射，写入双格式或新格式
- 第 2 阶段：提供 migration/backfill，把存量数据回填为新字段
- migration 应优先采用幂等设计，多次运行不应重复破坏数据。
- repair 引擎应只做有限自动动作，避免把状态机变成无限自愈循环。
- 测试应覆盖状态表单元测试、读取兼容测试、Board 链接集成测试、Discussion 生命周期集成测试和 verify/repair 分支测试。

## Success Metrics

- 100% 的 Swarm、Worker、BoardTask、Discussion 状态读取都能映射到 canonical 状态
- 非法状态迁移在测试中被全部拒绝，核心迁移表覆盖率达到 90% 以上
- 至少 95% 的 Admin/UI 状态展示来自 canonical 状态字段，而不是页面端推导
- 常见异常场景下，系统可自动修复或自动给出 inspection 结论，覆盖率达到 80% 以上
- verify gate 生效后，“Swarm 显示 completed 但实际未验证”的问题降为 0
- legacy 数据升级后，已有 Swarm 列表和详情页可正常打开，兼容回归为 0
- 管理员在 15 秒内可以判断一个异常 Swarm 是 `blocked`、`repairing`、`verifying` 还是 `failed`

## Open Questions

- verify 阶段首期是否统一由 Conductor 触发，还是允许特定 task type 自带 verify worker
- repair 的默认最大次数是否全局固定，还是按 task type 配置
- `paused` 恢复后是否必须回到精确的前一状态，还是允许统一回到 `dispatching`
- SSE 兼容窗口保留多久，才能安全移除旧事件格式
