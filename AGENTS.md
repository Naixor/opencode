- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Prefer single word variable names where possible
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream

### Naming

Prefer single word names for variables and functions. Only use multiple words if necessary.

```ts
// Good
const foo = 1
function journal(dir: string) {}

// Bad
const fooBar = 1
function prepareJournal(dir: string) {}
```

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests

## Sandbox Architecture Decisions

### 方案选型：OS 原生沙箱（非 Docker）

sandbox 使用 OS 原生沙箱机制，不使用 Docker。原因：Docker 容器运行 Linux，无法支持 macOS 原生工具链（Xcode、iOS Simulator 等）。

- **Phase 1: macOS** — Seatbelt (`sandbox-exec` + 动态生成 .sb profile)
- **Phase 2: Linux** — Landlock + seccomp
- **Windows** — 架构预留，暂不实现

### 沙箱执行准则

- **bash 和 MCP 工具**：必须通过 sandbox 执行（per-command `sandbox-exec` 包裹）。这是 LLM 绕过风险所在——LLM 可以编写任意脚本绕过应用层检查。
- **文件工具（read/write/glob/grep）**：走应用层 allowlist 检查，不走 sandbox。这些工具的代码由我们控制，LLM 无法绕过。
- **allowlist 条目一律 rw**，deny 路径在 sandbox profile 中用 deny 规则处理。

### 跨平台测试要求

macOS 和 Linux 的沙箱实现必须共用一份集成测试。测试面向 Executor 接口编写，验证沙箱行为（能访问 allowlist 文件、不能访问 deny 文件），不关心底层平台实现。
