# 第 9 章：会话与上下文管理

> **核心结论**：OpenClaw 以 JSONL 文件为会话存储格式，用 `uuidv7` 时间有序 ID 排序，通过 5 种 Entry 类型记录完整的会话树（含分支和压缩检查点）；Context Engine 是可插拔接口，`thread_bootstrap` 模式支持持久化后端线程复用；MEMORY.md 通过符号链接安全检查防止路径逃逸。

---

## JSONL 会话存储格式

OpenClaw 的会话以 JSONL（每行一个 JSON 对象）格式存储，位于 `~/.openclaw/sessions/<sessionKey>/transcript.jsonl`：

```typescript
// src/agents/sessions/session-manager.ts
// ——每个 JSONL 文件的第一行——
export interface SessionHeader {
  type: "session";
  version?: number;           // v1 会话没有版本号（向后兼容保留字段）
  id: string;                 // uuidv7 格式（时间有序）
  timestamp: string;          // ISO 8601 时间戳
  cwd: string;                // 会话启动时的工作目录
  parentSession?: string;     // 父会话 ID（分支时填写）
}

// ——每条对话消息——
export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;      // 完整的消息对象（含 role, content, tool_calls 等）
}

// ——上下文压缩检查点——
export interface CompactionEntry<T = unknown> extends SessionEntryBase {
  type: "compaction";
  summary: string;            // 压缩生成的摘要文本
  firstKeptEntryId: string;   // 保留的最早消息 ID（摘要之前的消息被截断）
  tokensBefore: number;       // 压缩前 token 数
  details?: T;                // 扩展数据（如 ArtifactIndex，插件可写入）
  fromHook?: boolean;         // true 表示由插件触发的压缩
}

// ——分支摘要（会话分叉时）——
export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;             // 分叉点的 Entry ID
  summary: string;            // 分叉前历史的摘要
  details?: T;                // 插件扩展数据（不发送给 LLM）
  fromHook?: boolean;
}

// ——模型/思考级别变更记录——
export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}
```

所有 Entry 都有公共基类 `SessionEntryBase`：

```typescript
export interface SessionEntryBase {
  type: string;
  id: string;                 // uuidv7（时间戳有序，便于按时间排序）
  parentId: string | null;    // 父 Entry ID（null 表示会话的第一条记录）
  timestamp: string;          // ISO 8601
}
```

---

## uuidv7：为什么选择时间有序 ID

```typescript
// src/agents/runtime/index.ts
import { uuidv7 } from "...";  // 时间有序 UUID
```

标准 UUIDv4 是完全随机的，文件系统中的多个 JSONL 文件无法按时间顺序合并。uuidv7 的前 48 位是毫秒时间戳，使得：
- 同一会话的 Entry 按 ID 排序即是时间顺序
- 多会话合并分析时无需解析 `timestamp` 字段
- 在索引数据库（SQLite）中 ID 本身就是有序主键

---

## JSONL 序列化工具

```typescript
// src/config/sessions/transcript-jsonl.ts

// 每行 = JSON.stringify(entry) + "\n"
export function serializeJsonlEntry(entry: unknown): string {
  return `${JSON.stringify(entry)}\n`;
}

// 批量序列化（多条 Entry 用 "\n" 分隔，末尾加 "\n"）
export function serializeJsonlEntries(entries: readonly unknown[]): string {
  const lines = entries.map((e) => JSON.stringify(e));
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

// 同步追加写入（Attempt 结束时调用）
export function appendJsonlEntriesSync(filePath: string, entries: readonly unknown[]): void {
  if (entries.length === 0) { return; }
  appendFileSync(filePath, serializeJsonlEntries(entries), "utf-8");
}

// 异步写入（新建会话时）
export async function writeJsonlEntry(filePath: string, entry: unknown): Promise<void> {
  await fs.writeFile(filePath, serializeJsonlEntry(entry), "utf-8");
}
```

**设计选择——追加写入（append-only）**：JSONL 格式天然支持追加，每次对话只需追加新 Entry，而不是重写整个文件。即使进程崩溃，已持久化的 Entry 也不会丢失。这比数据库事务更简单，在单机场景下可靠性足够。

---

## SessionKey 解析逻辑

```typescript
// src/config/sessions/session-key.ts

// 第一步：从消息上下文派生原始 Key
export function deriveSessionKey(scope: SessionScope, ctx: MsgContext): string {
  if (scope === "global") { return "global"; }
  // 群组/频道消息 → 使用群组特有 Key
  const resolvedGroup = resolveGroupSessionKey(ctx);
  if (resolvedGroup) { return resolvedGroup.key; }
  // 私聊 → 使用发送者 E.164 手机号（标准化后）
  const from = ctx.From ? normalizeE164(ctx.From) : "";
  return from || "unknown";
}

// 第二步：基于 Agent ID 和 mainKey 构建最终 Key
export function resolveSessionKey(
  scope: SessionScope,
  ctx: MsgContext,
  mainKey?: string,
  agentId: string = DEFAULT_AGENT_ID,
): string {
  // 优先使用消息中携带的显式 SessionKey（如 Webhook 调用时传入）
  const explicit = ctx.SessionKey?.trim();
  if (explicit) { return normalizeExplicitSessionKey(explicit, ctx); }

  const raw = deriveSessionKey(scope, ctx);
  if (scope === "global") { return raw; }

  const canonicalAgentId = normalizeAgentId(agentId);
  const canonicalMainKey = normalizeMainKey(mainKey);

  const isGroup = raw.includes(":group:") || raw.includes(":channel:");
  if (!isGroup) {
    // 私聊：归入 Agent 的"主会话"桶
    return buildAgentMainSessionKey({ agentId: canonicalAgentId, mainKey: canonicalMainKey });
  }
  // 群组/频道：以 Agent ID 为命名空间，防止多 Agent 共用同一个群组 Key 时碰撞
  return `agent:${canonicalAgentId}:${raw}`;
}
```

**关键设计：isGroup 的判断方式**——通过字符串包含 `:group:` 或 `:channel:` 来判断，而不是通过枚举类型或函数调用。这使得 SessionKey 格式是自描述的——直接看 Key 字符串就能判断会话类型。

---

## SessionKey 格式一览

| 场景 | SessionKey 示例 | 说明 |
|---|---|---|
| 私聊（电话号） | `agent:default:+8613800138000` | E.164 格式 |
| Telegram 群组 | `agent:default:telegram:group:-1001234567890` | 负数群组 ID |
| Telegram 频道 | `agent:default:telegram:channel:1234567890` |  |
| 全局共享 | `global` | 所有用户共享同一会话 |
| 子 Agent | `agent:default:+8613800138000:sub:01234567...` | 含 `:sub:` 标记 |
| 显式传入 | `my-custom-session-key` | Webhook 调用传入 |
| 多 Agent | `agent:codex:+8613800138000` | 不同 agentId 的私聊 |

---

## ContextEngine 接口：完整定义

```typescript
// src/context-engine/types.ts
export interface ContextEngine {
  readonly info: ContextEngineInfo;

  // 初始化引擎（加载历史会话）
  bootstrap?(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult>;

  // 每条消息写入后调用（用于更新引擎内部索引）
  ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;     // 心跳 Attempt 触发时为 true
  }): Promise<IngestResult>;

  // 核心方法：装配本次 Attempt 的上下文
  assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    availableTools?: Set<string>;  // 影响引擎对上下文的决策
    prompt?: string;               // 当前用户输入（支持 RAG 检索）
    model?: string;                // 影响 token 计算（不同模型的 tokenizer 不同）
    citationsMode?: CitationsMode;
  }): Promise<AssembleResult>;

  // 压缩：当上下文超出预算时调用
  compact(params: {
    sessionId: string;
    tokenBudget?: number;
    force?: boolean;           // 强制压缩（忽略阈值检查）
    abortSignal?: AbortSignal;
  }): Promise<CompactResult>;

  // 每轮结束后的后置处理（如更新向量索引）
  afterTurn?(params: {
    sessionId: string;
    messages: AgentMessage[];
    prePromptMessageCount?: number;
    tokenBudget?: number;
    autoCompactionSummary?: string;
    runtimeContext?: unknown;
    isHeartbeat?: boolean;
  }): Promise<void>;

  // 子 Agent 派生时的上下文准备
  prepareSubagentSpawn?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    contextMode?: "isolated" | "fork";
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined>;
}
```

---

## AssembleResult：上下文装配的返回值

```typescript
// src/context-engine/types.ts
export type AssembleResult = {
  messages: AgentMessage[];             // 要发送给 LLM 的消息列表
  estimatedTokens: number;

  // token 预算的权威性声明：
  // "assembled" = 引擎保证不超出预算
  // "preassembly_may_overflow" = 引擎无法保证（由 attempt.ts 再做截断）
  promptAuthority?: "assembled" | "preassembly_may_overflow";

  // 引擎向 System Prompt 注入的额外内容（如 RAG 检索结果）
  systemPromptAddition?: string;

  // 持久化后端线程的上下文投影配置（高级特性）
  contextProjection?: ContextEngineProjection;
};

export type ContextEngineProjection = {
  // "per_turn"：每次 Attempt 都重新注入完整上下文（默认）
  // "thread_bootstrap"：初始化一次后复用，直到 epoch 变化
  mode: "per_turn" | "thread_bootstrap";
  epoch?: string;       // epoch 变化时触发后端线程轮换
  fingerprint?: string; // 用于检测上下文是否发生变化
};
```

**`thread_bootstrap` 的使用场景**：某些 LLM Provider（如 OpenAI 的 Stateful API）支持维持一个持久化的上下文线程。如果上下文没变（epoch 相同），就不需要每次 Attempt 都重新发送全部历史消息——节省大量 token 和延迟。这是 OpenClaw 为支持未来 Stateful API 预留的扩展点。

---

## CompactResult：压缩结果

```typescript
// src/context-engine/types.ts
export type CompactResult = {
  ok: boolean;
  compacted: boolean;            // 是否真的进行了压缩（false = 未达到压缩阈值）
  reason?: string;               // 未压缩的原因说明
  result?: {
    summary?: string;            // 生成的摘要文本（写入 CompactionEntry）
    firstKeptEntryId?: string;   // 保留的最早消息 ID
    tokensBefore: number;
    tokensAfter?: number;
    sessionId?: string;          // 压缩后可能产生新的会话 ID（分支）
    sessionFile?: string;        // 新的 JSONL 文件路径
  };
};
```

**压缩的实际触发条件**：当 `estimatedTokens > tokenBudget * 0.9` 时，attempt.ts 调用 `contextEngine.compact()`。默认引擎会：
1. 调用 LLM 生成对话摘要
2. 将摘要写入 `CompactionEntry`（设置 `firstKeptEntryId`）
3. 保留摘要之后的最近 N 条消息
4. 更新 JSONL 文件（追加 CompactionEntry）

---

## MEMORY.md 安全保护

```typescript
// src/memory/root-memory-files.ts
export const CANONICAL_ROOT_MEMORY_FILENAME = "MEMORY.md";
export const LEGACY_ROOT_MEMORY_FILENAME = "memory.md";  // 旧版（迁移用）

// 加载时的符号链接安全检查
export async function resolveCanonicalRootMemoryFile(workspaceDir: string): Promise<string | null> {
  const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === CANONICAL_ROOT_MEMORY_FILENAME &&
      entry.isFile() &&
      !entry.isSymbolicLink()    // 关键：拒绝符号链接
    ) {
      return path.join(workspaceDir, entry.name);
    }
  }
  return null;
}
```

**为什么拒绝符号链接？** 攻击场景：恶意代码或用户失误导致 `MEMORY.md` 被替换为指向 `~/.ssh/id_rsa` 的符号链接。如果不检查，Agent 会读取并在对话中暴露 SSH 私钥。符号链接检查确保 MEMORY.md 只能是工作区目录中的真实文件，不能是指向其他位置的链接。

---

## 子 Agent 上下文隔离

```typescript
// src/context-engine/types.ts
export type SubagentSpawnPreparation = {
  rollback: () => void | Promise<void>;  // 子 Agent 启动失败时的回滚函数
};

// 子 Agent 派生时的上下文模式
// "isolated"：子 Agent 从空白上下文开始，不继承父上下文
// "fork"：子 Agent 继承父上下文的快照，但独立演化
```

`prepareSubagentSpawn` 方法是 Context Engine 的可选钩子——默认（内置）引擎直接创建空白的子会话（`isolated`）；自定义引擎可以实现 `fork` 模式，将父会话的 RAG 索引或向量嵌入传递给子 Agent。

---

## 会话管理 CLI 命令

```bash
# 列出所有会话
openclaw sessions list

# 查看指定会话的历史
openclaw sessions view <sessionKey>

# 导出会话（用于迁移或备份）
openclaw sessions export <sessionKey>

# 删除过期会话
openclaw sessions prune --older-than 30d

# 查看会话压缩记录
openclaw sessions compactions <sessionKey>
```

---

## 小结

1. **JSONL + uuidv7**：追加写入，崩溃安全；时间有序 ID 便于按时间排序和索引
2. **5 种 Entry 类型**：SessionHeader + SessionMessageEntry + CompactionEntry + BranchSummaryEntry + ModelChangeEntry，完整记录会话树
3. **SessionKey 解析**：私聊 → `agent:{id}:{phone}`；群组/频道 → `agent:{id}:{platform}:{kind}:{gid}`；全局 → `global`
4. **ContextEngine 接口**：`ingest → assemble → compact → afterTurn` 四段式生命周期，`thread_bootstrap` 模式支持 Stateful API
5. **MEMORY.md 安全检查**：符号链接拒绝，防止 Agent 读取工作区外的敏感文件

## 延伸阅读

- [第 4 章：Agent 执行引擎](04-agent-engine.html)
- [第 6 章：多 LLM 提供商抽象](06-llm-providers.html)
- [第 10 章：ACP、MCP 与语音](10-acp-mcp-voice.html)
