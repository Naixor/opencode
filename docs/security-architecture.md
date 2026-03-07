# OpenCode 安全管控架构

## 一、架构总览

整个安全体系分为 **应用层管控** 和 **OS 级沙箱** 两层，纵深防御。

```
用户输入 → Tool 执行
            ├── 文件工具 (read/write/edit/glob/grep)
            │     └── SecurityAccess.checkAccess() → 应用层 allowlist + deny 检查
            ├── Bash 工具
            │     ├── BashScanner → 提取文件路径 → checkAccess()
            │     └── Sandbox.wrap() → OS 级 sandbox-exec 隔离
            └── MCP 工具
                  └── LLMScanner → 扫描敏感内容 → 自动脱敏
```

### 核心流程

```
User Input → Agent Selection → SessionPrompt.build() → LLM.stream()
  → Tool Execution (with hooks + permissions) → Stream Response → Loop
```

安全检查贯穿 Tool Execution 阶段，在工具真正执行前拦截非法操作。

---

## 二、应用层安全（`src/security/`）

### 2.1 配置系统（`config.ts`）

安全策略通过 `.opencode-security.json` 文件定义，支持多级作用域。

#### 配置文件示例

```json
{
  "roles": [
    { "name": "viewer", "level": 1 },
    { "name": "developer", "level": 5 },
    { "name": "admin", "level": 10 }
  ],
  "rules": [
    {
      "pattern": ".env*",
      "type": "file",
      "deniedOperations": ["read", "write", "llm"],
      "allowedRoles": ["admin"]
    },
    {
      "pattern": "secrets/",
      "type": "directory",
      "deniedOperations": ["read", "write", "llm"],
      "allowedRoles": ["admin"]
    }
  ],
  "allowlist": [
    { "pattern": "src/**", "type": "directory" },
    { "pattern": "docs/**", "type": "directory" },
    { "pattern": "README.md", "type": "file" }
  ]
}
```

#### 多级作用域

支持在子目录放置独立的 `.opencode-security.json`，子目录配置覆盖父目录：

```
project/
├── .opencode-security.json          # 根配置
├── src/
│   └── .opencode-security.json      # src 作用域配置（覆盖根）
└── packages/
    └── secret-pkg/
        └── .opencode-security.json  # 更深层作用域
```

**合并语义：**

| 配置项 | 合并策略 |
|--------|---------|
| Roles | 取并集（同名 role 的 level 必须一致，否则报错） |
| Rules | 子级覆盖父级（最具体的路径优先） |
| Allowlist | 子级覆盖父级 |
| Segments / Logging / Auth | 最深层生效 |
| MCP Policy | 取最严格策略 |

#### 性能优化

- **磁盘缓存**：配置解析结果缓存到 `~/.config/opencode/caches/security-<hash>.json`，启动时跳过目录遍历
- **内存缓存**：`resolveForPath()` 使用 LRU 缓存（最多 1024 条）
- **热重载**：通过 `chokidar` 监听 `.opencode-security.json` 文件变化，自动刷新配置并同步刷新 sandbox policy

---

### 2.2 访问控制（`access.ts`）

核心访问判定模块，采用 **Deny 优先** 策略。

#### 判定流程

```
checkAccess(filePath, operation, role)
  │
  ├─ 1. resolveSymlink(filePath)        # 解析符号链接（防绕过）
  │     └─ 完全解析链式 symlink → 获得真实路径
  │
  ├─ 2. 路径归一化
  │     └─ 绝对路径 → 相对路径（相对于 projectRoot）
  │     └─ Windows 反斜杠 → 正斜杠
  │
  ├─ 3. Deny 规则匹配（minimatch glob）
  │     ├─ 命中 → 检查 role 是否在 allowedRoles 中
  │     │     ├─ role 被允许 → 继续
  │     │     └─ role 未被允许 → ❌ DENIED
  │     └─ 未命中 → 继续
  │
  ├─ 4. 目录继承检查
  │     └─ 子路径继承父目录的 deny 保护
  │
  ├─ 5. Allowlist 匹配
  │     └─ 多层 AND 逻辑（所有层都必须匹配）
  │     └─ 层内 OR 逻辑（任一条目匹配即可）
  │
  └─ 返回 { allowed: boolean, reason?: string }
```

#### Operation 类型

| Operation | 含义 | 适用工具 |
|-----------|------|---------|
| `read` | 读取文件内容 | read, glob, grep, bash |
| `write` | 写入/修改文件 | write, edit, bash |
| `llm` | 内容发送给 LLM | prompt 构建、MCP 输出 |

#### 符号链接防绕过

```
symlink: ./safe/link → ../secrets/password.txt

checkAccess("./safe/link", "read", role)
  → resolveSymlink → realPath = "../secrets/password.txt"
  → 对真实路径执行 deny 检查
  → 如果 secrets/ 被 deny → ❌ DENIED
```

---

### 2.3 RBAC 角色体系（`role.ts` + `token.ts`）

#### 角色定义

```json
{
  "roles": [
    { "name": "viewer", "level": 1 },
    { "name": "developer", "level": 5 },
    { "name": "admin", "level": 10 }
  ]
}
```

`level` 越高权限越大。高 level 角色自动拥有低 level 角色的访问权。

#### 角色检测顺序

```
1. 项目目录 .opencode-role.token    → JWT RS256 签名 token
2. ~/.config/opencode/role.token    → 全局 token
3. 无 token → 降级为配置中 level 最低的角色
```

#### JWT Token 格式

```
Header: { alg: "RS256", typ: "JWT" }
Payload: {
  role: "developer",    // 必填：角色名
  exp: 1709683200,      // 可选：过期时间戳
  jti: "token-id-123"   // 可选：用于吊销
}
Signature: RS256(header.payload, privateKey)
```

**验证流程：**
1. 解析 3 段式 JWT（header.payload.signature）
2. 使用配置中的公钥验证 RS256 签名
3. 检查过期（`exp` < 当前时间）
4. 检查吊销列表（`authentication.revokedTokens`）
5. 提取 `role` 声明

---

### 2.4 代码段保护（`segments.ts` + `redact.ts`）

保护文件内的特定代码段，防止被 AI 读取或发送给 LLM。

#### Marker 模式

在代码中用注释标记保护区间：

```typescript
// 正常代码，AI 可以看到

// @security-start
const API_KEY = "sk-xxxx"  // 这段会被脱敏
const DB_PASSWORD = "xxx"
// @security-end

// 正常代码，AI 可以看到
```

**支持的注释格式：**

| 语言 | 格式 |
|------|------|
| JS/TS/C/Java | `// marker` |
| Python/Shell | `# marker` |
| HTML/XML | `<!-- marker -->` |
| JS/C | `/* marker */` |
| Python | `""" marker """` / `''' marker '''` |

#### AST 模式（仅 TS/JS）

按函数/类名正则匹配保护：

```json
{
  "segments": {
    "ast": [
      {
        "namePattern": "^(encrypt|decrypt|sign).*",
        "language": "typescript"
      }
    ]
  }
}
```

这会自动保护所有名称匹配 `encrypt*`、`decrypt*`、`sign*` 的函数和类。

#### 脱敏输出

```typescript
// 原始内容
const secret = "my-api-key"
function encryptData() { ... }

// 脱敏后（行号保留）
[REDACTED: Security Protected]

[REDACTED: Security Protected]
```

---

### 2.5 Bash 命令扫描（`bash-scanner.ts`）

在 bash 命令执行前，解析命令提取所有文件路径，逐一检查访问权限。

#### 解析能力

```bash
# 识别文件路径
cat /etc/passwd                    → ["/etc/passwd"]
grep -r "password" src/ config/    → ["src/", "config/"]
head -n 10 secrets.txt             → ["secrets.txt"]

# 处理管道和连接符
cat file1.txt | grep "key" && vim file2.txt
  → ["file1.txt", "file2.txt"]

# 处理引号和转义
cat "path with spaces/file.txt"    → ["path with spaces/file.txt"]
```

**支持的命令**：`cat, less, head, tail, vim, nano, grep, find, sed, awk`

**注意**：当 sandbox 启用时，跳过 bash scanner（OS 层隔离更强）。

---

### 2.6 LLM 内容扫描（`llm-scanner.ts`）

扫描发送给 LLM 和 MCP 工具的内容，检测是否包含受保护的路径或标记。

```
发送前扫描:
  scanForProtectedContent(content, config)
    → 匹配 marker 标记
    → 匹配 deny "llm" 操作的文件路径
    → 命中 → redactContent() 自动脱敏
```

---

### 2.7 审计日志（`audit.ts`）

所有安全决策记录到 `.opencode-security-audit.log`。

#### 日志格式（JSON Lines）

```json
{
  "timestamp": "2024-03-06T12:00:00.000Z",
  "role": "developer",
  "operation": "read",
  "path": "secrets/.env",
  "result": "denied",
  "reason": "Deny rule matched: .env* (role 'developer' not in allowedRoles)",
  "ruleTriggered": ".env*",
  "contentHash": "sha256:abc123..."
}
```

#### 日志级别

| 级别 | 行为 |
|------|------|
| `verbose` | 记录所有事件（允许 + 拒绝） |
| `normal` | 仅记录拒绝事件 |

---

## 三、OS 级沙箱（`src/sandbox/`）

### 3.1 设计决策

**不用 Docker**，原因：
- 无法支持 macOS 原生工具链（Xcode、iOS Simulator）
- 开发环境依赖系统级工具和路径

**采用 OS 原生沙箱**：
- **macOS**：Seatbelt（`sandbox-exec` + `.sb` profile）— 已实现
- **Linux**：Landlock + seccomp — 架构预留
- **Windows**：架构预留，暂不实现

### 3.2 执行准则

| 工具类型 | 安全执行方式 |
|---------|------------|
| Bash / MCP | 通过 sandbox 包裹（per-command `sandbox-exec`） |
| 文件工具 (read/write/edit) | 应用层 allowlist 检查（不经过 shell） |

---

### 3.3 macOS Seatbelt 实现

#### 工作原理

每条 bash 命令执行时，通过 `sandbox-exec` 包裹：

```bash
# 原始命令
rm -rf /important/data

# 沙箱包裹后
sandbox-exec -f /tmp/opencode-sandbox/sandbox-12345.sb /bin/zsh -c "rm -rf /important/data"
```

操作系统内核级别强制执行策略，进程无法绕过。

#### 策略生成流程

```
SecurityConfig (allowlist + deny rules)
  │
  ├─ 提取 allowlist patterns → 转换为写权限规则
  ├─ 提取 deny rules (read/llm) → 转换为读写禁止规则
  ├─ 添加 extra paths
  │
  └─ generateFullProfile()
       │
       ├─ Builtins（系统必要路径）
       │    ├─ (deny file-write* (subpath "/"))          # 全局禁写
       │    ├─ (allow file-write* (subpath "/tmp"))       # 放行 tmp
       │    ├─ (allow file-write* (subpath "<node_modules>"))
       │    └─ (allow file-write* (subpath "<.git>"))
       │
       ├─ Allowlist → Write 规则
       │    └─ (allow file-write* (subpath "<allowed-path>"))
       │
       └─ Deny 规则
            └─ (deny file-read* file-write* (regex "<pattern>"))
```

#### Seatbelt Profile 示例

```scheme
(version 1)
(allow default)

;; ===== Builtins =====
;; Global write deny
(deny file-write* (subpath "/"))

;; System paths
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write*
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/ptmx")
  (literal "/dev/urandom"))

;; Project dependencies
(allow file-write* (subpath "/Users/user/project/node_modules"))
(allow file-write* (subpath "/Users/user/project/.git"))

;; ===== Allowlist (write permissions) =====
(allow file-write* (subpath "/Users/user/project/src"))
(allow file-write* (subpath "/Users/user/project/docs"))
(allow file-write* (literal "/Users/user/project/README.md"))

;; ===== Deny rules =====
(deny file-read* file-write* (regex "^/Users/user/project/\\.env.*$"))
(deny file-read* file-write* (subpath "/Users/user/project/secrets"))
```

#### Glob → Seatbelt Regex 转换（`glob-to-regex.ts`）

```
src/**/*.ts     → ^/abs/path/src/(/.+)?/[^/]*\.ts$
.env*           → ^/abs/path/\.env[^/]*$
secrets/        → (subpath "/abs/path/secrets")
config.json     → (literal "/abs/path/config.json")
```

**转换规则：**

| Glob | Regex |
|------|-------|
| `*` | `[^/]*`（单层匹配） |
| `**` | `(/.+)?/`（零或多层） |
| `?` | `[^/]`（单字符） |
| 尾部 `**` | `/.*`（所有子路径） |

#### 策略验证

生成后立即用测试命令验证：

```bash
sandbox-exec -f /tmp/opencode-sandbox/sandbox-12345.sb /usr/bin/true
```

如果退出码非 0，说明策略有语法错误，sandbox 标记为 `failed`。

---

### 3.4 初始化流程（`init.ts`）

```
initSandbox()
  │
  ├─ 1. 检查配置：isSandboxEnabled(config) ?
  │     └─ opencode.json → sandbox.enabled: true
  │
  ├─ 2. 平台检测
  │     ├─ macOS → SeatbeltSandbox
  │     ├─ Linux → (预留)
  │     └─ 其他 → 不支持
  │
  ├─ 3. 可用性检查
  │     └─ sandbox-exec 是否在 PATH 中
  │
  ├─ 4. 生成策略
  │     ├─ 从 SecurityConfig 提取 allowlist + deny
  │     ├─ generateFullProfile()
  │     └─ 写入 /tmp/opencode-sandbox/sandbox-<pid>.sb
  │
  ├─ 5. 验证策略
  │     └─ sandbox-exec -f <profile> /usr/bin/true
  │
  └─ 6. 激活
        └─ setActiveSandbox(sandbox, "active")
```

#### 热重载

安全配置文件变更时自动刷新 sandbox 策略：

```
.opencode-security.json 变更
  → SecurityConfig.reload()
  → refreshSandboxPolicy()
      → 重新生成 Seatbelt profile（跳过平台/可用性检查）
      → 验证新策略
      → 更新活跃 sandbox
```

---

## 四、工具集成方式

### 4.1 文件工具

```typescript
// src/tool/read.ts（简化示意）
execute(args) {
  const config = SecurityConfig.getSecurityConfig()
  const role = getDefaultRole(config)

  // 1. 访问检查
  const result = SecurityAccess.checkAccess(args.filePath, "read", role)
  if (!result.allowed) throw new Error(`Security: ${result.reason}`)

  // 2. 读取文件
  const content = await readFile(args.filePath)

  // 3. 代码段保护 — 脱敏
  const segments = SecuritySegments.findMarkerSegments(content, config.segments.markers)
  const redacted = SecurityRedact.redactContent(content, segments)

  // 4. 审计日志
  SecurityAudit.logSecurityEvent({ role, operation: "read", path: args.filePath, allowed: true })

  return redacted
}
```

### 4.2 Bash 工具

```typescript
// src/tool/bash.ts（简化示意）
execute(args) {
  const sandbox = getActiveSandbox()

  if (!sandbox) {
    // 无沙箱 → 应用层扫描
    const paths = BashScanner.scanBashCommand(args.command, cwd)
    for (const p of paths) {
      const result = SecurityAccess.checkAccess(p, "read", role)
      if (!result.allowed) throw new Error(`Security: ${result.reason}`)
    }
    return exec(args.command)
  }

  // 有沙箱 → OS 级隔离（跳过应用层扫描）
  const wrappedCmd = sandbox.wrap([shell, "-c", args.command])
  // wrappedCmd = ["sandbox-exec", "-f", policyPath, shell, "-c", command]
  return exec(wrappedCmd)
}
```

### 4.3 MCP 工具

```typescript
// MCP 工具输出处理（简化示意）
if (mcpPolicy === "enforced") {
  const matches = LLMScanner.scanForProtectedContent(output, config)
  if (matches.length > 0) {
    output = SecurityRedact.redactContent(output, matches)
    SecurityAudit.logSecurityEvent({ operation: "llm", allowed: false })
  }
}
```

### 4.4 集成矩阵

| 工具类型 | 应用层 checkAccess | BashScanner | OS Sandbox | LLMScanner | 代码段脱敏 |
|---------|:-:|:-:|:-:|:-:|:-:|
| read | ✅ | - | - | - | ✅ |
| write / edit | ✅ | - | - | - | - |
| glob / grep | ✅ | - | - | - | - |
| bash | ✅（无沙箱时） | ✅（无沙箱时） | ✅（有沙箱时） | - | - |
| MCP | - | - | - | ✅ | ✅ |

---

## 五、诊断工具（Doctor）

### 5.1 Security Doctor（`security/doctor.ts`）

验证安全配置的完整性和正确性：

| 检查项 | 说明 |
|--------|------|
| 配置文件语法 | JSON 解析 + Zod schema 校验 |
| 角色冲突 | 多个配置中同名 role 的 level 不一致 |
| 规则引用 | deny 规则中引用了未定义的 role |
| Deny 规则完整性 | deniedOperations 不能为空 |
| Allowlist/Deny 重叠 | 同时出现在 allowlist 和 deny 中的路径 |
| Glob 语法 | 无效的 glob 模式 |
| 作用域越界 | 子目录配置中 `../` 模式逃逸了作用域 |
| Sandbox 兼容性 | write-only deny 仅在应用层生效 |
| 冗余规则 | 被更宽泛的规则覆盖的具体规则 |

### 5.2 Sandbox Doctor（`sandbox/doctor.ts`）

验证沙箱运行环境：

| 检查项 | 说明 |
|--------|------|
| 平台检测 | macOS (✅), Linux (⏭), 其他 (❌) |
| sandbox-exec | 命令是否在 PATH 中 |
| macOS 版本 | 需要 macOS 11+（Darwin 20+） |
| SIP 状态 | System Integrity Protection 应启用 |
| 基础验证 | 用最小策略测试 `/usr/bin/true` |

---

## 六、文件清单

### Security（`src/security/`）

| 文件 | 职责 |
|------|------|
| `schema.ts` | Zod schema 定义（Role, Rule, AllowlistEntry, SecurityConfig 等） |
| `config.ts` | 配置加载、缓存、合并、热重载 |
| `access.ts` | 核心访问控制判定（deny 优先 + allowlist） |
| `role.ts` | 角色检测（JWT token 查找） |
| `token.ts` | JWT RS256 解析与验证 |
| `segments.ts` | 代码段保护识别（Marker + AST） |
| `redact.ts` | 内容脱敏（替换为 `[REDACTED]`） |
| `bash-scanner.ts` | Bash 命令文件路径提取 |
| `llm-scanner.ts` | LLM/MCP 内容敏感信息扫描 |
| `audit.ts` | 安全事件审计日志 |
| `doctor.ts` | 配置诊断与校验 |

### Sandbox（`src/sandbox/`）

| 文件 | 职责 |
|------|------|
| `index.ts` | Sandbox 接口定义、状态管理 |
| `init.ts` | 初始化与策略刷新 |
| `seatbelt.ts` | macOS Seatbelt 实现（sandbox-exec 包裹） |
| `profile.ts` | Seatbelt Profile 生成（.sb 文件） |
| `builtins.ts` | 系统必要路径的内置放行规则 |
| `glob-to-regex.ts` | Glob 模式 → Seatbelt SBPL 正则转换 |
| `doctor.ts` | 沙箱环境诊断 |
