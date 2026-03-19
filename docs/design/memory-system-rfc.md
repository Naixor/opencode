# RFC: OpenCode Memory System (v2)

> **Status**: Draft v2
> **Author**: Stormspirit
> **Date**: 2026-03-17
> **Target**: packages/opencode/src/memory/

---

## 1. 背景与动机

当前 OpenCode 有一套基于文件的静态上下文注入系统（AGENTS.md、README.md、`.opencode/rules/*.md`），但缺乏**动态学习**能力——agent 无法从用户的纠正、偏好、代码风格中自动积累经验。每次新会话都是"从零开始"。

**核心问题**：OpenCode 用得越多，应该越懂用户，但现在不是。

**竞品对比**：

| 能力 | Claude Code | GitHub Copilot | Cursor | Windsurf | **OpenCode（目标）** |
|---|---|---|---|---|---|
| 静态规则文件 | CLAUDE.md | copilot-instructions.md | .cursor/rules/ | User rules | .opencode/rules/ ✅ |
| 全量交互日志 | ❌ | ❌ | ❌ | ❌ | **✅ 复用 LlmLog** |
| 自动记忆提取 | MEMORY.md | ✅ (citation-based) | ❌ | ✅ | **✅ 基于日志+LLM** |
| 可定制优化策略 | ❌ | ❌ | ❌ | ❌ | **✅ 用户提供 MD 模板** |
| 个人/团队分层 | ❌ | user/repo 分层 | ❌ | ❌ | **✅ 远端 Team + 审批** |
| 语义召回 + 冲突检测 | ❌ | ❌ | ❌ | ❌ | **✅ LLM 判断，非 embedding** |
| 记忆衰减 | ❌ | 28天自动清理 | ❌ | ❌ | **✅ 基于引用的衰减** |

---

## 2. 设计目标

1. **全量可追溯**：所有用户交互已由 LlmLog 系统全量记录（system_prompt + messages + tool_calls，gzip 压缩存 SQLite），Memory 系统直接复用，无需重复存储
2. **越用越懂你**：自动从对话中提取有价值的偏好和模式，`/remember` 时携带完整对话上下文避免歧义
3. **不臃肿**：注入池有上限、记忆有衰减、有整理，存储无硬上限，LLM 分析策略可通过用户 MD 文件定制
4. **个人→团队→审批**：优秀个人记忆主动发现并推荐晋升，通过远端服务提交，团队管理者审批后生效
5. **无侵入**：完全通过 HookChain 集成，不修改核心 LLM 流程

---

## 3. 架构总览

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Memory System                                │
├───────────┬────────────┬───────────────┬─────────────────────────────┤
│  Storage  │  Engine    │  Optimizer    │  Team Sync                  │
│  Layer    │  Layer     │  Layer        │  Layer                      │
├───────────┼────────────┼───────────────┼─────────────────────────────┤
│ LlmLog    │ Extract    │ LLM Analyze   │ Auto-detect candidates      │
│ (existing)│ (from log) │ (pluggable    │ User confirm + edit         │
│ + Memory  │ Recall     │  MD template) │ Upload to feishu-server     │
│   Store   │ (agent +   │ Decay/Prune   │ 飞书卡片审批 → 生效          │
│ (new JSON)│  conflict) │ Consolidate   │ Pull approved → local       │
└───────────┴────────────┴───────────────┴─────────────────────────────┘
         │                       │                        │
         ▼                       ▼                        ▼
  ┌──────────────┐     ┌──────────────────┐    ┌──────────────────────────┐
  │  HookChain   │     │ .opencode/       │    │  feishu-server           │
  │  pre-llm     │     │ memory/          │    │  (独立服务，飞书账号体系)  │
  │  post-tool   │     │   optimizer.md   │    │  REST API + 飞书机器人    │
  │  lifecycle   │     │   personal.json  │    │  审批卡片 + Webhook 回调  │
  └──────────────┘     └──────────────────┘    └──────────────────────────┘
```

---

## 4. Memory 数据模型

### 4.1 单条 Memory 结构

```typescript
// src/memory/memory.ts
import z from "zod"

export namespace Memory {
  export const Category = z.enum([
    "style",       // 代码风格偏好：缩进、命名、注释风格
    "pattern",     // 代码模式：常用的设计模式、错误处理方式
    "tool",        // 工具偏好：测试框架、构建工具、lint 配置
    "domain",      // 领域知识：业务逻辑、API 约定、数据模型
    "workflow",    // 工作流偏好：commit 风格、PR 流程、分支策略
    "correction",  // 纠正记录：用户明确纠正 agent 的行为
    "context",     // 项目上下文：架构决策、技术栈选型
  ])

  export const Scope = z.enum([
    "personal",    // 个人记忆，仅当前用户可见
    "team",        // 团队记忆，从远端审批通过后拉取
  ])

  /**
   * Team Memory 多维隔离作用域
   *
   * 设计原则：
   * - 维度之间 AND 关系：所有非空维度都必须匹配
   * - 维度内部 OR 关系：满足其一即可
   * - 空数组 = 该维度不做过滤
   * - global: true 无条件匹配所有上下文，忽略其他维度
   *
   * 示例：
   *   { global: true }                                     → 全团队生效
   *   { languages: ["typescript"] }                        → 所有 TS 项目生效
   *   { languages: ["python"], techStack: ["fastapi"] }    → Python + FastAPI 项目生效
   *   { projectIds: ["opencode"], modules: ["src/tui"] }   → opencode 的 TUI 模块生效
   */
  export const TeamScope = z.object({
    // 维度 1：全局通用 — 无条件生效，忽略其他维度
    global: z.boolean().default(false),

    // 维度 2：项目隔离 — 匹配 projectID（来自 .opencode/ 或 opencode.json）
    projectIds: z.array(z.string()).default([]),

    // 维度 3：语言隔离 — 匹配项目主要语言（自动检测或配置声明）
    languages: z.array(z.string()).default([]),
    // e.g., ["typescript", "python", "go", "rust", "java"]

    // 维度 4：技术选型隔离 — 匹配依赖/框架/工具链
    techStack: z.array(z.string()).default([]),
    // e.g., ["hono", "drizzle", "bun", "react", "fastapi", "pytest"]

    // 维度 5：模块隔离 — 匹配工作路径的前缀（相对于项目根目录）
    modules: z.array(z.string()).default([]),
    // e.g., ["packages/opencode/src/tui", "packages/sdk", "apps/web"]
  })

  export const Status = z.enum([
    "pending",     // auto-extract 待确认期，参与注入但需经受验证
    "confirmed",   // 正式记忆（manual 直接进入 / pending 转正）
  ])

  export const Info = z.object({
    id: z.string(),                          // nanoid
    content: z.string(),                     // 记忆内容（自然语言描述）
    category: Category,
    scope: Scope,
    status: Status.default("confirmed"),     // manual → confirmed, auto → pending
    tags: z.array(z.string()).default([]),    // 自由标签，用于检索

    // --- 溯源（完整上下文链） ---
    source: z.object({
      sessionID: z.string(),                 // 来源会话
      llmLogID: z.string().optional(),       // 关联的 LlmLog 记录 ID（可回溯完整对话）
      messageID: z.string().optional(),      // 来源消息
      method: z.enum(["auto", "manual", "promoted", "pulled"]),
      // /remember 时保存的对话上下文快照
      contextSnapshot: z.string().optional(),
    }),
    citations: z.array(z.string()).default([]),  // 关联的文件路径

    // --- 生命周期 ---
    score: z.number().default(1.0),          // 相关性得分 0-10
    useCount: z.number().default(0),         // 被注入 prompt 的次数
    hitCount: z.number().default(0),         // 实际影响输出的次数（pending 转正依据之一）
    lastUsedAt: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    confirmedAt: z.number().optional(),      // pending → confirmed 的时间
    expiresAt: z.number().optional(),

    // --- 团队晋升 ---
    teamCandidateAt: z.number().optional(),  // 被标记为候选的时间
    teamSubmittedAt: z.number().optional(),  // 提交到远端的时间
    teamApprovedAt: z.number().optional(),   // 审批通过的时间
    promotedBy: z.string().optional(),

    // --- Team Memory 隔离作用域 ---
    // scope === "team" 时必填，定义这条团队记忆的适用范围
    // scope === "personal" 时忽略
    teamScope: TeamScope.optional(),
  })
  export type Info = z.infer<typeof Info>
}
```

### 4.2 存储层设计

**核心原则：LlmLog 是全量事实源，Memory 是从中提炼的精华。**

```
已有（不改）：
  SQLite llm_log 表系列        ← 全量交互日志（system_prompt, messages, tool_calls）
                                  gzip 压缩，通过 LlmLog.get(id) 可还原完整对话

新增：
  ~/.config/opencode/storage/memory/
  ├── {projectID}/
  │   └── personal.json         ← 个人记忆（JSON array，程序化 CRUD）
  └── global/
      └── personal.json         ← 跨项目的全局个人记忆

  .opencode/memory/
  ├── optimizer.md              ← 用户自定义优化策略模板（可选）
  └── .personal.md              ← 个人记忆导出（gitignore）
```

**团队记忆不再存本地文件**，改为从远端服务拉取（见第 7 节）。

### 4.3 与现有系统的关系

```
优先级（高→低）：
1. .opencode/rules/*.md         — 硬性规则（现有，不变）
2. AGENTS.md                    — 项目级指令（现有，不变）
3. Team Memory（远端拉取）       — 团队记忆（新增，审批制）
4. Personal Memory（本地 JSON）  — 个人偏好（新增，本地）
5. README.md                    — 项目概述（现有，不变）
```

---

## 5. Auto-Extract：全量日志 + 上下文丰富的记忆提取

### 5.1 全量交互日志（已有，直接复用）

现有 `LlmLogCapture` 系统已经全量记录了每一轮 LLM 交互：

```
LlmLogTable          → session_id, agent, model, status, time_start/end
LlmLogRequestTable   → system_prompt (gzip), messages (gzip), tools, options
LlmLogResponseTable  → completion_text, tool_calls, raw_response (gzip)
LlmLogTokensTable    → input/output/reasoning/cache tokens, cost
LlmLogToolCallTable  → tool_name, input (json), output (json), duration
LlmLogAnnotationTable → type, content, marked_text
```

**无需扩展**。通过 `LlmLog.get(id)` 可以还原任何一轮的完整对话，包括 system prompt 和所有 messages。Memory 系统只需要在 source 中记录 `llmLogID`，就能追溯到完整上下文。

### 5.2 手动记忆（/remember）：携带完整上下文

当用户使用 `/remember` 时，不能只保存用户说的那句话——必须保存足够的上下文来消除歧义。

```typescript
// src/memory/engine/extractor.ts
export namespace MemoryExtractor {

  /**
   * /remember 命令处理：提取当前对话上下文构建无歧义的记忆
   *
   * 例如用户说: /remember 用这个格式
   * 如果只存 "用这个格式" 是没意义的
   * 需要回溯对话找到 "这个格式" 指的是什么
   */
  export async function rememberWithContext(
    sessionID: string,
    userInput: string,
    recentMessages: Array<{ role: string; content: string }>,
  ): Promise<Memory.Info> {

    // 1. 获取当前 LlmLog ID（由 LlmLogCapture hook 维护）
    const llmLogID = LlmLogCapture.getCurrentLogId(sessionID)

    // 2. 构建上下文快照：最近 N 轮对话
    const contextWindow = recentMessages.slice(-10)  // 最多保留最近 10 轮
    const contextSnapshot = contextWindow
      .map(m => `[${m.role}]: ${m.content}`)
      .join("\n---\n")

    // 3. 用 LLM 从上下文中提炼出清晰无歧义的记忆
    const extracted = await llmExtract({
      prompt: `用户在对话中说"${userInput}"，请结合上下文提炼一条清晰的、
        可脱离对话独立理解的开发偏好或知识。

        上下文：
        ${contextSnapshot}

        要求：
        - 内容必须自包含，不能有"这个"、"那个"等指代词
        - 包含具体的技术细节（框架名、配置值、代码模式等）
        - 输出 JSON: { content, category, tags, citations }`,
    })

    // 4. 存储记忆，关联完整溯源链
    return Memory.create({
      ...extracted,
      scope: "personal",
      source: {
        sessionID,
        llmLogID,                    // 可通过此 ID 还原完整对话
        method: "manual",
        contextSnapshot,             // 冗余保存上下文快照，快速查看
      },
    })
  }
}
```

**示例**：

```
user> 帮我写个 API handler
agent> [生成了一个用 express 的 handler]
user> 不对，我们用 Hono
agent> [改成 Hono]
user> /remember 用这个格式

→ 提取结果（而非仅存"用这个格式"）：
  content: "API handler 统一使用 Hono 框架（import { Hono } from 'hono'），
            不使用 Express。路由定义在 src/routes/ 目录下。"
  category: "tool"
  tags: ["hono", "api", "framework"]
  source.contextSnapshot: "[user]: 帮我写个 API handler\n---\n[agent]: ...\n---\n..."
  source.llmLogID: "log_abc123"   ← 可以通过 LlmLog.get("log_abc123") 看完整对话
```

### 5.3 自动提取（基于上下文的 LLM 提取 + 待确认期）

#### 5.3.1 设计理念

Auto-Extract 不靠正则匹配关键词——用户说"别用 console.log"可能是一次性调试指令也可能是持久偏好，正则无法区分。正确做法是**让 LLM 看完整对话上下文来判断**是否值得提取，以及提取什么。

提取出的记忆不直接生效，而是进入 **pending（待确认）** 状态：

```
auto-extract → status: "pending" → 参与注入（被 recall agent 正常筛选）
                                  → 经过验证后自动转正为 "confirmed"
                                  → 或在 Memory Manager 中被用户删除
```

**不打扰用户**：pending 记忆静默进入，不弹通知。用户在 Memory Manager 页面可以看到 pending 列表自行管理。

#### 5.3.2 提取时机

两个时机，互为补充：
1. **compaction 时提取**（主时机）：上下文溢出触发 compaction，此时对话足够长且 LLM 仍在运行，可靠
2. **下次启动时补提取**（兜底）：如果用户直接关闭终端，compaction 没来得及触发，下次打开同一 session 时异步补提取

**幂等保证**：每次提取成功后记录 `extracted:{sessionID}` 标记，已提取过的 session 不再重复提取。

```typescript
export namespace MemoryAutoExtract {
  export function register() {
    // 时机 1：compaction 时提取（主时机，上下文最完整）
    HookChain.register("memory-extract-session-end", "session-lifecycle", 200, async (ctx) => {
      if (ctx.event === "session.compacting") {
        await extractFromSession(ctx.sessionID)
      }
    })

    // 时机 2：session 恢复时检查是否需要补提取
    HookChain.register("memory-extract-recovery", "session-lifecycle", 210, async (ctx) => {
      if (ctx.event === "session.resumed") {
        const extracted = await Memory.getMeta(`extracted:${ctx.sessionID}`)
        if (extracted) return  // 已提取过，跳过

        // 异步补提取，不阻塞用户当前操作
        extractFromSession(ctx.sessionID).catch(err => {
          log.warn("recovery extract failed", { sessionID: ctx.sessionID, error: err })
        })
      }
    })
  }

  /**
   * 基于完整会话上下文的 LLM 提取
   * 不是逐条消息扫正则，而是让 LLM 通读整段对话后判断
   */
  async function extractFromSession(sessionID: string) {
    const llmLogID = LlmLogCapture.getCurrentLogId(sessionID)
    const detail = await LlmLog.get(llmLogID)
    if (!detail) return

    // 用 LLM 分析整段对话，提取值得记住的偏好/模式/知识
    const extracted = await llmExtract({
      prompt: `分析以下开发对话，提取用户表达的持久性偏好、代码模式、工具选择、
        项目约定等值得长期记住的信息。

        注意区分：
        - 持久偏好（"我们项目用 Hono"、"不用分号"）→ 应提取
        - 一次性指令（"这次别用 console.log 调试"）→ 不应提取
        - 项目约定（"API 返回格式统一用 { code, data, message }"）→ 应提取
        - 临时上下文（"帮我看看这个 bug"）→ 不应提取

        对话内容：
        ${detail.messages.slice(-20).map(m => `[${m.role}]: ${m.content}`).join("\n---\n")}

        如果没有值得提取的内容，返回空数组。
        对每条提取结果输出 JSON:
        [{ "content": "...", "category": "...", "tags": [...], "citations": [...] }]`,
    })

    if (!extracted || extracted.length === 0) return

    // 构建上下文快照
    const contextSnapshot = detail.messages.slice(-10)
      .map(m => `[${m.role}]: ${typeof m.content === "string" ? m.content : "..."}`)
      .join("\n---\n")

    // 存为 pending 状态
    for (const item of extracted) {
      // 去重：检查是否已有相似内容的记忆
      const existing = await Memory.findSimilar(item.content)
      if (existing) continue

      await Memory.create({
        ...item,
        scope: "personal",
        status: "pending",              // ← 待确认
        source: {
          sessionID,
          llmLogID,
          method: "auto",
          contextSnapshot,
        },
      })
    }

    // 标记已提取，防止重复提取
    await Memory.setMeta(`extracted:${sessionID}`, Date.now())
  }
}
```

#### 5.3.3 Pending 转正机制

pending 记忆参与正常的注入流程（recall agent 会把它和 confirmed 记忆一起筛选），但需要满足条件才能转正：

```typescript
export namespace MemoryConfirmation {
  /**
   * 转正条件（全部满足）：
   * 1. 存活天数 >= 7 天（经历了足够多的会话验证）
   * 2. hitCount >= 2（至少被实际使用过 2 次，说明确实有用）
   * 3. 未被 recall agent 标记为冲突
   * 4. 用户未手动删除
   *
   * 满足条件后静默转正，不打扰用户。
   */
  const CONFIRM_MIN_DAYS = 7
  const CONFIRM_MIN_HITS = 2

  export async function checkPendingMemories() {
    const pendings = await Memory.list({ scope: "personal", status: "pending" })

    for (const memory of pendings) {
      const ageInDays = (Date.now() - memory.createdAt) / (1000 * 60 * 60 * 24)

      if (ageInDays >= CONFIRM_MIN_DAYS && memory.hitCount >= CONFIRM_MIN_HITS) {
        await Memory.update(memory.id, {
          status: "confirmed",
          confirmedAt: Date.now(),
        })
        log.info("pending memory confirmed", { id: memory.id, content: memory.content })
      }
    }
  }

  // 在 maintain() 定期任务中调用
}
```

#### 5.3.4 Memory Manager 中的 Pending 管理

Web 页面中 pending 记忆有独立的展示区：

```
┌─────────────────────────────────────────────────────────┐
│  🧠 Memory Manager                        162/200      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  📋 待确认 (8 条)                           [全部确认]  │
│  ┌───────────────────────────────────────────────────┐  │
│  │ ☐ [tool] 使用 vitest 而非 jest       3天 | 1次命中 │  │
│  │ ☐ [style] 变量命名用 camelCase       5天 | 2次命中 │  │
│  │ ☐ [pattern] try-catch 统一用 Result  1天 | 0次命中 │  │
│  │ ...                                                │  │
│  │         [✅ 确认选中] [🗑️ 删除选中]               │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ── 正式记忆 (154 条) ──                                │
│  ...                                                    │
└─────────────────────────────────────────────────────────┘
```

用户可以：
- **手动确认**：选中 → 确认，立即变为 confirmed
- **手动删除**：不需要的直接删
- **不管它**：满足条件后自动转正，不满足的就一直待在 pending 区

### 5.4 记忆召回（Recall）：专用 Agent + LLM 过滤 + 冲突检测

#### 5.4.1 设计理念

记忆检索不走 embedding/向量搜索，而是直接**让 LLM 判断**。原因：

1. **200 条上限**的记忆量拼在一起只有几千 token，一次 LLM 调用就能处理
2. **LLM 语义理解远超向量相似度**：能理解"写路由"和"用 Hono 框架"的逻辑关联
3. **不需要额外基础设施**：无 embedding 模型、无向量数据库、无索引维护
4. **可以做冲突检测**：向量搜索只能返回"相似"，LLM 能发现"矛盾"

#### 5.4.2 memory-recall Agent

定义一个专用的 `memory-recall` agent，用独立的 model + provider 配置，与主 agent 解耦：

```typescript
// agent.ts 新增
"memory-recall": {
  name: "memory-recall",
  description: "Memory recall agent. Filters relevant memories and detects conflicts.",
  mode: "primary",
  hidden: true,
  temperature: 0.0,       // 确定性输出
  // model 由 config.memory.recallModel 指定，默认用小模型
  permission: PermissionNext.merge(
    defaults,
    PermissionNext.fromConfig({
      "*": "deny",         // 不需要任何工具
    }),
    user,
  ),
  prompt: PROMPT_MEMORY_RECALL,
  options: {},
}
```

**为什么是独立 Agent：**

- **选合适的模型**：主 agent 可能用 Claude Opus / GPT-4 这种贵的大模型，recall 只是做过滤和冲突检测，用小模型（Haiku / GPT-4o-mini）即可，成本可忽略
- **选合适的 provider**：用户主力 provider 可能是 Anthropic，但 recall 可以走更便宜的 provider
- **不占主 agent 的 context**：recall 在独立调用中完成，不消耗主对话的 token 预算

#### 5.4.3 Recall Prompt 设计

```markdown
# Memory Recall Agent

你是 OpenCode 的记忆召回助手。你的任务是从用户的记忆库中筛选出与当前对话相关的记忆，
并检测记忆与当前对话之间是否存在矛盾。

## 输入
- 当前对话的最近几轮消息
- 用户的全部记忆列表（每条包含 id、content、category、tags）

## 任务

### 1. 过滤不相关的记忆
去掉与当前对话完全无关的记忆。判断标准：
- 如果这条记忆注入到 system prompt 中，对当前任务的完成**没有任何帮助**，则去掉
- 宁可多保留，不要误删（保留有一点点相关的）

### 2. 检测冲突
对比每条候选记忆与当前对话内容，发现矛盾：
- 用户当前说"用 Express"，但记忆说"用 Hono" → 冲突
- 用户当前代码用了分号，但记忆说"不用分号" → 冲突
- 记忆之间互相矛盾也要标出

### 3. 输出格式
```json
{
  "relevant": ["mem_id1", "mem_id2", ...],
  "conflicts": [
    {
      "memoryId": "mem_id3",
      "memoryContent": "API handler 统一使用 Hono 框架",
      "currentContext": "用户要求使用 Express 框架",
      "description": "用户当前要求与记忆中的框架偏好不一致"
    }
  ]
}
```
注意：如果没有冲突，conflicts 为空数组。如果所有记忆都不相关，relevant 为空数组。
```

#### 5.4.4 两阶段注入策略

会话早期上下文太少，recall agent 无法有效判断相关性。因此采用**两阶段策略**：

```
阶段一（前 N 轮）：全量注入
  所有记忆全量注入（200 条 ≈ 几千 token），主 LLM 自行取用
  不调 recall agent，零额外延迟

阶段二（N 轮后）：recall agent 精准过滤
  上下文足够丰富 → 调 recall agent 去掉不相关记忆 + 检测冲突
  注入量减少（省 token），同时开始冲突检测
  后续每 M 轮用户消息重新 recall 一次
```

**存储与注入分离**：auto-extract 不限制写入，记忆该存就存。限制发生在**注入侧**——送给 recall agent 和主 LLM 的候选池上限为 200 条，超出时对 auto 类按 score 取 top，manual 类全量保留。这样低分 auto 记忆暂时不参与注入，但数据不丢失，score 回升后能重新进入候选池。

**score 的定位**：score 不参与注入排序（由 recall agent 语义判断），只用于**auto 记忆超额时的候选池截断**和 **Optimizer 分析 / Memory Manager 清理建议排序**。

```typescript
export namespace MemoryInject {
  const RECALL_THRESHOLD = 3   // 用户消息数达到此阈值后启用 recall agent
  const RE_RECALL_INTERVAL = 5 // recall 后每 N 轮用户消息重新 recall
  const INJECT_POOL_LIMIT = 200 // 送给 recall / 主 LLM 的候选池上限

  // 召回缓存
  const recallCache = new Map<string, {
    result: RecallResult
    userMessageCount: number
  }>()

  /**
   * 构建候选池：manual 全量 + auto 按 score 取 top，总量不超过 INJECT_POOL_LIMIT
   */
  function buildCandidatePool(allMemories: Memory.Info[]): Memory.Info[] {
    const manual = allMemories.filter(m => m.source.method === "manual" || m.source.method === "pulled")
    const auto = allMemories.filter(m => m.source.method === "auto" || m.source.method === "promoted")

    const autoSlots = Math.max(0, INJECT_POOL_LIMIT - manual.length)
    const topAuto = auto.sort((a, b) => b.score - a.score).slice(0, autoSlots)

    return [...manual, ...topAuto]
  }

  export function register() {
    HookChain.register("memory-injector", "pre-llm", 130, async (ctx) => {
      const allMemories = await Memory.list({
        scope: ["personal", "team"],
        projectID: Instance.project.id,
      })
      if (allMemories.length === 0) return

      const pool = buildCandidatePool(allMemories)
      const userMessageCount = countUserMessages(ctx.messages)

      // ─── 阶段一：全量注入候选池（前几轮） ───
      if (userMessageCount < RECALL_THRESHOLD) {
        ctx.system.push(formatMemoriesForPrompt(pool))
        return
      }

      // ─── 阶段二：recall agent 精准过滤 ───
      if (shouldReRecall(ctx.sessionID, userMessageCount)) {
        const recallResult = await MemoryRecall.invoke({
          memories: pool.map(m => ({
            id: m.id, content: m.content, category: m.category, tags: m.tags,
          })),
          recentMessages: ctx.messages.slice(-6),
        })

        recallCache.set(ctx.sessionID, {
          result: recallResult,
          userMessageCount,
        })
      }

      const cached = recallCache.get(ctx.sessionID)
      if (!cached) {
        // 缓存未命中（理论上不会），降级为全量注入
        ctx.system.push(formatMemoriesForPrompt(pool))
        return
      }

      // 注入过滤后的记忆
      const relevant = allMemories.filter(m => cached.result.relevant.includes(m.id))
      if (relevant.length > 0) {
        ctx.system.push(formatMemoriesForPrompt(relevant))
        for (const m of relevant) {
          await Memory.incrementUseCount(m.id)
        }
      }

      // 冲突处理：通知用户确认
      if (cached.result.conflicts.length > 0) {
        for (const conflict of cached.result.conflicts) {
          Bus.publish(MemoryEvent.ConflictDetected, conflict)
        }
        ctx.system.push(formatConflictWarning(cached.result.conflicts))
      }
    })
  }

  function shouldReRecall(sessionID: string, currentCount: number): boolean {
    const cached = recallCache.get(sessionID)
    if (!cached) return true
    if (currentCount - cached.userMessageCount >= RE_RECALL_INTERVAL) return true
    if (Memory.isDirty(sessionID)) return true  // /remember 或 /forget 触发
    return false
  }
}
```

**阶段切换示意**：

```
第 1 轮 user msg → 阶段一：全量注入（零延迟，主 LLM 自行取用）
第 2 轮 user msg → 阶段一：同上
第 3 轮 user msg → 阶段二：首次 recall agent → 过滤为 N 条 + 冲突检测
第 4-7 轮        → 阶段二：使用缓存
第 8 轮 user msg → 阶段二：重新 recall（每 5 轮刷新）
用户 /remember   → 下一轮强制重新 recall（isDirty）
```

#### 5.4.5 冲突处理 UX

当 recall agent 检测到记忆与当前对话矛盾时，主 agent 会主动询问用户：

```
⚠️ 记忆冲突：
  你之前的偏好是"API handler 统一使用 Hono 框架"，
  但你现在要求使用 Express。

  请确认：
  a) 按当前要求用 Express（本次对话）
  b) 按当前要求用 Express，并更新记忆（永久修改偏好）
  c) 还是用 Hono（按记忆执行）
```

用户选择 b) 后，自动更新或删除旧记忆，创建新记忆。

#### 5.4.6 TUI 中的 Recall 可见性

用户应该清楚知道当前会话 agent 使用了哪些记忆，这既保证透明度，也方便用户判断记忆质量（错误的记忆可以及时删除）。

**阶段一（全量注入）**：在 TUI 状态栏显示记忆数量：

```
🧠 162 memories loaded
```

**阶段二（recall 过滤后）**：recall 完成时弹一次 toast 通知，显示本次激活的记忆：

```
🧠 Recall: 8/162 memories active
   [style]    不使用分号，printWidth: 120
   [tool]     使用 Bun 测试框架 (bun:test)
   [pattern]  错误处理统一用 NamedError.create()
   [domain]   API 返回格式 { code, data, message }
   ...
```

**重新 recall 时**（每 5 轮或 isDirty）：toast 更新为新的激活列表，delta 标注变化：

```
🧠 Recall: 6/162 memories active (−3 +1)
   [tool]     使用 Hono 框架                      ← NEW
   [style]    不使用分号，printWidth: 120
   ...
```

**冲突时**：冲突记忆高亮标注，链接到 Web 详情：

```
🧠 Recall: 8/162 memories active | ⚠️ 1 conflict
   [tool]  ⚠️ 使用 Hono 框架 (与当前对话矛盾) → http://localhost:19836/conflicts/mem_xxx
```

**实现方式**：通过 Bus 事件通知 TUI 渲染层：

```typescript
// recall 完成后发布事件
Bus.publish(MemoryEvent.RecallComplete, {
  sessionID: ctx.sessionID,
  phase: userMessageCount < RECALL_THRESHOLD ? "full" : "filtered",
  totalMemories: allMemories.length,
  activeMemories: relevant.map(m => ({ id: m.id, content: m.content, category: m.category })),
  conflicts: cached?.result.conflicts ?? [],
  delta: computeDelta(previousActive, relevant),  // { added: [...], removed: [...] }
})

// TUI 侧监听并渲染
Bus.subscribe(MemoryEvent.RecallComplete, (event) => {
  StatusBar.setMemoryIndicator(event)
  if (event.phase === "filtered") {
    Toast.show(formatRecallToast(event))
  }
})
```

### 5.5 TUI & CLI 交互

#### 5.5.1 TUI：统一 `/memory` 命名空间

所有记忆操作收敛到 `/memory` 一个顶级命令下，通过二级子命令展开。用户输入 `/memory` 后弹出子命令选择列表，也可以直接输入 `/memory:remember` 跳过选择。

**命令列表**：

```
/memory                     ← 弹出二级命令选择列表
/memory:remember <内容>     ← 记住当前上下文中的偏好
/memory:forget <id>         ← 删除一条记忆
/memory:list                ← TUI 内显示摘要（top 10 + web 链接）
/memory:manager             ← 打开 Web 管理页面
/memory:promote <id>        ← 打开 Web promote 页面
/memory:pull                ← 拉取团队记忆
/memory:optimize            ← 手动触发 Optimizer
```

**二级列表交互**（用户输入 `/memory` 后展示）：

```
user> /memory
→ 选择操作：
   1. remember  记住当前对话中的偏好
   2. forget    删除一条记忆
   3. list      查看记忆摘要
   4. manager   打开 Memory Manager (Web)
   5. promote   提交记忆到团队 (Web)
   6. pull      拉取团队记忆
   7. optimize  手动触发优化
```

**TUI 内直接执行的（轻量操作）**：

```
user> /memory:remember 我们的 API 返回格式统一用 { code, data, message }
→ ✅ 已记住 [domain] API 返回格式统一用 { code, data, message }

user> /memory:forget mem_abc123
→ ✅ 已删除记忆 #abc123

user> /memory:list
→ 📝 个人 162 条 | 👥 团队 5 条
   [style]    不使用分号，printWidth: 120
   [tool]     使用 Bun 测试框架 (bun:test)
   [pattern]  错误处理用 NamedError.create() 模式
   ...
   完整管理 → http://localhost:19836

user> /memory:pull
→ ✅ 拉取了 3 条新的团队记忆
```

**跳转 Web 的（管理类操作）**：

```
user> /memory:manager
→ 🌐 http://localhost:19836

user> /memory:promote mem_xxx
→ 🌐 http://localhost:19836/promote/mem_xxx
```

**系统通知**（容量告警、冲突检测）：

```
# 容量
💡 记忆 162/200 → http://localhost:19836
⚠️ 候选池已满 200/200 → http://localhost:19836?tab=cleanup

# 冲突
⚠️ 记忆冲突：偏好"用 Hono" vs 当前"用 Express" → http://localhost:19836/conflicts/mem_xxx
```

#### 5.5.2 CLI 命令

CLI 命令与 TUI 子命令一一对应，`/memory:xxx` → `opencode memory xxx`：

```bash
# 轻量操作（CLI 直接执行）
opencode memory remember "我们项目使用 Bun" --category tool
opencode memory forget <id>
opencode memory list                   # 终端打印摘要
opencode memory pull
opencode memory optimize [--template ./my-strategy.md]
opencode memory export --format md     # 导出（脚本化用途）

# 管理操作（打开 Web）
opencode memory manager                # 启动 Web 并打开浏览器
opencode memory promote <id>           # 打开 Web promote 页面
```

### 5.6 Memory Manager（本地 Web 管理页面）

**所有记忆管理操作的唯一入口。** TUI `/memory:manager` 和 CLI `opencode memory manager` 统一跳转到这里。

本地 HTTP 服务（端口可配置），仅监听 `127.0.0.1`，无需认证（本机访问）。opencode 启动时自动启动 Memory Manager 服务（不打开浏览器），需要时通过 `/memory:manager` 打开。

#### 5.6.1 页面功能

```
┌─────────────────────────────────────────────────────────────────┐
│  🧠 OpenCode Memory Manager                    162/200 ██████░ │
├──────────┬──────────────────────────────────────────────────────┤
│ 筛选     │  记忆列表                                            │
│          │                                                      │
│ 范围     │  ☐ [style] 不使用分号，printWidth: 120               │
│ ○ 全部   │     score: 8.2 | 使用 12次 | 命中 8次 | 3天前        │
│ ○ 个人   │     来源: /remember | 📎 查看上下文                   │
│ ○ 团队   │                                                      │
│          │  ☐ [tool] 使用 Bun 测试框架 (bun:test)               │
│ 分类     │     score: 7.5 | 使用 8次 | 命中 5次 | 7天前         │
│ ☑ style  │     来源: auto-extract | 📎 查看上下文                │
│ ☑ pattern│                                                      │
│ ☑ tool   │  ☐ [pattern] import 排序用 natural sort    ⚠️ 低活跃 │
│ ☑ domain │     score: 0.3 | 使用 1次 | 命中 0次 | 90天前        │
│ ☑ ...    │     来源: auto-extract                                │
│          │                                                      │
│ 排序     │  ────────────────────────────────────────────────     │
│ ○ score  │                                                      │
│ ○ 最近   │  已选 2 条:  [✏️ 编辑] [🗑️ 删除] [⬆️ 晋升Team]     │
│ ○ 使用频 │                                                      │
│          ├──────────────────────────────────────────────────────┤
│ 搜索     │  右侧面板: 记忆详情                                   │
│ [______] │                                                      │
│          │  content: 不使用分号，printWidth: 120                 │
│ ──────── │  category: style      scope: personal                │
│ 智能建议 │  tags: [semicolons] [prettier]                        │
│          │  citations: [.prettierrc]                              │
│ 🔍 发现  │                                                      │
│ 3 条可   │  ── 溯源 ──                                           │
│ 合并     │  来源: /remember (2026-01-15)                         │
│          │  会话: "配置项目代码风格..."                            │
│ ⚠️ 2 条  │  上下文快照: [展开查看]                                │
│ 疑似过时 │  完整对话: [打开 LlmLog]                               │
│          │                                                      │
│ 💡 容量  │  ── 生命周期 ──                                       │
│ 建议清理 │  score: 8.2 (衰减后)                                  │
│ 10 条    │  注入 12 次 / 命中 8 次 (命中率 66.7%)                │
│          │  上次命中: 3 天前                                      │
└──────────┴──────────────────────────────────────────────────────┘
```

**核心功能**：

1. **浏览 & 筛选**：按 scope / category / 排序方式 / 关键词搜索，快速定位
2. **批量操作**：勾选多条 → 批量删除、批量编辑 category/tags
3. **内容编辑**：点击记忆 → 右侧面板展开详情 → 直接编辑 content / tags / category
4. **溯源查看**：展开 contextSnapshot 看提取时的对话上下文，或跳转到完整 LlmLog
5. **智能建议**（由 Optimizer 提供）：
   - 可合并的重复记忆（点击一键合并）
   - 疑似过时的记忆（标记高亮）
   - 容量满时的清理建议（按优先级排序，低活跃 auto 记忆优先推荐）
6. **Team 晋升**：选中记忆 → 编辑内容 → **编辑隔离作用域（TeamScope）** → 提交到 feishu-server

#### 5.6.2 实现方式

```typescript
// src/memory/web/server.ts
export namespace MemoryManagerServer {
  export async function start(port = 19836) {
    const app = new Hono()

    // API 层：操作本地 Memory JSON
    app.get("/api/memories", async (c) => { /* list with filters */ })
    app.get("/api/memories/:id", async (c) => { /* detail + contextSnapshot */ })
    app.put("/api/memories/:id", async (c) => { /* update content/tags/category */ })
    app.delete("/api/memories/:id", async (c) => { /* delete */ })
    app.post("/api/memories/batch-delete", async (c) => { /* batch delete */ })
    app.get("/api/memories/:id/llmlog", async (c) => { /* fetch full LlmLog */ })
    app.get("/api/stats", async (c) => { /* count, capacity, category breakdown */ })
    app.get("/api/suggestions", async (c) => { /* optimizer suggestions */ })

    // 前端：单文件 HTML（内嵌 JS/CSS），或 React SPA
    app.get("/", async (c) => c.html(MANAGER_HTML))

    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch })
    log.info("Memory Manager started", { url: `http://localhost:${port}` })
    await open(`http://localhost:${port}`)
    return server
  }
}
```

前端可以是**单文件 HTML**（内嵌 React + Tailwind，打包成一个字符串嵌在代码里），不需要额外的构建步骤或静态文件服务。跟 OpenCode 现有的 log-viewer Web UI 方式一致。

---

## 6. Memory Optimizer（可定制 LLM 分析优化器）

### 6.1 设计理念

Optimizer 的核心是**用 LLM 分析记忆库**，判断哪些记忆该合并、哪些该衰减、哪些有潜力晋升为 Team。**分析策略由一个 Markdown 文件定义**，用户可以提供自己的文件来调整效果。

### 6.2 优化策略模板（optimizer.md）

用户可以在 `.opencode/memory/optimizer.md` 放一个自定义模板。如果不提供，使用内置默认模板。

**默认内置模板**（`src/memory/optimizer/default-strategy.md`）：

```markdown
# Memory Optimization Strategy

## 分析目标
对当前记忆库进行分析，执行以下优化操作。

## 1. 去重与合并
找出内容相似或互补的记忆条目，合并为一条更完整的记忆。
合并规则：
- 同一个技术概念的多种表述 → 合并为最清晰的一条
- 同一工具的不同配置细节 → 合并为一条综合配置说明
- 保留最高 score，useCount 累加

## 2. 过时检测
识别可能已过时的记忆：
- 提到了已被替代的技术/版本
- 与更新的记忆产生矛盾
- 标记为 expiresAt = 7 天后

## 3. 质量提升
改进记忆内容的表达质量：
- 模糊的描述 → 补充具体的技术细节
- 缺少代码示例的 pattern 类 → 添加简短示例
- 过长的描述 → 精简为核心要点

## 4. Team 候选识别
识别具有团队价值的个人记忆：
- 描述的是项目级约定而非个人偏好
- 涉及架构决策、API 规范、编码标准
- score >= 5.0 且 useCount >= 5
→ 标记为 teamCandidate 并说明推荐理由

## 5. 输出格式
对每条记忆输出操作建议：
```json
{
  "actions": [
    { "type": "merge", "ids": ["id1", "id2"], "mergedContent": "..." },
    { "type": "expire", "id": "id3", "reason": "..." },
    { "type": "improve", "id": "id4", "newContent": "..." },
    { "type": "team_candidate", "id": "id5", "reason": "..." },
    { "type": "keep", "id": "id6" }
  ]
}
```
```

**用户自定义示例**（`.opencode/memory/optimizer.md`）：

```markdown
# 我的优化策略

## 特殊规则
- 带有 "react" 标签的记忆永不过期（我们是 React 项目）
- "workflow" 类记忆优先合并（团队流程应该统一）
- score < 3.0 的直接标记过期，不需要等衰减
- Team 候选的条件放宽：useCount >= 3 即可

## 合并优先级
1. 同一文件路径的 citations → 高优合并
2. 同一 category 内的相似内容 → 中优合并
3. 跨 category 的相关内容 → 低优合并

## 额外分析
- 如果发现记忆之间有矛盾，标记为 conflict 并列出矛盾点
- 如果发现某类记忆过多（> 30%），建议精简该类别
```

### 6.3 Optimizer 实现

```typescript
// src/memory/optimizer/optimizer.ts
export namespace MemoryOptimizer {
  const log = Log.create({ service: "memory.optimizer" })

  /**
   * 加载优化策略模板
   * 优先级：用户提供的 .opencode/memory/optimizer.md > 内置默认
   */
  async function loadStrategy(): Promise<string> {
    const userTemplate = path.join(Instance.directory, ".opencode", "memory", "optimizer.md")
    const userContent = await Bun.file(userTemplate).text().catch(() => null)
    if (userContent) {
      log.info("using user-provided optimizer strategy", { path: userTemplate })
      return userContent
    }

    // 读取内置默认模板
    const defaultTemplate = path.join(__dirname, "default-strategy.md")
    return Bun.file(defaultTemplate).text()
  }

  /**
   * 执行 LLM 分析优化
   * @param customTemplatePath 可选的自定义模板路径（CLI --template 参数）
   */
  export async function optimize(customTemplatePath?: string): Promise<OptimizeResult> {
    // 1. 加载策略
    const strategy = customTemplatePath
      ? await Bun.file(customTemplatePath).text()
      : await loadStrategy()

    // 2. 加载所有记忆
    const memories = await Memory.list({ scope: "personal" })
    if (memories.length === 0) return { actions: [], summary: "No memories to optimize." }

    // 3. 构建 LLM prompt
    const prompt = buildOptimizePrompt(strategy, memories)

    // 4. 调用 LLM 分析（使用当前配置的模型，或 fallback 到小模型）
    const config = await Config.get()
    const model = config.memory?.optimizerModel ?? getDefaultSmallModel()
    const result = await llmAnalyze(model, prompt)

    // 5. 解析并执行操作建议
    const actions = parseActions(result)
    const applied = await applyActions(actions, memories)

    log.info("optimize complete", {
      total: memories.length,
      merged: applied.merged,
      expired: applied.expired,
      improved: applied.improved,
      teamCandidates: applied.teamCandidates,
    })

    return applied
  }

  /**
   * 执行衰减计算（纯算法，不需要 LLM）
   */
  export function calculateDecay(memory: Memory.Info): number {
    const now = Date.now()
    const daysSinceUse = memory.lastUsedAt
      ? (now - memory.lastUsedAt) / (1000 * 60 * 60 * 24)
      : (now - memory.createdAt) / (1000 * 60 * 60 * 24)

    const config = Config.getSync()
    const halfLife = config.memory?.decayHalfLife ?? 30

    const decayFactor = Math.pow(0.5, daysSinceUse / halfLife)
    const usageFactor = Math.min(2.0, 1.0 + memory.useCount * 0.1)
    const hitRate = memory.useCount > 0 ? memory.hitCount / memory.useCount : 0
    const hitFactor = 1.0 + hitRate * 0.5

    return memory.score * decayFactor * usageFactor * hitFactor
  }

  /**
   * 容量管控：存储无上限，注入池有上限，不自动淘汰
   *
   * 原则：
   * - 存储层面无硬上限：记忆随便积累，JSON 几百 KB 成本可忽略
   * - 注入池有上限：buildCandidatePool 的 INJECT_POOL_LIMIT = 200
   * - 记忆是用户的资产，系统不能擅自删除
   * - auto-extract 也不阻止写入——提取和注入是分离的
   * - 超出注入池上限时，auto 记忆按 score 截断（由 buildCandidatePool 处理）
   * - 用户侧只做通知：注入池接近满时提醒，满了建议整理
   *
   * 容量告警基于注入池（而非存储量）：
   *   - 80%（160/200）：TUI 提示"注入池快满了，部分低分记忆将不参与注入"
   *   - 100%（200/200）：TUI 强提示 + 引导打开 Memory Manager 整理
   *                       （低分 auto 记忆仍在存储中，只是不进入注入候选池）
   */
  const INJECT_POOL_LIMIT = 200
  const WARN_RATIO = 0.8

  /**
   * 定期维护（session-lifecycle hook 触发，每天最多一次）
   *
   * 职责：
   * 1. 更新衰减分数
   * 2. 注入池容量检查 + 用户通知
   * 3. 检测 team candidates
   */
  export async function maintain() {
    const memories = await Memory.list({ scope: "personal" })

    // 1. 更新衰减分数
    for (const memory of memories) {
      const effectiveScore = calculateDecay(memory)
      await Memory.update(memory.id, { score: effectiveScore })
    }

    // 2. 注入池容量检查
    // 模拟 buildCandidatePool 的候选计算，判断注入池使用率
    const manual = memories.filter(m => m.source.method === "manual")
    const auto = memories.filter(m => m.source.method === "auto" || m.source.method === "promoted")
    const autoSorted = auto.sort((a, b) => b.score - a.score)
    const poolSize = manual.length + Math.min(autoSorted.length, INJECT_POOL_LIMIT - manual.length)

    if (poolSize >= INJECT_POOL_LIMIT) {
      const overflowCount = memories.length - INJECT_POOL_LIMIT
      Bus.publish(MemoryEvent.CapacityFull, {
        stored: memories.length,     // 存储总量（无上限）
        poolSize: INJECT_POOL_LIMIT, // 注入池已满
        overflowCount,               // 被挤出注入池的记忆数
        suggestions: autoSorted
          .slice(-10)  // 得分最低的 10 条 auto 记忆
          .map(m => ({ id: m.id, content: m.content, category: m.category, score: m.score })),
      })
    } else if (poolSize >= INJECT_POOL_LIMIT * WARN_RATIO) {
      Bus.publish(MemoryEvent.CapacityWarning, { stored: memories.length, poolSize, limit: INJECT_POOL_LIMIT })
    }

    log.info("maintain complete", { stored: memories.length, poolSize, limit: INJECT_POOL_LIMIT })
  }

  // 注意：没有 canAdd 限制，没有存储上限。auto-extract 和 manual 都始终允许写入。
  // 超出注入池上限时，低分 auto 记忆不进入候选池（由 buildCandidatePool 处理），
  // 但数据永久保留在存储中，score 回升后可重新进入注入池。

  // Hook 注册
  export function register() {
    HookChain.register("memory-optimizer", "session-lifecycle", 210, async (ctx) => {
      if (ctx.event !== "session.created") return

      const lastMaintain = await Memory.getMeta("lastMaintainAt")
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
      if (lastMaintain && lastMaintain > oneDayAgo) return

      await maintain()
      await MemoryConfirmation.checkPendingMemories()  // pending 转正检查
      await detectTeamCandidates()
      await Memory.setMeta("lastMaintainAt", Date.now())
    })
  }
}
```

### 6.4 Team 候选自动发现

在 Optimizer 运行时，除了 LLM 分析建议外，还有一个基于规则的自动检测：

```typescript
async function detectTeamCandidates() {
  const memories = await Memory.list({ scope: "personal" })
  const config = await Config.get()
  const threshold = config.memory?.promotionThreshold ?? {
    minScore: 5.0,
    minUseCount: 5,
    minAgeInDays: 7,
  }

  const candidates: Memory.Info[] = []

  for (const m of memories) {
    if (m.teamCandidateAt) continue  // 已经是候选了
    if (m.category === "correction") continue  // 纠正类不晋升

    const ageInDays = (Date.now() - m.createdAt) / (1000 * 60 * 60 * 24)
    if (
      m.score >= threshold.minScore &&
      m.useCount >= threshold.minUseCount &&
      ageInDays >= threshold.minAgeInDays
    ) {
      await Memory.update(m.id, { teamCandidateAt: Date.now() })
      candidates.push(m)
    }
  }

  // 如果有新候选，在下次 TUI 启动时提醒用户
  if (candidates.length > 0) {
    Bus.publish(MemoryEvent.TeamCandidatesFound, {
      count: candidates.length,
      memories: candidates.map(m => ({ id: m.id, content: m.content, category: m.category })),
    })
  }
}
```

用户看到的提醒：

```
💡 发现 3 条高质量个人记忆可能适合分享给团队：
   1. [style] 不使用分号，printWidth: 120 (score: 8.2, 使用 12 次)
   2. [pattern] 错误处理统一用 NamedError.create() (score: 7.5, 使用 8 次)
   3. [tool] 测试使用 bun run test:parallel (score: 9.0, 使用 15 次)
   输入 /promote <id> 提交到团队，或 /promote all 全部提交
```

---

## 7. Team Sync：feishu-server + 飞书账号审批

### 7.1 设计理念

Team Memory Server 作为独立服务 **feishu-server** 部署，核心思路：

1. **飞书账号即团队身份**：直接使用飞书组织架构（部门、群组）管理 Team Memory 的权限，无需额外的账号体系
2. **飞书卡片即审批流**：Memory 提交后以交互式卡片发送到指定飞书群，审核者直接在卡片上点击"通过/拒绝/修改"，零学习成本
3. **飞书机器人即通知**：审批结果、新记忆生效、候选提醒全部通过飞书消息推送
4. **独立部署**：feishu-server 作为单独项目，opencode 通过 REST API 对接，与 opencode 本体解耦
5. **多维隔离**：Team Memory 通过 5 个维度精准控制作用范围，避免无关记忆污染上下文

### 7.1.1 多维隔离体系

团队记忆的复杂性在于：同一个团队可能有多个项目、多种语言、不同技术选型、不同模块，记忆的适用范围差异很大。如果不做隔离，Python 项目会收到 TypeScript 的代码风格建议，前端模块会收到后端的架构约定。

**5 个隔离维度**：

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Team Memory 隔离维度                              │
├──────────┬───────────────────────┬───────────────────────────────────────┤
│ 维度     │ 含义                   │ 示例                                 │
├──────────┼───────────────────────┼───────────────────────────────────────┤
│ global   │ 全局通用，无条件生效     │ "commit message 使用英文"             │
│          │                        │ "PR 必须关联 issue"                   │
│          │                        │ "不允许直接 push main 分支"            │
├──────────┼───────────────────────┼───────────────────────────────────────┤
│ project  │ 特定项目专属             │ "opencode 的 TUI 用 Ink 渲染"        │
│          │                        │ "billing-service 的 API 前缀是 /v2"  │
├──────────┼───────────────────────┼───────────────────────────────────────┤
│ language │ 编程语言相关             │ "TypeScript 不使用 any"              │
│          │                        │ "Python 用 ruff 做 lint"             │
│          │                        │ "Go 错误处理不使用 panic"             │
├──────────┼───────────────────────┼───────────────────────────────────────┤
│ techStack│ 技术选型/框架/工具链     │ "HTTP 路由统一用 Hono"               │
│          │                        │ "ORM 统一用 Drizzle"                 │
│          │                        │ "测试用 vitest 而非 jest"            │
├──────────┼───────────────────────┼───────────────────────────────────────┤
│ module   │ 项目内模块/目录          │ "src/tui/ 下组件用 function 组件"    │
│          │                        │ "packages/sdk/ 导出必须有 JSDoc"     │
└──────────┴───────────────────────┴───────────────────────────────────────┘
```

**匹配规则**：

```typescript
// src/memory/engine/team-scope-matcher.ts
export namespace TeamScopeMatcher {

  /**
   * 判断一条 Team Memory 是否匹配当前项目上下文
   *
   * 规则：
   *   - global: true → 无条件匹配
   *   - 非空维度之间是 AND 关系（所有非空维度都必须匹配）
   *   - 维度内多个值是 OR 关系（满足其一即可）
   *   - 空数组 = 该维度不做过滤
   */
  export function matches(
    scope: Memory.TeamScope,
    context: ProjectContext,
  ): boolean {
    // 全局记忆，无条件匹配
    if (scope.global) return true

    // 检查每个非空维度
    if (scope.projectIds.length > 0) {
      if (!scope.projectIds.includes(context.projectId)) return false
    }
    if (scope.languages.length > 0) {
      if (!scope.languages.some(l => context.languages.includes(l))) return false
    }
    if (scope.techStack.length > 0) {
      if (!scope.techStack.some(t => context.techStack.includes(t))) return false
    }
    if (scope.modules.length > 0) {
      // 模块匹配使用路径前缀：当前工作路径以某个 module 开头即匹配
      if (!scope.modules.some(m => context.currentModulePath?.startsWith(m))) return false
    }

    // 所有非空维度都匹配通过（全空 = 无任何约束 = 匹配）
    return true
  }
}
```

### 7.1.2 项目上下文自动检测

客户端在启动时自动检测当前项目的上下文信息，用于 Team Memory 的维度过滤和 Pull API 请求参数：

```typescript
// src/memory/engine/project-context.ts
export namespace ProjectContext {

  export const Info = z.object({
    projectId: z.string(),                    // 项目标识（目录名 或 opencode.json 中声明）
    languages: z.array(z.string()),           // 检测到的编程语言
    techStack: z.array(z.string()),           // 检测到的技术栈/框架/工具
    currentModulePath: z.string().optional(), // 当前工作路径（相对项目根目录）
  })
  export type Info = z.infer<typeof Info>

  /**
   * 从项目结构自动推断上下文
   * 优先使用 opencode.json 中的显式声明，其次自动检测
   */
  export async function detect(): Promise<Info> {
    const config = await Config.get()
    const projectRoot = Instance.current().root

    // 1. projectId：优先用配置声明，其次用目录名
    const projectId = config.memory?.projectId
      ?? path.basename(projectRoot)

    // 2. languages：自动检测
    const languages = config.memory?.languages
      ?? await detectLanguages(projectRoot)

    // 3. techStack：自动检测
    const techStack = config.memory?.techStack
      ?? await detectTechStack(projectRoot)

    // 4. currentModulePath：从当前 cwd 推断
    const cwd = process.cwd()
    const currentModulePath = cwd.startsWith(projectRoot)
      ? path.relative(projectRoot, cwd)
      : undefined

    return { projectId, languages, techStack, currentModulePath }
  }

  /**
   * 从文件扩展名和配置文件检测语言
   */
  async function detectLanguages(root: string): Promise<string[]> {
    const langs: Set<string> = new Set()
    const checks: [string, string][] = [
      ["tsconfig.json",      "typescript"],
      ["package.json",       "typescript"],   // 后续通过内容判断 ts/js
      ["pyproject.toml",     "python"],
      ["requirements.txt",   "python"],
      ["go.mod",             "go"],
      ["Cargo.toml",         "rust"],
      ["pom.xml",            "java"],
      ["build.gradle",       "java"],
      ["*.swift",            "swift"],
      [".dart_tool",         "dart"],
    ]
    for (const [file, lang] of checks) {
      if (await fileExists(path.join(root, file))) langs.add(lang)
    }
    // package.json 细化：如果有 tsconfig.json 则为 typescript，否则为 javascript
    if (langs.has("typescript") && !await fileExists(path.join(root, "tsconfig.json"))) {
      langs.delete("typescript")
      langs.add("javascript")
    }
    return [...langs]
  }

  /**
   * 从依赖文件检测技术选型
   */
  async function detectTechStack(root: string): Promise<string[]> {
    const stack: Set<string> = new Set()

    // Node.js 依赖
    const pkgPath = path.join(root, "package.json")
    if (await fileExists(pkgPath)) {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"))
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      }
      // 常见框架/工具映射
      const depMap: Record<string, string> = {
        "hono": "hono", "express": "express", "fastify": "fastify", "koa": "koa",
        "react": "react", "vue": "vue", "svelte": "svelte", "next": "nextjs",
        "drizzle-orm": "drizzle", "prisma": "prisma", "typeorm": "typeorm",
        "vitest": "vitest", "jest": "jest", "mocha": "mocha",
        "tailwindcss": "tailwind", "ink": "ink",
        "bun-types": "bun",
      }
      for (const [dep, name] of Object.entries(depMap)) {
        if (dep in allDeps) stack.add(name)
      }
    }

    // Python 依赖
    const pyprojectPath = path.join(root, "pyproject.toml")
    if (await fileExists(pyprojectPath)) {
      const content = await fs.readFile(pyprojectPath, "utf-8")
      const pyDepMap: Record<string, string> = {
        "fastapi": "fastapi", "django": "django", "flask": "flask",
        "pytest": "pytest", "sqlalchemy": "sqlalchemy",
        "pydantic": "pydantic", "ruff": "ruff",
      }
      for (const [dep, name] of Object.entries(pyDepMap)) {
        if (content.includes(dep)) stack.add(name)
      }
    }

    return [...stack]
  }
}
```

**用户也可以在 `opencode.json` 显式声明**，覆盖自动检测：

```jsonc
// opencode.json
{
  "memory": {
    "projectId": "opencode",               // 覆盖自动检测的 projectId
    "languages": ["typescript"],            // 覆盖自动检测的语言
    "techStack": ["hono", "drizzle", "bun", "ink"],  // 覆盖自动检测的技术选型
    // currentModulePath 始终由运行时推断，不可配置
  }
}
```

### 7.2 feishu-server 架构

```
feishu-server/                        # 独立项目
├── src/
│   ├── app.ts                        # Hono HTTP 服务入口
│   ├── auth/
│   │   ├── feishu-oauth.ts           # 飞书 OAuth2 登录（用于 Web 管理页）
│   │   ├── feishu-identity.ts        # 从飞书 user_access_token 提取用户身份
│   │   └── api-token.ts              # opencode CLI 用的 API Token（绑定飞书账号）
│   ├── memory/
│   │   ├── store.ts                  # Team Memory CRUD（双写：关系型 DB + OpenViking）
│   │   ├── viking-client.ts          # OpenViking REST API 客户端（写入 + 检索）
│   │   ├── submit.ts                 # 提交接口 + 触发飞书审批卡片
│   │   ├── review.ts                 # 审批逻辑（来自飞书卡片回调）+ 审批通过后写入 OpenViking
│   │   └── pull.ts                   # 拉取已审批记忆（通过 OpenViking 检索 + 维度过滤）
│   ├── feishu/
│   │   ├── bot.ts                    # 飞书机器人（发消息、发卡片）
│   │   ├── card-builder.ts           # 审批卡片模板构建
│   │   ├── card-callback.ts          # 卡片交互回调处理
│   │   └── webhook.ts               # 飞书事件订阅（可选）
│   ├── notify/
│   │   ├── daily-upstream.ts         # 复用已有的每日 upstream check 通知
│   │   └── memory-events.ts          # 记忆事件通知（提交、审批、生效）
│   └── web/
│       ├── dashboard.tsx             # 管理后台（Team Memory 列表、统计）
│       └── review-page.tsx           # Web 审批页面（飞书卡片的补充）
├── db/
│   └── schema.sql                    # 关系型 DB schema（审批状态、用户信息等元数据）
├── viking/
│   └── docker-compose.viking.yml     # OpenViking 服务配置
├── deploy/
│   ├── Dockerfile
│   └── docker-compose.yml            # 包含 feishu-server + OpenViking 服务编排
└── package.json
```

### 7.2.1 OpenViking 集成：Team Memory 存储与检索

**为什么引入 OpenViking**：

当团队记忆积累到数百甚至上千条时，纯 LLM recall 的方式面临两个问题：一是全量记忆塞入 recall prompt 的 token 成本增长，二是 LLM 在大量候选中做语义匹配的精度下降。OpenViking（字节火山引擎开源的 AI Agent 上下文数据库）提供了**文件系统范式 + 向量语义检索 + 分层加载**的能力，非常适合 Team Memory 的存储和检索场景。

**定位**：OpenViking 作为 feishu-server 的存储后端之一，负责 Team Memory 的**语义索引和检索**。关系型数据库（SQLite/PostgreSQL）仍然保留，负责**审批状态、用户信息、元数据管理**。

```
┌─────────────────────────────────────────────────────────────────┐
│                     feishu-server                                │
├──────────────────┬──────────────────┬───────────────────────────┤
│  关系型 DB       │  OpenViking      │  飞书 API                  │
│  (审批元数据)    │  (语义存储+检索)  │  (认证+通知+审批)          │
├──────────────────┼──────────────────┼───────────────────────────┤
│ • 审批状态       │ • 记忆内容       │ • OAuth2 登录              │
│ • 用户身份       │ • 向量索引       │ • 审批卡片                 │
│ • 提交/审批记录  │ • 目录层级       │ • 消息通知                 │
│ • teamScope 元数据│ • 语义检索      │                            │
└──────────────────┴──────────────────┴───────────────────────────┘
```

**OpenViking 目录结构映射**：

5 个隔离维度映射为 OpenViking 的 `viking://` 目录层级。每条团队记忆根据其 `teamScope` **多挂载**到对应的目录下（类似文件系统的硬链接）：

```
viking://team-memory/
├── _global/                          # global: true 的记忆
│   ├── commit-english.md             # "commit message 使用英文"
│   └── pr-must-link-issue.md
├── projects/                         # projectIds 维度
│   ├── opencode/
│   │   └── tui-uses-ink.md
│   └── billing-service/
│       └── api-prefix-v2.md
├── languages/                        # languages 维度
│   ├── typescript/
│   │   ├── no-any-type.md
│   │   └── use-zod-validation.md
│   └── python/
│       ├── use-ruff-lint.md
│       └── type-hints-required.md
├── techstack/                        # techStack 维度
│   ├── hono/
│   │   └── route-pattern.md
│   ├── drizzle/
│   │   └── schema-convention.md
│   └── react/
│       └── function-components.md
└── modules/                          # modules 维度
    ├── opencode--src--tui/
    │   └── ink-component-pattern.md
    └── opencode--packages--sdk/
        └── jsdoc-required.md
```

**写入流程**（审批通过后触发）：

```typescript
// feishu-server/src/memory/viking-client.ts
export namespace VikingClient {
  const VIKING_BASE = process.env.VIKING_URL ?? "http://localhost:8000"

  /**
   * 审批通过后，将记忆写入 OpenViking
   * 根据 teamScope 多挂载到对应的目录
   */
  export async function writeMemory(memory: ApprovedTeamMemory) {
    const scope = memory.teamScope
    const dirs = resolveDirectories(scope)

    for (const dir of dirs) {
      await fetch(`${VIKING_BASE}/api/v1/files`, {
        method: "POST",
        body: JSON.stringify({
          path: `${dir}/${memory.id}.md`,
          content: formatMemoryContent(memory),
          metadata: {
            id: memory.id,
            category: memory.category,
            tags: memory.tags,
            teamScope: scope,
            approvedAt: memory.approvedAt,
          },
        }),
      })
    }
  }

  /**
   * 将 teamScope 转换为 OpenViking 目录列表
   * 一条记忆可能挂载到多个目录（多维度）
   */
  function resolveDirectories(scope: TeamScope): string[] {
    if (scope.global) return ["viking://team-memory/_global"]

    const dirs: string[] = []
    for (const pid of scope.projectIds) {
      dirs.push(`viking://team-memory/projects/${pid}`)
    }
    for (const lang of scope.languages) {
      dirs.push(`viking://team-memory/languages/${lang}`)
    }
    for (const tech of scope.techStack) {
      dirs.push(`viking://team-memory/techstack/${tech}`)
    }
    for (const mod of scope.modules) {
      dirs.push(`viking://team-memory/modules/${mod.replace(/\//g, "--")}`)
    }
    // 无任何维度约束 → 等同全局
    if (dirs.length === 0) dirs.push("viking://team-memory/_global")
    return dirs
  }
}
```

**检索流程**（客户端 Pull 时触发）：

```typescript
// feishu-server/src/memory/pull.ts
export async function pullTeamMemories(params: PullParams): Promise<TeamMemory[]> {
  // 1. 确定搜索目录：根据客户端 ProjectContext 构建搜索范围
  const searchDirs = [
    "viking://team-memory/_global",  // 全局永远搜
  ]
  if (params.projectId) {
    searchDirs.push(`viking://team-memory/projects/${params.projectId}`)
  }
  for (const lang of params.languages ?? []) {
    searchDirs.push(`viking://team-memory/languages/${lang}`)
  }
  for (const tech of params.techStack ?? []) {
    searchDirs.push(`viking://team-memory/techstack/${tech}`)
  }
  if (params.module) {
    searchDirs.push(`viking://team-memory/modules/${params.module.replace(/\//g, "--")}`)
  }

  // 2. OpenViking 目录递归检索
  //    利用 L0(目录) → L1(摘要) → L2(完整内容) 分层加载
  //    服务端完成向量语义匹配，返回排序后的结果
  const results = await fetch(`${VIKING_BASE}/api/v1/search`, {
    method: "POST",
    body: JSON.stringify({
      directories: searchDirs,
      query: params.contextHint,  // 可选：客户端传递当前会话主题摘要
      since: params.since,        // 增量过滤
      limit: 200,                 // 最多返回 200 条
    }),
  })

  // 3. 从关系型 DB 补充审批元数据
  const items = await results.json()
  return enrichWithMetadata(items)
}
```

**与 memory-recall agent 的分工**：

```
服务端（OpenViking）            客户端（memory-recall agent）
─────────────────────          ────────────────────────────
✅ 向量语义检索（快）            ✅ LLM 语义精排（准）
✅ 目录维度预过滤                ✅ 冲突检测（memory vs 当前上下文）
✅ L0/L1/L2 分层加载             ✅ 去除不相关记忆（负过滤）
✅ 增量同步（since）             ✅ 与个人记忆合并注入
✅ 大规模记忆支持（千+条）       ✅ 最终注入决策
```

OpenViking 做"粗筛 + 排序"（结构化维度 + 向量语义），recall agent 做"精排 + 冲突检测"（LLM 理解）。当 Team Memory 量小（< 100 条）时 OpenViking 的优势不明显，但当积累到数百上千条时，这种分层过滤的价值很大。

**部署方式**：

```yaml
# deploy/docker-compose.yml
services:
  feishu-server:
    build: .
    ports: ["3000:3000"]
    depends_on: [openviking, postgres]
    environment:
      VIKING_URL: http://openviking:8000
      DATABASE_URL: postgres://...

  openviking:
    image: volcengine/openviking:latest
    ports: ["8000:8000"]
    volumes:
      - viking-data:/data
    environment:
      # embedding 模型配置（OpenViking 需要）
      EMBEDDING_PROVIDER: openai  # 或 volcengine / litellm
      EMBEDDING_MODEL: text-embedding-3-small
      EMBEDDING_API_KEY: ${EMBEDDING_API_KEY}
      # VLM 非必须（Team Memory 是纯文本，不需要视觉理解）

  postgres:
    image: postgres:16
    volumes:
      - pg-data:/var/lib/postgresql/data
```

### 7.3 飞书身份集成

```typescript
// feishu-server/src/auth/feishu-identity.ts

/**
 * 飞书用户身份解析
 * opencode CLI 通过 `opencode auth login --provider feishu-team` 获取 API Token
 * 该 Token 绑定飞书用户 open_id
 */
export namespace FeishuIdentity {

  export interface User {
    openId: string           // 飞书 open_id
    unionId: string          // 跨应用 union_id
    name: string             // 飞书姓名
    avatarUrl: string
    departmentIds: string[]  // 所属部门（用于权限判断）
  }

  // opencode CLI 首次连接时的登录流程：
  // 1. opencode 打开浏览器 → feishu-server/auth/login
  // 2. 飞书 OAuth2 授权 → 获取 user_access_token
  // 3. feishu-server 生成 API Token → 返回给 opencode CLI
  // 4. opencode 存储 API Token 到 Auth.set("feishu-team", { type: "api", key: token })

  // 权限判断：谁能审批 Team Memory？
  // 配置方式：feishu-server config 中指定 reviewer 的飞书群 chat_id 或部门 department_id
  export function isReviewer(user: User, config: TeamConfig): boolean {
    if (config.reviewerOpenIds?.includes(user.openId)) return true
    if (config.reviewerDepartments?.some(d => user.departmentIds.includes(d))) return true
    return false
  }
}
```

### 7.4 飞书审批卡片

Memory 提交后，feishu-server 向指定审批群发送交互式卡片：

```typescript
// feishu-server/src/feishu/card-builder.ts
export function buildReviewCard(memory: TeamMemorySubmission): FeishuCardMessage {
  return {
    msg_type: "interactive",
    card: {
      header: {
        title: { tag: "plain_text", content: "📝 Team Memory 审批" },
        template: "blue",
      },
      elements: [
        // 记忆内容
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**[${memory.category}]** ${memory.content}`,
          },
        },
        // 元信息
        {
          tag: "div",
          fields: [
            { is_short: true, text: { tag: "lark_md", content: `**提交者**\n${memory.submitterName}` } },
            { is_short: true, text: { tag: "lark_md", content: `**标签**\n${memory.tags.join(", ")}` } },
          ],
        },
        // 隔离维度信息
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**适用范围**\n${formatTeamScope(memory.teamScope)}`,
            // 示例输出: "🌍 全局" 或 "📂 opencode | 🔤 TypeScript | 🛠 hono, drizzle"
          },
        },
        // 上下文摘要（折叠）
        {
          tag: "collapsible_panel",
          expanded: false,
          header: { title: { tag: "plain_text", content: "📎 对话上下文" } },
          elements: [{
            tag: "div",
            text: { tag: "lark_md", content: memory.sourceContext?.slice(0, 500) ?? "无" },
          }],
        },
        // 分隔线
        { tag: "hr" },
        // 审批按钮
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "✅ 通过" },
              type: "primary",
              value: { action: "approve", memoryId: memory.id },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "✏️ 修改后通过" },
              type: "default",
              value: { action: "revise", memoryId: memory.id },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "❌ 拒绝" },
              type: "danger",
              value: { action: "reject", memoryId: memory.id },
            },
          ],
        },
      ],
    },
  }
}
```

**飞书卡片效果示意**：

```
┌─────────────────────────────────────────────┐
│  📝 Team Memory 审批                        │
├─────────────────────────────────────────────┤
│  [pattern] 错误处理统一使用                  │
│  NamedError.create(name, schema) 模式        │
│                                              │
│  提交者: alice       标签: error, pattern     │
│                                              │
│  适用范围: 🔤 TypeScript | 🛠 hono, drizzle  │
│                                              │
│  ▸ 📎 对话上下文（点击展开）                 │
│                                              │
│  ─────────────────────────────────────────── │
│  [✅ 通过]  [✏️ 修改后通过]  [❌ 拒绝]       │
└─────────────────────────────────────────────┘
```

### 7.5 卡片回调处理

审核者点击按钮后，飞书将回调发送到 feishu-server：

```typescript
// feishu-server/src/feishu/card-callback.ts
export async function handleCardAction(payload: FeishuCardCallback) {
  const { action, memoryId } = payload.action.value
  const reviewer = await FeishuIdentity.fromToken(payload.operator.open_id)

  if (!FeishuIdentity.isReviewer(reviewer, config)) {
    // 非审核者点击 → 返回 toast 提示
    return { toast: { type: "info", content: "仅团队管理者可审批" } }
  }

  switch (action) {
    case "approve":
      await MemoryReview.approve(memoryId, reviewer)
      // 通知提交者
      await FeishuBot.sendToUser(memory.submitterOpenId,
        `✅ 你提交的 Team Memory 已通过：\n"${memory.content}"`)
      // 更新卡片状态（替换按钮为"已通过"）
      return updateCardToApproved(reviewer.name)

    case "reject":
      // 弹出输入框让审核者填写拒绝理由
      return {
        type: "form",
        form: {
          elements: [{
            tag: "input",
            name: "reason",
            placeholder: { content: "请输入拒绝理由" },
          }],
          confirm: {
            title: { content: "确认拒绝" },
          },
        },
      }

    case "revise":
      // 弹出输入框让审核者修改内容
      return {
        type: "form",
        form: {
          elements: [{
            tag: "textarea",
            name: "revisedContent",
            default_value: memory.content,
            placeholder: { content: "修改记忆内容后通过" },
          }],
        },
      }
  }
}
```

### 7.6 feishu-server REST API

opencode CLI 通过以下 API 与 feishu-server 交互：

```
# 认证
GET  /auth/login                    → 跳转飞书 OAuth2
GET  /auth/callback                 → OAuth2 回调，生成 API Token
POST /auth/token/refresh            → 刷新 Token

# Memory CRUD
POST /api/memory/submit             → 提交记忆到审批队列（body 含 teamScope）
GET  /api/memory/team               → 拉取已审批的团队记忆（支持多维过滤，见下方）
GET  /api/memory/pending            → 查看待审批列表（审核者）
GET  /api/memory/status/<id>        → 查看单条记忆审批状态
POST /api/memory/review/<id>        → Web 端审批（飞书卡片的补充）

# 飞书回调
POST /feishu/card-callback          → 飞书卡片交互回调
POST /feishu/event                  → 飞书事件订阅回调（可选）

# 管理
GET  /api/admin/stats               → 统计数据
GET  /api/admin/memories            → 所有记忆列表（含历史）
DELETE /api/admin/memory/<id>       → 删除记忆（管理者）
```

**Team Memory Pull API 详细设计**：

```
GET /api/memory/team
  ?since=<timestamp>              # 增量拉取基准时间
  &projectId=opencode             # 当前项目标识
  &languages=typescript,python    # 逗号分隔的语言列表
  &techStack=hono,drizzle,bun     # 逗号分隔的技术栈列表
  &module=packages/opencode/src   # 当前工作模块路径
```

**服务端过滤逻辑**（两阶段）：

```typescript
// feishu-server/src/memory/pull.ts
export async function pullTeamMemories(params: PullParams): Promise<TeamMemory[]> {
  // Phase 1: 时间增量过滤 — 只取 since 之后审批通过的
  let memories = await db.query(
    `SELECT * FROM team_memories WHERE status = 'approved' AND approved_at > ?`,
    [params.since ?? 0]
  )

  // Phase 2: 维度过滤 — 在服务端完成，减少网络传输
  // 返回：global 记忆 + 匹配任一维度的记忆
  return memories.filter(m => {
    const scope = m.teamScope
    // 全局记忆无条件返回
    if (scope.global) return true
    // 无任何维度约束 = 全局等效
    if (isEmpty(scope)) return true
    // 维度匹配（AND 逻辑，与客户端 TeamScopeMatcher 一致）
    return TeamScopeMatcher.matches(scope, {
      projectId: params.projectId,
      languages: params.languages,
      techStack: params.techStack,
      currentModulePath: params.module,
    })
  })
}
```

**设计要点**：服务端做"宽松预过滤"（结构化维度匹配），客户端 memory-recall agent 做"精准精排"（语义判断 + 冲突检测）。即使服务端过滤放行了一些边界 case，recall agent 也会在注入前做最终语义把关。

### 7.7 晋升完整流程

```
┌──────────────────────────────────────────────────────────────────┐
│  Phase 1: 自动发现候选（Optimizer 触发）                           │
│                                                                   │
│  个人记忆 score >= 5.0 && useCount >= 5 && age >= 7 天            │
│  OR Optimizer LLM 分析建议 team_candidate                         │
│        ↓                                                          │
│  标记 teamCandidateAt，TUI 通知用户                                │
│  "💡 发现 3 条记忆适合分享给团队"                                   │
└───────────────────────┬──────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────────┐
│  Phase 2: 用户确认 + 编辑（在 Memory Manager Web 完成）             │
│                                                                   │
│  用户执行 /memory:promote <id> → 打开 Web promote 页面            │
│        ↓                                                          │
│  展示记忆内容 + 溯源上下文                                         │
│  用户编辑隔离作用域（TeamScope）：                                  │
│    ☑ 全局通用    □ 项目: [opencode]                                │
│    ☑ 语言: [typescript]    ☑ 技术栈: [hono, drizzle]              │
│    □ 模块: []                                                      │
│  用户可以：                                                        │
│    a) 确认作用域 + 直接提交                                        │
│    b) 编辑内容 + 作用域后提交                                      │
│    c) 取消                                                         │
└───────────────────────┬──────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────────┐
│  Phase 3: 上传到 feishu-server                                    │
│                                                                   │
│  POST /api/memory/submit（携带飞书 API Token 认证）                │
│  body: { content, category, tags, teamScope, sourceContext }      │
│  teamScope 即用户在 Web promote 页面编辑的隔离作用域               │
│  feishu-server 收到后：                                            │
│    1. 存入数据库（status: pending, teamScope 一同存储）            │
│    2. 向审批飞书群发送交互式卡片（展示适用范围）                    │
│    3. 返回 memory ID                                              │
│  本地标记 teamSubmittedAt                                          │
└───────────────────────┬──────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────────┐
│  Phase 4: 飞书群内审批                                             │
│                                                                   │
│  审核者在飞书群看到卡片，直接点击按钮：                              │
│    ✅ 通过 → memory 状态变为 approved，通知提交者                   │
│    ✏️ 修改后通过 → 弹出编辑框，审核者优化措辞后通过                  │
│    ❌ 拒绝 → 弹出理由输入框，填写后拒绝，通知提交者                  │
│                                                                   │
│  也可通过 feishu-server Web Dashboard 审批（大批量时更方便）        │
└───────────────────────┬──────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────────┐
│  Phase 5: 全员自动拉取                                             │
│                                                                   │
│  团队其他成员的 opencode 启动时：                                   │
│    自动检测 ProjectContext（projectId, languages, techStack）       │
│    GET /api/memory/team?since=<ts>&projectId=X&languages=Y&...   │
│    服务端按维度预过滤 → 增量拉取匹配的团队记忆 → 本地缓存          │
│  下次 pre-llm 时注入到 prompt（Team Conventions 区块）             │
│                                                                   │
│  提交者也会收到飞书消息：                                           │
│    "✅ 你的 Team Memory 已通过审批并生效"                           │
│    "❌ 你的 Team Memory 被拒绝：理由 xxx"                           │
└──────────────────────────────────────────────────────────────────┘
```

### 7.8 opencode 侧客户端

```typescript
// src/memory/sync/feishu-team.ts
export namespace FeishuTeamSync {
  const log = Log.create({ service: "memory.feishu-team" })

  /**
   * 首次登录：引导用户通过飞书 OAuth 获取 API Token
   */
  export async function login() {
    const config = await Config.get()
    const serverUrl = config.memory?.teamServerUrl
    if (!serverUrl) throw new Error("memory.teamServerUrl not configured")

    // 打开浏览器进行飞书 OAuth
    const loginUrl = `${serverUrl}/auth/login?redirect=cli`
    await open(loginUrl)

    // 等待用户完成授权（通过本地 HTTP callback 接收 token）
    const token = await waitForOAuthCallback()
    await Auth.set("feishu-team", { type: "api", key: token })
    log.info("feishu team login complete")
  }

  /**
   * 提交记忆
   */
  export async function submit(memory: Memory.Info, editedContent?: string, teamScope?: Memory.TeamScope) {
    const config = await Config.get()
    const serverUrl = config.memory?.teamServerUrl
    const auth = await Auth.get("feishu-team")
    if (!auth || auth.type !== "api") {
      throw new Error("请先执行 opencode auth login --provider feishu-team 登录飞书")
    }

    const res = await fetch(`${serverUrl}/api/memory/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${auth.key}`,
      },
      body: JSON.stringify({
        content: editedContent ?? memory.content,
        category: memory.category,
        tags: memory.tags,
        citations: memory.citations,
        teamScope: teamScope,  // 用户在 Web promote 页面编辑的隔离作用域
        sourceContext: memory.source.contextSnapshot?.slice(0, 2000),
      }),
    })

    if (!res.ok) throw new Error(`submit failed: ${res.status}`)
    const result = await res.json()

    await Memory.update(memory.id, { teamSubmittedAt: Date.now() })
    log.info("submitted to feishu team server", { memoryId: memory.id, remoteId: result.id })
    return result
  }

  /**
   * 增量拉取已审批的团队记忆
   * 携带当前项目上下文，服务端按维度预过滤后返回匹配的记忆
   */
  export async function pull() {
    const config = await Config.get()
    const serverUrl = config.memory?.teamServerUrl
    if (!serverUrl) {
      log.info("team server not configured, skip pull")
      return
    }

    const auth = await Auth.get("feishu-team")
    if (!auth) {
      log.info("feishu team not authenticated, skip pull")
      return
    }

    try {
      // 检测当前项目上下文，作为 Pull API 的维度过滤参数
      const ctx = await ProjectContext.detect()
      const lastPull = await Memory.getMeta("lastTeamPullAt")

      const params = new URLSearchParams()
      if (lastPull) params.set("since", String(lastPull))
      params.set("projectId", ctx.projectId)
      if (ctx.languages.length) params.set("languages", ctx.languages.join(","))
      if (ctx.techStack.length) params.set("techStack", ctx.techStack.join(","))
      if (ctx.currentModulePath) params.set("module", ctx.currentModulePath)

      const url = `${serverUrl}/api/memory/team?${params.toString()}`
      const res = await fetch(url, {
        headers: { "Authorization": `Bearer ${auth.key}` },
      })

      if (!res.ok) throw new Error(`pull failed: ${res.status}`)
      const items = await res.json()

      for (const item of items) {
        await Memory.upsert({
          id: `team_${item.id}`,
          content: item.content,
          category: item.category,
          scope: "team",
          tags: item.tags,
          citations: item.citations,
          teamScope: item.teamScope,  // 保留隔离作用域，供 recall agent 参考
          source: { sessionID: "", method: "pulled" },
          score: 10.0,  // Team 记忆满分，不衰减
          createdAt: item.approvedAt,
          updatedAt: item.approvedAt,
        })
      }

      await Memory.setMeta("lastTeamPullAt", Date.now())
      log.info("pulled team memories", {
        count: items.length,
        projectId: ctx.projectId,
        languages: ctx.languages,
        techStack: ctx.techStack,
      })
    } catch (err) {
      log.warn("team server unreachable, using cached team memory", { error: err })
    }
  }
}
```

### 7.9 降级策略

```
feishu-server 不可达：
  ├── Personal Memory → 完全不受影响（纯本地）
  ├── Team Memory → 使用本地缓存（上次 pull 的结果）
  ├── /promote → 提示"服务不可达，记忆保持为候选状态"
  └── pull → 静默跳过，使用缓存

feishu-server 未配置（teamServerUrl 为空）：
  ├── Team 相关功能全部隐藏
  ├── /promote → 提示"请配置 memory.teamServerUrl"
  └── 其他功能正常
```

---

## 8. 集成点与 Hook 注册

### 8.1 Hook 优先级全景

```
Pre-LLM Chain:
  100  directory-agents-injector     (existing)
  110  directory-readme-injector     (existing)
  120  rules-injector               (existing)
  130  memory-injector              ★ NEW: 调用 memory-recall agent 过滤 + 冲突检测 + 注入
  200  (removed — 不再使用正则信号检测)
  999  llm-log-capture              (existing)

Post-Tool Chain:
  0    llm-log-tool-finish          (existing)
  200  (removed — 合并到 session-end 提取)
  210  memory-hit-tracker           ★ NEW: 更新命中计数

Session-Lifecycle Chain:
  100  compaction-context-injector  (existing)
  110  compaction-todo-preserver    (existing)
  200  memory-extract-session-end   ★ NEW: compaction 时 LLM 上下文提取 → pending
  210  memory-extract-recovery     ★ NEW: session 恢复时检查 + 异步补提取（幂等）
  210  memory-optimizer             ★ NEW: 定期衰减 + pending 转正检查 + team 候选检测
  999  llm-log-response-capture     (existing)
```

### 8.2 Config 扩展

```typescript
// opencode.json 新增配置项
{
  "memory": {
    "enabled": true,                  // 总开关
    "autoExtract": true,              // 自动提取
    "autoOptimize": true,             // 自动整理（衰减+候选检测）
    "injectLimit": 2000,              // 注入 token 上限
    "decayHalfLife": 30,              // 衰减半衰期（天）
    "injectPoolLimit": 200,            // 注入池上限（存储无上限）
    "teamLimit": 100,                 // 团队记忆本地缓存上限
    "recallModel": null,              // 记忆召回 agent 的模型（null=自动选小模型）
    "recallProvider": null,           // 记忆召回 agent 的 provider（null=跟随主 provider）
    "optimizerModel": null,           // LLM 优化使用的模型（null=自动选择）
    "managerPort": 19836,             // Memory Manager Web UI 端口
    "teamServerUrl": null,            // feishu-server 地址，如 https://feishu.yourteam.com
    "promotionThreshold": {
      "minScore": 5.0,
      "minUseCount": 5,
      "minAgeInDays": 7
    }
  }
}
```

---

## 9. 文件结构

```
packages/opencode/src/memory/
├── memory.ts                        # Memory namespace：数据模型、CRUD、query
├── storage.ts                       # MemoryStorage：JSON 文件存储 + meta 管理
├── engine/
│   ├── extractor.ts                 # 提取引擎（/remember 上下文提取 + session-end LLM 提取）
│   ├── confirmation.ts              # pending 转正逻辑（天数 + hitCount 检查）
│   ├── injector.ts                  # 上下文注入引擎（调用 recall agent + 冲突处理）
│   ├── recall.ts                    # memory-recall agent 调用封装 + 缓存
│   ├── project-context.ts           # 项目上下文自动检测（languages, techStack, modules）
│   └── team-scope-matcher.ts        # Team Memory 多维隔离匹配逻辑
├── agent/
│   └── recall.txt                   # memory-recall agent prompt
├── optimizer/
│   ├── optimizer.ts                 # LLM 分析优化主入口
│   ├── default-strategy.md          # 内置默认优化策略模板
│   ├── decay.ts                     # 衰减计算
│   └── pruner.ts                    # 容量管控 + 过期清理
├── sync/
│   ├── feishu-team.ts               # feishu-server API 客户端（登录、提交、拉取）
│   ├── promotion.ts                 # 个人→团队晋升逻辑（候选检测 + 用户确认）
│   └── pull.ts                      # 团队记忆增量拉取 + 本地缓存
├── hooks/
│   ├── register.ts                  # Hook 注册入口
│   ├── auto-extract.ts              # pre-llm + post-tool 提取
│   ├── inject.ts                    # pre-llm 注入
│   ├── hit-tracker.ts               # post-tool 命中追踪
│   ├── session-summary.ts           # session-lifecycle 总结
│   └── optimizer-hook.ts            # session-lifecycle 定期优化
├── cli/
│   ├── memory-cmd.ts                # CLI: opencode memory {remember,forget,list,pull,optimize,export,manager,promote}
│   └── memory-tui.ts                # TUI: /memory 命名空间（二级列表 + 子命令）
├── web/
│   ├── server.ts                    # 本地 HTTP 服务（Hono, 127.0.0.1）
│   ├── api.ts                       # REST API（CRUD + stats + suggestions）
│   └── app.html                     # 单文件前端（React + Tailwind 内嵌）
└── test/
    ├── memory.test.ts
    ├── extractor.test.ts
    ├── optimizer.test.ts
    ├── team-server.test.ts
    └── promotion.test.ts
```

---

## 10. 关键设计决策

### Q1: 为什么全量日志不需要扩展 LlmLog？

**Answer**: 现有的 `LlmLogCapture` 已经在 `pre-llm` hook (priority 999) 中记录了 system_prompt（gzip）和 messages（gzip），在 `session-lifecycle` hook 中记录了 response 和 tool_calls。`LlmLog.get(id)` 可以还原完整的一轮交互。Memory 系统只需要在每条记忆的 `source.llmLogID` 中存一个引用 ID 即可追溯。

### Q2: /remember 为什么要携带上下文快照？

**Answer**: 两个原因。第一，用户说"记住这个"时，"这个"是什么需要从上下文推断，LLM 提炼时需要上下文。第二，虽然可以通过 `llmLogID` 回溯完整对话，但 `contextSnapshot` 提供快速预览能力——`memory show <id>` 时不需要解压 gzip、查 SQLite，直接读 JSON 就能看到上下文。

### Q3: 为什么 Optimizer 用 MD 文件定义策略？

**Answer**: 三个好处。第一，**低门槛**：用户用自然语言描述期望的优化行为，不需要写代码。第二，**LLM-native**：MD 文件直接作为 LLM prompt 的一部分，LLM 天然理解 Markdown。第三，**可版本控制**：`.opencode/memory/optimizer.md` 可以提交到 git，团队共享优化策略。

### Q4: 为什么记忆召回用 LLM 而不是 embedding 向量搜索？

**Answer**: 三个原因：

1. **质量**：LLM 语义理解远超向量相似度。"帮我写一个路由" 和 "API handler 用 Hono" 之间的关联，embedding 很可能匹配不上，LLM 能理解。200 条记忆只有几千 token，一次调用就能处理
2. **零基础设施**：不需要 embedding 模型、向量数据库、索引维护。存储就是纯 JSON，检索就是一次 LLM 调用
3. **能做冲突检测**：向量搜索只能返回"相似"，LLM 能发现"矛盾"——用户当前说"用 Express"但记忆说"用 Hono"，这种冲突只有 LLM 能判断。发现冲突后主动让用户确认，避免 agent 在矛盾的指令下做出错误选择

**成本控制**：recall agent 使用独立的小模型（Haiku / GPT-4o-mini），每次会话只调一次（缓存 5 轮），成本可忽略。

### Q5: 为什么 Team Server 放在 feishu-server 里而不是嵌入 opencode？

**Answer**: 三个原因：

1. **账号复用**：飞书组织架构天然包含团队成员、部门、权限，不需要重新建一套账号系统。谁是 reviewer 直接通过飞书部门/群组配置
2. **审批零成本**：交互式卡片直接在飞书群里操作，审核者不需要打开额外页面或学习 CLI 命令。点一个按钮就完成审批
3. **通知即时**：提交、审批、拒绝的通知直接走飞书消息，团队成员一定能看到。比邮件或 git commit 通知靠谱得多
4. **独立部署**：feishu-server 可以同时服务多个项目的多个 opencode 实例，还能整合已有的 daily-upstream-check 通知能力

### Q6: 不用飞书的团队怎么办？

**Answer**: `feishu-server` 的 REST API 层是通用的，飞书只是认证和通知的实现。如果团队用 Slack/钉钉/企微，可以：

1. 替换 `auth/` 层为对应平台的 OAuth
2. 替换 `feishu/` 层为对应平台的消息卡片
3. `memory/` 层完全复用

未来可以抽象为 `team-server-core` + `feishu-adapter` / `slack-adapter` 的插件架构。

### Q7: feishu-server 不可用怎么办？

**Answer**: 优雅降级。Personal Memory 完全本地，不受影响。Team Memory 有本地缓存，服务不可用时用缓存。`/promote` 会提示服务不可达，记忆保持为 `teamCandidate` 状态，等服务恢复后重试。

### Q8: 为什么 Team Memory 用 OpenViking 而不是直接用关系型 DB + 全量 LLM 召回？

**Answer**: 规模问题。个人记忆注入池上限 200 条，全量塞进 recall prompt 问题不大。但 Team Memory 是整个团队共享的，一个活跃团队可能积累上千条团队记忆。在这个规模下：

1. **token 成本**：1000 条记忆 × 平均 50 token = 50K token，每次会话的 recall 调用就要消耗大量 token
2. **LLM 精度下降**：候选太多时 LLM 的注意力分散，容易漏掉关键记忆或误判相关性
3. **延迟**：全量 LLM 处理几千 token 的 recall prompt 需要数秒

OpenViking 的价值在于**用向量检索做第一轮粗筛**（毫秒级），结合**目录层级做结构化过滤**（利用 5 维隔离），最终只给 recall agent 几十条高相关候选。这是"漏斗模型"：OpenViking 从千级缩到百级，recall agent 从百级缩到十级。

**为什么不用独立的向量数据库**（如 Qdrant、Milvus）：OpenViking 不只是向量库，它的文件系统范式天然支持我们的目录层级隔离，L0/L1/L2 分层加载减少了 token 浪费，而且它是字节开源的，与我们的 feishu-server 技术栈（同为字节生态）能很好协作。

### Q9: 为什么 Team Memory 需要 5 个隔离维度而不是简单的项目隔离？

**Answer**: 实际团队场景远比"一个团队一个项目"复杂：

1. **有些约定是跨项目的**：如"commit 用英文"、"PR 必须关联 issue"。这需要 `global` 维度
2. **同一项目可能包含多种语言**：如 monorepo 里有 TypeScript 后端和 Python 数据管道。TypeScript 的 `any` 禁令不应该出现在 Python 上下文中。这需要 `language` 维度
3. **技术选型决定了很多具体实践**：选了 Hono 就不用 Express，选了 Drizzle 就不用 Prisma。同一团队的不同项目可能有不同选型。这需要 `techStack` 维度
4. **大型项目内部模块差异大**：TUI 用 Ink 组件模式，SDK 用纯函数模式，测试工具用 CLI 模式。模块级别的约定不应互相干扰。这需要 `module` 维度

**维度组合的威力**：`{ languages: ["typescript"], techStack: ["hono"] }` 精准命中"团队中使用 Hono 的 TypeScript 项目"，既不会漏掉新项目（只要它用 TS + Hono），也不会误伤 Python 或 Express 项目。

---

## 11. 实施路线

### Phase 1（MVP，2 周）
- [ ] `Memory` namespace：数据模型 + CRUD + JSON 存储
- [ ] `memory-recall` agent：LLM 过滤 + 冲突检测 + 召回缓存
- [ ] `memory-injector` hook：调用 recall agent → 注入相关记忆 → 冲突通知
- [ ] `/remember` 带上下文提取（关联 LlmLog）
- [ ] CLI 命令：`memory add/list/show/remove`
- [ ] TUI 命令：`/remember` `/forget` `/memories`

### Phase 2（自动提取，2 周）
- [ ] `MemoryAutoExtract`：信号检测 + LLM 提炼
- [ ] `MemoryHitTracker`：命中追踪
- [ ] `MemorySessionSummary`：会话结束总结
- [ ] 提取质量调优

### Phase 3（可定制优化器 + Memory Manager，3 周）
- [ ] 内置 `default-strategy.md`
- [ ] `MemoryOptimizer`：加载策略 → LLM 分析 → 执行操作
- [ ] 衰减机制 + 容量告警（80% 提示 / 100% 引导 Memory Manager 整理）
- [ ] `memory optimize` 命令（支持 `--template`）
- [ ] Team 候选自动发现 + 用户通知
- [ ] **Memory Manager Web UI**：本地 Hono 服务 + 单文件 React 前端
  - [ ] 记忆浏览/筛选/搜索/排序
  - [ ] 单条编辑 + 批量删除
  - [ ] 溯源查看（contextSnapshot + LlmLog 跳转）
  - [ ] Optimizer 智能建议（合并/过时/清理推荐）
  - [ ] `/memory-manager` TUI 命令 + `opencode memory manager` CLI 命令

### Phase 4（opencode 侧 Team Sync 客户端，2 周）
- [ ] `ProjectContext`：项目上下文自动检测（languages, techStack）
- [ ] `TeamScopeMatcher`：多维隔离匹配逻辑
- [ ] `FeishuTeamSync` API 客户端（登录、提交、拉取 + 维度过滤参数）
- [ ] `opencode auth login --provider feishu-team` 飞书 OAuth 登录流程
- [ ] `/memory:promote` 流程（Web 页面编辑 teamScope → 提交到 feishu-server）
- [ ] `memory pull`（启动时自动检测 ProjectContext + 增量拉取）
- [ ] `memory status` 查看审批状态
- [ ] 降级策略（服务不可用时用缓存）

### Phase 5（feishu-server + OpenViking 独立服务，4 周）
- [ ] Hono HTTP 服务骨架 + PostgreSQL（审批元数据、用户信息）
- [ ] **OpenViking 集成**：Docker 部署 + REST API 客户端（viking-client.ts）
- [ ] **目录结构初始化**：根据 5 维隔离创建 `viking://team-memory/` 目录树
- [ ] **写入管道**：审批通过 → 关系型 DB 存元数据 → OpenViking 写入语义索引（多目录挂载）
- [ ] **检索管道**：Pull API 接收 ProjectContext → 构建搜索目录 → OpenViking 目录递归检索 → 返回
- [ ] 飞书 OAuth2 登录 + API Token 管理
- [ ] Memory CRUD REST API（Pull API 支持多维度过滤参数，底层走 OpenViking 检索）
- [ ] 飞书机器人：审批卡片构建 + 发送（卡片展示隔离维度信息）
- [ ] 飞书卡片回调处理（通过/修改/拒绝）
- [ ] 飞书消息通知（提交、审批结果、新记忆生效）
- [ ] Web Dashboard 管理页面（按维度筛选、统计各维度记忆分布、OpenViking 检索轨迹可视化）
- [ ] Docker Compose 部署方案（feishu-server + OpenViking + PostgreSQL）
- [ ] 整合 daily-upstream-check 通知到 feishu-server

### Phase 6（打磨，1 周）
- [ ] 相关性过滤优化（OpenViking 检索参数调优 + recall agent prompt 调优）
- [ ] 性能优化（OpenViking 索引预热、Pull 缓存策略）
- [ ] 测试覆盖
- [ ] 文档
