# 第 9 章：会话与上下文管理

## 本章信息

| | |
|--|--|
| **本章目标** | 理解 OpenClaw 如何存储会话历史、管理上下文窗口和实现跨对话记忆 |
| **适合读者** | 对会话持久化、上下文管理、向量记忆感兴趣的开发者 |
| **前置知识** | 第 4 章 |
| **核心结论** | OpenClaw 以文件系统（JSON 转录文件）为主存储会话历史，通过可插拔的 Context Engine 接口管理上下文窗口，支持自定义压缩策略；Memory 系统以 MEMORY.md 文件为载体实现跨会话记忆 |

---

## 核心结论

**OpenClaw 的会话持久化以文件系统为核心（JSON 转录文件），上下文管理通过可插拔的 `ContextEngine` 接口实现，默认按 token 预算截断历史消息；Memory 系统以工作区根目录的 `MEMORY.md` 文件为载体实现跨会话持久记忆。**

---

## 会话存储层

### 存储位置

```typescript
// 文件路径：src/config/sessions/paths.ts
export function resolveStorePath(
  config: OpenClawConfig,
  sessionKey: string,
): string {
  // 默认位置：~/.openclaw/sessions/{sessionKey}/transcript.json
  // 支持 OPENCLAW_STATE_DIR 环境变量覆盖
}
```

会话数据存储在用户主目录的 `.openclaw/sessions/` 下，每个会话一个 JSON 文件。

### 会话 Store 接口

```typescript
// 文件路径：src/config/sessions/store.ts（推断结构）
export type SessionStoreEntry = {
  sessionKey: string;
  messages: AgentMessage[];         // 消息历史
  metadata: SessionMetadata;
  createdAt: number;
  updatedAt: number;
};

export async function loadSessionStore(
  sessionKey: string,
): Promise<SessionStoreEntry | null> {
  // 从文件系统加载会话数据
  // 支持增量更新（只读取最新的 delta）
}

export async function updateSessionStoreEntry(params: {
  sessionKey: string;
  newMessages: AgentMessage[];
  transcriptFile: string;
}): Promise<void> {
  // 将新消息追加到会话文件
  // 使用写锁防止并发写入
}
```

### 会话压缩与归档

长会话的消息数量会持续增加。OpenClaw 实现了会话文件归档：

```typescript
// 文件路径：src/gateway/session-archive.fs.ts
// 当会话文件超过一定大小时，将旧消息归档
// 归档后的旧消息仍可通过 transcripts 命令查看
```

---

## 会话类型与路由

### sessionKey 格式

```typescript
// 文件路径：src/routing/session-key.ts
export const DEFAULT_AGENT_ID = "main";

export function isSubagentSessionKey(sessionKey: string): boolean {
  // 子 Agent 的 sessionKey 格式与主 Agent 不同
  return sessionKey.includes(SUBAGENT_KEY_SEPARATOR);
}
```

会话 Key 编码了通道信息、Agent ID 和对话 ID，使得路由系统可以从 Key 中直接推断会话归属。

### 多会话管理

Gateway 支持同时管理多个活跃会话：

```typescript
// 文件路径：src/gateway/server-runtime-state.ts
export type GatewayServerRuntimeState = {
  activeSessions: Map<string, ActiveSession>;
  // 每个通道可以绑定到不同的会话
  // 同一用户在不同通道的对话使用不同的 sessionKey
};
```

---

## Context Engine：可插拔上下文管理

Context Engine 是 OpenClaw 最重要的扩展点之一，通过 `ContextEngine` 接口支持完全自定义的上下文管理策略。

### 接口定义

```typescript
// 文件路径：src/context-engine/types.ts
export interface ContextEngine {
  readonly info: ContextEngineInfo;

  // 初始化（导入历史消息）
  bootstrap?(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult>;

  // 消息摄取（单条）
  ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult>;

  // 上下文装配（核心方法）
  assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    availableTools?: Set<string>;
    prompt?: string;          // 当前用户输入（支持检索式引擎）
    model?: string;           // 当前模型 ID
  }): Promise<AssembleResult>;

  // 压缩（减少 token 占用）
  compact(params: {
    sessionId: string;
    tokenBudget?: number;
    force?: boolean;
    abortSignal?: AbortSignal;   // 支持取消
  }): Promise<CompactResult>;

  // 轮次结束后处理
  afterTurn?(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<void>;
}
```

### AssembleResult 详解

```typescript
// 文件路径：src/context-engine/types.ts
export type AssembleResult = {
  messages: AgentMessage[];          // 准备发送给 LLM 的消息列表
  estimatedTokens: number;           // 预计 token 数量

  // 控制 token 预算计算的权威性
  promptAuthority?: "assembled" | "preassembly_may_overflow";

  // 可选：上下文引擎的系统 Prompt 补充
  systemPromptAddition?: string;

  // 可选：持久化后端线程的上下文投影配置
  contextProjection?: ContextEngineProjection;
};

export type ContextEngineProjection = {
  // "per_turn": 每次都重新注入上下文（默认）
  // "thread_bootstrap": 初始化一次，复用同一后端线程直到 epoch 改变
  mode: "per_turn" | "thread_bootstrap";
  epoch?: string;      // 上下文 epoch，变化时触发后端线程轮换
  fingerprint?: string;
};
```

`thread_bootstrap` 模式是一个高级特性，允许持久化后端线程（如保持与 LLM 的长连接）复用已注入的上下文，避免每次都重新注入完整历史。

### 上下文压缩

```typescript
// 文件路径：src/context-engine/types.ts
export type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;              // 压缩后的摘要文本
    firstKeptEntryId?: string;     // 保留的最早消息 ID
    tokensBefore: number;
    tokensAfter?: number;
    sessionId?: string;            // 压缩后可能轮换 session ID
    sessionFile?: string;
  };
};
```

默认压缩策略：生成对话摘要，删除旧消息，只保留摘要和最近的 N 条消息。

---

## 子 Agent 上下文管理

Context Engine 还需要处理子 Agent 的上下文隔离与传递：

```typescript
// 文件路径：src/context-engine/types.ts
// 父 Agent 派生子 Agent 时，Context Engine 需要准备子 Agent 的初始上下文
export type SubagentSpawnPreparation = {
  rollback: () => void | Promise<void>; // 子 Agent 启动失败时回滚
};

// ContextEngine 接口的可选方法
prepareSubagentSpawn?(params: {
  parentSessionKey: string;
  childSessionKey: string;
  contextMode?: "isolated" | "fork";   // 隔离或继承父上下文
  ttlMs?: number;                       // 子 Agent 超时
}): Promise<SubagentSpawnPreparation | undefined>;
```

---

## Memory 系统

### MEMORY.md 文件

OpenClaw 的 Memory 系统使用 Markdown 文件作为持久化载体：

```typescript
// 文件路径：src/memory/root-memory-files.ts
/** 标准根记忆文件名 */
export const CANONICAL_ROOT_MEMORY_FILENAME = "MEMORY.md";
/** 旧版根记忆文件名（保持兼容） */
export const LEGACY_ROOT_MEMORY_FILENAME = "memory.md";

export function resolveCanonicalRootMemoryPath(workspaceDir: string): string {
  return path.join(workspaceDir, CANONICAL_ROOT_MEMORY_FILENAME);
}

/** 加载 MEMORY.md，仅当它是真实文件（非符号链接）时 */
export async function resolveCanonicalRootMemoryFile(
  workspaceDir: string,
): Promise<string | null> {
  try {
    const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === CANONICAL_ROOT_MEMORY_FILENAME &&
        entry.isFile() &&
        !entry.isSymbolicLink()    // 安全检查：不跟随符号链接
      ) {
        return path.join(workspaceDir, entry.name);
      }
    }
  } catch {}
  return null;
}
```

`MEMORY.md` 是工作区根目录下的一个普通 Markdown 文件，AI 助手可以读写它来存储跨会话的记忆。符号链接安全检查防止了通过软链接访问工作区外的文件。

### 记忆修复目录

```typescript
// 文件路径：src/memory/root-memory-files.ts
export function resolveRootMemoryRepairDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".openclaw-repair", "root-memory");
}

// 当需要迁移 memory.md → MEMORY.md 时，旧文件备份到修复目录
export function shouldSkipRootMemoryAuxiliaryPath(params: {
  workspaceDir: string;
  absPath: string;
}): boolean {
  // 在辅助扫描中跳过修复目录和旧版文件名
}
```

### Memory Host SDK

```typescript
// 文件路径：src/memory-host-sdk/host/
// 为实现高级 Memory 功能（如向量嵌入）的插件提供 SDK
// 支持：
// - 语义相似度搜索
// - 记忆片段检索
// - 向量存储接口
```

---

## 转录文件管理

会话的完整消息历史存储在"转录文件"中：

```typescript
// 文件路径：src/gateway/session-transcript-files.fs.ts
export async function writeSessionTranscriptEntry(
  transcriptFile: string,
  entry: TranscriptEntry,
): Promise<void> {
  // 以追加方式写入转录文件
  // 使用会话写锁防止并发写入
}

// 文件路径：src/gateway/session-transcript-index.fs.ts
// 维护转录文件的索引，支持按时间范围查询
```

---

## 会话状态机

```typescript
// 文件路径：src/channels/run-state-machine.ts
// 每个通道会话有独立的状态机，管理消息处理状态
export type ChannelSessionState =
  | "idle"           // 等待用户消息
  | "processing"     // 正在处理消息
  | "streaming"      // 正在流式返回回复
  | "cooldown";      // 防抖冷却期
```

---

## 会话压缩检查点

OpenClaw 在上下文压缩时记录检查点，便于调试和审计：

```typescript
// 文件路径：src/gateway/session-compaction-checkpoints.ts
export type CompactionCheckpoint = {
  sessionKey: string;
  checkpointId: string;
  compactedAt: number;
  tokensBefore: number;
  tokensAfter: number;
  summaryLength: number;
};
```

---

## 小结

1. 会话历史以文件系统（JSON 转录文件）为主存储，位于 `~/.openclaw/sessions/`
2. Context Engine 是可插拔接口，支持自定义上下文装配、压缩和子 Agent 上下文管理策略
3. `thread_bootstrap` 投影模式是高级特性，允许持久化后端线程复用已注入上下文
4. Memory 系统以 `MEMORY.md` 文件为载体，符号链接安全检查防止路径逃逸
5. 会话压缩生成摘要+保留最近消息，压缩检查点记录 token 变化情况

## 延伸阅读

- [第 4 章：Agent 执行引擎](04-agent-engine.html)
- [第 6 章：多 LLM 提供商抽象](06-llm-providers.html)
- [第 10 章：ACP、MCP 与语音](10-acp-mcp-voice.html)
