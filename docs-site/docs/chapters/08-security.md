# 第 8 章：安全审计机制

> **核心结论**：OpenClaw 的安全哲学是"强默认值 + 显式旋钮"——通过 14 个 `audit-*.ts` 模块全面检查配置，通过 `DangerousFlagContract` 机制让插件声明危险配置项，通过写锁+符号链接防护+沙盒多层保护执行边界，通过 `openclaw doctor --fix` 强制迁移，不维护兼容分支。

---

## 安全类型系统

```typescript
// src/security/audit.types.ts
// 严重性只有三级（注意：没有 "high"/"medium"/"low"）
export type SecurityAuditSeverity = "info" | "warn" | "critical";

// 每一条审计发现
export type SecurityAuditFinding = {
  checkId: string;       // 唯一检查 ID（如 "gateway-auth-weak-token"）
  severity: SecurityAuditSeverity;
  title: string;         // 人类可读的问题标题
  detail: string;        // 详细描述（含上下文信息）
  remediation?: string;  // 建议的修复步骤（可选）
};

// 被用户主动静默的发现
export type SecurityAuditSuppressedFinding = SecurityAuditFinding & {
  suppression: {
    reason?: string;     // 静默原因（供后续审计审查）
  };
};

// 审计结果计数（按严重性分组）
export type SecurityAuditSummary = {
  critical: number;
  warn: number;
  info: number;
};

// 完整审计报告
export type SecurityAuditReport = {
  ts: number;                                     // Unix 时间戳
  summary: SecurityAuditSummary;
  findings: SecurityAuditFinding[];
  suppressedFindings?: SecurityAuditSuppressedFinding[];
  deep?: {
    gateway?: {
      attempted: boolean;
      url: string | null;
      ok: boolean;
      error: string | null;
      close?: { code: number; reason: string } | null;
    };
  };
};
```

**三级而非五级严重性**：`info/warn/critical` 比常见的 `info/low/medium/high/critical` 更简洁。实际项目中，5 级分类往往导致"medium 是可以忽略的"误解；3 级迫使开发者做明确二分决策：是否需要立即修复（critical）、是否需要关注（warn）。

---

## 14 个审计模块

```
src/security/
├── audit.ts                    ← 主入口，编排所有检查
├── audit.types.ts              ← 类型定义
├── audit-gateway-config.ts     ← Gateway 基础配置
├── audit-gateway-exposure.ts   ← 网络暴露（是否监听公网地址）
├── audit-gateway-auth.ts       ← 认证强度（token 熵 + 弱密码检测）
├── audit-channel.ts            ← 通道配置（缺少白名单等）
├── audit-exec-safe-bins.ts     ← 已批准可执行文件的安全性
├── audit-exec-sandbox.ts       ← 沙盒配置有效性
├── audit-exec-surface.ts       ← 执行面暴露程度
├── audit-plugins-trust.ts      ← 插件信任级别
├── audit-model-hygiene.ts      ← 模型配置（如过时的模型版本）
├── audit-fs.ts                 ← 文件系统权限设置
├── audit-deep-code-safety.ts   ← 深度代码安全扫描（--deep 模式）
└── audit-trust-model.ts        ← 信任模型一致性验证
```

这些模块是独立运行的：每个模块接收 `OpenClawConfig`，返回 `SecurityAuditFinding[]`，最终由 `audit.ts` 合并排序。各模块互不依赖，可以单独测试。

---

## 危险配置标志系统

这是 OpenClaw 安全架构中最有创意的部分——插件可以通过 `configContracts` 声明哪些配置项属于"危险"标志：

```typescript
// src/security/dangerous-config-flags-core.ts（精简）
type DangerousFlagContract = {
  path: string;           // 配置路径（相对于 plugin.config）
  equals: string | number | boolean | null;  // 触发警告的值
};
```

**内置的危险标志检测**（直接在 `collectEnabledInsecureOrDangerousFlagsFromContracts` 中硬编码）：

```typescript
// 1. 允许 Hook 请求自定义 SessionKey（可能绕过会话隔离）
if (cfg.hooks?.allowRequestSessionKey === true) {
  enabledFlags.push("hooks.allowRequestSessionKey=true");
}

// 2. 允许 SSRF 请求访问私有网络（如内网 API）
if (cfg.browser?.ssrfPolicy?.dangerouslyAllowPrivateNetwork === true) {
  enabledFlags.push("browser.ssrfPolicy.dangerouslyAllowPrivateNetwork=true");
}

// 3. 关闭文件系统工作区隔离（Agent 可以访问工作区外的文件）
if (cfg.tools?.fs?.workspaceOnly === false) {
  enabledFlags.push("tools.fs.workspaceOnly=false");
}

// 4. Docker 沙盒危险键（来自 DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS 常量）
// 如：privileged=true, network_mode="host", disable_security_options=true
collectSandboxDockerDangerousFlags(cfg.agents?.defaults?.sandbox?.docker, "agents.defaults.sandbox.docker");
```

**插件扩展的危险标志**：插件通过 `configContracts.dangerousFlags` 声明自己的危险配置项：

```json5
// 插件 manifest.json 示例
{
  "configContracts": {
    "dangerousFlags": [
      { "path": "skipSslVerification", "equals": true },
      { "path": "allowRemoteCodeExecution", "equals": true }
    ]
  }
}
```

当用户配置了 `plugins.entries.my-plugin.config.skipSslVerification = true` 时，审计会自动产生一条 `warn` 级别的发现，不需要插件自己实现检查逻辑。

---

## 执行权限批准机制

```typescript
// src/infra/exec-approvals.ts
export type ExecApproval = {
  commandPattern: string;  // Glob 模式（如 "git *" 或 "docker run *"）
  approved: boolean;
  approvedAt?: number;
  approvedBy?: "user" | "operator" | "admin";
};

export type ExecApprovalsFile = {
  approvals: ExecApproval[];
  defaultAsk: boolean;     // 未匹配命令是否默认询问用户
};
```

**执行权限漂移检测**（`audit-exec-safe-bins.ts`）：

```typescript
// 漂移检测：已批准的可执行文件发生了变化
export function collectExecFilesystemPolicyDriftHits(
  approvals: ExecApprovalsFile,
  platform: NodeJS.Platform,
): PolicyDriftHit[] {
  // 检查三种漂移类型：
  // 1. 文件已删除（但仍在批准列表）
  // 2. 文件权限变化（如被赋予 SUID 位）
  // 3. 文件哈希变化（可能是被篡改或意外更新）
}
```

**为什么需要漂移检测？** 想象用户批准了 `/usr/local/bin/kubectl` 的执行权限，但后来该文件被替换为恶意版本。没有漂移检测时，Agent 会继续调用它。漂移检测确保批准是"对特定文件状态的批准"，而不是"对文件路径的永久批准"。

---

## 沙盒安全层级

```typescript
// src/agents/sandbox/config.ts
export type SandboxMode =
  | "none"              // 无沙盒（审计产生 warn）
  | "docker"            // Docker 容器隔离（最强）
  | "bwrap"             // Linux bubblewrap（轻量，Linux 专用）
  | "macOS-sandbox"     // macOS Sandbox Profile（Apple 沙盒）
  | "none-except-network"; // 只限制文件系统，允许网络
```

**Docker 沙盒的危险键**（`DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS`）：

```typescript
// 开启任一键时，审计会报告 critical 发现
const DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS = [
  "privileged",            // 赋予容器 root 权限
  "disable_security_options", // 禁用 seccomp/AppArmor
  "allow_host_pid_namespace",  // 共享宿主进程空间
  "allow_host_network",        // 使用宿主网络
] as const;
```

当用户配置 `agents.defaults.sandbox.docker.privileged = true` 时，审计会产生 `critical` 发现，并在 `SecurityAuditReport.deep.gateway` 中记录深度探测结果（如果 Gateway 正在运行）。

---

## Doctor 强制迁移机制

`openclaw doctor --fix` 是 OpenClaw 安全体系的"自愈"机制。关键设计决策：

**不维护向后兼容路径**：
```
// AGENTS.md 的架构约束（精确引用）
"Core runtime reads canonical config only. No silent compat for old/malformed config keys.
If a config change invalidates existing files, add a matching openclaw doctor --fix migration."
```

这意味着：如果用户有一个旧版格式的配置文件，直接运行 `openclaw` 会报错，而不是静默兼容。`openclaw doctor --fix` 才是修复路径，确保迁移是显式的、可审计的。

**Doctor 覆盖的迁移类型**：

| 迁移类型 | 原因 |
|---|---|
| 配置字段重命名 | 旧字段已弃用（如 `openai-codex` → `openai`） |
| 配置格式变更 | 字段结构调整 |
| 插件配置修复 | 插件版本升级导致的配置不兼容 |
| Gateway 认证升级 | 弱 token 被升级为强 token |

---

## Gateway 认证审计

```typescript
// src/security/audit-gateway-auth.ts（推断）
// 检查 1：token 熵
// token 长度 < 32 字节 → critical
// token 熵 < 120 bits → warn

// 检查 2：公网 + 无认证
// Gateway 监听 0.0.0.0 且 auth.mode = "none" → critical

// 检查 3：Gateway 通过 HTTP 而非 HTTPS 暴露
// 生产环境使用 HTTP → warn
```

**深度审计模式**：加 `--deep` 标志时，审计会尝试实际连接 Gateway WebSocket，验证认证是否真的生效（而不只是检查配置文件）：

```typescript
// SecurityAuditReport.deep.gateway 的实际连接结果
deep: {
  gateway: {
    attempted: true,
    url: "ws://localhost:4000",
    ok: false,    // 连接失败（配置与实际不符）
    error: "ECONNREFUSED",
    close: null,
  }
}
```

---

## 审计结果静默

用户可以静默特定发现（并说明原因）：

```typescript
// src/config/types.openclaw.ts
export type SecurityAuditSuppression = {
  id: string;            // 要静默的 checkId
  reason?: string;       // 静默原因（会被审计记录存档）
  suppressedAt?: number; // 静默时间戳
};
```

静默发现会出现在 `suppressedFindings` 数组中，而不是直接删除——这确保安全团队在回顾审计报告时，能看到哪些发现被主动忽略了、原因是什么。这比"把问题删掉"更透明。

---

## 与其他框架的对比

| 维度 | OpenClaw | LangGraph | AutoGen |
|---|---|---|---|
| 安全审计 | 14 个独立模块 | 无 | 无 |
| 危险配置检测 | 声明式 DangerousFlagContract | 无 | 无 |
| 执行权限漂移检测 | 有（文件哈希检查） | 无 | 无 |
| 强制迁移机制 | doctor --fix | 无 | 无 |
| 沙盒模式 | Docker/bwrap/macOS/none | 无 | 可选 Docker |

---

## 小结

1. **三级严重性**：`info/warn/critical`——比五级更简洁，迫使开发者做明确决策
2. **SecurityAuditFinding** 的 `checkId` 是稳定标识符，可以在 suppression 配置中引用
3. **危险配置标志**通过 `DangerousFlagContract` 机制让插件声明危险项，审计引擎统一处理
4. **执行权限漂移检测**：批准是对文件状态的批准，文件哈希变化会触发重新审查
5. **Doctor 强制迁移**：不维护兼容路径，旧配置必须通过 `doctor --fix` 显式迁移

## 延伸阅读

- [第 5 章：插件系统深解](05-plugin-system.html)
- [第 7 章：Skills 系统](07-skills.html)
- [第 9 章：会话与上下文管理](09-session-context.html)
