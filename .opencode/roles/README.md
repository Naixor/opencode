# Swarm Discussion Roles

预定义的讨论角色模板，供 `swarm_discuss()` 使用。

每个 `.md` 文件的 frontmatter 包含 `name` 和 `perspective`，可直接传给 `swarm_discuss` 的 `roles` 参数。

---

## 核心角色

| 角色          | 文件           | 适用场景                         |
| ------------- | -------------- | -------------------------------- |
| **PM**        | `pm.md`        | 产品决策、需求优先级、MVP 边界   |
| **Architect** | `architect.md` | 架构选型、模块设计、技术债务     |
| **Security**  | `security.md`  | 安全评审、权限设计、攻击面分析   |
| **QA**        | `qa.md`        | 测试策略、质量标准、回归风险     |
| **DBA**       | `dba.md`       | 数据库设计、迁移策略、查询优化   |
| **FE**        | `fe.md`        | UI/UX 设计、前端性能、双端一致性 |

---

## 推荐组合

### 技术选型（默认三角）

```ts
roles: [PM, Architect, QA]
// 适用于：框架选型、API 风格、新依赖引入
```

### 安全评审

```ts
roles: [Security, Architect, DevOps]
// 适用于：认证方案、权限模型、沙箱策略
```

### 数据库方案

```ts
roles: [DBA, Architect, DevOps]
// 适用于：Schema 变更、迁移策略、性能优化
```

### 全栈功能设计

```ts
roles: [PM, Architect, FE, QA]
// 适用于：新功能模块、跨端特性、大重构
```

### 上线评审

```ts
roles: [QA, DevOps, Security]
// 适用于：发布前检查、回滚方案、生产就绪评估
```

---

## 使用方式

### 在 TUI 中

```
/swarm discuss 我们应该用 WebSocket 还是 SSE 做实时通知
```

系统默认使用 PM + RD + QA。也可以指定角色名引用这些模板。

### 在代码中

```ts
swarm_discuss({
  topic: "SQLite WAL 模式 vs 默认 journal 模式",
  roles: [
    { name: "DBA", perspective: "关注查询性能、并发写入和数据一致性" },
    { name: "Architect", perspective: "关注系统可扩展性和模块边界" },
    { name: "DevOps", perspective: "关注部署复杂度和运维成本" },
  ],
  max_rounds: 3,
})
```

---

## 自定义角色

在此目录下创建新的 `.md` 文件即可。frontmatter 格式：

```yaml
---
name: RoleName # 简短角色名，1-3 词
perspective: > # 角色视角描述，越具体越好
  关注 X、Y 和 Z。倾向于 A，反对 B。
---
```

正文部分作为角色的详细指导，包含职责、关注点和行为准则。

**设计要点**：`perspective` 应明确角色「关注什么」和「倾向什么」，让不同角色产生有价值的观点碰撞。
