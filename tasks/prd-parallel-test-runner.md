# PRD: Bun 并发/分布式测试运行器（文件级并发）

## Introduction

当前 `bun test` 在 `packages/opencode` 下串行执行所有 120+ 个测试文件，总耗时随测试量线性增长。本功能设计一套基于 Bun 的**文件级并发测试运行器**，通过多进程并行执行、智能负载均衡分片、实时结果流式聚合，显著缩短本地开发和 CI/CD 的测试等待时间。单机模式优先交付，分布式（多机）模式作为可选扩展。

---

## Goals

- 将 `packages/opencode` 的测试总耗时缩短 60%+（以 4 核机器为基准）
- 支持单机多进程并发（N worker 进程并行跑不同文件）
- 支持分布式多机执行（可选，通过 coordinator/agent 模型）
- 基于历史耗时数据实现智能分片，保证各 worker 负载均衡
- 实时流式输出每个文件的通过/失败结果
- 最终输出聚合汇总报告（总耗时、通过数、失败数、各文件耗时）
- 对失败用例提供与原生 `bun test` 一致的错误信息

---

## User Stories

### US-001: 文件发现与分片计算
**Description:** As a developer, I want the runner to automatically discover all test files and split them into balanced shards so I don't need to manually specify files.

**Acceptance Criteria:**
- [ ] 递归扫描指定目录（默认 `test/`），收集所有 `*.test.ts` 文件路径
- [ ] 读取历史耗时数据文件（`.test-timing.json`）；首次运行时无历史数据则均分
- [ ] 使用 greedy bin-packing 算法将文件分配到 N 个 worker，使各 worker 预期耗时差异最小
- [ ] 支持 `--workers N` 参数覆盖 worker 数（默认 = `os.cpus().length`）
- [ ] 支持 `--pattern glob` 参数过滤要执行的文件（如 `--pattern "test/security/**"`）
- [ ] Typecheck passes

### US-002: 多进程并发执行（单机模式）
**Description:** As a developer, I want multiple bun test processes to run in parallel on my machine so I can get faster feedback during development.

**Acceptance Criteria:**
- [ ] 每个测试文件启动独立的 `bun test <file>` 子进程（1 file = 1 process，完全隔离）
- [ ] 各 worker 进程彼此隔离（独立 stdio、独立环境变量、独立 process.env）
- [ ] 支持 `--timeout N` 参数设定每个 worker 的最大执行时间（秒），超时则 kill 并标记为失败
- [ ] 最大并发进程数受 `--max-workers` 限制（默认 = `os.cpus().length`，防止资源耗尽）
- [ ] 默认：任意 worker 失败不影响其他 worker 继续执行
- [ ] 支持 `--stop-on-failure` 参数：首个失败出现后立即 kill 所有运行中进程并退出
- [ ] Typecheck passes

### US-003: 实时流式输出
**Description:** As a developer, I want to see each test file's result as soon as it finishes so I don't have to wait for all tests to complete before getting feedback.

**Acceptance Criteria:**
- [ ] 每个测试文件执行完毕后立即输出：文件路径、通过数、失败数、耗时
- [ ] 失败时立即打印完整错误信息（与 `bun test` 原生输出一致）
- [ ] 支持 `--silent` 参数仅输出最终汇总（适合 CI 日志精简）
- [ ] 支持 `--verbose` 参数输出每条 test case 的结果
- [ ] 进度条显示：`[已完成文件数/总文件数]`
- [ ] Typecheck passes

### US-004: 历史耗时数据记录
**Description:** As a developer, I want the runner to learn from past runs so future sharding gets more accurate and balanced.

**Acceptance Criteria:**
- [ ] 每次运行结束后，将各文件实际耗时写入 `.test-timing.json`（项目根目录）
- [ ] 数据格式：`{ "test/file.test.ts": { "avg": 1234, "runs": 5 } }`（移动平均）
- [ ] 若文件已被删除，则从记录中清除
- [ ] `.test-timing.json` 提交到 git（初始值由首次运行后手动提交，后续持续更新）
- [ ] Typecheck passes

### US-005: 聚合汇总报告
**Description:** As a developer, I want a clear final summary after all tests finish so I can quickly assess the overall test run result.

**Acceptance Criteria:**
- [ ] 所有 worker 完成后输出汇总：总测试数、通过数、失败数、跳过数、总耗时、并发加速比
- [ ] 列出所有失败的文件（路径 + 失败用例数）
- [ ] 支持 `--reporter json` 输出机器可读的 JSON 报告文件（`test-results.json`）
- [ ] 支持 `--reporter junit` 输出 JUnit XML（兼容 CI 平台报告）
- [ ] 非零退出码当有任意测试失败时（与 `bun test` 一致）
- [ ] Typecheck passes

### US-006: CLI 入口集成
**Description:** As a developer, I want a simple command to replace `bun test` so I can adopt the parallel runner with minimal friction.

**Acceptance Criteria:**
- [ ] 在 `packages/opencode/package.json` 中新增 `"test:parallel": "bun run script/test-parallel.ts"` 脚本
- [ ] 支持所有常用参数：`--workers`, `--pattern`, `--timeout`, `--reporter`, `--silent`, `--verbose`, `--stop-on-failure`
- [ ] `--help` 输出完整参数说明
- [ ] `bun run test:parallel` 与 `bun test` 产生等价的通过/失败结果（正确性等价）
- [ ] Typecheck passes

### US-007: 分布式多机模式（可选扩展）
**Description:** As a CI engineer, I want to distribute test files across multiple machines so large test suites can finish even faster on CI.

**Acceptance Criteria:**
- [ ] 支持 `--shard N/M` 参数（如 `--shard 1/4` 表示本机执行第 1 片，共 4 片），兼容 GitHub Actions matrix strategy
- [ ] 分片编号与文件列表确定性一致（相同文件集、相同 N/M 总产生相同分配）
- [ ] 各机器独立运行，无需网络通信（stateless sharding）
- [ ] 可选：支持通过环境变量 `TEST_SHARD_INDEX` / `TEST_SHARD_TOTAL` 控制分片（CI 友好）
- [ ] Typecheck passes

---

## Functional Requirements

- **FR-1:** 递归发现 `*.test.ts` 文件，支持 glob pattern 过滤
- **FR-2:** 读取/写入 `.test-timing.json` 作为历史耗时缓存（移动平均）
- **FR-3:** 使用 LPT（最长处理时间优先）调度：文件按历史耗时降序入队，空闲 slot 立即取队头启动，最大并发受 `--max-workers` 控制，最小化总 wall time
- **FR-4:** 以独立子进程运行每个 shard（`Bun.spawn`），并发上限受 `--max-workers` 控制
- **FR-5:** 捕获每个子进程的 **stderr**（bun test 将汇总行输出至 stderr），用正则表达式 `/(\d+)\s+pass/`、`/(\d+)\s+fail/`、`/(\d+)\s+skip/` 提取通过/失败/跳过数；不使用 `--reporter json`（Bun 不支持该选项）
- **FR-6:** 每个文件完成后即时输出结果（实时流式），不等待全部完成
- **FR-7:** 所有 worker 完成后输出聚合汇总，包含加速比计算（串行耗时 / 实际耗时）
- **FR-8:** 支持 `--reporter json` 和 `--reporter junit` 输出机器可读格式（注：此为汇总报告的输出格式，非 bun 子进程的 reporter 标志）
- **FR-9:** 支持 `--shard N/M` 进行无状态静态分片（分布式模式）
- **FR-10:** 任意 worker 超时时 kill 对应进程并在报告中标记为超时失败
- **FR-11:** 最终进程退出码：有失败时非零，全部通过时为 0

---

## Non-Goals

- 不修改现有 `bun test` 命令（保留原命令不变）
- 不实现 test case 级别的并发（以文件为最小调度单元）
- 不实现动态 work-stealing（智能静态分片足够覆盖大多数场景）
- 不实现网络协调的真分布式（`--shard N/M` 的 stateless 模式已满足多机需求）
- 不实现测试结果缓存/跳过未变更文件（属于独立功能）
- 不提供 Web UI 或 TUI 界面
- 不发布为独立 npm 包（仅作为 monorepo 内工具）

---

## Technical Considerations

- **实现位置：** `packages/opencode/script/test-parallel.ts` + `script/test-parallel/`（与现有 `build.ts` 同级）
- **进程管理：** 使用 `Bun.spawn(["bun", "test", file])` 启动子进程，分别通过 `pipe` 捕获 stdout / stderr
- **输出解析：** 读取子进程 **stderr**（`bun test` 将汇总行 `N pass / N fail / N skip` 输出至 stderr，仅将版本 banner 输出至 stdout）；使用正则 `/(\d+)\s+pass/` 等提取计数。**不传 `--reporter json`**：Bun v1.x 不支持该 reporter，传入会导致进程报错退出，stderr 无汇总行，计数全为 0。
- **并发控制：** 使用 Promise pool（限制最大同时运行的 worker 数），避免 fork bomb
- **分片算法：** Greedy bin-packing，O(N log N)，对 120 个文件完全足够
- **历史数据：** JSON 文件存于项目根目录，key 为绝对路径，value 为移动平均耗时
- **依赖：** 仅依赖 Bun 内置 API + `minimatch`（已存在于 lockfile），不引入额外 npm 包
- **代码风格：** 遵循 AGENTS.md 规范（no try/catch, no any, no else, prefer const）
- **测试：** `test/script/test-parallel/` 下的单元 + 集成测试覆盖 runner / discover / timing 模块

### 输出格式示例（实时）
```
[  1/120] ✓ test/util/format.test.ts          (12 pass, 0 fail, 0.3s)
[  2/120] ✓ test/config/config.test.ts         (8 pass, 0 fail, 0.8s)
[  3/120] ✗ test/security/path-traversal.ts   (5 pass, 2 fail, 1.2s)
  ● should block path traversal
    Expected: false
    Received: true
    at test/security/path-traversal.ts:42
...
[120/120] ✓ test/agent/agent.test.ts           (24 pass, 0 fail, 3.1s)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Test Results  120 files | 847 pass | 2 fail | 0 skip
 Duration      8.4s (serial: 47.2s, speedup: 5.6x)
 Workers       8 / 8 cpus
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### GitHub Actions 分布式使用示例
```yaml
strategy:
  matrix:
    shard: [1, 2, 3, 4]
steps:
  - run: bun run test:parallel --shard ${{ matrix.shard }}/4
```

---

## Design Considerations

### 调度算法（LPT 优先队列）

1 file = 1 process，最大并发 `--max-workers` 个进程同时运行。调度目标是最小化总 wall time（关键路径最短）。

```
输入: files[] 按历史耗时降序排列（LPT: Longest Processing Time first）
      maxWorkers N

queue = files（慢文件在前）
running = []

while queue 非空 or running 非空:
  while running.length < N and queue 非空:
    启动 queue.shift() 对应的 bun test 进程
    running.push(process)
  等待任意一个 running 中的进程完成
  从 running 移除已完成进程，触发实时输出
```

LPT（最长处理时间优先）是经典近似最优调度策略，能有效避免"最后一个慢文件独占尾部"导致整体延迟。首次无历史数据时，按文件名字母序排列（保证确定性）。

### 耗时数据更新（指数移动平均）

```
new_avg = 0.7 * actual_duration + 0.3 * old_avg
```

权重 0.7 偏向近期数据，适应测试文件的增删改。

---

## Success Metrics

- 4 核机器上，120 个测试文件的并发总耗时 ≤ 串行耗时的 40%（加速比 ≥ 2.5x）
- 与 `bun test` 产生等价的通过/失败判定（正确性 100%）
- `--shard N/M` 在 GitHub Actions matrix 场景下可正常使用
- 首次运行（无历史数据）也能正常并发执行，无崩溃

---

## Open Questions

1. ~~bun test 的输出格式是否有稳定的机器可读选项？~~ **已决定（修正）：** Bun v1.x 的 `--reporter` 仅支持 `junit`（需配合 `--reporter-outfile`）和 `dots`，**不支持 `json`**。汇总行（`N pass / N fail / N skip`）输出至 **stderr**，非 stdout。最终方案：直接运行 `bun test <file>`，读取 stderr，用正则解析计数。此为生产实现方式，并由 `test/script/test-parallel/runner.test.ts` 回归覆盖。
2. ~~部分测试是否有全局状态共享，并发运行是否会产生竞争条件？~~ **已决定：** 采用 1 file = 1 process 策略，进程间完全隔离，彻底消除 `process.env` 等共享状态风险。最大并发进程数通过 `--max-workers` 控制上限。
3. ~~`.test-timing.json` 的 git 策略？~~ **已决定：** 提交到 git，初始值由首次运行后手动生成并提交，CI 直接使用仓库中的历史数据，无需 cache action。
4. ~~Worker 进程的环境变量隔离是否需要特殊处理？~~ **已决定：** 完全继承父进程环境变量，不做额外处理。1 file = 1 process 策略已通过 PID 差异保证各进程 tmp 目录隔离，无需额外注入。
