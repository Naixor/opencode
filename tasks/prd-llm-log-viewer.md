# PRD: LLM Communication Log System & Web Viewer

## Introduction

OpenCode 当前缺乏对 LLM 通信细节的独立追踪能力。开发者在排查模型幻觉、优化 token 用量时，只能依赖分散的 session 数据和结构化日志，无法高效地回溯完整的请求/响应链路。

本功能设计一套独立的 LLM 通信日志系统，覆盖从 prompt 构建到 LLM 响应、tool call 执行、hook 处理的完整 agent loop，并提供一套 Web 查看系统和 CLI 入口，支持幻觉标注、token 用量分析与优化建议。

## Goals

- 完整记录每次 LLM 请求/响应的原始数据（system prompt、messages、completion、token 计数、cost）
- 记录 tool call 的输入输出，关联到对应的 LLM step
- 记录 hook 链处理过程（pre-llm / pre-tool / post-tool 的修改）
- 提供按 session / agent / model / provider 维度的 token 聚合统计与费用估算
- 提供 token 优化建议（识别过大 tool output、重复 context、cache 命中率等）
- 提供 Web 界面查看日志、分析 token、标注幻觉
- 提供 `opencode log-viewer` CLI 命令快速启动本地 Web 查看器
- 日志存储有上限控制，支持自动清理与数据库平滑升降级

## User Stories

### US-001: LLM 通信日志 Schema 与迁移

**Description:** As a developer, I need a database schema to store LLM communication logs so that all request/response data persists reliably.

**Acceptance Criteria:**
- [ ] 在现有 SQLite 数据库中新增以下表（通过 Drizzle migration）：
  - `llm_log` — 每次 LLM 调用的主记录（session_id, agent, model, provider, variant, request_id, time_start, time_end, duration_ms, status）
  - `llm_log_request` — 请求详情（llm_log_id FK, system_prompt BLOB gzip, messages BLOB gzip, tools JSON, options JSON）
  - `llm_log_response` — 响应详情（llm_log_id FK, completion_text, tool_calls JSON, raw_response BLOB gzip, error JSON）
  - `llm_log_tokens` — token 明细（llm_log_id FK, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total）
  - `llm_log_tool_call` — tool call 记录（llm_log_id FK, call_id, tool_name, input JSON, output JSON, title, duration_ms, status）
  - `llm_log_hook` — hook 处理记录（llm_log_id FK, hook_name, chain_type, priority, modified_fields JSON, duration_ms）
  - `llm_log_annotation` — 人工标注（llm_log_id FK, type: "hallucination"|"quality"|"note", content, marked_text, time_created）
- [ ] 所有表以 `llm_log_id` 为主外键，支持 CASCADE 删除
- [ ] migration 文件遵循现有 `packages/opencode/migration/` 目录格式
- [ ] 新表不影响现有表的查询性能（无交叉 FK）
- [ ] Typecheck 通过

### US-002: 日志存储上限与自动清理

**Description:** As a developer, I want log storage to have configurable size limits so that the database doesn't grow unboundedly.

**Acceptance Criteria:**
- [ ] 在 `opencode.json` config 中新增 `llmLog` 配置段：
  ```json
  {
    "llmLog": {
      "enabled": true,
      "max_records": 10000,
      "max_age_days": 30,
      "cleanup_interval_hours": 24
    }
  }
  ```
- [ ] 默认值：`max_records: 10000`，`max_age_days: 30`，`cleanup_interval_hours: 24`
- [ ] 清理策略：优先按 `max_age_days` 删除过期记录，再按 `max_records` 删除最旧记录
- [ ] 清理操作在后台执行，不阻塞主流程
- [ ] 带有 annotation 的记录受保护，不被自动清理（除非超过 `max_age_days` 的 2 倍）
- [ ] 清理时级联删除关联的子表记录
- [ ] Typecheck 通过

### US-003: LLM 通信日志采集 — Pre-LLM Hook

**Description:** As a developer, I want to capture the complete input context before each LLM call so I can analyze what was sent to the model.

**Acceptance Criteria:**
- [ ] 注册 `pre-llm` hook（名称 `llm-log-capture`，priority 999 即最后执行，确保捕获其他 hook 修改后的最终状态）
- [ ] 捕获并写入 `llm_log` + `llm_log_request`：
  - session_id, agent, model (id + provider), variant
  - system prompt（完整数组）
  - messages（序列化后的完整消息历史）
  - tools（可用工具列表，仅名称 + schema，不含 execute 函数）
  - provider options（temperature, topP, topK, maxOutputTokens 等）
- [ ] 生成唯一 `request_id` 并通过 hook context 传递，供后续 hook 关联
- [ ] 当 `llmLog.enabled = false` 时完全跳过，零开销
- [ ] Typecheck 通过

### US-004: LLM 通信日志采集 — 响应与 Token 记录

**Description:** As a developer, I want to capture the LLM response and token usage after each call so I can analyze output quality and costs.

**Acceptance Criteria:**
- [ ] 在 `processor.ts` 的 `finish-step` 事件处理完后，emit session-lifecycle 事件 `"step.finished"`，日志系统通过 session-lifecycle hook 监听并写入 `llm_log_response` + `llm_log_tokens`：
  - completion text（完整文本响应）
  - tool calls（名称 + 参数 + ID）
  - raw response metadata（finish reason、model version 等）
  - error 信息（如有）
  - token 明细：input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens
  - 费用计算：根据 `Provider.Model.cost` 逐项计算，处理 >200K context 特殊定价
- [ ] 更新 `llm_log` 主记录的 time_end、duration_ms、status（success/error/aborted）
- [ ] 对于 streaming 中断（abort），仍记录已接收的部分数据
- [ ] 日志写入异步执行，不阻塞 LLM 响应流
- [ ] Typecheck 通过

### US-005: Tool Call 日志采集

**Description:** As a developer, I want to log every tool call's input/output so I can trace the complete agent loop and identify oversized tool outputs.

**Acceptance Criteria:**
- [ ] 注册 `pre-tool` hook（`llm-log-tool-start`，priority 999）记录 tool call 开始：
  - 关联 `llm_log_id`（通过 session context 中的当前 request_id）
  - tool_name, input args (JSON), time_start
- [ ] 注册 `post-tool` hook（`llm-log-tool-finish`，priority 0 即最先执行）记录 tool call 完成：
  - output (JSON), title, metadata, duration_ms, status
- [ ] 记录 tool output 的字节大小，用于后续优化分析
- [ ] Typecheck 通过

### US-006: Hook 链处理日志采集

**Description:** As a developer, I want to see how each hook modifies the LLM context so I can debug prompt construction and tool interception.

**Acceptance Criteria:**
- [ ] 在 `HookChain` 执行机制中增加 instrumentation 支持：
  - 记录 hook_name, chain_type, priority, duration_ms
  - 记录 modified_fields：通过浅比较 context 对象在 hook 执行前后的 key，标记哪些字段被修改（如 `["system", "providerOptions"]`）
  - 不做 JSON diff，不存内容快照
- [ ] 写入 `llm_log_hook` 表，关联 `llm_log_id`
- [ ] Typecheck 通过

### US-007: 日志查询 API（Server 端）

**Description:** As a developer, I want a query API to retrieve and filter log data so the web viewer can display it.

**Acceptance Criteria:**
- [ ] 在 `packages/opencode` 中新增 `src/log/` 模块，提供以下查询函数：
  - `LlmLog.list(filters)` — 分页列表，支持按 session_id / agent / model / provider / time_range / status 筛选。**仅查询主表字段，不加载压缩大字段**（system_prompt, messages, raw_response）
  - `LlmLog.get(id)` — 获取单条日志完整详情（含 request, response, tokens, tool_calls, hooks, annotations），**此时解压并返回大字段内容**
  - `LlmLog.stats(filters)` — 聚合统计：按维度分组的 token 总量、费用总计、平均响应时间
  - `LlmLog.analyze(filters)` — 优化建议：识别 top-N 最大 tool output、cache 命中率、重复 context 占比
  - `LlmLog.annotate(llm_log_id, annotation)` — 添加标注
  - `LlmLog.deleteAnnotation(annotation_id)` — 删除标注
  - `LlmLog.cleanup(options)` — 手动触发清理（默认保护有 annotation 的记录，`force: true` 可跳过保护）
- [ ] 所有查询函数使用 Drizzle query builder，参数通过 Zod schema 校验
- [ ] 遵循现有 namespace 模式（`export namespace LlmLog { ... }`）
- [ ] Typecheck 通过

### US-008: Log Viewer Web 应用 — 独立 Package

**Description:** As a developer, I want a web application to browse and analyze LLM logs visually.

**Acceptance Criteria:**
- [ ] 新建 `packages/log-viewer/` 包，技术栈：
  - 框架：Vite + React（轻量，适合独立工具）
  - 样式：Tailwind CSS
  - 数据获取：通过本地 HTTP API（由 opencode 进程提供）
- [ ] 包含以下页面/视图：
  - **日志列表页** — 带筛选面板（session / agent / model / provider / time range / status），分页展示
  - **日志详情页** — 完整的请求/响应查看，含 system prompt、messages、completion、tool calls、hook 链
  - **Token 统计面板** — 聚合图表（按时间、按 model、按 agent 维度），费用趋势
  - **优化建议页** — 展示 top-N 大 tool output、cache 命中率、重复 context 分析结果
- [ ] 响应式布局，支持窄屏（最小 1024px）
- [ ] `package.json` 中配置 `build` 和 `dev` 脚本
- [ ] Typecheck 通过

### US-009: 日志详情页 — 请求/响应查看器

**Description:** As a developer, I want to inspect the full request and response of each LLM call so I can trace exactly what the model saw and produced.

**Acceptance Criteria:**
- [ ] 请求面板：
  - System prompt 以 collapsible section 展示（支持多段）
  - Messages 以聊天气泡样式展示，区分 user/assistant/tool 角色
  - 消息内容支持 Markdown 渲染和代码高亮
  - Tool schema 以 JSON 树形展示
  - Provider options 以 key-value 表格展示
- [ ] 响应面板：
  - Completion text 以 Markdown 渲染
  - Tool calls 以卡片列表展示（名称、参数、输出、耗时）
  - Token 明细以表格展示（input / output / reasoning / cache read / cache write / cost）
  - Error 以红色高亮面板展示
- [ ] 支持请求/响应左右对照布局
- [ ] Typecheck 通过
- [ ] Verify in browser using dev-browser skill

### US-010: 幻觉标注功能

**Description:** As a developer, I want to select and annotate text in LLM responses as hallucination so I can track and analyze hallucination patterns.

**Acceptance Criteria:**
- [ ] 在日志详情页的响应面板中，支持选中文本后弹出标注菜单
- [ ] 标注类型：`hallucination`（幻觉）、`quality`（质量问题）、`note`（备注）
- [ ] 每个标注包含：选中文本、标注类型、自由文本备注、创建时间
- [ ] 标注以高亮样式叠加在原文上（幻觉=红色、质量=黄色、备注=蓝色）
- [ ] 支持查看和删除已有标注
- [ ] 标注数据通过 API 存入 `llm_log_annotation` 表
- [ ] Typecheck 通过
- [ ] Verify in browser using dev-browser skill

### US-011: Diff 视图 — LLM 声称 vs 实际

**Description:** As a developer, I want to compare what the LLM claimed to do (in its response) versus what actually happened (tool outputs) so I can identify hallucinations.

**Acceptance Criteria:**
- [ ] 在日志详情页新增 "Diff" 标签页
- [ ] 对于包含文件编辑 tool call 的日志条目：
  - 左侧显示 completion 原文中与该 tool call 相关的段落
  - 右侧显示 tool call 的实际输入参数和执行结果
- [ ] 对于包含 bash tool call 的日志条目：
  - 左侧显示 completion 原文中与该 tool call 相关的段落
  - 右侧显示实际执行的命令和输出
- [ ] 按位置关联 completion 文本与 tool call（不做自然语言意图提取）
- [ ] 使用 diff 高亮样式标记不一致之处
- [ ] 如果 tool call 失败但 LLM 未提及，自动标记为潜在幻觉
- [ ] Typecheck 通过
- [ ] Verify in browser using dev-browser skill

### US-012: Token 统计与费用分析面板

**Description:** As a developer, I want visual charts showing token usage and costs across different dimensions so I can identify optimization opportunities.

**Acceptance Criteria:**
- [ ] 按时间维度：折线图展示每小时/每天的 token 用量和费用趋势
- [ ] 按 model 维度：柱状图对比不同模型的 token 消耗和费用
- [ ] 按 agent 维度：饼图展示不同 agent 的 token 占比
- [ ] 按 session 维度：表格展示每个 session 的 token 总量和费用
- [ ] 每个图表支持时间范围筛选
- [ ] 汇总面板：总请求数、总 token 数、总费用、平均每次请求 token 数
- [ ] 使用轻量图表库（推荐 recharts 或 chart.js）
- [ ] Typecheck 通过
- [ ] Verify in browser using dev-browser skill

### US-013: Token 优化建议引擎

**Description:** As a developer, I want automated analysis that identifies token optimization opportunities so I can reduce costs.

**Acceptance Criteria:**
- [ ] 分析并展示以下优化建议：
  - **过大 Tool Output** — 列出 top-10 最大的 tool output（按字节），附带 tool 名称、session、压缩建议
  - **Cache 命中率** — 计算 cache_read_tokens / total_input_tokens 比率，低于阈值（如 30%）时建议优化 prompt 稳定性
  - **重复 Context** — 分析同一 session 内多次 LLM 调用中重复出现的 message 内容占比
  - **高成本模型使用** — 标识可以降级到更便宜模型的低复杂度请求（基于 output token 少 + 无 tool call 的简单问答）
  - **Reasoning Token 占比** — 标识 reasoning token 占比过高的请求，建议调整 think mode
- [ ] 每条建议包含：问题描述、影响估算（token 数 / 费用）、建议操作
- [ ] 建议结果可导出为 JSON
- [ ] Typecheck 通过
- [ ] Verify in browser using dev-browser skill

### US-014: Log Viewer HTTP API Server

**Description:** As a developer, I need an HTTP API server that bridges the web viewer and the log query module.

**Acceptance Criteria:**
- [ ] 在 `packages/opencode` 中新增 `src/log/server.ts`，使用 Bun 原生 HTTP server：
  - `GET /api/logs` — 列表查询（query params 对应 LlmLog.list filters）
  - `GET /api/logs/:id` — 详情查询
  - `GET /api/logs/stats` — 聚合统计
  - `GET /api/logs/analyze` — 优化建议
  - `POST /api/logs/:id/annotations` — 添加标注
  - `DELETE /api/logs/annotations/:id` — 删除标注
  - `POST /api/logs/cleanup` — 手动清理
  - `GET /api/health` — 健康检查
- [ ] 静态文件服务：serve `packages/log-viewer/dist/` 目录
- [ ] CORS 配置：开发模式允许 localhost 跨域
- [ ] 默认端口 `19836`，支持 `--port` 参数覆盖
- [ ] Typecheck 通过

### US-015: `opencode log-viewer` CLI 命令

**Description:** As a user, I want a CLI command to quickly launch the log viewer so I don't need to set up anything manually.

**Acceptance Criteria:**
- [ ] 新增 CLI 子命令 `opencode log-viewer`，注册在 `src/cli/cmd/` 中
- [ ] 启动行为：
  1. 构建/检查 log-viewer 静态资源（优先使用预构建版本）
  2. 启动 HTTP API server（端口默认 19836）
  3. 自动打开浏览器访问 `http://localhost:19836`
  4. 在终端显示访问地址和 Ctrl+C 退出提示
- [ ] 支持参数：`--port <number>`（自定义端口）、`--no-open`（不自动打开浏览器）
- [ ] 当端口被占用时自动尝试下一个端口
- [ ] Typecheck 通过

### US-016: 数据库升降级兼容

**Description:** As a developer, I want the log tables to support smooth database migrations so that upgrades and downgrades don't break existing functionality.

**Acceptance Criteria:**
- [ ] Migration 文件独立于现有 session 相关 migration（单独的 migration 文件）
- [ ] 所有新表使用 `IF NOT EXISTS` 创建
- [ ] 表结构变更通过增量 migration 文件处理（不修改已有 migration）
- [ ] Migration 始终无条件执行（只建表改表），`llmLog.enabled` 仅控制运行时采集行为
- [ ] 提供 `opencode log-viewer --reset` 命令用于清空所有 log 表数据（保留表结构）
- [ ] log 表的 schema 变更不影响核心 session/message 表
- [ ] Typecheck 通过

## Functional Requirements

- FR-1: 在现有 SQLite 数据库中新增 6 张 log 表（llm_log, llm_log_request, llm_log_response, llm_log_tokens, llm_log_tool_call, llm_log_hook）+ 1 张标注表（llm_log_annotation）
- FR-2: 通过 pre-llm hook 采集完整请求上下文（system prompt, messages, tools, options）
- FR-3: 在 LLM.stream() 完成后采集响应数据和 token 明细
- FR-4: 通过 pre-tool / post-tool hook 采集 tool call 输入输出
- FR-5: 通过 HookChain instrumentation 采集 hook 元信息（name, chain_type, priority, duration_ms, modified_fields），不存内容快照
- FR-6: 根据 `Provider.Model.cost` 逐项计算费用（含 >200K context 特殊定价和 cache 定价）
- FR-7: 提供 `LlmLog` namespace 的查询、统计、分析、标注 API
- FR-8: 提供 Bun HTTP server 暴露 REST API + 静态资源服务
- FR-9: 提供独立 `packages/log-viewer` Web 应用（Vite + React + Tailwind）
- FR-10: Web 应用包含日志列表、日志详情、token 统计、优化建议、幻觉标注、diff 视图
- FR-11: 提供 `opencode log-viewer` CLI 命令启动本地查看器
- FR-12: 日志存储有上限控制，支持按记录数和天数自动清理
- FR-13: 带 annotation 的记录受保护（延长 2x 生命周期）
- FR-14: 日志写入全部异步执行，不阻塞 LLM 主流程
- FR-15: `llmLog.enabled: false` 时零开销（hook 直接跳过）
- FR-16: 前置工作：集成 HookChain 系统，将 Plugin.trigger 调用替换为 HookChain.executePreLLM/PreTool/PostTool，注册所有 hook namespace

## Non-Goals (Out of Scope)

- **实时日志流** — 不做 WebSocket 实时推送，刷新页面即可查看最新数据
- **远程日志收集** — 仅本地 SQLite 存储，不支持发送到远程服务器
- **自动幻觉检测** — 仅提供人工标注和 diff 对照工具，不做 AI 驱动的自动检测
- **日志导出为 OpenTelemetry/Jaeger 格式** — 不对接外部 APM 系统
- **多用户协作标注** — 单用户本地工具，无登录和权限管理
- **日志加密** — 日志与现有 session 数据同级别安全，不单独加密
- **Windows 支持的 log-viewer** — 遵循项目整体策略，Windows 暂不特殊处理

## Design Considerations

- **日志详情页布局**：左右分栏（请求 | 响应），上方 tab 切换（Overview / Request / Response / Tools / Hooks / Diff / Annotations）
- **统计面板**：Dashboard 风格，顶部汇总卡片 + 下方多图表区域
- **颜色方案**：与 opencode TUI 风格保持一致，深色主题为主，浅色主题可选
- **标注交互**：类似 Google Docs 的选中标注模式，选中文本后出现浮动工具栏
- **复用 `packages/ui`**：如果其中有可复用的组件（如 Button, Input），优先复用

## Technical Considerations

- **存储位置**：复用 `~/.opencode/data/opencode.db`，与 session 数据共享同一数据库文件
- **Migration**：遵循现有 `packages/opencode/migration/` 目录结构，用 Drizzle kit 生成
- **日志写入性能**：使用 SQLite WAL 模式（已启用）+ 批量写入（将同一个 step 的多条记录合并为一次事务）
- **大字段存储**：system_prompt、messages、raw_response 使用 gzip 压缩后以 BLOB 存储（`llm_log_request.messages`、`llm_log_response.raw_response` 等字段）。列表查询不加载压缩字段，仅在详情查询时解压返回
- **Hook 记录**：仅记录元信息（name, duration, modified_fields），通过浅比较检测修改字段，不做 JSON diff 也不存内容快照
- **Bun HTTP Server**：使用 `Bun.serve()` 原生 API，无需额外框架
- **Web 应用构建**：log-viewer build 产物随 opencode CLI 一起打包分发，无需运行时下载
- **图表库**：推荐 recharts（React 生态，轻量，声明式 API）
- **Bus 事件**：新增 `LlmLogEvent` 系列事件，用于解耦日志写入和 UI 通知

## Success Metrics

- LLM 请求/响应日志覆盖率 100%（log enabled 时所有调用都被记录）
- 日志写入对 LLM 响应延迟的影响 < 5ms（异步写入）
- 开发者可在 3 次点击内从日志列表定位到具体的 tool call 输出
- Token 统计数据与 provider 账单误差 < 1%（基于相同的 cost 数据源）
- `opencode log-viewer` 命令从执行到浏览器打开 < 3 秒
- 默认配置下，30 天日志存储占用 < 100MB

## Resolved Decisions

1. **大字段压缩策略** — 使用 gzip 压缩存储为 BLOB（system_prompt, messages, raw_response）。列表查询不加载压缩字段，仅详情查询时解压返回。gzip/gunzip 在 `LlmLog` namespace 的查询/写入函数中手动处理，不自定义 Drizzle column type。
2. **日志采样** — 不做采样。幻觉追查需要完整数据，存储控制由 max_records + max_age_days + 压缩三重保障。
3. **log-viewer 分发方式** — 预构建产物嵌入 opencode CLI 二进制（Bun embed），运行时从内存读取，单文件分发。
4. **Hook 快照粒度** — 不做 JSON diff，不存内容快照。仅记录 hook name + chain_type + priority + duration_ms + modified_fields（哪些 context 字段被修改）。`llm_log_hook` 表去掉 `input_snapshot` 和 `output_snapshot`，改为 `modified_fields` JSON 数组。去掉 `hook_detail` 和 `hook_detail_exclude` 配置项。
5. **与现有 `packages/web` 的关系** — 完全独立的 `packages/log-viewer`，不集成到 `packages/web`。
6. **SDK 暴露** — 初期不暴露，外部工具可直接调用 REST API。后续有明确需求再加。
7. **HookChain 集成（前置工作）** — 现有 HookChain 系统（pre-llm / pre-tool / post-tool）已定义但未接入生产代码。须先完成集成：(a) 在应用启动时调用所有 hook namespace 的 `register()`；(b) `llm.ts` 的 `Plugin.trigger("experimental.chat.system.transform")` 替换为 `HookChain.executePreLLM()`；(c) `prompt.ts` 的 `Plugin.trigger("tool.execute.before/after")` 替换为 `HookChain.executePreTool()` / `executePostTool()`；(d) 重复逻辑（`Truncate.output()`、grep 内建截断）统一迁移到 hook 链路。Security 代码（权限检查、LLMScanner、SecurityRedact）保持在 prompt.ts 中间不动。
8. **跨 chain type 状态传递** — 各 Context schema 新增 `metadata: z.record().optional()` 字段。同 chain type 内通过 metadata 共享数据。跨 chain type（pre-llm → pre-tool）通过 `Instance.state()` 维护 `Map<sessionID, currentLlmLogId>` 桥接。
9. **响应采集方式** — 不在 `LLM.stream()` 的 onFinish 回调中采集。在 `processor.ts` 的 `finish-step` 事件处理完后 emit 新的 session-lifecycle 事件 `"step.finished"`，日志系统通过 session-lifecycle hook 监听采集。
10. **API 路由匹配** — 保持 `/api/logs/` 前缀。`Bun.serve()` 中手动优先匹配静态路径（`/api/logs/stats`、`/api/logs/analyze`）再 fallback 到 `/api/logs/:id`。
11. **Migration 执行策略** — Migration 始终无条件执行（只建表改表），`llmLog.enabled` 仅控制运行时采集行为。
12. **Config 段命名** — 配置段使用 `llmLog`（而非 `log`），避免与已有的顶级 `logLevel` 字段混淆。
13. **Tool call 关联** — `llm_log_tool_call` 表新增 `call_id` 字段，存储 AI SDK 生成的 `toolCallId`，用于区分同一 step 内同一 tool 的多次调用。
14. **Diff 视图** — 不做自然语言意图提取。左侧展示 completion 原文，右侧展示对应 tool call 的输入输出，按位置关联并排对照。
15. **手动清理的 annotation 保护** — `LlmLog.cleanup(options)` 手动清理默认也保护有 annotation 的记录，提供 `force: true` 参数可跳过保护。

## Open Questions

（无）
