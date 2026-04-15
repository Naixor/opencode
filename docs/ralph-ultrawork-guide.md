# Ralph / Ultrawork 上手指南

这份文档是给 0 基础用户看的。

目标只有一个：让你尽快看懂这套 workflow 怎么工作，知道先看什么、怎么用、为什么这样设计。

---

## 1. 先用一句话理解这套 workflow

可以把它理解成一条自动推进的软件交付流水线：

`Markdown PRD -> prd.json -> 单故事迭代执行 -> 验证 -> 记录进度 -> 下一轮`

其中：

- `Markdown PRD` 负责描述需求
- `tasks/prd.json` 负责把需求拆成机器可执行的小故事
- Ralph loop 负责一轮一轮推进
- Ultrawork 在 Ralph loop 的基础上，再加一层更严格的验证

---

## 2. 当前讨论中的 PRD 是什么

当前正在推进的 PRD 源文件是 `tasks/prds/prd-hindsight-local-memory-integration.md`。

当前执行分支写在 `tasks/prd.json` 里，是 `ralph/hindsight-local-memory-companion-integration`。

这份 PRD 的目标是：

给 OpenCode 加一个本地嵌入式 Hindsight companion，用来提升 memory recall 和 memory extraction 的效果，但不替换现有本地 JSON memory 的权威地位。

也就是说：

- Hindsight 是辅助检索层
- 本地 JSON memory 仍然是 authoritative source of truth
- OpenCode 继续基于本地权威 memory 做生命周期、注入、命中统计和衰减

可以用这张图理解：

```txt
Local JSON memory   -> source of truth
Hindsight companion -> ranking + retrieval helper
OpenCode agents     -> still use authoritative local records
```

---

## 3. 当前 PRD 进度总结

当前 `tasks/prd.json` 一共有 `US-001` 到 `US-020`，共 20 个 user stories。

当前进度：

- 已完成：`US-001` 到 `US-007`
- 未完成：`US-008` 到 `US-020`
- 当前完成度：`7 / 20 = 35%`
- 下一张待做故事：`US-008`

已经完成的内容，主要是 phase 1 的底座：

- Hindsight config schema 和默认值
- embedded service lifecycle
- Hindsight client wrapper
- worktree bank identity 和稳定 document mapping
- authoritative memory retain wrapper
- Hindsight recall query 和 resolve pipeline
- Hindsight ranking 接入现有 memory recall

还没完成的内容，主要集中在：

- 保持本地 authority 边界不被破坏
- Hindsight-aware extractor
- context budget enforcement
- session slice retain
- extraction context injection
- create/update 后的持续 retain
- sidecar state persistence
- resumable backfill
- observability 和 inspect command
- regression coverage

如果你只想知道一句话版现状：

> 基础设施已经搭起来了，但完整闭环还没收尾。

---

## 4. PRD 为什么要先转换成 `prd.json`

Markdown PRD 适合人看，不适合自动循环稳定执行。

Ralph 需要的不是一篇长文，而是一份结构化 backlog。所以 Markdown PRD 会先转换成 `tasks/prd.json`。

转换规则来自 `.opencode/skills/ralph/SKILL.md`。最重要的规则有 6 条：

1. 每个 story 都要足够小，最好一轮就能做完
2. story 要按依赖顺序排序，先底层，再上层
3. 验收标准必须可验证，不能写空话
4. 每个 story 都必须带 `Typecheck passes`
5. UI story 还要带 `Verify in browser using dev-browser skill`
6. 如果 feature 变了，要先归档旧的 `prd.json` 和 `progress.txt`

生成后的 `prd.json` 至少要有这些字段：

```json
{
  "project": "OpenCode",
  "branchName": "ralph/feature-name",
  "sourcePrdFile": "tasks/prds/example.md",
  "description": "Short feature goal",
  "userStories": [
    {
      "id": "US-001",
      "title": "One small story",
      "description": "As a user, I want ... so that ...",
      "acceptanceCriteria": ["One verifiable condition", "Typecheck passes"],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

这里几个字段最重要：

- `branchName`: 这次任务应该在哪个分支做
- `sourcePrdFile`: 这份 JSON 是从哪份原始 PRD 拆出来的
- `userStories`: 机器真正按顺序推进的任务列表
- `passes`: 这张 story 是否已经完成

---

## 5. Ralph loop 是怎么工作的

Ralph loop 的核心思路不是“在一个超长 session 里死磕到底”，而是：

- 每轮开一个新的 child session
- 让每轮只处理当前上下文真正需要的内容
- 把上一轮成果写进共享 memory file
- 下一轮先读 memory file，再继续做

这套逻辑主要在 `packages/opencode/src/session/hooks/ralph-loop.ts`。

可以把它理解成下面这条流水线：

```txt
Read tasks/prd.json
   |
   v
Pick highest-priority story where passes=false
   |
   v
Run one focused iteration in a fresh child session
   |
   v
Write progress into /tmp/ralph.memory.<origin>.md
   |
   +--> not done: start next child session
   |
   +--> done: emit <promise>DONE</promise>
```

### Ralph loop 的几个关键点

#### 5.1 每轮都是 fresh child session

这样做的好处是避免超长上下文越来越乱。

上一轮的结果不会完全丢失，因为 loop 会把进展写到共享文件里。

共享文件路径格式是：

```txt
/tmp/ralph.memory.<originSessionID>.md
```

#### 5.2 完成信号不是普通文本，而是 promise tag

普通 Ralph loop 用这个标记表示“我认为已经做完了”：

```txt
<promise>DONE</promise>
```

loop 检测到这个标记后，才会进入完成处理流程。

#### 5.3 不是一次做完整个 PRD，而是一次只做一张 story

`tasks/AGENTS.md` 明确要求：

- 先读 `tasks/prd.json`
- 找到最高优先级且 `passes: false` 的 story
- 一次只实现这一张 story
- 跑检查
- 更新 `prd.json`、`progress.txt`

这就是 one-story-per-iteration 的执行纪律。

---

## 6. Ultrawork 是什么，它比 Ralph 多了什么

Ultrawork 不是另一套完全不同的系统。

它是 Ralph loop 的更严格版本：当工作 session 觉得自己完成了，不能直接算结束，还要再经过 Oracle 验证。

### 6.1 `/ulw` 会做什么

在 CLI 里，只有当 `/ulw` 出现在“最新用户消息的开头”时，才会触发特殊行为。

行为规则是：

- `/ulw some task` -> 设置 `variant=max`，并把 `/ulw` 从消息正文里去掉
- `/ulw on some task` -> 同样开启更强模式
- `/ulw off some task` -> 这次调用显式关闭 `/ulw` 行为
- `please explain /ulw` -> 不会触发，因为它不在开头

示例：

```txt
/ulw implement US-008
=> variant=max
=> actual task text: implement US-008

/ulw off implement US-008
=> do not enable ULW prefix behavior for this invocation

please explain /ulw
=> no special behavior
```

### 6.2 Ultrawork 的完整闭环

Ultrawork 在 Ralph loop 之上，多了一步 Oracle verification。

完整流程是：

```txt
Work iteration
   |
   v
Emit <promise>DONE</promise>
   |
   v
Start Oracle verification session
   |
   +--> Oracle emits <promise>VERIFIED</promise>
   |         |
   |         v
   |      final success
   |
   +--> Oracle does not verify
             |
             v
      continue fixing in another iteration
```

也就是说：

- `DONE` 只代表“工作 session 认为自己做完了”
- `VERIFIED` 才代表“系统认可真的做完了”

这能显著减少一种常见问题：

> 模型自我感觉已经完成，但实际上还有遗漏。

---

## 7. 这几个文件分别是干什么的

这套 workflow 最关键的 4 个文件/目录如下：

```txt
tasks/
├── AGENTS.md
├── progress.txt
├── prd.json
├── prds/
└── archive/
```

### 7.1 `tasks/prd.json`

这是当前机器可执行的 backlog。

你看它，就能知道：

- 当前 feature 是什么
- 当前分支应该是什么
- 原始 PRD 是哪份文件
- 哪些 stories 已完成
- 下一张要做什么

### 7.2 `tasks/prds/*.md`

这是人类可读的原始 PRD。

它适合看背景、目标、功能边界、技术选择。

### 7.3 `tasks/progress.txt`

这是 append-only 的执行记录。

它有两个部分：

- 顶部 `Codebase Patterns`: 长期可复用经验
- 下方按时间追加的 story progress: 每一轮实际做了什么

这份文件的意义非常大，因为后续 iteration 会复用这里的信息。

### 7.4 `tasks/AGENTS.md`

这是 Ralph 的执行规则书。

它明确要求：

- 一次只做一张 story
- 做完要跑质量检查
- 更新 `passes`
- 追加 progress
- 发现可复用规律时要沉淀到 `progress.txt`

### 7.5 `tasks/archive/`

这是历史归档目录。

当 feature 变了，旧的 `prd.json` 和 `progress.txt` 不应该直接覆盖，而应该归档进去，避免新旧任务混在一起。

---

## 8. 对 0 基础用户最有用的实际操作顺序

如果你完全没接触过这套系统，最推荐按下面顺序上手。

### 第一步：先看 `tasks/prd.json`

重点看 4 件事：

- `branchName`
- `sourcePrdFile`
- 哪个 story 的 `passes` 还是 `false`
- 当前最高优先级未完成 story 是哪张

### 第二步：再看 `tasks/progress.txt`

先看顶部 `Codebase Patterns`，再看最近几条 progress。

这样你能快速知道：

- 这个仓库有什么固定套路
- 前几轮已经做到了哪里
- 哪些坑已经踩过了

### 第三步：最后才看原始 PRD

也就是看 `tasks/prds/prd-hindsight-local-memory-integration.md`。

这一步是为了理解“为什么要做这件事”，而不是直接开始写代码。

### 第四步：发一个只聚焦一张 story 的请求

最推荐的方式是直接用 `/ulw`，并且请求要足够具体。

例如：

```bash
opencode "/ulw implement the next unfinished story from tasks/prd.json"
```

如果你已经知道下一张是 `US-008`，可以更具体：

```bash
opencode "/ulw implement US-008 from tasks/prd.json and keep local memory authoritative"
```

对于新手，最重要的不是写很长的提示词，而是：

- 一次只盯一张 story
- 请求里明确 story ID 或“next unfinished story”
- 不要把多个目标混在一起

---

## 9. 这套 workflow 的优势

### 9.1 对新手友好

大需求会被拆成小 stories。你不需要一上来就理解整个系统，只需要先理解当前这一张。

### 9.2 可追踪

`prd.json` 看任务状态，`progress.txt` 看施工日志，`sourcePrdFile` 看原始需求，`archive/` 看历史切换。整条链路很清楚。

### 9.3 降低长上下文漂移

每轮 fresh child session，可以减少长会话越来越乱的问题。共享 memory file 又保证不会完全失去上下文。

### 9.4 验证更严格

Ultrawork 增加 Oracle verification，可以降低“模型过早宣布完成”的概率。

### 9.5 更适合自动化迭代

因为 stories 小、验收标准明确，所以系统更容易一轮轮稳定推进，而不是一次性做一大坨模糊工作。

---

## 10. 这套 workflow 的劣势

### 10.1 比一次性手改更慢

每轮都要开新 session、读写记忆、做检测、可能还要验证，所以速度通常比“人直接改完”慢。

### 10.2 很依赖 PRD 拆分质量

如果 story 太大、顺序不对、验收标准写得很空，loop 就容易卡住或者产出质量下降。

### 10.3 很依赖纪律执行

例如：

- story 必须小
- `progress.txt` 必须持续维护
- `passes` 必须及时更新
- feature 切换时必须归档

这些规则只要少做一个，后面接手就会越来越难。

### 10.4 对初学者来说名词较多

你会同时接触 PRD、Ralph、Ultrawork、Oracle、progress、archive、sourcePrdFile 等概念。第一次看会有一点学习成本。

---

## 11. 给 0 基础用户的最快上手版本

如果你只想记最少内容，请记住下面这 5 步：

```txt
1. Read tasks/prd.json
2. Find the next story where passes=false
3. Read tasks/progress.txt
4. Run one focused /ulw request
5. Check whether that one story moved forward
```

再压缩成一句话就是：

> 先看 backlog，再只推进一张 story，不要一次做很多事。

---

## 12. 一段适合直接照抄的上手说明

如果你要给一个完全没接触过这套系统的人一句可执行说明，可以直接发这段：

```txt
先打开 tasks/prd.json，看当前 feature、sourcePrdFile 和哪个 story 还没完成。
再打开 tasks/progress.txt，看顶部 Codebase Patterns 和最近几次进展。
然后只针对下一张未完成 story 发一个 /ulw 请求。
不要一次推进多张 story，也不要跳过 progress 和 passes 的维护。
```

这就是这套 workflow 最实用的入门方式。

---

## 13. References

下面这些 skill 和文件，是这套 workflow 最相关的参考入口。

### 核心 workflow skills

- `ralph` - 把 Markdown PRD 转成 `tasks/prd.json` 可执行格式，规则定义见 `.opencode/skills/ralph/SKILL.md`
- `prd` - 用来生成新的 Markdown PRD，输出目录默认是 `tasks/prds/`，定义见 `.opencode/skills/prd/SKILL.md`
- `build-verify` - 先跑 typecheck/build，只提取错误，适合在测试前做快速验证，定义见 `.opencode/skills/build-verify/SKILL.md`
- `test-analyze` - 跑测试并生成结构化失败报告，支持先接 `build-verify`，定义见 `.opencode/skills/test-analyze/SKILL.md`

### 测试修复相关 skills

- `test-fix-round` - 按 ledger 一次修一类失败，适合把大批测试失败拆成一轮一轮处理，定义见 `.opencode/skills/test-fix-round/SKILL.md`
- `test-fix-report` - 从 test-fix ledger 生成最终修复报告，定义见 `.opencode/skills/test-fix-report/SKILL.md`

### 浏览器验证相关 skills

- `browser-automation` - 提供稳定的浏览器自动化操作方式，适合 UI 验证和页面交互检查，定义见 `/Users/bytedance/.config/opencode/skills/browser-automation/SKILL.md`

### 核心参考文件

- `tasks/prd.json` - 当前机器可执行 backlog
- `tasks/prds/prd-hindsight-local-memory-integration.md` - 当前原始 PRD
- `tasks/progress.txt` - 可复用经验和每轮 story 进度
- `tasks/AGENTS.md` - Ralph 的执行规则
- `packages/opencode/src/session/hooks/ralph-loop.ts` - Ralph / Ultrawork loop 核心实现
- `packages/opencode/src/cli/cmd/run.ts` - CLI 中 `/ulw` 前缀处理逻辑
- `packages/opencode/src/session/hooks/detection-checking.ts` - `/ulw` 前缀检测和 variant 处理逻辑
