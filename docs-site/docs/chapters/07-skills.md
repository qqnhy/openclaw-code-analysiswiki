# 第 7 章：Skills 系统

## 本章信息

| | |
|--|--|
| **本章目标** | 理解 Skills 如何让用户通过 Markdown 文件自定义 AI 助手的行为 |
| **适合读者** | 想使用或开发 OpenClaw Skills 的用户和开发者 |
| **前置知识** | 第 4 章 |
| **核心结论** | Skills 是 OpenClaw 最直接的用户扩展机制，以 Markdown 文件形式存在于工作区，在每次 Agent 运行时被加载并注入系统 Prompt，支持环境变量覆盖和 token 优化 |

---

## 核心结论

**Skills 是 OpenClaw 最轻量的扩展机制：一个 Markdown 文件即是一个 Skill，放入工作区后 Agent 自动加载并将其内容注入系统 Prompt。** Skills 系统内置了 `~` 路径压缩优化（节省 400-600 tokens），支持 env 变量覆盖和沙盒路径限制。

---

## 什么是 Skill？

Skill 是一个放在特定目录下的 **Markdown 文件**（通常命名为 `SKILL.md`）。它的内容会被注入到 Agent 的系统 Prompt 中，影响 AI 的行为。

典型的 Skill 示例：

```markdown
---
name: "代码审查助手"
description: "在审查代码时提供详细的安全检查意见"
triggers:
  - review
  - code review
---

# 代码审查指南

当用户请求代码审查时：
1. 检查潜在的安全漏洞（SQL 注入、XSS 等）
2. 评估代码的可读性和维护性
3. 提供具体的改进建议
```

Skill 文件有 YAML frontmatter（可选）和 Markdown 正文两部分。

---

## Skills 目录结构

```
src/skills/
├── config/               # Skill 配置解析
│   └── config.ts         # 允许列表、过滤规则
├── discovery/            # Skill 发现与过滤
│   ├── agent-filter.ts   # Agent 级 Skill 过滤
│   ├── filter.ts         # 通用过滤逻辑
│   └── skill-index.ts    # Skill 索引与元数据提取
├── lifecycle/            # Skill 生命周期管理
├── loading/              # Skill 加载核心
│   ├── workspace.ts      # 工作区 Skill 加载（主入口）
│   ├── local-loader.ts   # 本地文件加载
│   ├── bundled-dir.ts    # 内置 Skill 目录
│   ├── frontmatter.ts    # YAML frontmatter 解析
│   ├── plugin-skills.ts  # 插件贡献的 Skills
│   └── skill-contract.ts # Skill 格式化为 Prompt
├── runtime/              # 运行时 Skill 管理
│   ├── embedded-run-entries.ts  # 单次运行的 Skill 条目
│   ├── env-overrides.ts         # 环境变量覆盖
│   └── session-snapshot.ts      # 会话 Skill 快照
├── security/             # Skill 安全检查
└── types.ts              # Skill 类型定义
```

---

## Skill 加载流程

### workspace.ts 入口

```typescript
// 文件路径：src/skills/loading/workspace.ts
export async function resolveSkillsPromptForRun(params: {
  config: OpenClawConfig;
  sessionKey: string;
  agentDir: string;
}): Promise<string> {
  // 1. 确定 Skill 搜索目录
  const skillDirs = resolveSkillDirectories(params);

  // 2. 从各目录加载 Skill 文件
  const allSkills = await loadSkillsFromAllDirs(skillDirs);

  // 3. 过滤和排序（根据触发词、优先级）
  const filteredSkills = filterPromptVisibleSkillEntries(allSkills, context);

  // 4. 序列化为系统 Prompt 文本
  return formatSkillsForPrompt(compactSkillPaths(filteredSkills));
}
```

### Skill 搜索目录

Skills 从以下目录按优先级搜索：

1. `~/.openclaw/skills/`（用户全局 Skills）
2. `{agentDir}/skills/`（Agent 工作区 Skills）
3. 插件贡献的 Skills 目录（通过 `plugin-skills.ts`）
4. 内置 Skill 目录（`bundled-dir.ts`）

### 路径压缩优化

```typescript
// 文件路径：src/skills/loading/workspace.ts
/**
 * Replace the user's home directory prefix with `~` in skill file paths
 * to reduce system prompt token usage. Models understand `~` expansion,
 * and the read tool resolves `~` to the home directory.
 *
 * Example: `/Users/alice/.bun/.../skills/github/SKILL.md`
 *       → `~/.bun/.../skills/github/SKILL.md`
 *
 * Saves ~5–6 tokens per skill path × N skills ≈ 400–600 tokens total.
 */
function compactSkillPaths(skills: Skill[]): Skill[] {
  const homes = resolveCompactHomePrefixes();
  if (homes.length === 0) { return skills; }
  // 将最长的 home 路径前缀替换为 ~
  // 处理符号链接路径（realpath）
}
```

这个优化细节体现了 OpenClaw 团队对 token 消耗的精细管理——每个 Skill 路径节省 5-6 个 token，在 Skills 数量较多时可节省 400-600 tokens。

---

## Frontmatter 解析

```typescript
// 文件路径：src/skills/loading/frontmatter.ts
export type ParsedSkillFrontmatter = {
  name?: string;
  description?: string;
  version?: string;
  triggers?: string[];           // 触发此 Skill 的关键词
  priority?: number;             // Skill 优先级（影响注入顺序）
  enabled?: boolean;             // 是否启用
  models?: string[];             // 只对特定模型生效
  channels?: string[];           // 只对特定通道生效
};

export function resolveOpenClawMetadata(
  frontmatter: Record<string, unknown>,
): ParsedSkillFrontmatter {
  // 解析并验证 frontmatter 字段
}
```

### Skill 调用策略

```typescript
// 文件路径：src/skills/loading/frontmatter.ts
export type SkillInvocationPolicy =
  | "always"      // 每次运行都注入
  | "on-trigger"  // 只有触发词匹配时注入
  | "manual";     // 需要用户显式激活
```

---

## 环境变量覆盖

Skills 可以为 Agent 运行设置额外的环境变量，这在沙盒环境中特别有用：

```typescript
// 文件路径：src/skills/runtime/env-overrides.ts
export function applySkillEnvOverrides(
  baseEnv: NodeJS.ProcessEnv,
  skillEntries: SkillEntry[],
): NodeJS.ProcessEnv {
  // 从 Skill 的 frontmatter 中读取 env 覆盖
  // 合并多个 Skill 的 env 设置（后加载的 Skill 优先级更高）
  return { ...baseEnv, ...skillEnvOverrides };
}
```

### 安全考虑

Skill 的 env 覆盖受到严格约束：

```typescript
// 文件路径：src/skills/security/
// 禁止 Skill 覆盖某些危险的环境变量（如 PATH、LD_PRELOAD 等）
```

---

## 内置 Skills

OpenClaw 带有一批内置 Skills，覆盖常见使用场景：

```typescript
// 文件路径：src/skills/loading/bundled-dir.ts
export function resolveBundledSkillsDir(): string {
  // 返回随 OpenClaw 发行包携带的内置 Skills 目录
  // 通常位于 dist/bundled-skills/
}
```

内置 Skills 可以被用户创建同名文件覆盖（优先级规则）。

---

## 插件 Skills

插件可以贡献 Skills 目录：

```typescript
// 文件路径：src/skills/loading/plugin-skills.ts
export async function resolvePluginSkillDirs(
  snapshot: PluginMetadataSnapshot,
): Promise<PluginSkillDir[]> {
  // 从插件 manifest 中读取 skills 目录声明
  // 返回所有插件贡献的 Skills 搜索路径
}
```

---

## Skills 与 Prompt 的关系

Skills 最终以什么格式注入到系统 Prompt 中？

```typescript
// 文件路径：src/skills/loading/skill-contract.ts
export function formatSkillsForPrompt(skills: Skill[]): string {
  // 将 Skills 格式化为系统 Prompt 的一个 section
  // 通常格式：
  // <skills>
  // ## {skill-name}
  // {skill-content}
  //
  // ## {skill-name-2}
  // ...
  // </skills>
}
```

在 Agent 的完整系统 Prompt 中，Skills 注入的位置和优先级由 `buildSystemPromptParams()` 控制（第 4 章）。

---

## Session 级 Skill 快照

为了保证会话内的 Skill 一致性，OpenClaw 在每次 Agent 运行时记录 Skill 快照：

```typescript
// 文件路径：src/skills/runtime/session-snapshot.ts
export type SkillSessionSnapshot = {
  sessionKey: string;
  skillEntries: SkillEntry[];
  snapshotAt: number;
};
```

这防止了在长会话中 Skills 文件被修改导致上下文不一致。

---

## 小结

1. Skills 是最轻量的用户扩展方式：一个 Markdown 文件即可改变 AI 行为
2. 路径压缩优化（`~` 替换）节省 400-600 tokens，体现了对 token 消耗的精细管理
3. Skills 来源有 4 类：用户全局、工作区、插件贡献、内置
4. YAML frontmatter 控制 Skill 的元数据：触发词、优先级、模型/通道限制
5. env 覆盖功能使 Skill 可以为 Agent 运行注入环境变量，但受安全约束

## 延伸阅读

- [第 4 章：Agent 执行引擎](04-agent-engine.html)
- [第 5 章：插件系统深解](05-plugin-system.html)
- [第 8 章：安全审计机制](08-security.html)
