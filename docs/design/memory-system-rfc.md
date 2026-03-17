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
| 记忆衰减 | ❌ | 28天自动清理 | ❌ | ❌ | **✅ 基于引用的衰减** |

---

## 2. 设计目标

1. **全量可追溯**：所有用户交互已由 LlmLog 系统全量记录（system_prompt + messages + tool_calls，gzip 压缩存 SQLite），Memory 系统直接复用，无需重复存储
2. **越用越懂你**：自动从对话中提取有价值的偏好和模式，`/remember` 时携带完整对话上下文避免歧义
3. **不臃肿**：记忆有衰减、有整理、有容量限制，LLM 分析策略可通过用户 MD 文件定制
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
│ + Memory  │ Inject     │  MD template) │ Upload to feishu-server     │
│   Store   │ /remember  │ Decay/Prune   │ 飞书卡片审批 → 生效          │
│ (new JSON)│ w/ context │ Consolidate   │ Pull approved → local       │
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

  export const Info = z.object({
    id: z.string(),                          // nanoid
    content: z.string(),                     // 记忆内容（自然语言描述）
    category: Category,
    scope: Scope,
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
    hitCount: z.number().default(0),         // 实际影响输出的次数
    lastUsedAt: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    expiresAt: z.number().optional(),

    // --- 团队晋升 ---
    teamCandidateAt: z.number().optional(),  // 被标记为候选的时间
    teamSubmittedAt: z.number().optional(),  // 提交到远端的时间
    teamApprovedAt: z.number().optional(),   // 审批通过的时间
    promotedBy: z.string().optional(),
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

### 5.3 自动提取

```typescript
export namespace MemoryAutoExtract {
  // 信号检测 + 提取
  const EXTRACTION_SIGNALS = {
    correction: [
      /不要|别|不用|不是这样|错了|应该是|改成|换成/,
      /don't|not like that|wrong|should be|change to|use .* instead/i,
    ],
    preference: [
      /我喜欢|我习惯|我更倾向|我们团队用|我们的规范|always use|prefer|convention/i,
    ],
    tool: [
      /用 (bun|npm|pnpm|yarn)|框架是|tech stack|使用 (vitest|jest|mocha)/i,
    ],
  }

  export function register() {
    // 从用户消息中提取显式偏好
    HookChain.register("memory-extract-explicit", "pre-llm", 200, async (ctx) => {
      const lastUserMsg = getLastUserMessage(ctx.messages)
      if (!lastUserMsg) return

      for (const [category, patterns] of Object.entries(EXTRACTION_SIGNALS)) {
        for (const pattern of patterns) {
          if (pattern.test(lastUserMsg.content)) {
            // 同样走 LLM 提炼 + 上下文快照
            const llmLogID = LlmLogCapture.getCurrentLogId(ctx.sessionID)
            const contextSnapshot = ctx.messages.slice(-6)
              .map(m => `[${m.role}]: ${typeof m.content === "string" ? m.content : "..."}`)
              .join("\n---\n")

            await extractWithLLM(ctx.sessionID, llmLogID, lastUserMsg, category, contextSnapshot)
            break
          }
        }
      }
    })

    // 从重复修改模式中检测隐式偏好
    HookChain.register("memory-extract-implicit", "post-tool", 200, async (ctx) => {
      if (ctx.toolName === "edit" || ctx.toolName === "write") {
        await detectRepetitivePatterns(ctx)
      }
    })

    // 会话结束时做一次总结性提取
    HookChain.register("memory-extract-session-end", "session-lifecycle", 200, async (ctx) => {
      if (ctx.event === "session.deleted" || ctx.event === "session.compacting") {
        await extractSessionSummary(ctx.sessionID)
      }
    })
  }
}
```

### 5.4 记忆注入（Inject）

```typescript
export namespace MemoryInject {
  export function register() {
    HookChain.register("memory-injector", "pre-llm", 130, async (ctx) => {
      const memories = await Memory.query({
        scope: ["personal", "team"],
        projectID: Instance.project.id,
        limit: 20,
        minScore: 0.5,
        sortBy: "relevance",
      })

      if (memories.length === 0) return

      const relevant = await filterByRelevance(memories, ctx.messages)
      const injection = formatMemoriesForPrompt(relevant)
      ctx.system.push(injection)

      for (const m of relevant) {
        await Memory.incrementUseCount(m.id)
      }
    })
  }
}
```

### 5.5 命令行 & TUI 接口

```bash
# 手动添加记忆（会自动获取当前会话上下文）
opencode memory add "我们项目使用 Bun 而不是 Node.js" --category tool

# 列出记忆
opencode memory list [--scope personal|team] [--category style]

# 查看记忆详情（含溯源上下文）
opencode memory show <id>             # 显示记忆内容 + contextSnapshot
opencode memory show <id> --full      # 还原关联的完整 LlmLog 对话

# 删除/搜索/导出
opencode memory remove <id>
opencode memory search "eslint config"
opencode memory export --format md > memories.md

# 手动触发整理优化
opencode memory optimize [--template ./my-strategy.md]

# 团队同步
opencode memory promote <id>          # 提交到远端等待审批
opencode memory pull                  # 拉取已审批的团队记忆
```

**TUI 内交互**：

```
user> /remember 我们的 API 返回格式统一用 { code, data, message }
→ ✅ 已记住 [domain] API 返回格式统一用 { code, data, message }
   📎 已关联对话上下文（10 轮），可通过 `memory show mem_xxx --full` 查看

user> /forget <id>
→ ✅ 已删除记忆 #abc123

user> /memories
→ 📝 个人记忆 (12 条) | 👥 团队记忆 (5 条)
   [style]    不使用分号，printWidth: 120
   [tool]     使用 Bun 测试框架 (bun:test)
   [pattern]  错误处理用 NamedError.create() 模式
   ...
```

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
   * 定期清理（session-lifecycle hook 触发，每天最多一次）
   */
  export async function prune() {
    const memories = await Memory.list({ scope: "personal" })
    let pruned = 0

    for (const memory of memories) {
      const effectiveScore = calculateDecay(memory)

      if (effectiveScore < 0.1) {
        await Memory.update(memory.id, {
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        })
        pruned++
      } else if (memory.expiresAt && memory.expiresAt < Date.now()) {
        await Memory.remove(memory.id)
        pruned++
      } else {
        await Memory.update(memory.id, { score: effectiveScore })
      }
    }

    log.info("prune complete", { total: memories.length, pruned })
  }

  // Hook 注册
  export function register() {
    // 定期执行 prune + 检测 team candidates
    HookChain.register("memory-optimizer", "session-lifecycle", 210, async (ctx) => {
      if (ctx.event !== "session.created") return

      const lastPrune = await Memory.getMeta("lastPruneAt")
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
      if (lastPrune && lastPrune > oneDayAgo) return

      await prune()
      await detectTeamCandidates()  // Optimizer 主动发现 Team 候选
      await Memory.setMeta("lastPruneAt", Date.now())
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
│   │   ├── store.ts                  # Team Memory CRUD（SQLite/PostgreSQL）
│   │   ├── submit.ts                 # 提交接口 + 触发飞书审批卡片
│   │   ├── review.ts                 # 审批逻辑（来自飞书卡片回调）
│   │   └── pull.ts                   # 拉取已审批记忆（增量）
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
│   └── schema.sql                    # 数据库 schema
├── deploy/
│   ├── Dockerfile
│   └── docker-compose.yml
└── package.json
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
┌─────────────────────────────────────────┐
│  📝 Team Memory 审批                    │
├─────────────────────────────────────────┤
│  [pattern] 错误处理统一使用              │
│  NamedError.create(name, schema) 模式    │
│                                          │
│  提交者: alice       标签: error, pattern │
│                                          │
│  ▸ 📎 对话上下文（点击展开）             │
│                                          │
│  ─────────────────────────────────────── │
│  [✅ 通过]  [✏️ 修改后通过]  [❌ 拒绝]   │
└─────────────────────────────────────────┘
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
POST /api/memory/submit             → 提交记忆到审批队列
GET  /api/memory/team?since=<ts>    → 拉取已审批的团队记忆（增量）
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
│  Phase 2: 用户确认 + 编辑                                         │
│                                                                   │
│  用户执行 /promote <id>                                           │
│        ↓                                                          │
│  展示记忆内容 + 溯源上下文                                         │
│  用户可以：                                                        │
│    a) 直接提交                                                     │
│    b) 编辑后提交                                                   │
│    c) 取消                                                         │
└───────────────────────┬──────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────────┐
│  Phase 3: 上传到 feishu-server                                    │
│                                                                   │
│  POST /api/memory/submit（携带飞书 API Token 认证）                │
│  feishu-server 收到后：                                            │
│    1. 存入数据库（status: pending）                                │
│    2. 向审批飞书群发送交互式卡片                                    │
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
│    GET /api/memory/team?since=<last_pull_at>                      │
│    增量拉取 approved 状态的记忆 → 写入本地 Team Memory 缓存        │
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
  export async function submit(memory: Memory.Info, editedContent?: string) {
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
      const lastPull = await Memory.getMeta("lastTeamPullAt")
      const url = lastPull
        ? `${serverUrl}/api/memory/team?since=${lastPull}`
        : `${serverUrl}/api/memory/team`

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
          source: { sessionID: "", method: "pulled" },
          score: 10.0,  // Team 记忆满分，不衰减
          createdAt: item.approvedAt,
          updatedAt: item.approvedAt,
        })
      }

      await Memory.setMeta("lastTeamPullAt", Date.now())
      log.info("pulled team memories", { count: items.length })
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
  130  memory-injector              ★ NEW: 注入 personal + team 记忆
  200  memory-extract-explicit      ★ NEW: 检测提取信号
  999  llm-log-capture              (existing)

Post-Tool Chain:
  0    llm-log-tool-finish          (existing)
  200  memory-extract-implicit      ★ NEW: 检测重复模式
  210  memory-hit-tracker           ★ NEW: 更新命中计数

Session-Lifecycle Chain:
  100  compaction-context-injector  (existing)
  110  compaction-todo-preserver    (existing)
  200  memory-extract-session-end   ★ NEW: 会话结束总结提取
  210  memory-optimizer             ★ NEW: 定期衰减 + team 候选检测
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
    "personalLimit": 200,             // 个人记忆上限
    "teamLimit": 100,                 // 团队记忆本地缓存上限
    "optimizerModel": null,           // LLM 优化使用的模型（null=自动选择）
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
│   ├── extractor.ts                 # 提取引擎（/remember + auto-extract）
│   ├── injector.ts                  # 上下文注入引擎
│   └── scorer.ts                    # 相关性评分
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
│   ├── memory-cmd.ts                # CLI: memory add/list/show/remove/promote/pull/optimize/review
│   └── memory-tui.ts                # TUI: /remember /forget /memories /promote
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

### Q4: 为什么 Team Server 放在 feishu-server 里而不是嵌入 opencode？

**Answer**: 三个原因：

1. **账号复用**：飞书组织架构天然包含团队成员、部门、权限，不需要重新建一套账号系统。谁是 reviewer 直接通过飞书部门/群组配置
2. **审批零成本**：交互式卡片直接在飞书群里操作，审核者不需要打开额外页面或学习 CLI 命令。点一个按钮就完成审批
3. **通知即时**：提交、审批、拒绝的通知直接走飞书消息，团队成员一定能看到。比邮件或 git commit 通知靠谱得多
4. **独立部署**：feishu-server 可以同时服务多个项目的多个 opencode 实例，还能整合已有的 daily-upstream-check 通知能力

### Q5: 不用飞书的团队怎么办？

**Answer**: `feishu-server` 的 REST API 层是通用的，飞书只是认证和通知的实现。如果团队用 Slack/钉钉/企微，可以：

1. 替换 `auth/` 层为对应平台的 OAuth
2. 替换 `feishu/` 层为对应平台的消息卡片
3. `memory/` 层完全复用

未来可以抽象为 `team-server-core` + `feishu-adapter` / `slack-adapter` 的插件架构。

### Q6: feishu-server 不可用怎么办？

**Answer**: 优雅降级。Personal Memory 完全本地，不受影响。Team Memory 有本地缓存，服务不可用时用缓存。`/promote` 会提示服务不可达，记忆保持为 `teamCandidate` 状态，等服务恢复后重试。

---

## 11. 实施路线

### Phase 1（MVP，2 周）
- [ ] `Memory` namespace：数据模型 + CRUD + JSON 存储
- [ ] `memory-injector` hook：手动添加的记忆注入到 prompt
- [ ] `/remember` 带上下文提取（关联 LlmLog）
- [ ] CLI 命令：`memory add/list/show/remove`
- [ ] TUI 命令：`/remember` `/forget` `/memories`

### Phase 2（自动提取，2 周）
- [ ] `MemoryAutoExtract`：信号检测 + LLM 提炼
- [ ] `MemoryHitTracker`：命中追踪
- [ ] `MemorySessionSummary`：会话结束总结
- [ ] 提取质量调优

### Phase 3（可定制优化器，2 周）
- [ ] 内置 `default-strategy.md`
- [ ] `MemoryOptimizer`：加载策略 → LLM 分析 → 执行操作
- [ ] 衰减机制 + 容量管控
- [ ] `memory optimize` 命令（支持 `--template`）
- [ ] Team 候选自动发现 + 用户通知

### Phase 4（opencode 侧 Team Sync 客户端，2 周）
- [ ] `FeishuTeamSync` API 客户端（登录、提交、拉取）
- [ ] `opencode auth login --provider feishu-team` 飞书 OAuth 登录流程
- [ ] `/promote` 流程（确认 → 编辑 → 提交到 feishu-server）
- [ ] `memory pull`（启动时自动增量拉取）
- [ ] `memory status` 查看审批状态
- [ ] 降级策略（服务不可用时用缓存）

### Phase 5（feishu-server 独立服务，3 周）
- [ ] Hono HTTP 服务骨架 + SQLite 存储
- [ ] 飞书 OAuth2 登录 + API Token 管理
- [ ] Memory CRUD REST API
- [ ] 飞书机器人：审批卡片构建 + 发送
- [ ] 飞书卡片回调处理（通过/修改/拒绝）
- [ ] 飞书消息通知（提交、审批结果、新记忆生效）
- [ ] Web Dashboard 管理页面
- [ ] Docker 部署方案
- [ ] 整合 daily-upstream-check 通知到 feishu-server

### Phase 6（打磨，1 周）
- [ ] 相关性过滤优化
- [ ] 性能优化
- [ ] 测试覆盖
- [ ] 文档
