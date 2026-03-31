# Feishu Auth Server

通过飞书 SSO 为团队统一管理 AI 模型访问权限，无需分发 API Key。

---

## 概述

这是 OpenCode 的飞书 OAuth 认证服务端。它作为 LLM API 的反向代理运行，通过飞书单点登录验证用户身份，自动注入共享的 API Key，将请求转发到 Anthropic 或 OpenAI。

团队成员只需通过飞书授权登录，即可使用 AI 模型。管理员集中管理 API Key，用户侧零配置。

---

## 架构

```
用户终端                         认证服务器                      上游 API
+-----------+                  +------------------+           +-------------+
|           | 1. 获取配置       |                  |           |             |
| opencode  | --------------> | /.well-known/    |           |             |
|           |                  |   opencode       |           |             |
|           | 2. 飞书 OAuth    |                  |           |             |
|           | --------------> | /auth/token      |           |             |
|           |    (auth code)   |   签发 JWT       |           |             |
|           |                  |                  |           |             |
|           | 3. LLM 请求      |                  |           |             |
|           | --------------> | /v1/anthropic/*  | --------> | Anthropic   |
|           |    (JWT)         |   验证 JWT       |  (API Key) |             |
|           |                  |   注入 API Key   |           |             |
|           |                  |                  |           |             |
|           | 4. 自动刷新      |                  |           |             |
|           | --------------> | /auth/refresh    |           |             |
|           |                  |   换发新 JWT     |           |             |
+-----------+                  +------------------+           +-------------+
```

---

## 认证流程

完整的认证流程分为以下步骤：

1. 用户启动 `opencode`，客户端请求 `/.well-known/opencode` 获取认证配置
2. 执行 `opencode feishu-auth --issuer <url> --app-id <id>` 启动本地 OAuth 回调服务器
3. 浏览器打开飞书 SSO 授权页面，用户完成授权
4. 飞书回调携带 auth code 到本地服务器（端口 19876-19885）
5. 客户端将 auth code 发送到 `/auth/token` 换取 RS256 JWT
6. JWT 保存到本地，后续所有 LLM 请求都携带该 JWT
7. 服务端验证 JWT 后注入真实 API Key，转发请求到上游
8. JWT 即将过期时客户端自动调用 `/auth/refresh` 续期

---

## 前置条件

### 飞书开放平台

在 [飞书开放平台](https://open.feishu.cn/) 创建企业自建应用，开启以下权限：

- `contact:user.email:readonly` - 获取用户邮箱
- `authen:access_as_user` - 以用户身份访问

在应用的「安全设置」中添加重定向 URL：

```
http://localhost:19876/oauth/callback
http://localhost:19877/oauth/callback
http://localhost:19878/oauth/callback
http://localhost:19879/oauth/callback
http://localhost:19880/oauth/callback
http://localhost:19881/oauth/callback
http://localhost:19882/oauth/callback
http://localhost:19883/oauth/callback
http://localhost:19884/oauth/callback
http://localhost:19885/oauth/callback
```

### RSA 密钥对

生成用于 JWT 签名的 RSA 密钥对：

```bash
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
```

### 运行环境

支持以下任一运行时（部署脚本会自动检测并安装）：

- [Bun](https://bun.sh/) >= 1.0（推荐，性能最优）
- [Node.js](https://nodejs.org/) >= 18（服务端无 Bun 时自动降级）

---

## 服务端部署

### 环境变量

复制 `.env.example` 并填入实际值：

```bash
cp .env.example .env
```

| 变量                 | 必填 | 默认值                      | 说明                     |
| -------------------- | ---- | --------------------------- | ------------------------ |
| `PORT`               | 否   | `3456`                      | 服务端口                 |
| `ISSUER_URL`         | 是   | -                           | 服务的公网 URL           |
| `APP_ID`             | 是   | -                           | 飞书应用 App ID          |
| `APP_SECRET`         | 是   | -                           | 飞书应用 App Secret      |
| `RSA_PRIVATE_KEY`    | 是   | -                           | PEM 格式 RSA 私钥        |
| `RSA_PUBLIC_KEY`     | 是   | -                           | PEM 格式 RSA 公钥        |
| `ANTHROPIC_API_KEY`  | 是   | -                           | 共享的 Anthropic API Key |
| `OPENAI_API_KEY`     | 是   | -                           | 共享的 OpenAI API Key    |
| `ANTHROPIC_BASE_URL` | 否   | `https://api.anthropic.com` | Anthropic 上游地址       |
| `OPENAI_BASE_URL`    | 否   | `https://api.openai.com`    | OpenAI 上游地址          |
| `FEISHU_BASE_URL`    | 否   | `https://open.feishu.cn`    | 飞书 API 地址            |
| `JWT_TTL`            | 否   | `172800`（48 小时）         | JWT 有效期（秒）         |

### 方式一：部署脚本（推荐）

一键部署脚本会自动检测/安装运行时、安装依赖、启动服务：

```bash
# 自动检测运行时并启动（优先 bun，降级 node）
bash script/deploy.sh

# 仅检查环境，不启动
bash script/deploy.sh --check

# 仅安装运行时和依赖
bash script/deploy.sh --install

# 强制使用 Node.js（服务端无 bun 时）
bash script/deploy.sh --node

# 强制使用 Bun
bash script/deploy.sh --bun
```

### 方式二：手动启动

```bash
# 使用 Bun（推荐）
npm run start:bun

# 使用 Node.js
npm run start
```

服务启动后会输出 `Feishu auth server running on http://localhost:3456 (bun|node)`。

### 方式三：Docker 部署

已提供多运行时 Dockerfile：

```bash
# 默认使用 Bun（推荐）
docker build -t feishu-server .
docker run -d --name feishu-server --env-file .env -p 3456:3456 feishu-server

# 使用 Node.js
docker build --build-arg RUNTIME=node -t feishu-server .
docker run -d --name feishu-server --env-file .env -p 3456:3456 feishu-server
```

建议通过 Nginx 或 Cloudflare Tunnel 暴露 HTTPS 端口。

---

## 客户端配置

在项目根目录创建 `opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "anthropic": {
      "options": {
        "baseURL": "https://your-server.example.com/v1/anthropic"
      }
    }
  },
  "auth": {
    "wellknown": "https://your-server.example.com"
  }
}
```

`auth.wellknown` 指向认证服务器地址。OpenCode 启动时会自动请求 `/.well-known/opencode` 获取认证方式和 provider 配置。

如果同时使用 OpenAI，添加对应的 provider 配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "anthropic": {
      "options": {
        "baseURL": "https://your-server.example.com/v1/anthropic"
      }
    },
    "openai": {
      "options": {
        "baseURL": "https://your-server.example.com/v1/openai"
      }
    }
  },
  "auth": {
    "wellknown": "https://your-server.example.com"
  }
}
```

---

## 使用方式

配置完成后，直接运行 `opencode`。首次使用时会自动触发飞书授权流程：

```bash
opencode
```

浏览器会弹出飞书登录页面，授权后回到终端即可开始使用。

### 查看认证状态

```bash
opencode auth list
```

### 退出登录

```bash
opencode auth logout
```

退出时会清除本地保存的 JWT 和飞书认证信息。

---

## 自动刷新机制

客户端内置了 JWT 自动刷新插件。每次发送 LLM 请求前，插件会检查 JWT 的剩余有效期。

如果 JWT 将在 5 分钟内过期，插件自动调用 `/auth/refresh` 获取新 JWT。刷新过程对用户透明，并且有 Promise 去重机制确保并发请求时只触发一次刷新。

刷新失败（如 refresh_token 已过期）时需要重新授权。

---

## API 参考

### GET /.well-known/opencode

返回自动发现配置，包括认证命令和 provider 地址。

**响应示例：**

```json
{
  "auth": {
    "command": ["opencode", "feishu-auth", "--issuer", "https://your-server.example.com", "--app-id", "cli_xxx"],
    "env": "OPENCODE_FEISHU_TOKEN"
  },
  "config": {
    "provider": {
      "anthropic": {
        "options": { "baseURL": "https://api.anthropic.com" }
      },
      "openai": {
        "options": { "baseURL": "https://api.openai.com" }
      }
    }
  }
}
```

---

### POST /auth/token

用飞书 OAuth auth code 换取 JWT。

**请求体：**

```json
{
  "code": "飞书授权码",
  "redirect_uri": "http://localhost:19876/oauth/callback"
}
```

**响应示例：**

```json
{
  "jwt": "eyJhbGciOiJSUzI1NiIs...",
  "refresh_token": "飞书 refresh_token",
  "expires_at": 1700000000,
  "name": "张三",
  "email": "zhangsan@example.com"
}
```

---

### POST /auth/refresh

用 refresh_token 换取新 JWT。需要在 Authorization header 中携带当前 JWT（可以已过期）。

**请求头：**

```
Authorization: Bearer <当前 JWT>
```

**请求体：**

```json
{
  "refresh_token": "飞书 refresh_token"
}
```

**响应示例：**

```json
{
  "jwt": "eyJhbGciOiJSUzI1NiIs...",
  "refresh_token": "新的飞书 refresh_token",
  "expires_at": 1700172800
}
```

---

### /v1/anthropic/\*, /v1/openai/\*

LLM API 反向代理。请求必须携带有效 JWT。

服务端验证 JWT 后替换 Authorization header 为真实 API Key，透传请求（含流式响应）到上游。

**请求头：**

```
Authorization: Bearer <JWT>
```

---

## 安全机制

### JWT 签名

使用 RS256（非对称加密）签发和验证 JWT。私钥仅存在于服务端，公钥用于验证。即使 JWT 泄露也无法伪造新 Token。

### 本地存储

客户端将认证信息保存在 `feishu-auth.json`，文件权限设置为 `0o600`（仅当前用户可读写）。

### OAuth 安全

- 授权流程使用随机 `state` 参数防止 CSRF 攻击
- 重定向 URI 白名单限制为 `localhost:19876` 到 `localhost:19885`，防止开放重定向
- auth code 一次性使用，换取 Token 后即失效

### API Key 隔离

真实 API Key 仅存在于服务端环境变量中，不会传输到客户端。客户端仅持有 JWT，通过反向代理间接使用 API。

---

## 常见问题

### 浏览器没有自动打开

手动复制终端输出的 URL 到浏览器中打开。

### 端口被占用

客户端会依次尝试 19876-19885 共 10 个端口。如果全部被占用，请释放其中一个端口后重试。

### refresh_token 过期

飞书 refresh_token 有独立的过期时间（通常 30 天）。过期后需要重新执行飞书授权流程。运行 `opencode auth logout` 清除旧凭证后重新启动即可。

### JWT 验证失败

检查服务端的 `RSA_PUBLIC_KEY` 和 `RSA_PRIVATE_KEY` 是否匹配。可以用以下命令验证：

```bash
echo "test" | openssl dgst -sha256 -sign private.pem | openssl dgst -sha256 -verify public.pem -signature /dev/stdin
```

### 飞书 API 报错 502

确认 `APP_ID` 和 `APP_SECRET` 正确，且飞书应用已发布上线。自建应用需要在开放平台「版本管理与发布」中创建版本并审核通过。
