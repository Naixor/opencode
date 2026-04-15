# Tech: Hindsight Local Memory Integration

## Overview

本文定义 phase 1 的落地方案。目标是把 Hindsight 接入现有 memory system，但不替换本地 JSON authority。

核心原则只有三条：

- `packages/opencode/src/memory/storage.ts` 继续是 authoritative store
- Hindsight 只走 local embedded mode
- Hindsight 同时参与 `extract` 和 `recall`

## Why local stays authoritative

现有系统已经在本地 memory 上承载 `status`、`score`、`useCount`、`hitCount`、`meta`、`confirmation`、`decay` 和 UI。直接把 authority 切到 Hindsight，会把 retrieval 升级变成 lifecycle 重构。

phase 1 的目标是先增强 retrieval 和 extraction quality。这样 blast radius 小，也能保留现有 fallback。

## Architecture

建议增加一个小型 companion 子系统，集中管理 daemon、id mapping、retain 和 query。

推荐目录：

- `packages/opencode/src/memory/hindsight/client.ts`
- `packages/opencode/src/memory/hindsight/service.ts`
- `packages/opencode/src/memory/hindsight/mapper.ts`
- `packages/opencode/src/memory/hindsight/bank.ts`
- `packages/opencode/src/memory/hindsight/retain.ts`
- `packages/opencode/src/memory/hindsight/recall.ts`
- `packages/opencode/src/memory/hindsight/backfill.ts`
- `packages/opencode/src/memory/hindsight/event.ts` if needed

现有文件主要做集成点修改：

- `packages/opencode/src/memory/engine/extractor.ts`
- `packages/opencode/src/memory/engine/recall.ts`
- `packages/opencode/src/memory/hooks/auto-extract.ts`
- `packages/opencode/src/memory/hooks/inject.ts`
- `packages/opencode/src/memory/hooks/hit-tracker.ts`
- `packages/opencode/src/memory/memory.ts`
- `packages/opencode/src/config/config.ts`

## Draw the boundary

OpenCode local memory 负责 lifecycle。Hindsight 负责 local semantic retrieval and structured retention.

边界如下：

- Local memory owns: create, update, confirm, decay, inject decision, hit tracking, UI read model
- Hindsight owns: local daemon, embedding/indexing, ranked retrieval, retained conversation docs, optional observations
- Mapping layer owns: `memory_id <-> hindsight document/source reference`

## Map the data

phase 1 不需要把所有本地字段复制成 Hindsight first-class schema。只需要稳定映射和最小 metadata。

先明确 Hindsight 的 storage model，避免按错抽象层接入：

- Hindsight 的顶层隔离单元是 `bank`，更像一个 agent/user/workspace memory store，不是 `world` / `experience` / `observation` 三个独立 bank
- 同一个 bank 内部会把 retained content 处理成 memory units、documents、chunks，以及后续 consolidation 产出的 observations
- recall 时可以按 `types: ["world", "experience", "observation"]` 过滤，但这些 type 是 bank 内的事实类型，不是外层 bank mapping
- retain 时的 `document_id` 是最稳定的 upsert 锚点；同一个 `document_id` 默认 `replace`，会删除旧 document 关联的 memory units 后重新处理
- Hindsight retain API 的 `metadata` 输入目前是 `Record<string, string>`，不是任意 JSON；数组或对象要么转成 tags，要么转成 JSON string 再放 metadata

因此 phase 1 不建议按 `experience` / `observation` / `world` 拆成多个 Hindsight banks。更稳妥的做法是：每个 workspace scope 对应一个 bank，在单 bank 内通过 document、tags、metadata 和 recall `types` 组织数据。

建议 document metadata：

```ts
{
  workspace_id: string
  project_root: string
  session_id?: string
  memory_id?: string
  source_kind: "memory" | "session_slice" | "observation"
  categories?: string // JSON string or comma-joined canonical value
  tags?: string // optional duplicate string form for trace/debug only
  status?: string
  created_at: string
  updated_at?: string
}
```

建议 bank mapping：

- `bankId`: workspace/project-scoped companion store，例如 `opencode:${workspaceHash}`
- `document_id`: source-scoped stable id，例如单条本地 memory、session slice、observation candidate
- `tags`: 用于 recall filter 和 visibility slicing，例如 `scope:personal`、`category:tool`、`status:confirmed`
- `types`: 交给 Hindsight 在单 bank 内自动产出 `world` / `experience` / `observation`

本地 memory category 不直接变成 bank。category 更适合进 tags，metadata 只保留 string-valued trace fields。

## Understand Hindsight storage

Hindsight 本地 embedded mode 不是把数据写成一组本地 JSON 文件。官方文档说明它唯一的 storage backend 是 PostgreSQL；开发态默认拉起 embedded `pg0`，未配置 `DATABASE_URL` 时数据落在 `~/.hindsight/pg0/`。

这对集成方案有两个直接影响：

1. OpenCode 现有 `personal.json` 仍然是 authority，不能指望和 Hindsight 底层存储做文件级同步
2. 现有 JSON memory 导入 Hindsight 时，必须走 Hindsight API 的 `retain` / `retainBatch` / document upsert 流程，而不是写库或写文件

导入后在 Hindsight 里可观测到的主要对象是：

- `documents`: source container，持有 `id`, `original_text`, `content_hash`, `memory_unit_count`, `tags`, `document_metadata`
- `chunks`: retained 原文分块，保留原始文本上下文
- `memory units`: Hindsight 从 retained content 中抽取出的事实单元
- `observations`: consolidation 后形成的更高层综合观察

phase 1 的 OpenCode mapping 应该主要依赖 `document_id`、`tags`、`metadata` 和 recall result 里的 `document_id` / `id`，而不是假设 Hindsight 会保留 OpenCode 自定义 schema。

## Define stable ids

必须先解决 idempotency。否则 backfill、re-retain 和 stale cleanup 都会失控。

建议规则：

- Local memory doc id: `mem:${workspaceHash}:${memory.id}`
- Session slice doc id: `sess:${workspaceHash}:${sessionID}:${start}:${end}`
- Observation doc id: `obs:${workspaceHash}:${sessionID}:${hash}`

`workspaceHash` 用稳定 project/worktree identity 生成。不要依赖随机 uuid。

## Run the service

优先使用 `@vectorize-io/hindsight-all` + `@vectorize-io/hindsight-client`。它更适合 Node/Bun 内嵌监督模式。

保留 `hindsight-embed` CLI 作为实现备选，但 phase 1 最好只有一个默认路径。这样测试和 fallback 更简单。

生命周期建议：

1. First use 时 lazy start
2. Health check 成功后写入 in-process ready state
3. 同 workspace 复用同一 client/service handle
4. 进程退出时尝试优雅 shutdown
5. start/query timeout 都走非 fatal fallback

ASCII flow:

```text
OpenCode session
    |
    +--> MemoryHindsight.service()
             |
             +--> start local daemon on 127.0.0.1
             +--> health check
             +--> return client
             +--> on failure => degraded + fallback
```

## Integrate extract

`extract` 不是只在最后把结果写进 Hindsight。它应该在分析前后都使用 Hindsight。

推荐流程：

```text
session messages
   |
   +--> retain session slice into Hindsight workspace bank
   |
   +--> query Hindsight for related docs / observations
   |
   +--> merge with existing local memories
   |
   +--> call existing MemoryExtractor LLM prompt
   |
   +--> create/update authoritative local memories
   |
   +--> retain resulting memory docs back into Hindsight
```

具体集成点：

- `packages/opencode/src/memory/engine/extractor.ts` 在 `Memory.list()` 后追加 Hindsight context gathering
- prompt 输入新增一个 section，比如 `## Hindsight context`
- section 内容只放有限条目，避免 prompt 膨胀
- local memory write path 仍然调用 `Memory.create()` / `Memory.update()`

extract path 的 Hindsight 输入建议分两类：

- ranked related documents
- structured observations or facts derived from retained conversation

如果 Hindsight 返回空、超时或 parse 失败，直接省略该 section。不要让 extractor flow fail closed。

## Integrate recall

`recall` 的目标不是让 Hindsight 直接决定注入文本。它只负责更强的 ranking。

推荐流程：

```text
recent conversation
   |
   +--> query Hindsight with session context
   |
   +--> get ranked source refs / memory ids
   |
   +--> resolve refs against local Memory.list()
   |
   +--> optional current recall-agent filter on narrowed set
   |
   +--> inject authoritative local memories
```

两种 phase 1 方案都可行：

- 方案 A: Hindsight 先缩小 candidate set，再交给现有 recall agent 做 final filter
- 方案 B: Hindsight 直接给 ranked ids，OpenCode 按 top-k 注入并保留 conflict logic

建议先做方案 A。它更保守，也更符合 phased rollout。

`packages/opencode/src/memory/engine/recall.ts` 需要：

- 先从本地 memory 拿全量或基础 candidate
- 若 hindsight enabled，调用 `memory/hindsight/recall.ts`
- 把结果 resolve 成本地 `Memory.Info[]`
- 对 stale ids 做 drop + log
- 若 Hindsight unavailable，走当前逻辑

### Resolve `document_id -> memory_id`

phase 1 不应把 Hindsight 的 `memory unit id` 或 observation id 当成 OpenCode 主键。OpenCode 侧长期稳定的回查锚点只有两类：

- `document_id`，例如 `mem:${workspaceHash}:${memory.id}`
- `metadata.memory_id`，作为 document trace 字段和 fallback

建议 resolve 优先级：

1. 命中结果有 `document_id`，且符合 `mem:${workspaceHash}:<memoryId>` 规则时，直接 parse 出本地 `memoryId`
2. 若 `document_id` 不可逆解析，再尝试读 `metadata.memory_id`
3. 若命中结果是 observation，且带有 `source_fact_ids` 或 source facts，则优先回到其关联 source fact 的 `document_id`
4. 上述都失败时，把命中视为 unresolved，记录 debug log 后丢弃，不进入 injection

建议约束：

- `sess:` 和 `obs:` 文档默认不直接注入；它们只作为 ranking evidence 或 extractor context
- 只有 `mem:` 文档允许直接 resolve 成本地 authority memory
- resolve 阶段必须校验 `workspaceHash`，避免跨 workspace bank 污染

可用一个明确的 parser，避免 recall 逻辑散落在 hook 里：

```ts
type ResolveHit = {
  memoryId?: string
  documentId?: string
  reason: "document_id" | "metadata" | "source_fact" | "unresolved"
}

function resolve(hit: RecallResult, workspaceHash: string): ResolveHit {
  const doc = hit.document_id
  if (doc?.startsWith(`mem:${workspaceHash}:`)) {
    return {
      memoryId: doc.slice(`mem:${workspaceHash}:`.length),
      documentId: doc,
      reason: "document_id",
    }
  }

  const id = hit.metadata?.memory_id
  if (typeof id === "string" && id.length > 0) {
    return {
      memoryId: id,
      documentId: doc ?? undefined,
      reason: "metadata",
    }
  }

  return {
    documentId: doc ?? undefined,
    reason: "unresolved",
  }
}
```

### Recall resolve pipeline

建议把 Hindsight recall 命中后的 authority 回查明确成单独流程：

```ts
async function recallWithAuthority(input: {
  sessionId: string
  query: string
  pool: Memory.Info[]
  workspaceHash: string
}) {
  const hits = await HindsightRecall.query(input)
  const ids = hits
    .map((hit) => resolve(hit, input.workspaceHash))
    .filter((hit) => hit.memoryId)
    .map((hit) => hit.memoryId as string)

  const uniq = [...new Set(ids)]
  const local = new Map(input.pool.map((m) => [m.id, m]))
  const resolved = uniq.flatMap((id) => {
    const mem = local.get(id)
    return mem ? [mem] : []
  })

  return {
    hits,
    resolved,
    stale: uniq.filter((id) => !local.has(id)),
  }
}
```

这个流程里要明确三件事：

- Hindsight 只负责排序和证据，不直接产出 prompt payload
- local authority lookup 只认 `Memory.list()` 结果里的本地 record
- stale / unresolved 命中要 drop，但要记日志，便于发现 backfill 漏洞或 bank 污染

## Decide injection ownership

`packages/opencode/src/memory/hooks/inject.ts` 不需要理解 Hindsight document schema。它只消费本地 memory ids 或 `Memory.Info`。

这样 injection hook 保持稳定。ranking source 可替换，但 injection contract 不变。

## Preserve hit tracking and decay

`packages/opencode/src/memory/hooks/hit-tracker.ts` 和 `packages/opencode/src/memory/optimizer/decay.ts` 继续只操作本地 memory。不要在 phase 1 试图同步 Hindsight 内部 usage counter。

如果需要观测 Hindsight 命中，可以额外记录 log 或 event。不要改写现有 authority field。

## Sketch the config

建议在 `packages/opencode/src/config/config.ts` 增加：

```ts
memory: {
  hindsight: {
    enabled: boolean
    mode: "embedded"
    extract: boolean
    recall: boolean
    backfill: boolean
    workspaceScope: "project" | "worktree"
    bankPrefix: string
    startupTimeoutMs: number
    queryTimeoutMs: number
    retainLimit: number
    recallLimit: number
    observationLimit: number
    logLevel: "error" | "warn" | "info" | "debug"
  }
}
```

默认建议：

- `enabled: false`
- `mode: "embedded"`
- `extract: true`
- `recall: true`
- `backfill: false`
- `workspaceScope: "project"`

phase 1 不开放 remote endpoint、api key、cloud tenant 等配置。

## Handle failure and fallback

失败处理必须细分。不要把所有异常都变成一个黑盒 `catch`。

建议分类：

- startup failure -> mark degraded, skip Hindsight for session/process window
- health failure -> recheck once, then fallback
- retain failure -> log and continue extract/recall
- query timeout -> fallback to current recall/extract context
- stale reference -> drop silently with debug log
- backfill interruption -> resume from checkpoint or re-run idempotently

fallback contract：

- user session must continue
- local memory create/update must continue
- injection must continue
- no destructive writeback to local memory on Hindsight partial failure

## Plan backfill

backfill 只把现有本地 memory 复制进入 Hindsight。它不是 schema migration。

建议实现：

1. Read all local memories
2. For each memory, map one authoritative Hindsight `document_id`, one text payload, string-only metadata, and normalized tags
3. Import via `retain()` or batched `retainBatch()` into the workspace bank instead of writing PostgreSQL directly
4. Prefer `document_id` upsert with `updateMode: "replace"` so reruns are deterministic
5. Use async batches for larger imports, then poll Hindsight operations state until `completed` or `failed`
6. Record structured state in local persistence, such as a dedicated memory meta record or JSON state object with `status`, `cursor`, `processed`, `updatedAt`, `operationIds`, `lastDocumentId`, `failures`, and summary counts; do not rely on the current numeric-only `Memory.setMeta()` shape unchanged

可以增加一个显式入口，但 phase 1 不强制需要独立 CLI。也可以在 enable 后由 hook 延迟触发一次。

建议的 JSON -> Hindsight 导入 mapping：

```ts
// Local memory -> Hindsight retain item
{
  content: memory.content,
  document_id: `mem:${workspaceHash}:${memory.id}`,
  timestamp: new Date(memory.updatedAt).toISOString(),
  context: memory.source.contextSnapshot,
  tags: [
    `scope:${memory.scope}`,
    `status:${memory.status}`,
    ...memory.categories.map((x) => `category:${x}`),
    ...memory.tags.map((x) => `tag:${x}`),
  ],
  metadata: {
    workspace_id: workspaceHash,
    project_root: projectRoot,
    memory_id: memory.id,
    session_id: memory.source.sessionID,
    source_kind: "memory",
    source_method: memory.source.method,
    created_at: new Date(memory.createdAt).toISOString(),
    updated_at: new Date(memory.updatedAt).toISOString(),
    citations_json: JSON.stringify(memory.citations),
  },
  update_mode: "replace",
}
```

具体导入策略建议：

- 每条本地 memory 对应一个 Hindsight document，优先保证 idempotent upsert，而不是把多个 memory 先拼成大文档
- `categories` 和 OpenCode tags 主要落到 Hindsight tags，方便 recall filter；metadata 只放 trace fields 和必要的 JSON-stringified 辅助字段
- recall 命中后优先通过 `document_id -> memory_id` 映射回本地 authority；不要把 Hindsight memory unit id 当长期稳定主键
- backfill 结束后可用 list-documents / get-document / bank stats 做抽样校验，确认 `total_documents` 与本地导入条数大致一致

### Persist backfill state

当前 `packages/opencode/src/memory/storage.ts` 里的 `meta` 还是 `Record<string, number>`，适合时间戳或计数，不适合承载 backfill 的结构化恢复状态。

phase 1 建议不要继续扩 `personal.json.meta`，而是新增一个与 `personal.json` 同目录的 sidecar state 文件，例如：

```text
${Global.Path.data}/memory/${encodeURIComponent(Instance.directory)}/hindsight.json
```

这样做的原因：

- 保持 project-scoped isolation，与现有 `personal.json` 存储边界一致
- 避免为了 Hindsight 改写本地 authority 文件 shape，减少 migration 风险
- 允许后续在同一 sidecar 文件里继续放 service state、bank identity、backfill audit，而不污染 memory authority record

建议 sidecar shape：

```ts
type HindsightState = {
  version: 1
  bankId: string
  workspaceHash: string
  workspaceScope: "project" | "worktree"
  updatedAt: number
  backfill: BackfillState
}

type BackfillState = {
  status: "idle" | "running" | "paused" | "completed" | "failed"
  mode: "manual" | "auto"
  startedAt?: number
  updatedAt: number
  completedAt?: number
  cursor?: string
  lastMemoryId?: string
  lastDocumentId?: string
  processed: number
  succeeded: number
  failed: number
  skipped: number
  batchSize: number
  operationIds: string[]
  failures: Array<{
    memoryId: string
    documentId: string
    error: string
    at: number
  }>
}
```

字段约束建议：

- `cursor` 记录本地 JSON 遍历进度，默认使用最后一个成功写入的 `memory.id`
- `lastDocumentId` 只做调试和对账，不做 authority source
- `operationIds` 只保存仍可能需要轮询的 async retain operation；完成后可裁剪
- `failures` 保留最近 N 条，例如 100 条，避免 sidecar 无限增长
- `completedAt` 只有 `status === "completed"` 时写入

### Backfill lifecycle

建议状态流转：

```text
idle -> running -> completed
                -> failed
                -> paused
paused -> running
failed -> running
completed -> running   // explicit re-run only
```

执行规则：

- 启动时如果 `status === "running"`，不要直接假设成功，先检查 `operationIds` 对应的 Hindsight operations 状态
- 若全部 operation 已 `completed`，继续从 `cursor` 后恢复
- 若任一 operation `failed`，写入 `failures` 并把 state 标成 `failed`
- 若 operation 不存在但本地 state 仍是 `running`，按不确定中断处理：从 `lastMemoryId` 对应 document 做抽样校验后继续幂等重放
- `paused` 只由显式用户动作或安全阈值触发，不由普通 retain error 隐式写入

### Resume and reconciliation

恢复和对账建议分三步：

1. 读取 `hindsight.json`，确定 `bankId`、`cursor`、`operationIds`
2. 轮询未完成 operation，清理已完成项，记录失败项
3. 从 `cursor` 后继续导入；每个 retain item 仍使用稳定 `document_id` + `updateMode: "replace"`

导入完成后的轻量对账：

- 本地统计 `Memory.list()` 条数
- Hindsight 侧用 `listDocuments()` 或 bank stats 读取 `total_documents`
- 允许一定偏差，但偏差必须可解释，例如 session slice / observation docs 是否也进入同一个 bank
- 随机抽样 `getDocument(document_id)`，验证 `document_metadata.memory_id`、`tags`、`original_text` 与本地 JSON 一致

如果 phase 1 只 backfill 本地 memory，不回填 session slice / observation docs，那么验收时应要求：

- `total_documents >= succeeded`
- 抽样文档的 `document_id` 可逆解析出本地 `memory.id`
- recall 命中结果里的 `document_id` 能稳定 resolve 回本地 authority

## Add observability

至少需要这些日志字段：

- service state
- startup duration
- query duration
- retain count
- ranked hit count
- resolved local id count
- stale drop count
- fallback reason
- backfill progress

如果要加 event，建议保持轻量：

- `MemoryEvent.HindsightReady`
- `MemoryEvent.HindsightFallback`
- `MemoryEvent.HindsightBackfillProgress`

event 不是必须。日志优先。

## Change the files

建议新增和修改如下。

新增：

- `packages/opencode/src/memory/hindsight/service.ts` 管 daemon lifecycle
- `packages/opencode/src/memory/hindsight/client.ts` 管 SDK call wrapper
- `packages/opencode/src/memory/hindsight/mapper.ts` 管 id/metadata mapping
- `packages/opencode/src/memory/hindsight/bank.ts` 管 bank naming
- `packages/opencode/src/memory/hindsight/retain.ts` 管 retain/upsert
- `packages/opencode/src/memory/hindsight/recall.ts` 管 retrieval wrapper
- `packages/opencode/src/memory/hindsight/backfill.ts` 管 backfill and checkpoint
- `packages/opencode/src/memory/hindsight/state.ts` 管 sidecar state read/write and recovery

建议进一步拆成函数级职责，避免后续实现时边界漂移：

- `service.ts`
  - `get(input)`：返回 workspace-scoped singleton service handle
  - `start(input)`：启动 `HindsightServer` 并等待 health
  - `stop(input)`：优雅停止 daemon
  - `health(input)`：检查当前 service 是否可用
  - `baseUrl(input)`：返回 client 连接地址
- `client.ts`
  - `connect(input)`：基于 service handle 构造 `HindsightClient`
  - `retain(input)`：单条 retain wrapper，统一 timeout 和错误包装
  - `retainBatch(input)`：批量 retain wrapper
  - `recall(input)`：统一 recall 调用参数、budget 和 include options
  - `listDocuments(input)` / `getDocument(input)` / `listOperations(input)`：给 backfill / reconcile 用的薄封装
- `bank.ts`
  - `workspaceHash(input)`：基于 project/worktree 生成稳定 hash
  - `bankId(input)`：生成 `opencode:${workspaceHash}`
  - `tags(input)`：把 scope/category/status/tag 归一成 Hindsight tags
  - `filter(input)`：把 recall filter 转成 Hindsight tags / types 参数
- `mapper.ts`
  - `memoryDocumentId(memory, workspaceHash)`
  - `sessionDocumentId(input)`
  - `observationDocumentId(input)`
  - `memoryMetadata(memory, workspace)`：生成 string-only metadata
  - `retainItem(memory, workspace)`：把本地 memory 映射成 Hindsight retain item
  - `resolve(hit, workspaceHash)`：把 recall hit 映射回本地 `memoryId`
- `retain.ts`
  - `upsertMemory(input)`：单条本地 memory -> Hindsight document
  - `upsertSessionSlice(input)`：session slice retain
  - `upsertBatch(input)`：批量导入入口
  - `normalize(input)`：统一 `updateMode`, timestamp, context, tags 上限
- `recall.ts`
  - `query(input)`：对 Hindsight 发起 recall
  - `resolveHits(input)`：把 hits 解析成本地 candidate ids
  - `rank(input)`：返回 narrowed local pool 和调试信息
  - `context(input)`：给 extractor 准备 Hindsight context section
- `backfill.ts`
  - `run(input)`：主 backfill 流程
  - `resume(input)`：从 state 恢复
  - `step(input)`：处理一批 memory
  - `reconcile(input)`：导入结束后抽样对账
  - `retry(input)`：重跑 failed state
- `state.ts`
  - `load(input)`：读 `hindsight.json`
  - `save(input)`：原子写回 state
  - `mutate(input)`：封装单锁更新
  - `markRunning(input)` / `markFailed(input)` / `markCompleted(input)`
  - `trimFailures(input)`：限制 sidecar 膨胀

建议模块依赖方向保持单向：

```text
service -> client
bank -> mapper -> retain/recall/backfill
state -> backfill
recall -> engine/recall.ts
retain -> extractor.ts / auto-extract.ts / backfill.ts
```

其中两条约束要明确：

- `engine/recall.ts` 和 `engine/extractor.ts` 只编排，不直接理解 Hindsight SDK 细节
- `hooks/inject.ts` 只消费本地 authority 结果，不依赖 `document_id` parser 或 Hindsight response shape

修改：

- `packages/opencode/src/memory/engine/extractor.ts`
- `packages/opencode/src/memory/engine/recall.ts`
- `packages/opencode/src/memory/hooks/auto-extract.ts`
- `packages/opencode/src/memory/hooks/inject.ts`
- `packages/opencode/src/memory/hooks/hit-tracker.ts`
- `packages/opencode/src/memory/memory.ts`
- `packages/opencode/src/config/config.ts`

如果需要暴露 state，可再补：

- `packages/opencode/src/memory/event.ts`

## Roll out in phases

### Phase 0

先接 service、config、mapping 和 no-op fallback。此时默认关闭。

### Phase 1

上线 recall + extract integration，一起打通 companion 模式的主路径，但仍保持 `enabled: false` 默认关闭。

### Phase 2

补 backfill、observability hardening 和 tuning。必要时再评估 world bank 扩展。

## Test the design

测试策略分三层。

### Unit

- `mapper` 的 stable id 生成
- metadata mapping
- stale ref filtering
- config parsing
- fallback decision logic

### Integration

- Hindsight enabled recall returns ranked refs -> resolves to local memory ids
- Hindsight timeout -> current recall path still works
- Hindsight extract context injected -> local memory create/update still works
- backfill re-run remains idempotent and restores from structured persisted state

### Behavior

- injection only sees authoritative local memories
- hit tracking still increments local records
- decay and confirmation remain unchanged when Hindsight is enabled

如果 CI 不适合拉起真实 daemon，可加 lightweight fake adapter for wrapper-level tests。真实 daemon smoke test 可以放成 opt-in integration test。

## Watch the risks

主要风险：

- local daemon lifecycle 在 Bun/Node 环境下不稳定
- retrieval 结果和 local memory 映射漂移
- extract prompt 因额外 context 过长而退化
- backfill 写入量过大导致首次启用卡顿

对应缓解：

- lazy start + timeout + process cache
- stable id + stale drop + upsert only
- hard limit Hindsight context size
- backfill 分批并记录 checkpoint

## Decide later

phase 1 之后再决定两件事：

- 是否让 Hindsight observation 成为本地 memory candidate 的更强输入
- 是否让部分 durable world facts 走更专门的 bank 策略

现阶段不要做 source-of-truth replacement。先把 companion 模式跑稳。
