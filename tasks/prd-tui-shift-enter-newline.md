# PRD: TUI Input Box Shift+Enter Newline Support

## Introduction

OpenCode 的 TUI 输入框当前不支持 Shift+Enter 换行。虽然 keybind 配置系统已经定义了 `input_newline` 默认值包含 `shift+return`，但实际在终端中 Shift+Enter 未生效（Cmd+Enter 同样未生效）。

经调研，OpenTUI 的 KeyBinding 匹配机制采用**精确修饰键匹配**（binding key 格式为 `name:ctrl:shift:meta:super`），不存在 plain Enter 拦截 Shift+Enter 的问题。因此根本原因很可能在**终端模拟器层面**：多数终端对 Shift+Enter 和 Enter 发送相同的转义序列（`\r`），导致 OpenTUI 无法感知 `shift` 修饰键。

本 PRD 旨在诊断并解决 TUI 输入框的换行功能，确保用户有可靠的方式在输入框内插入换行。

## Goals

- 确保用户在 TUI 输入框中有至少一种可靠的换行方式
- 优先支持 Shift+Enter 换行（在支持的终端中）
- 保留 Ctrl+J 作为通用的换行后备方案（所有终端均支持）
- 保留硬编码 keybinding 作为兜底机制
- 允许用户通过 `keybinds` 配置自定义 submit/newline 按键

## User Stories

### US-001: 诊断终端 Shift+Enter 支持情况
**Description:** As a developer, I need to understand why Shift+Enter and Cmd+Enter are not working in the TUI, so that I can determine the correct fix strategy.

**Acceptance Criteria:**
- [ ] 在 OpenTUI 的 keyboard handler 中添加调试日志，记录收到的 ParsedKey（包括 name、ctrl、shift、meta 字段）
- [ ] 分别测试 Enter、Shift+Enter、Ctrl+Enter、Cmd+Enter、Ctrl+J，记录 OpenTUI 实际收到的按键信息
- [ ] 确认终端是否将 Shift+Enter 识别为带 `shift: true` 的 `return` 事件
- [ ] 整理诊断结论，确定问题是终端层面还是 OpenTUI 层面

### US-002: 确保 config 驱动的 keybinding 正确生效
**Description:** As a developer, I want to verify that the config-driven keybindings for `input_submit` and `input_newline` are correctly registered in OpenTUI's KeyBinding map, so that the config system works as designed.

**Acceptance Criteria:**
- [ ] 确认 `mapTextareaKeybindings` 为 "submit" 和 "newline" 正确生成了 KeyBinding 条目
- [ ] 确认生成的 KeyBinding 与硬编码条目不冲突（OpenTUI 使用 last-write-wins 合并策略）
- [ ] 保留硬编码的 `{ name: "return", action: "submit" }` 和 `{ name: "return", meta: true, action: "newline" }` 作为兜底
- [ ] 确保 config 驱动的绑定在硬编码之后追加（config 覆盖硬编码）
- [ ] Typecheck passes (`bun turbo typecheck`)

### US-003: Shift+Enter 在支持的终端中插入换行
**Description:** As a user using a modern terminal (Kitty, WezTerm, iTerm2 with CSI u mode), I want Shift+Enter to insert a newline in the TUI input box, so that I can compose multiline prompts.

**Acceptance Criteria:**
- [ ] 在支持区分 Shift+Enter 的终端中，按 Shift+Enter 可在光标位置插入换行
- [ ] 输入框自动扩展高度显示新行（最多 6 行）
- [ ] 光标移至新行开头
- [ ] 按 Enter（无修饰键）仍然提交输入

### US-004: Ctrl+J 作为通用换行快捷键
**Description:** As a user, I want Ctrl+J to always insert a newline regardless of terminal type, so that I have a reliable multiline input method.

**Acceptance Criteria:**
- [ ] Ctrl+J 在所有终端中均可插入换行
- [ ] 行为与 Shift+Enter 完全一致（在光标位置插入换行）
- [ ] 不与其他功能冲突

### US-005: 用户可自定义 submit 和 newline 快捷键
**Description:** As a user, I want to customize which keys trigger submit vs newline via the config file, so that I can match my preferred workflow.

**Acceptance Criteria:**
- [ ] 在 config 中设置 `keybinds.input_submit` 可更改提交键
- [ ] 在 config 中设置 `keybinds.input_newline` 可更改换行键
- [ ] 设置 `keybinds.input_newline` 为 `"none"` 时禁用换行
- [ ] 无效或缺失的配置值回退到默认值

## Functional Requirements

- FR-1: 保留 `textarea-keybindings.ts` 中的硬编码条目 `{ name: "return", action: "submit" }` 和 `{ name: "return", meta: true, action: "newline" }` 作为兜底
- FR-2: Config 驱动的 keybinding 追加在硬编码之后，利用 OpenTUI 的 last-write-wins 合并策略实现 config 覆盖硬编码
- FR-3: `input_submit` 默认值为 `"return"`（plain Enter）
- FR-4: `input_newline` 默认值为 `"shift+return,ctrl+return,alt+return,ctrl+j"`
- FR-5: OpenTUI 的精确匹配机制确保 `return:0:0:0:0`（submit）和 `return:0:1:0:0`（Shift+Enter newline）不会冲突
- FR-6: Ctrl+J（`j:1:0:0:0`）作为不依赖终端修饰键识别的可靠换行方案

## Non-Goals

- 不修改 web UI（`packages/app/`）— 已支持 Shift+Enter 换行
- 不修改 desktop app 快捷键
- 不增加行数指示器等多行编辑 UX 增强
- 不增加 Tab 缩进支持
- 不修改 textarea 最大高度或滚动行为
- 不修改 OpenTUI 上游代码

## Technical Considerations

### OpenTUI KeyBinding 匹配机制（已确认）

OpenTUI 采用精确匹配，binding key 格式为 `name:ctrl:shift:meta:super`：
- `return:0:0:0:0` → Enter（无修饰键）→ submit
- `return:0:1:0:0` → Shift+Enter → newline
- `return:1:0:0:0` → Ctrl+Enter → newline
- `return:0:0:1:0` → Alt/Meta+Enter → newline
- `j:1:0:0:0` → Ctrl+J → newline

每个 key 组合映射唯一 action，不存在优先级/拦截问题。合并策略为 last-write-wins。

### 终端兼容性（核心风险）

| 终端 | Shift+Enter 识别 | Ctrl+Enter | Ctrl+J |
|------|-------------------|------------|--------|
| Kitty | 支持（Kitty keyboard protocol） | 支持 | 支持 |
| WezTerm | 支持 | 支持 | 支持 |
| iTerm2（CSI u 模式） | 支持 | 支持 | 支持 |
| macOS Terminal.app | 不支持（与 Enter 相同） | 不确定 | 支持 |
| 多数 Linux 终端 | 不支持 | 不确定 | 支持 |

**Ctrl+J 是唯一在所有终端中都可靠的换行快捷键**（因为 Ctrl+J 的 ASCII 码就是 `\n`，终端直接发送 `0x0A`）。

### 相关文件

- `packages/opencode/src/cli/cmd/tui/component/textarea-keybindings.ts` — textarea keybinding 配置
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` — Prompt 组件
- `packages/opencode/src/cli/cmd/tui/context/keybind.tsx` — keybind context provider
- `packages/opencode/src/util/keybind.ts` — keybind 解析工具
- `packages/opencode/src/config/config.ts` — 默认 keybind 配置

### 实现建议

1. **第一步（US-001）**：添加调试日志，确认终端实际发送的按键信息
2. **第二步（US-002）**：确认 config 驱动的 keybinding 正确注册到 OpenTUI
3. **第三步（US-003/004）**：根据诊断结果，确保至少 Ctrl+J 可靠工作，Shift+Enter 在支持的终端中工作
4. **第四步（US-005）**：验证用户自定义配置生效

## Success Metrics

- Ctrl+J 在所有终端中可靠插入换行
- Shift+Enter 在支持的现代终端（Kitty、WezTerm、iTerm2 CSI u）中可靠插入换行
- Enter 始终提交输入，不受其他绑定影响
- 用户自定义的 keybind 覆盖生效
- 无回归：现有功能不受影响

## Open Questions

- ~~OpenTUI 的 KeyBinding 匹配是否支持修饰键精确匹配？~~ **已确认：支持精确匹配，不存在拦截问题。**
- 当前 Cmd+Enter 和 Shift+Enter 均未生效，是否确认是终端不发送修饰键信息导致？需通过 US-001 诊断确认。
- 是否需要在 TUI 界面中显示换行快捷键提示（如 placeholder 中显示 "Ctrl+J to newline"）？
- 是否需要更新 keybind 文档（`packages/web/src/content/docs/keybinds.mdx`）？
