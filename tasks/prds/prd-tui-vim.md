# PRD: TUI Input Vim Mode

## Introduction

为 OpenCode 的 TUI 输入框增加 Vim 模式，让习惯 Vim 编辑方式的用户可以在终端内更高效地编辑 prompt，而不必切换回系统默认的文本编辑习惯。

当前问题是：TUI 输入框支持基础文本编辑，但对重度键盘用户来说，光标移动、删除、修改、选择和进入插入状态的效率不高，尤其在多行 prompt、长 prompt、命令式编辑场景下更明显。

本阶段目标是定义一个最小可交付版本（MVP），优先解决“是否支持 Vim 风格的模态编辑”和“支持到什么程度”的问题，同时控制实现复杂度，避免把输入框演变成完整 Vim 编辑器。

当前已确定的产品决策：

- Vim 模式开关首版支持配置文件 + 启动参数/命令行选项
- Vim 模式下优先保持现有 `Enter` 提交语义，避免打断当前 prompt 提交流程
- 模式状态优先显示在现有状态栏/状态区，而不是额外增加输入框边框提示或新面板
- 功能范围首版仅面向 TUI 输入框，不抽象为跨终端共享编辑模型
- Vim 模式启用后，输入框获得焦点时默认进入 `Insert`，降低首次输入成本
- MVP 暂不纳入 `o` `O` `dd` `cw` 等复合编辑命令，先聚焦基础导航与模态切换

## Goals

- 让 Vim 用户可以在 TUI 输入框内完成常见编辑操作，而不依赖方向键或重复删除输入
- 为不使用 Vim 的用户保留当前默认输入体验，且默认行为不回归
- 将功能限制在输入框编辑能力，不扩展到全局 TUI 导航或命令模式
- 支持增量交付，先上线最小可用 Vim 模式，再视反馈补充高级操作

## User Stories

### US-001: 提供 Vim 模式开关

**Description:** As a TUI user who prefers Vim editing, I want to enable Vim mode for the input box so that I can use modal editing without affecting users who prefer the current behavior.

**Acceptance Criteria:**

- [ ] 提供明确的 Vim 模式开关入口，至少支持通过配置文件与启动参数/命令行选项开启或关闭
- [ ] 默认保持当前非 Vim 行为不变
- [ ] Vim 模式关闭时，现有 submit/newline/文本编辑行为无回归
- [ ] Typecheck passes

### US-002: 支持 Normal 和 Insert 两种基础模式

**Description:** As a Vim user, I want the input box to support Normal mode and Insert mode so that I can switch between navigation and text entry efficiently.

**Acceptance Criteria:**

- [ ] Vim 模式开启后，输入框至少支持 `Normal` 和 `Insert` 两种模式
- [ ] 在 `Insert` 模式下，普通字符输入行为与当前输入框一致
- [ ] 在 `Normal` 模式下，普通字符不会直接写入文本
- [ ] Vim 模式启用且输入框获得焦点后，默认进入 `Insert`
- [ ] 支持从 `Insert` 通过 `Esc` 返回 `Normal`
- [ ] 至少支持从 `Normal` 通过 `i` 进入 `Insert`
- [ ] Typecheck passes

### US-003: 支持基础 Vim 导航和编辑命令

**Description:** As a Vim user, I want the most common navigation and editing commands in Normal mode so that I can edit prompts without leaving the keyboard home row.

**Acceptance Criteria:**

- [ ] `h` `j` `k` `l` 可在 `Normal` 模式下移动光标
- [ ] `0` 和 `$` 可移动到当前行首和行尾
- [ ] `w` 和 `b` 可按词移动
- [ ] `x` 可删除光标下字符
- [ ] `a` 和 `A` 可进入追加输入
- [ ] MVP 命令集合有明确边界；首版至少覆盖 `h` `j` `k` `l` `0` `$` `w` `b` `x` `i` `a` `A`
- [ ] `o` `O` `dd` `cw` 在首版中明确标记为非目标范围，避免实现与测试边界不清
- [ ] Typecheck passes

### US-004: 提供可见的模式反馈

**Description:** As a Vim user, I want to see the current input mode so that I do not accidentally submit or edit text in the wrong mode.

**Acceptance Criteria:**

- [ ] 在现有状态栏或状态区显示当前模式状态，至少区分 `NORMAL` 和 `INSERT`
- [ ] 模式反馈在窄终端下仍可辨认，不遮挡主要输入内容
- [ ] 切换模式时状态显示及时更新
- [ ] TUI 手动验证通过
- [ ] Typecheck passes

### US-005: 明确提交与换行在 Vim 模式下的行为

**Description:** As a Vim user, I want submit and newline behavior to remain predictable in Vim mode so that I do not lose prompts or break existing input workflows.

**Acceptance Criteria:**

- [ ] `Insert` 模式下 `Enter` 默认保持当前提交语义，不因启用 Vim 模式自动改成插入换行
- [ ] `Normal` 模式下 `Enter` 行为有明确规则，且不会导致用户误提交 prompt
- [ ] 现有 `input_submit` 和 `input_newline` keybind 配置与 Vim 模式的优先级关系明确且可测试
- [ ] 不因 Vim 模式导致用户无法可靠提交 prompt
- [ ] Typecheck passes

## Functional Requirements

- FR-1: 系统必须允许用户为 TUI 输入框启用或禁用 Vim 模式。
- FR-2: 首版必须同时支持配置文件与启动参数/命令行选项两种 Vim 模式开关入口。
- FR-3: Vim 模式范围仅限于 TUI 输入框编辑，不改变 TUI 其他区域的键盘行为。
- FR-4: 首版不得为了 Vim 模式引入跨终端共享编辑模型或新的通用编辑器抽象，除非现有输入组件无法满足 MVP。
- FR-5: Vim 模式至少包含 `Normal` 和 `Insert` 两种模式。
- FR-6: Vim 模式启用且输入框获得焦点时，系统必须默认进入 `Insert` 模式。
- FR-7: 系统必须支持使用 `Esc` 从 `Insert` 返回 `Normal`。
- FR-8: 系统必须支持使用 `i` 从 `Normal` 进入 `Insert`。
- FR-9: 在 `Normal` 模式下，`h` `j` `k` `l` 必须执行光标移动，而不是写入文本。
- FR-10: 在 `Insert` 模式下，现有文本输入、粘贴、历史、附件等行为必须保持兼容，除非有明确例外说明。
- FR-11: 系统必须在现有状态栏或状态区提供当前模式的可见反馈，不新增独立面板。
- FR-12: Vim 模式开启后，`Insert` 模式下 `Enter` 必须默认沿用当前提交语义，除非用户显式触发现有换行 keybind。
- FR-13: 系统必须明确 Vim 模式与现有 `input_submit`、`input_newline`、textarea keybindings 的冲突处理规则。
- FR-14: 系统必须为 MVP 明确定义支持的 Vim 命令集合；未支持命令需要视为超出首版范围，而不是未定义行为。
- FR-15: `o` `O` `dd` `cw` 等复合编辑命令首版不得隐式支持或部分支持；若未实现，必须明确列为后续候选。
- FR-16: 当 Vim 模式关闭时，输入框行为必须与当前实现保持一致。

## Non-Goals

- 不实现完整 Vim 功能集（如宏、寄存器、文本对象、可视模式、命令行模式、搜索替换）
- 不修改 web 输入框行为
- 不为整个 TUI 增加全局 Vim 导航
- 不在首版中抽象为可复用到其他终端输入场景的共享编辑模型
- 不在首个版本中支持用户自定义 Vim 键位映射
- 不在首个版本中追求与原生 Vim 100% 一致
- 不因为启用 Vim 模式而重定义默认 prompt 提交流程

## Design Considerations

- 模式指示应尽量复用现有状态栏或 prompt 状态区，避免引入新面板
- 文案需要让非 Vim 用户也能理解，例如首次启用时提示 `Esc` / `i` 的基本用法
- 如果空间允许，可在 placeholder 或状态区显示最小帮助提示，但不应长期占用主要编辑区域
- 交互优先级应是“避免误提交”高于“追求 Vim 细节一致性”
- 默认进入 `Insert` 的决策应在体验上保持“聚焦即可输入”；用户无需先学习 `i` 才能完成首次 prompt 输入

## Technical Considerations

- 重点实现位置预计在 `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` 与 `packages/opencode/src/cli/cmd/tui/component/textarea-keybindings.ts`
- 现有输入框已经有 textarea keybinding 映射机制；Vim 模式需要定义与该机制的关系，避免重复拦截或行为冲突
- 需要确认底层 `TextareaRenderable` 是否已提供足够的光标移动与文本编辑原语，避免为少量收益重写输入组件
- 若实现成本过高，MVP 应优先选择“有限 Vim 仿真”而不是引入新的复杂编辑器抽象或跨端共享模型
- 建议按阶段交付：第一阶段只做开关、模式切换、状态提示、基础导航和少量编辑命令；第二阶段再根据反馈评估 `o` `O` `dd` `cw` 等高频命令
- 首版应避免半实现复合命令；比起支持不完整的 `dd`/`cw`，更优先保证基础命令与提交流程稳定

## Success Metrics

- 启用 Vim 模式的用户可以在不离开键盘主区的情况下完成常见 prompt 编辑
- Vim 模式关闭的用户无行为回归
- 首版上线后，至少能覆盖 Vim 用户最常用的一组基础命令，而不是只支持模式切换
- 该功能不会显著增加输入框相关 bug 或维护复杂度
- 不因 Vim 模式导致 prompt 提交成功率下降或新增明显误提交反馈

## Open Questions

- 当前无新增未决问题；若实现中发现 `TextareaRenderable` 无法稳定支持词级移动或模态切换，再回到方案评审补充技术决策.
