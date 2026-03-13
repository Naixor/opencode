# PRD: 飞书身份认证 — 基于飞书 OAuth 的模型访问通道

## Introduction

为 opencode CLI 集成飞书（Feishu）企业自建应用 OAuth 2.0 认证，使内部团队成员通过飞书账号登录后即可使用 Claude 等 AI 模型，无需自行管理 API key。

整体架构分为两层：

1. **Wellknown 层（Phase 1）**：部署内部 wellknown 服务端点 + 飞书 OAuth 认证脚本 + 轻量反向代理。用户通过 `opencode auth login https://ai.corp.com` 一条命令完成登录，远程配置自动将 provider 指向内部代理，代理注入真实 API key 后转发到 Anthropic/OpenAI。
2. **Plugin 层（Phase 2）**：内置飞书插件实现 token 自动刷新，利用 `chat.headers` hook 在每次请求前检查并透明地刷新过期 token，避免用户频繁重新登录。

该方案利用 opencode 已有的 wellknown 机制（CLI 端零改动）和 plugin 机制，最小化开发成本。

## Goals

- 团队成员通过 `opencode auth login https://ai.corp.com` 一条命令完成飞书 OAuth 登录
- 登录后即可使用管理员配置的 AI 模型（Claude、GPT 等），无需自行获取 API key
- 模型列表和可用 provider 由管理员通过 wellknown 远程配置集中管控
- 真实 API key 始终保留在服务端（反向代理中），不暴露给客户端
- 飞书 token 过期时通过 `chat.headers` hook 自动刷新（通过内置 plugin），用户无感知
- `opencode auth list` 中显示飞书用户名和邮箱
- 飞书 API base URL 可配置，默认 `open.feishu.cn`，预留 Lark 海外版扩展

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                          User's Machine                              │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │  opencode CLI                                                 │   │
│  │                                                               │   │
│  │  1. opencode auth login https://ai.corp.com                   │   │
│  │     → fetch /.well-known/opencode                             │   │
│  │     → run `opencode feishu-auth --issuer ... --app-id ...`     │   │
│  │       → 飞书授权 → 获取 auth code                             │   │
│  │       → 提交 auth code 给签发服务 → 获取 RS256 JWT            │   │
│  │       → JWT → stdout, 元数据 → feishu-auth.json               │   │
│  │     → store JWT in <data_dir>/auth.json                       │   │
│  │                                                               │   │
│  │  2. On startup: load remote config from wellknown             │   │
│  │     → providers point to https://ai.corp.com/v1/...           │   │
│  │     → env var CORP_AI_KEY = <JWT>                             │   │
│  │                                                               │   │
│  │  3. Plugin: auto-refresh before JWT expiry                    │   │
│  │     → refresh 飞书 token → 调签发服务换新 JWT                  │   │
│  │     → update auth.json transparently                          │   │
│  │                                                               │   │
│  │  4. Model call: request to https://ai.corp.com/v1/...         │   │
│  │     → Authorization: Bearer <JWT>                             │   │
│  └─────────────────────────────┬─────────────────────────────────┘   │
└────────────────────────────────┼─────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     Internal Server (ai.corp.com)                    │
│                                                                      │
│  ┌──────────────────┐ ┌──────────────┐ ┌─────────────────────────┐  │
│  │ /.well-known/    │ │ JWT Issuer   │ │ Reverse Proxy           │  │
│  │ opencode         │ │              │ │ (nginx/Caddy)           │  │
│  │                  │ │ POST /auth/  │ │                         │  │
│  │ Returns:         │ │   token      │ │ /v1/anthropic/* →       │  │
│  │ - auth.command   │ │              │ │   verify JWT (公钥)     │  │
│  │ - auth.env       │ │ - recv code  │ │   inject Authorization: │  │
│  │ - config.provider│ │ - exchange   │ │     Bearer sk-ant-xxx   │  │
│  │   (baseURL map)  │ │   飞书 token │ │   forward to            │  │
│  │                  │ │ - sign JWT   │ │     api.anthropic.com   │  │
│  │                  │ │   (RSA 私钥) │ │                         │  │
│  │                  │ │ - return JWT │ │ /v1/openai/* →          │  │
│  │                  │ │ + metadata   │ │                         │  │
│  │                  │ │              │ │   verify JWT (公钥)     │  │
│  │                  │ │              │ │   inject Authorization: │  │
│  │                  │ │              │ │     Bearer sk-xxx       │  │
│  │                  │ │              │ │   forward to            │  │
│  │                  │ │              │ │     api.openai.com      │  │
│  └──────────────────┘ └──────────────┘ └─────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## User Stories

### Phase 1: Wellknown + 飞书 OAuth 认证脚本

#### US-001: 部署 wellknown 服务端点

**Description:** 作为管理员，我需要部署一个内部服务提供 `/.well-known/opencode` 端点，让团队成员可以通过 `opencode auth login` 接入。

**Acceptance Criteria:**

- [ ] `GET https://ai.corp.com/.well-known/opencode` 返回 JSON，包含 `auth.command`（飞书认证脚本路径）、`auth.env`（环境变量名）、`config.provider`（provider 配置及 baseURL 映射）
- [ ] `config.provider` 中包含管理员配置的可用模型 provider（如 `anthropic`、`openai`），各 provider 的 `baseURL` 指向内部反向代理地址
- [ ] 端点返回示例结构完整可用（见 Functional Requirements）
- [ ] Typecheck 通过

#### US-002: 飞书 OAuth 认证脚本（feishu-auth CLI）

**Description:** 作为系统，我需要一个认证脚本完成飞书 OAuth 流程，输出 JWT 到 stdout，供 opencode wellknown 机制消费，并将 refresh_token 等元数据写入 `<Global.Path.data>/feishu-auth.json`。

**Acceptance Criteria:**

- [ ] 脚本执行飞书 OAuth 2.0 授权码流程：打开浏览器 → 用户在飞书授权 → 本地回调接收 auth code
- [ ] 授权 URL 包含正确的 `app_id`、`redirect_uri`、`state` 参数
- [ ] 回调服务器动态分配端口（优先尝试 19876，若被占用则在 19876-19885 范围内自动递增选取可用端口），`redirect_uri` 中的端口与实际监听端口一致
- [ ] 飞书开放平台需预注册 10 个回调地址（`http://localhost:19876/oauth/callback` 至 `http://localhost:19885/oauth/callback`）
- [ ] 验证 `state` 参数（防 CSRF）
- [ ] 将 auth code 提交给服务端签发服务（`POST https://ai.corp.com/auth/token`），由签发服务在服务端完成 auth code → user_access_token → JWT 的交换流程
- [ ] 签发服务返回 JSON 响应（包含 JWT、refresh_token、expires_at、用户信息），脚本将 JWT 输出到 stdout，将 refresh_token 等元数据写入 `<Global.Path.data>/feishu-auth.json`
- [ ] 授权超时（5 分钟）后给出明确错误提示
- [ ] 浏览器显示授权成功/失败页面
- [ ] Typecheck 通过

#### US-003: 反向代理服务

**Description:** 作为管理员，我需要部署一个反向代理，验证 JWT 后注入真实 API key 并转发请求到模型提供商。

**Acceptance Criteria:**

- [ ] 代理接收请求时验证 `Authorization: Bearer <JWT>` 中的 token 有效性
- [ ] 验证通过后，将 Authorization header 替换为真实的 provider API key（如 `sk-ant-xxx`）
- [ ] 将请求原样转发到对应的上游 API（如 `api.anthropic.com`），包括流式响应（SSE passthrough，非解析）
- [ ] token 无效或过期时返回 401，CLI 端提示用户重新登录
- [ ] 支持配置多个 provider 的上游地址和 API key
- [ ] Typecheck 通过（如果用 TypeScript 实现）

#### US-004: 用户登录流程（端到端）

**Description:** 作为团队成员，我希望运行一条命令就能完成登录并使用 AI 模型。

**Acceptance Criteria:**

- [ ] 运行 `opencode auth login https://ai.corp.com`，自动完成：获取 wellknown 配置 → 执行飞书 OAuth → 存储凭据
- [ ] 登录完成后，`opencode auth list` 显示已登录的凭据
- [ ] 启动 opencode 时自动加载远程配置，可用模型列表与管理员配置一致
- [ ] 直接使用 Claude/GPT 等模型对话，无需任何额外配置
- [ ] Typecheck 通过

### Phase 2: Plugin 自动 Token 刷新

#### US-005: 内置飞书 Plugin 实现 token 自动刷新

**Description:** 作为系统，我需要在飞书 token 即将过期时自动刷新，避免用户频繁重新登录。

**Acceptance Criteria:**

- [ ] 内置 plugin 通过 `chat.headers` hook 在每次模型请求前检查 JWT 是否即将过期（提前 5 分钟）
- [ ] 过期时从 `<Global.Path.data>/feishu-auth.json` 读取 refresh_token，调用签发服务刷新 JWT
- [ ] 签发服务在服务端使用 refresh_token 调用飞书 `POST /open-apis/authen/v1/oidc/refresh_access_token` 刷新，签发新 JWT 返回
- [ ] 刷新后同时更新 `process.env[key]`（使 SDK 立即使用新 token）、`<Global.Path.data>/auth.json` 中的 JWT、以及 `<Global.Path.data>/feishu-auth.json` 中的 refresh_token、expires_at 等元数据
- [ ] refresh_token 也过期时（30 天），提示用户重新运行 `opencode auth login`
- [ ] 刷新过程对用户透明，不中断当前会话
- [ ] Typecheck 通过

#### US-006: auth list 显示飞书用户信息

**Description:** 作为团队成员，我希望 `opencode auth list` 能显示我的飞书用户名和邮箱，方便确认登录的是哪个账号。

**Acceptance Criteria:**

- [ ] `opencode auth list` 中飞书条目显示格式为 `Feishu oauth (张三 / user@company.com)`
- [ ] 如果用户信息缺失（如旧版本存储的凭据），降级显示为 `Feishu wellknown`
- [ ] 不影响其他 provider 的显示格式
- [ ] Typecheck 通过

#### US-007: 飞书登出

**Description:** 作为团队成员，我希望可以通过 `opencode auth logout` 移除飞书的登录凭据。

**Acceptance Criteria:**

- [ ] `opencode auth logout` 的 provider 列表中显示已登录的飞书账号
- [ ] 选择后成功移除 `auth.json` 中对应的凭据
- [ ] 已有的 logout 流程无需修改（现有逻辑已覆盖 wellknown 类型）
- [ ] Typecheck 通过

## Functional Requirements

### Wellknown 端点

- FR-1: `GET /.well-known/opencode` 返回以下结构：
  ```json
  {
    "auth": {
      "command": ["opencode", "feishu-auth", "--issuer", "https://ai.corp.com", "--app-id", "cli_xxx"],
      "env": "CORP_AI_KEY"
    },
    "config": {
      "provider": {
        "anthropic": {
          "options": { "baseURL": "https://ai.corp.com/v1/anthropic" }
        },
        "openai": {
          "options": { "baseURL": "https://ai.corp.com/v1/openai" }
        }
      }
    }
  }
  ```
- FR-2: `auth.command` 指向 opencode 内置子命令，通过参数传入签发服务地址（`--issuer`）和飞书 App ID（`--app-id`），执行飞书 OAuth 后将 JWT 输出到 stdout，元数据（refresh_token、用户信息）写入 `<Global.Path.data>/feishu-auth.json`
- FR-3: `auth.env` 指定环境变量名，opencode 启动时自动设置 `process.env[auth.env] = token`
- FR-4: `config.provider` 定义可用的 provider 及其 baseURL（指向内部代理），管理员可按需增减

### 飞书 OAuth 认证脚本（内置子命令 `opencode feishu-auth`）

- FR-5: 认证脚本作为 opencode 内置子命令实现（`opencode feishu-auth`），代码放在 `packages/opencode/src/cli/cmd/` 下，无需用户额外安装
- FR-6: OAuth 授权 URL：`https://{BASE_URL}/open-apis/authen/v1/authorize?app_id={APP_ID}&redirect_uri=http://localhost:{PORT}/oauth/callback&state={STATE}&scope=contact:user.email:readonly`，`BASE_URL` 默认 `open.feishu.cn`，`PORT` 为动态分配的本地端口
- FR-7: 客户端仅获取 auth code，不接触 app_secret。auth code 交换流程（获取 app_access_token → 换取 user_access_token → 获取用户信息）全部在服务端签发服务中完成
- FR-8: 签发服务接口 `POST https://ai.corp.com/auth/token`，body: `{ "code": "...", "redirect_uri": "..." }`，服务端使用安全存储的 app_id / app_secret 完成飞书 OAuth 交换，返回 JSON：`{ "jwt": "...", "refresh_token": "...", "expires_at": ..., "name": "...", "email": "..." }`。签发服务需验证 `redirect_uri` 是否匹配预注册白名单（`http://localhost:19876~19885/oauth/callback`，共 10 个端口），不匹配则拒绝请求
- FR-9: 飞书 App Secret 仅存在于服务端签发服务中，客户端无需配置。飞书 App ID（非机密信息，用于构造授权 URL）由管理员通过 wellknown 端点的 `auth.command` 参数传入（`--app-id`），客户端无需手动配置
- FR-10: OAuth `state` 使用 `crypto.randomUUID()` 生成，回调时严格校验
- FR-11: 本地回调服务器动态分配端口（优先 19876，被占用时在 19876-19885 范围内自动递增选取可用端口；若 10 个端口均被占用则报错）
- FR-12: 飞书 API base URL 可通过环境变量 `FEISHU_BASE_URL` 覆盖，默认 `open.feishu.cn`
- FR-13: 认证脚本通过 `auth.command` 参数接收签发服务地址（`--issuer`）和飞书 App ID（`--app-id`），无需用户额外配置。管理员在 wellknown 端点中配置完整的命令参数，如 `["opencode", "feishu-auth", "--issuer", "https://ai.corp.com", "--app-id", "cli_xxx"]`

### JWT 签发

- FR-14: 认证脚本获取 auth code 后，调用内部签发服务（`POST https://ai.corp.com/auth/token`），传入 auth code 和 redirect_uri。签发服务在服务端完成：获取 app_access_token → 换取 user_access_token → 获取用户信息 → 签发 RS256 JWT
- FR-15: JWT payload 包含：`sub`（飞书 open_id）、`email`、`name`、`exp`（过期时间，由签发服务控制）、`iat`（签发时间）
- FR-16: 签发服务持 RSA 私钥和飞书 app_secret，返回 JSON 响应：`{ "jwt": "...", "refresh_token": "...", "expires_at": ..., "name": "...", "email": "..." }`。认证脚本将 `jwt` 输出到 stdout（供 wellknown 机制消费），将其余字段写入 `<Global.Path.data>/feishu-auth.json`
- FR-16a: 签发服务另提供刷新接口 `POST https://ai.corp.com/auth/refresh`，请求需携带当前 JWT（即使已过期）作为 `Authorization: Bearer <jwt>` 头部，body: `{ "refresh_token": "..." }`。签发服务验证 JWT 签名（跳过 `exp` 检查）并确认 `sub` 与 refresh_token 关联的用户一致后，在服务端刷新飞书 token 并签发新 JWT，返回格式同上

### 反向代理

- FR-17: 代理持 RSA 公钥，验证请求中的 `Authorization: Bearer <JWT>` 签名和有效期，无效/过期时返回 HTTP 401
- FR-18: 验证通过后将 Authorization header 替换为真实 provider API key，请求原样转发（包括 SSE 流式响应 passthrough）
- FR-19: 支持多 provider 路由：`/v1/anthropic/*` → `api.anthropic.com`，`/v1/openai/*` → `api.openai.com`

### Plugin Token 刷新

- FR-20: 内置 plugin 注册 `chat.headers` hook，在每次模型请求前检查 JWT 有效期（解码 JWT payload 中的 `exp` 字段）
- FR-21: JWT 即将过期（≤5 分钟）时，从 `<Global.Path.data>/feishu-auth.json` 读取 refresh_token，携带当前 JWT 作为 `Authorization: Bearer <jwt>` 头部，调用签发服务 `POST https://ai.corp.com/auth/refresh`，body: `{ "refresh_token": "..." }`。并发请求触发刷新时，plugin 应合并为单次刷新调用（promise 去重），避免竞态导致 refresh_token 失效
- FR-22: 签发服务在服务端使用 refresh_token 刷新飞书 token 并签发新 JWT，返回 JSON：`{ "jwt": "...", "refresh_token": "...", "expires_at": ... }`。客户端刷新后需同时更新三处：(1) `process.env[key]`（使 provider SDK 后续请求立即使用新 token，无需重启）；(2) `<Global.Path.data>/auth.json` 中 wellknown 条目的 `token` 字段（使下次重启也生效）；(3) `<Global.Path.data>/feishu-auth.json` 中的 refresh_token、expires_at 等元数据
- FR-23: 飞书 refresh_token 也过期时（30 天），签发服务返回特定错误码，plugin 抛出明确错误，提示用户 `opencode auth login` 重新认证

### 飞书认证元数据存储

- FR-24: 飞书认证的元数据（refresh_token、用户信息等）独立存储在 `<Global.Path.data>/feishu-auth.json`（与 `auth.json` 同目录），不修改现有 WellKnown auth schema
- FR-25: `feishu-auth.json` 使用独立的 zod schema 校验：
  ```ts
  z.object({
    refresh_token: z.string(),
    expires_at: z.number(),
    name: z.string(),
    email: z.string(),
    wellknown_url: z.string(), // 关联的 wellknown URL，用于匹配 auth.json 中的条目
  })
  ```
- FR-26: 认证脚本完成登录后写入此文件，plugin 刷新 token 后更新此文件
- FR-27: `opencode auth logout` 移除飞书凭据时，检查是否存在 `<Global.Path.data>/feishu-auth.json`，若存在则同时清理。这是对 logout 逻辑的最小扩展（~5 行），不涉及 wellknown 机制本身的修改

### auth list 增强

- FR-28: `opencode auth list` 中 wellknown 类型条目，检查是否存在对应的 `feishu-auth.json`，若存在且包含 name 和 email，显示为 `Feishu oauth ({name} / {email})`
- FR-29: 如果 `feishu-auth.json` 不存在或用户信息缺失，降级显示为原有的 wellknown 格式

### auth.command 执行错误处理

- FR-30: `auth login` 流程中 `auth.command` 执行失败时（exit code 非零），给出友好的错误提示。若 stderr 中包含 "unknown command" 或类似信息，提示用户 `当前 opencode 版本不支持此认证方式，请升级到最新版本`

### Wellknown Fetch 错误处理

- FR-31: `auth login` 流程和 `config.ts` 启动时 fetch `/.well-known/opencode` 端点时，均增加错误处理：
  - 网络不通 / DNS 解析失败：提示 `无法连接到 {url}，请检查网络或 URL 是否正确`
  - HTTP 非 2xx 状态码：提示 `服务端返回错误 ({status})，请联系管理员`
  - 响应非合法 JSON：提示 `服务端返回格式异常，请联系管理员检查 /.well-known/opencode 配置`
  - 请求超时（10 秒）：提示 `连接超时，请检查网络`

## Non-Goals

- 不实现 Console Web 应用的飞书登录（本期仅 CLI）
- 不获取用户的部门、职位、工号等企业组织架构信息
- 不实现飞书商店应用上架（仅企业自建应用）
- 不实现飞书机器人消息推送
- 不实现多租户（多企业）支持
- 不修改 opencode 现有的 wellknown 机制（零客户端改动，如需扩展 auth list 显示仅改 list 展示逻辑；logout 时清理 `feishu-auth.json` 和 auth.command 执行失败提示属于最小扩展，不涉及 wellknown 机制本身）
- 不实现飞书小程序登录
- 不实现用量管控 / rate limit（本期）
- 不实现邮箱自动关联（留给未来 Console 集成）
- 不开箱支持 Lark 海外版（通过 `FEISHU_BASE_URL` 环境变量预留扩展）

## Design Considerations

- **Wellknown 优先**：利用 opencode 已有的 `opencode auth login <url>` 机制，CLI 端零改动。飞书 OAuth 的复杂性封装在认证脚本中，对 opencode 核心代码无侵入
- **反向代理最小化**：代理只做 JWT 验签（RSA 公钥）+ header 替换 + 请求转发，不解析 request/response body，SSE 流式响应直接 passthrough。可以用 nginx/Caddy/Cloudflare Workers 实现
- **安全性**：飞书 app_secret 仅存在于服务端签发服务中，客户端不接触任何机密凭据。auth code 交换、token 刷新均在服务端完成
- **Plugin 作为增强**：Phase 2 的 plugin 利用 `chat.headers` hook 在每次请求前检查 JWT 有效期，过期时调用签发服务的刷新接口获取新 JWT。刷新后同时更新 `process.env[key]`（使 SDK 立即生效）和 `auth.json`（使重启后也生效）
- **独立元数据存储**：飞书认证的 refresh_token、用户信息等元数据独立存储在 `<Global.Path.data>/feishu-auth.json`（与 `auth.json` 同目录），使用独立 zod schema 校验，不修改现有 WellKnown auth schema
- **auth list 增强**：`auth list` 显示时检查是否存在 `feishu-auth.json`，有则显示用户名和邮箱，无则降级为原有格式
- **认证脚本内置**：飞书认证脚本作为 opencode 内置子命令 `opencode feishu-auth` 实现，由 wellknown 的 `auth.command: ["opencode", "feishu-auth", "--issuer", "...", "--app-id", "..."]` 触发，签发服务地址和 App ID 通过命令参数传入，作为独立进程执行，与 opencode 主进程解耦
- **服务端代码位置**：签发服务 + 反向代理 + wellknown 端点的服务端代码放在本仓库新建的 `packages/feishu-server` package 中，与客户端代码同仓库管理

## Technical Considerations

- **飞书 OAuth 2.0 特殊流程**（在服务端完成）：
  - 需要先获取 `app_access_token`（应用级 token），再用它换 `user_access_token`
  - OIDC 接口使用 `Authorization: Bearer <app_access_token>` 头部鉴权
  - 以上流程全部在签发服务的服务端执行，客户端仅提交 auth code
  - `redirect_uri` 必须与飞书开放平台中配置的重定向 URL 完全一致
- **动态端口分配**：本地回调服务器优先使用 `localhost:19876`，若端口被占用（如 MCP OAuth 服务器正在运行），在 19876-19885 范围内自动递增选取可用端口。`redirect_uri` 中的端口与实际监听端口一致。飞书开放平台需预注册 10 个回调地址（19876-19885）
- **wellknown 远程配置**：opencode 启动时会 fetch `<url>/.well-known/opencode` 获取最新配置，管理员可随时更新可用模型列表而无需用户侧操作。fetch 失败时给出友好的错误提示（网络错误、非 JSON 响应、HTTP 错误等）
- **token 存储格式**：wellknown auth 存储为 `{ type: "wellknown", key: "<env_var_name>", token: "<jwt>" }`，JWT 作为 bearer token 发送给代理。飞书 refresh_token、用户信息等元数据独立存储在 `<Global.Path.data>/feishu-auth.json` 中（与 `auth.json` 同目录），使用独立 zod schema 校验
- **JWT 设计**：RS256 签名。payload 包含 `sub`（open_id）、`email`、`name`、`exp`、`iat`。签发服务持私钥，代理持公钥。JWT 有效期由签发服务决定（默认 48 小时，平衡安全性和刷新频率）
- **RSA 密钥管理**：私钥仅存在于签发服务，公钥部署到所有反向代理实例。可通过 JWKS 端点动态分发公钥，也可静态配置
- **飞书 token 有效期**：user_access_token 约 2 小时，refresh_token 约 30 天。plugin 需要在 JWT 过期前用飞书 refresh_token 刷新飞书 token，再换新 JWT
- **代理 SSE 透传**：反向代理不需要理解 SSE 格式，只需要设置正确的 `Transfer-Encoding` / `Content-Type` 并透传 upstream 响应
- **无新依赖**：认证脚本使用 Bun 原生 `fetch` 和 `Bun.serve`

## Success Metrics

- 团队成员运行 `opencode auth login https://ai.corp.com` 后 30 秒内完成飞书登录
- 登录后直接使用 Claude 等模型，零额外配置
- token 自动刷新在 30 天内无需用户重新登录
- 管理员更新 wellknown 配置后，用户下次启动 opencode 自动生效
- 真实 API key 不暴露在客户端，仅存在于代理服务端
- `opencode auth list` 正确显示飞书用户名和邮箱

## Decisions Log

| #   | 问题                       | 决定                                                                                              |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | 是否支持 Lark 海外版？     | 先国内 `open.feishu.cn`，base URL 抽为配置项预留扩展                                              |
| 2   | 回调端口策略？             | 动态端口分配：优先 19876，在 19876-19885 范围内递增选取可用端口                                   |
| 3   | 代码位置？                 | 客户端内置在 `packages/opencode/src/`，服务端在 `packages/feishu-server/`                         |
| 4   | auth list 显示什么？       | 显示用户名 + 邮箱（`Feishu oauth (张三 / user@company.com)`），从 `feishu-auth.json` 读取         |
| 5   | 邮箱自动关联？             | 本期不做，留给未来 Console 集成                                                                   |
| 6   | 模型调用链路？             | Wellknown + Plugin：wellknown 做基础认证 + 远程配置，plugin 通过 `chat.headers` 做 token 自动刷新 |
| 7   | 支持哪些模型？             | 可配置，管理员通过 wellknown 配置决定                                                             |
| 8   | 用量管控？                 | 本期不需要                                                                                        |
| 9   | token 格式？               | 自签 JWT（RS256），包含 open_id、email、name、exp，代理端公钥验签                                 |
| 10  | JWT 签名方式？             | RSA 非对称密钥（RS256），签发服务持私钥，代理持公钥，代理无法伪造 token                           |
| 11  | 认证脚本分发？             | 内置在 opencode 中作为子命令 `opencode feishu-auth`，用户无需额外安装                             |
| 12  | app_secret 存放位置？      | 仅存在于服务端签发服务中，客户端不接触。auth code 交换在服务端完成                                |
| 13  | token 刷新 hook？          | 使用 `chat.headers`（每次请求调用），不使用 `auth.loader`（仅加载时调用一次）                     |
| 14  | 飞书元数据存储？           | 独立文件 `<Global.Path.data>/feishu-auth.json`（与 auth.json 同目录），使用独立 zod schema 校验   |
| 15  | wellknown fetch 错误处理？ | 本次一并修复 `auth login` 和 `config.ts` 两处，增加网络异常、非 JSON 响应、HTTP 错误的友好提示    |
| 16  | stdout 输出内容？          | 仅输出 JWT 字符串（供 wellknown 机制消费），元数据写入 `feishu-auth.json`                         |
| 17  | JWT 有效期？               | 默认 48 小时，由签发服务控制，可按需调整                                                          |
| 18  | JWT 刷新生效方式？         | Plugin 刷新后同时更新 `process.env[key]`（SDK 立即生效）+ 写 `auth.json`（重启后生效）            |
| 19  | 版本不兼容处理？           | `auth.command` spawn 失败时给出"请升级 opencode"的友好错误提示                                    |
| 20  | 多 wellknown 实例？        | 单实例即可，`feishu-auth.json` 保持扁平结构，未来需要时再扩展为 Record                            |
| 21  | 回调端口范围？             | 固定范围 19876-19885（10 个端口），飞书平台预注册 10 个回调地址                                   |
| 22  | auth code 重放防护？       | 依赖飞书一次性 code 机制，签发服务不做额外防护                                                    |
| 23  | 服务端代码位置？           | 本仓库新建 `packages/feishu-server` package，与客户端同仓库管理                                   |
