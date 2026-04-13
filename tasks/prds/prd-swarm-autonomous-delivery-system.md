# PRD: Swarm Autonomous Delivery System

## Introduction

本 PRD 定义一个基于 Swarm 的自治软件交付系统，目标不是只做任务编排内核，而是交付一个可持续运行、可恢复、可审计、可逐步放量的完整交付体系。

系统以 Conductor + 多角色 Worker 为核心，通过共享状态、结构化共识、强约束的小 MR 循环、阶段门禁、失败恢复、回顾与记忆提取来完成从需求拆解到验证提交的端到端交付。

完整愿景包含自动规划、任务分派、代码实施、验证、提交、升级确认、回顾优化与后续执行记忆沉淀。

本 PRD 同时定义当前交付范围与后续阶段路线，确保实现路径清晰且每一步都能独立落地。

## Goals

- 构建一个可在仓库内执行真实开发任务的自治交付系统，而不是单次演示型多 Agent 编排
- 让系统能从目标输入开始，自主完成规划、分工、实施、验证、提交和回顾
- 将用户确认收敛到少数高风险的人机边界，仅在重大角色分配变更时强制确认
- 将“小 MR、独立验证、独立提交”作为故事级硬规则，降低回归风险和上下文漂移
- 让系统具备明确的权威状态对象、恢复机制、开放问题处理规则和可追踪的执行历史
- 通过分阶段发布，在不破坏现有工作流的前提下逐步走向完整自治交付

## User Stories

### US-001: 定义 Swarm 交付实体与权威状态

**Description:** As a developer, I want explicit authoritative state objects for swarm delivery so that every agent and UI reads the same source of truth.

**Acceptance Criteria:**

- [ ] 新增 `SwarmRun` 权威状态对象，至少包含 `id`、`goal`、`status`、`phase`、`created_at`、`updated_at`、`owner_session_id`
- [ ] 新增 `RoleSpec` 权威状态对象，至少包含 `role_id`、`name`、`responsibility`、`skills`、`limits`、`approval_required`
- [ ] 新增 `WorkItem` 权威状态对象，至少包含 `id`、`title`、`status`、`owner_role_id`、`blocked_by`、`scope`、`phase_gate`、`verification`
- [ ] 新增 `Decision` 权威状态对象，至少包含 `id`、`kind`、`summary`、`source`、`status`、`requires_user_confirmation`、`applies_to`、`related_question_id`、`decided_by`、`decided_at`
- [ ] 新增 `OpenQuestion` 权威状态对象，至少包含 `id`、`title`、`context`、`options`、`recommended_option`、`status`、`deadline_policy`、`blocking`、`affects`、`related_decision_id`、`raised_by`
- [ ] 明确定义 `Decision.status` 状态集合，至少包含 `proposed`、`decided`、`superseded`、`cancelled`
- [ ] 明确定义 `OpenQuestion.status` 状态集合，至少包含 `open`、`waiting_user`、`answered`、`resolved`、`deferred`、`cancelled`
- [ ] `OpenQuestion` 负责表达未决歧义、信息缺口、确认请求与阻塞范围，本身不得直接回写业务对象最终状态
- [ ] `Decision` 负责表达权威结论与生效结果，凡是会改变 `RoleSpec`、`WorkItem`、`SwarmRun` 或阶段 gate 的结果，必须通过 `Decision` 落地
- [ ] 所有对象有明确持久化位置、schema 校验和状态迁移约束
- [ ] `SwarmRun`、`RoleSpec`、`WorkItem`、`Decision`、`OpenQuestion` 以 SQLite 作为单一事实源持久化，SharedBoard、UI 视图或缓存对象只能作为投影，不得成为权威写入源
- [ ] 所有读写入口统一通过一组共享模块完成，禁止多个模块各自定义同名状态
- [ ] Typecheck passes

### US-002: 建立启动、规划与阶段门禁主循环

**Description:** As a user, I want one launch flow that turns a delivery goal into a gated execution plan so that the system can run autonomously with predictable checkpoints.

**Acceptance Criteria:**

- [ ] 提供从高层目标创建 `SwarmRun` 的启动入口
- [ ] 启动后系统生成阶段化执行计划，至少覆盖 `plan`、`implement`、`verify`、`commit`、`retrospective`
- [ ] 每个阶段必须定义进入条件、退出条件和失败回退动作
- [ ] 任一阶段未达成 gate 时，系统不得自动进入下一阶段
- [ ] gate 结果写回 `SwarmRun` 与相关 `WorkItem`，可供后续恢复与审计
- [ ] 规划阶段生成的任务必须显式标注 owner role、scope、依赖和预期验证方式
- [ ] Typecheck passes

### US-003: 建立角色分派与重大变更确认规则

**Description:** As a user, I want the system to change role assignments autonomously for normal work but require confirmation for major assignment changes so that control stays focused on meaningful boundaries.

**Acceptance Criteria:**

- [ ] 系统支持按 `RoleSpec` 将 `WorkItem` 分配给具体角色
- [ ] 以下变更必须进入用户确认：新增角色、删除角色、修改角色职责、跨角色重新分配任务 owner
- [ ] 其他普通执行内分派调整不需要用户确认
- [ ] 触发确认时生成 `OpenQuestion`，明确展示变更前后状态、原因、推荐选项与影响范围
- [ ] 未获得确认前，相关重大分派变更不得生效
- [ ] 确认结果写入 `Decision` 并回填到受影响的 `RoleSpec` 或 `WorkItem`
- [ ] Typecheck passes

### US-004: 建立共识模型与冲突裁决流程

**Description:** As a conductor, I want a concrete consensus model so that planning and delivery decisions can converge without vague agent chatter.

**Acceptance Criteria:**

- [ ] 定义结构化共识流程，至少包含 `proposal`、`review`、`objection`、`decision` 四类动作
- [ ] 每个需要共识的事项必须先创建一个 `Decision(status=proposed)`，并记录事项范围、候选结论、参与角色与关联对象
- [ ] `proposal`、`review`、`objection` 必须可追溯到同一个 `Decision`，禁止仅存在于自由文本消息中
- [ ] 当多个角色意见一致且信息充分时，系统自动将对应 `Decision` 更新为 `decided`，并记录通过原因
- [ ] 当存在冲突但未触发用户确认边界且信息充分时，由 Conductor 裁决并将 `Decision` 更新为 `decided`，同时记录理由
- [ ] 当冲突源于信息缺失、范围不清或需要外部输入时，系统必须创建或关联 `OpenQuestion`，并保持 `Decision` 为 `proposed`，直到问题被解决、取消或降级
- [ ] 当冲突触发重大角色分派变更边界时，系统必须将关联 `OpenQuestion` 置为 `waiting_user`，未获得结果前不得让对应 `Decision` 生效
- [ ] `OpenQuestion` 被解决后，系统必须回写关联 `Decision` 为 `decided`、`cancelled` 或 `superseded`，并同步更新受影响对象
- [ ] 决策结果必须可追溯到输入上下文、参与角色、关联 `OpenQuestion` 和最终理由
- [ ] Typecheck passes

### US-005: 建立开放问题处理机制

**Description:** As a worker, I want unresolved ambiguities captured as first-class open questions so that execution does not silently guess on decisions that should stay visible.

**Acceptance Criteria:**

- [ ] 实现 `OpenQuestion` 的创建、读取、更新与关闭流程
- [ ] 每个开放问题必须包含背景、阻塞影响、可选项、推荐项、默认超时策略、受影响对象和 `related_decision_id`
- [ ] 明确 `OpenQuestion` 生命周期，至少支持 `open -> waiting_user -> answered -> resolved`、`open -> deferred`、`open|waiting_user -> cancelled`
- [ ] 非阻塞问题可被标记为 `deferred`，不中断当前安全执行，但必须在下一相关 gate 计算前被重新检查
- [ ] 阻塞问题会暂停受影响的 `WorkItem`，直到问题被解决、取消或被明确降级为非阻塞
- [ ] 系统禁止将开放问题直接埋入自由文本日志而不入状态对象
- [ ] `OpenQuestion` 不得直接修改 `RoleSpec`、`WorkItem`、`SwarmRun`；任何需要生效的结论都必须通过关联 `Decision` 写回
- [ ] 问题关闭时必须关联一个最终 `Decision`，或明确记录“无需决策即关闭”的原因，并回写影响的 `WorkItem`、`Decision` 或 `SwarmRun`
- [ ] 关闭或降级问题后必须触发受影响 gate 的重新计算
- [ ] Typecheck passes

### US-006: 建立小 MR 交付循环与提交策略

**Description:** As a developer, I want each story-sized change to follow a strict small-MR loop so that every feature point is independently verified and committed.

**Acceptance Criteria:**

- [ ] 系统将“每个 story 或 feature point 必须独立验证并独立提交”作为硬规则执行
- [ ] 在 `WorkItem` 上显式记录 `small_mr_required=true`
- [ ] 任一 `WorkItem` 在进入 `commit` 阶段前必须已有通过的验证记录
- [ ] 系统禁止把多个未独立验证的故事合并成一次提交
- [ ] 每次提交必须关联唯一的 `WorkItem` 或单一 feature point
- [ ] 提交策略文档化为可执行规则，至少覆盖暂存范围、提交前验证、提交后状态回写
- [ ] P1 的 `commit` 阶段完成定义为本地 `git commit` 成功且结构化审计已回写；自动创建 PR/MR 不属于 P1 范围
- [ ] Typecheck passes

### US-007: 建立验证与恢复机制

**Description:** As a user, I want the system to recover from failed or interrupted execution without losing authoritative progress so that long autonomous runs stay practical.

**Acceptance Criteria:**

- [ ] 为 `WorkItem` 提供 checkpoint 机制，至少记录最近成功阶段、验证结果、已产出文件和未完成动作
- [ ] 当 agent 中断、超时、失败或被取消时，系统能基于 checkpoint 恢复而不是从头开始
- [ ] 恢复时必须重新加载权威状态对象，而不是仅依赖会话记忆
- [ ] 如果恢复后发现状态不一致，系统应暂停并生成 `OpenQuestion` 或 `Decision` 供处理
- [ ] 验证失败不会直接清空 `WorkItem` 进度，而是保留失败证据与回滚建议
- [ ] 验证失败后默认保留失败现场与工作树改动，系统不得自动执行 reset、checkout 覆盖或其他破坏性清理；如需清理，必须通过显式 `Decision` 记录理由与范围
- [ ] 至少覆盖规划中断、实施失败、验证失败、提交前中断四类恢复场景
- [ ] Typecheck passes

### US-008: 建立回顾与记忆提取流程

**Description:** As a conductor, I want every completed delivery loop to end with retrospective and memory extraction so that later runs improve from durable lessons.

**Acceptance Criteria:**

- [ ] `SwarmRun` 完成或失败后自动进入 `retrospective` 阶段
- [ ] 回顾至少产出：完成情况、失败点、升级点、角色协作问题、可复用经验
- [ ] 记忆提取只沉淀 durable point，不复制整段执行日志
- [ ] 提取结果按明确类别写入 memory 系统，避免无边界堆积
- [ ] 回顾结论必须可追溯到对应 `WorkItem`、`Decision` 和验证结果
- [ ] 回顾完成后，`SwarmRun` 才可标记为最终完成
- [ ] Typecheck passes

### US-009: 建立审计日志与恢复入口

**Description:** As an operator, I want to inspect the full autonomous delivery run and resume it from system state so that debugging and trust are possible.

**Acceptance Criteria:**

- [ ] 系统为每个 `SwarmRun` 保存结构化审计记录，不只保存自然语言摘要
- [ ] 审计记录至少覆盖阶段推进、角色分派、决策结果、开放问题、验证结果与提交记录
- [ ] 提供恢复入口，可从现有 `SwarmRun` 重建执行上下文
- [ ] 恢复入口能识别已完成与未完成的 `WorkItem`
- [ ] 恢复后不重复已标记完成且已验证通过的独立故事提交
- [ ] Typecheck passes

### US-010: 建立可视化与操作入口

**Description:** As a user, I want a UI to inspect swarm runs, answer confirmation requests, and monitor phase gates so that autonomous delivery remains understandable.

**Acceptance Criteria:**

- [ ] 提供查看 `SwarmRun`、`WorkItem`、`Decision`、`OpenQuestion` 状态的 UI 入口
- [ ] UI 明确显示当前阶段、阶段 gate 结果、阻塞项与待确认事项
- [ ] UI 支持处理重大角色分派变更确认
- [ ] UI 支持查看每个独立小 MR 的验证与提交结果
- [ ] UI 不直接绕过权威状态对象写入业务数据
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

## Functional Requirements

- FR-1: 系统必须以完整自治交付为目标，覆盖规划、实施、验证、提交、回顾，而不是只实现任务拆分
- FR-2: 系统必须有明确的权威状态对象，所有关键状态都可被持久化、恢复和审计
- FR-3: 系统必须支持多角色协作，并对重大角色分派变更执行强制用户确认
- FR-4: 系统必须定义清晰的共识模型与冲突裁决流程，避免自由文本式隐式决策
- FR-5: 系统必须将开放问题作为一等对象管理，不能让关键歧义隐式消失
- FR-6: 系统必须将“小 MR、独立验证、独立提交”作为故事级硬约束
- FR-7: 每个故事在完成前必须至少通过 `typecheck`，如涉及额外验证也要记录到 `verification`
- FR-8: 系统必须支持 checkpoint 与恢复，且恢复依赖权威状态而不是仅依赖会话内容
- FR-9: 系统必须在完成或失败后执行 retrospective 与 memory extraction
- FR-10: 系统必须保留结构化审计日志，支持后续分析与重放
- FR-11: 系统必须区分当前阶段可交付范围与未来阶段目标，避免一次性引入过多复杂度
- FR-12: UI 仅作为状态观察与确认入口，不改变核心执行规则
- FR-13: 所有从“未决歧义”到“已生效结论”的状态变化，必须显式经过 `OpenQuestion` 与 `Decision` 的关联链路，禁止直接从自由文本或临时内存回写业务对象
- FR-14: 阶段 gate 与恢复逻辑必须基于最新有效 `Decision` 和未解决 `OpenQuestion` 计算，checkpoint 与会话历史不得覆盖权威状态

## Non-Goals

- 不在首个阶段实现跨机器分布式执行
- 不在首个阶段实现自动发布到生产环境或外部部署编排
- 不在 P1 自动创建 PR/MR 或执行远程合并流程
- 不让系统在无验证记录时自动提交代码
- 不允许以“提高吞吐”为由跳过小 MR 规则
- 不把所有 agent 输出都沉淀为 memory，避免噪音记忆
- 不在当前范围内解决任意规模组织级排班、预算或权限审批系统

## Design Considerations

### 权威状态模型

系统必须把 `SwarmRun`、`RoleSpec`、`WorkItem`、`Decision`、`OpenQuestion` 作为权威状态对象。

所有流程推进、恢复、UI 展示和回顾提取都应优先读取这些对象，而不是从松散日志中二次推断。

这些对象统一以 SQLite 作为单一事实源持久化。SharedBoard、会话缓存和 UI 只负责读取或派生投影视图，不能绕过共享模块直接写成最终状态。

### 共识与裁决模型

共识流程采用结构化动作流：角色提交提案，其他角色评审并提出异议，Conductor 在规则边界内裁决或升级到用户确认。

系统不追求“所有角色都说服所有角色”，而是追求可记录、可追溯、可推进的决定。

### 开放问题处理

开放问题必须区分阻塞与非阻塞。

阻塞问题暂停受影响工作，非阻塞问题可延后，但必须保留到明确状态对象中并在后续 gate 前被重新检查。

### OpenQuestion 与 Decision 边界

`OpenQuestion` 只表示尚未解决的不确定性、确认请求或信息缺口，负责暴露阻塞范围、候选项和待答复对象。它可以暂停或延后工作，但不能直接让业务状态生效。

`Decision` 只表示已形成的权威结论，负责记录最终理由、生效范围和回写目标。任何会改变 `RoleSpec`、`WorkItem`、`SwarmRun` 或阶段 gate 结果的结论，都必须通过 `Decision` 生效。

### OpenQuestion 与 Decision 生命周期

默认流程为：识别歧义后创建 `OpenQuestion`，并为待裁事项创建或关联 `Decision(status=proposed)`。问题被回答、超时降级或被取消后，系统再将对应 `Decision` 更新为 `decided`、`cancelled` 或 `superseded`。

阻塞型 `OpenQuestion` 会冻结受影响 `WorkItem` 和相关 gate，非阻塞型 `OpenQuestion` 允许继续执行但必须在下一相关 gate 前重检。同一待裁事项在同一时刻只应有一个活跃 `OpenQuestion` 作为未决入口。

### 小 MR 与提交策略

每个故事或 feature point 都要形成独立的实现、独立的验证、独立的提交。

这不是推荐项，而是系统级策略；任何打包多个未独立验证故事的行为都视为流程违规。

P1 的提交边界只到本地 `git commit` 与审计回写，不自动创建 PR/MR。后续阶段若要引入远程协作对象，应作为独立范围扩展并补充新的 gate。

P1 默认对单一故事采用单线程执行到提交完成，不支持“同一故事内多个并行子任务后再汇总为单提交”的模式。若后续阶段要引入受控并行，必须额外定义并行资格、收敛条件、冲突处理和恢复规则。

如果一次实现自然波及多个故事，系统必须先拆成多个可独立验证的 `WorkItem`。同一角色内、且不改变 owner 的结构性拆分可自动执行；一旦拆分导致跨角色 owner 变化，必须走重大分派变更确认流程。

### 回顾与记忆提取

回顾不是附加日志，而是正式阶段。

记忆提取只保留后续执行真正可复用的 durable point，比如分派规则、失败模式、恢复经验和验证策略。

默认情况下，durable memory 在回顾完成后直接写入现有 memory 体系，不额外要求人工逐条审核。但系统必须先通过准入规则过滤，只允许写入可跨 run 复用、可关联结构化对象且不依赖临时上下文的内容。涉及 architecture、security 或其他高影响策略变更时，必须升级为人工确认。

## Technical Considerations

### 阶段发布计划

#### P0: 状态与门禁基础

目标是让系统具备最小可恢复的自治骨架。

范围包括权威状态对象、阶段门禁主循环、开放问题对象和审计日志基础。

**Phase gate:**

- [ ] 能创建并持久化 `SwarmRun`、`RoleSpec`、`WorkItem`、`Decision`、`OpenQuestion`
- [ ] 能从目标生成带 gate 的执行计划
- [ ] 能在中断后从状态对象恢复到正确阶段
- [ ] `typecheck` 通过

#### P1: 自治执行与小 MR 闭环

目标是让系统能完成真实的单故事自治交付闭环。

范围包括角色分派规则、重大分派确认、共识流程、小 MR 提交策略、checkpoint 恢复和回顾提取。

**Phase gate:**

- [ ] 至少一个故事能完成 plan -> implement -> verify -> commit -> retrospective 全链路
- [ ] 重大角色分派变更会进入用户确认
- [ ] 每个故事提交前都有独立验证记录
- [ ] 每个故事能独立提交，且不会与其他未验证故事混提
- [ ] `typecheck` 通过

#### P2: 可视化与操作面板

目标是提升可观察性和可控性，而不改变核心自治规则。

范围包括独立的 `SwarmRun` 页面、待确认列表、阶段 gate 展示和小 MR 结果查看。入口层可复用现有 session 导航，但详情视图不复用 session 页面主体。

**Phase gate:**

- [ ] UI 能展示当前阶段、阻塞项、待确认项与提交记录
- [ ] UI 能处理重大角色分派确认
- [ ] UI 展示的数据全部来自权威状态对象
- [ ] `typecheck` 通过
- [ ] Verify in browser using dev-browser skill

#### P3: 学习优化与多轮连续交付

目标是让系统从一次性自治执行进化到连续优化型自治交付。

范围包括记忆提取优化、回顾质量提升、策略调优和多轮 run 间经验复用。

**Phase gate:**

- [ ] 回顾能稳定提炼 durable point 而不是噪音摘要
- [ ] 后续 run 可读取前次提取的有效经验并改进分派或恢复决策
- [ ] 连续多轮运行后审计与恢复仍然稳定
- [ ] `typecheck` 通过

### 恢复策略

恢复必须优先依赖权威状态对象与 checkpoint，而不是拼接历史对话。

若恢复时发现状态缺失、阶段不一致或提交记录不匹配，系统必须停在安全边界并生成 `OpenQuestion` 或 `Decision`。

验证失败后默认保留失败现场、失败证据和当前工作树改动，供后续修复、审计和恢复使用。系统不得为追求“干净状态”而自动执行破坏性清理；若必须清理，只能在显式 `Decision` 生效后按范围执行。

### 提交策略

提交只发生在单一故事或单一 feature point 通过独立验证后。

如果某次实现改动波及多个故事，系统必须拆分为多个可独立验证的 `WorkItem`，而不是合并提交。

### 回顾与 memory extraction 技术边界

回顾结果需要关联结构化对象 ID，防止后续无法追溯来源。

memory extraction 应调用现有 memory 机制，只保存 durable point，不存临时日志或可从审计中直接重建的信息。

### Gate 计算与恢复优先级

阶段 gate 必须直接基于权威状态对象计算，而不是从自由文本日志或会话历史推断。计算时优先采用最新的有效 `Decision(status=decided)`，忽略 `superseded` 和 `cancelled` 的历史结论。

若存在关联的阻塞型 `OpenQuestion(status in [open, waiting_user, answered])`，对应 gate 必须判定为未通过或 `blocked`。若仅存在 `deferred` 的非阻塞问题，系统可继续当前阶段，但必须在下一相关 gate 前重新检查该问题是否仍可延后。

恢复时必须先重放最新有效 `Decision`，再检查未解决的 `OpenQuestion`，最后结合 `WorkItem` 与 checkpoint 推导恢复位置。checkpoint 只作为性能优化和执行提示，不能覆盖 `Decision` 或 `OpenQuestion` 的权威状态。

如果 checkpoint 与有效 `Decision`、活跃 `OpenQuestion` 或当前对象关系不一致，系统必须以权威状态对象为准，并将 checkpoint 视为过期。若恢复时发现一个事项存在多个活跃问题、多个互斥有效决策或缺少关联关系，系统必须停在安全边界并生成新的 `OpenQuestion` 或 `Decision` 供处理。

## Success Metrics

- 90% 以上的故事级交付能走完 plan -> implement -> verify -> commit -> retrospective 全链路
- 100% 的故事提交都有独立验证记录，且包含 `typecheck`
- 100% 的重大角色分派变更都通过显式用户确认处理
- 系统在中断后能恢复未完成 run，且不会重复已完成的小 MR 提交
- 回顾阶段能为后续 run 提供可复用的 durable memory，且人工抽检认为有效率达到 80% 以上
- UI 上能在 30 秒内定位当前阶段、阻塞项和待确认问题

## Open Questions

引入 `OpenQuestion` 与 `Decision` 的明确边界后，状态职责、生命周期和生效路径，以及当前阶段的产品范围均已收敛。当前版本无新增产品级 open question；后续若引入故事内受控并行、memory 审核分级细化或 UI 信息架构扩展，应以新的阶段范围决策单独评估。
