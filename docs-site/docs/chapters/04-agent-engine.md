# 第 4 章：Agent 执行引擎

## 本章信息

| | |
|--|--|
| **本章目标** | 深入理解一次 AI 对话请求从接收到回复的完整执行过程 |
| **适合读者** | 对 Agent 工作机制、LLM 调用链路感兴趣的开发者 |
| **前置知识** | 第 3 章 |
| **核心结论** | Agent 执行引擎的核心是 5377 行的 `attempt.ts`，它在单次函数调用中编排了 Prompt 构建、上下文压缩、LLM 流式调用、工具执行、会话持久化等完整流水线 |

---

## 核心结论

**嵌入式 Agent 执行引擎以 `attempt.ts` 为核心，在单次尝试（Attempt）内完成 Prompt 组装、技能注入、LLM 流式调用、工具执行循环和会话持久化的全部工作。** 该文件是整个项目最复杂的单体文件（5,377 行），集中体现了 OpenClaw 的 Agent 执行哲学。

---

## 执行引擎目录结构

```
src/agents/
├── embedded-agent-runner/
│   ├── run/
│   │   ├── attempt.ts          # 核心：单次执行尝试（5377 行）
│   │   └── ...
│   └── ...
├── sessions/
│   ├── session-manager.ts      # 会话状态管理器
│   ├── keybindings.ts          # 键绑定
│   └── package-manager.ts      # 包管理器检测
├── sandbox/                    # 沙盒隔离
│   └── config.ts               # 沙盒配置
├── harness/                    # Agent 钩子执行框架
├── modes/                      # Agent 运行模式
├── runtime/                    # Agent 运行时接口
└── tools/                      # 内置工具集
```

---

## attempt.ts 的职责概览

`attempt.ts` 通过一个庞大的函数 `runEmbeddedAgentAttempt()` 编排整个 Agent 执行尝试。从其导入列表可以看出它直接依赖的子系统：

```typescript
// 文件路径：src/agents/embedded-agent-runner/run/attempt.ts（前 100 行 import）
import { isAcpRuntimeSpawnAvailable } from "../../../acp/runtime/availability.js";
import { buildHierarchyReinforcementMessage } from "../../../auto-reply/handoff-summarizer.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { loadSessionStore, updateSessionStoreEntry } from "../../../config/sessions/store.js";
import { resolveContextEngineOwnerPluginId } from "../../../context-engine/registry.js";
import { createCodexNativeWebSearchWrapper } from "../../../llm/providers/stream-wrappers/openai.js";
import { resolveSkillsPromptForRun } from "../../../skills/loading/workspace.js";
import { resolveEmbeddedRunSkillEntries } from "../../../skills/runtime/embedded-run-entries.js";
import { buildTrajectoryArtifacts } from "../../../trajectory/metadata.js";
// ... 共导入 70+ 个模块
```

这 70+ 个直接导入体现了 attempt.ts 的"总装车间"角色——它不实现具体逻辑，而是调度所有子系统协同工作。

---

## 一次完整的 Agent 执行流程

### 阶段 1：准备阶段

```typescript
// 文件路径：src/agents/embedded-agent-runner/run/attempt.ts
// 1. 获取写锁（防止并发写入同一会话）
const sessionWriteLock = await acquireSessionWriteLock(sessionKey);

// 2. 解析运行时配置
const runtimeConfig = getRuntimeConfig();

// 3. 加载 Skills（用户自定义行为注入）
const skillsPrompt = await resolveSkillsPromptForRun({
  config: runtimeConfig,
  sessionKey,
  agentDir,
});

// 4. 解析上下文引擎
const contextEngineOwnerId = resolveContextEngineOwnerPluginId();
```

### 阶段 2：系统 Prompt 组装

Agent 执行引擎会从多个来源组装系统 Prompt：

```typescript
// 文件路径：src/agents/embedded-agent-runner/run/attempt.ts
const systemPromptParams = await buildSystemPromptParams({
  config: runtimeConfig,
  sessionKey,
  agentDir,
  // 注入来源：
  // - 基础系统 Prompt（硬编码的能力描述）
  // - Skills（用户自定义 .md 文件）
  // - 插件系统 Prompt 贡献
  // - Provider 特定的 Prompt 扩展
  // - 子 Agent 活跃上下文
  // - 心跳摘要（heartbeat summary）
  skillsPrompt,
});
```

Prompt 来源的优先级和组合方式在 `src/agents/system-prompt-params.ts` 中定义。

### 阶段 3：上下文组装（Context Engine）

```typescript
// 文件路径：src/agents/embedded-agent-runner/run/attempt.ts
// 调用可插拔的上下文引擎
const assembleResult: AssembleResult = await contextEngine.assemble({
  sessionId,
  sessionKey,
  messages: sessionMessages,
  tokenBudget: resolvedTokenBudget,
  availableTools: toolNameSet,
  prompt: userPrompt,
});
```

上下文引擎是可插拔的（`ContextEngine` 接口），默认实现会根据 token 预算截断历史消息；插件可以提供向量检索等高级上下文管理策略。

### 阶段 4：工具注册

```typescript
// 文件路径：src/agents/embedded-agent-runner/run/attempt.ts
// 聚合多来源的工具定义：
// 1. 内置工具（Bash、Read、Write、Edit 等）
const builtinTools = createOpenClawCodingTools({ config: runtimeConfig, ... });

// 2. 插件贡献的工具
const pluginTools = resolvePluginTools({ snapshot: pluginMetadataSnapshot });

// 3. MCP 工具（通过 Bundle MCP）
const mcpTools = await materializeBundleMcpToolsForRun({ sessionKey });

// 4. 客户端工具（Skills 定义的工具）
const clientTools = toClientToolDefinitions(skillEntries);

// 5. 工具冲突检查
const conflicts = findClientToolNameConflicts(clientTools, builtinTools);
if (conflicts.length > 0) {
  throw createClientToolNameConflictError(conflicts);
}
```

### 阶段 5：LLM 流式调用

```typescript
// 文件路径：src/agents/embedded-agent-runner/run/attempt.ts
// 注册 Provider 流（根据配置选择 Anthropic/OpenAI/Google 等）
const streamFn = registerProviderStreamForModel({
  model: resolvedModel,
  config: runtimeConfig,
  providerHandle: providerRuntimeHandle,
});

// 流式调用 LLM
for await (const event of streamFn({
  messages: assembleResult.messages,
  systemPrompt: finalSystemPrompt,
  tools: normalizedTools,
  maxTokens: ...,
})) {
  // 处理流式事件：文本片段、工具调用、停止原因等
  if (event.type === "text_delta") { /* 流式发送到通道 */ }
  if (event.type === "tool_use") { /* 执行工具调用 */ }
  if (event.type === "end") { /* 收集使用量、结束 */ }
}
```

### 阶段 6：工具执行循环

当 LLM 返回工具调用时，执行引擎会：

1. 验证工具名称是否在已注册工具列表中
2. 调用对应工具的执行函数
3. 将工具结果追加到消息历史
4. 重新调用 LLM（携带工具结果）
5. 重复直到 LLM 不再请求工具调用

### 阶段 7：会话持久化

```typescript
// 文件路径：src/agents/embedded-agent-runner/run/attempt.ts
// 将本次执行的消息追加到会话存储
await updateSessionStoreEntry({
  sessionKey,
  newMessages: turnMessages,
  transcriptFile: sessionFile,
});

// 触发上下文引擎的 afterTurn 生命周期
await contextEngine.afterTurn({
  sessionId,
  messages: turnMessages,
  prePromptMessageCount,
  tokenBudget: resolvedTokenBudget,
});
```

---

## 轨迹记录（Trajectory）

OpenClaw 支持记录 Agent 执行轨迹，用于调试和分析：

```typescript
// 文件路径：src/agents/embedded-agent-runner/run/attempt.ts
const trajectoryRecorder = createTrajectoryRuntimeRecorder({
  sessionKey,
  config: runtimeConfig,
});

// 执行结束后构建轨迹产物
const trajectoryArtifacts = await buildTrajectoryArtifacts({
  sessionKey,
  runMetadata: buildTrajectoryRunMetadata({...}),
  messages: turnMessages,
  toolDefinitions: toTrajectoryToolDefinitions(normalizedTools),
});
```

---

## 沙盒机制

Agent 执行工具（如 Bash 命令）时，会根据配置决定是否在沙盒中运行：

```typescript
// 文件路径：src/agents/sandbox.ts
export async function resolveSandboxContext(
  config: OpenClawConfig,
  agentDir: string,
): Promise<SandboxContext> {
  const sandboxConfig = resolveSandboxConfigForAgent(config, agentDir);
  return {
    mode: sandboxConfig.mode,   // "none" | "docker" | "bwrap" | "macOS-sandbox"
    workdir: agentDir,
    // ...
  };
}
```

沙盒支持 Docker、Linux bubblewrap、macOS Sandbox 等多种隔离方案。

---

## 子 Agent（Subagent）支持

OpenClaw 支持 Agent 嵌套执行（即 Agent 派生子 Agent）：

```typescript
// 文件路径：src/agents/embedded-agent-runner/run/attempt.ts
import {
  buildActiveSubagentSystemPromptAddition,
} from "../../subagent-active-context.js";

import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../../subagent-capabilities.js";
```

子 Agent 会话使用独立的 `sessionKey`，通过 `isSubagentSessionKey()` 区分。父 Agent 的活跃上下文会注入到子 Agent 的系统 Prompt 中，实现上下文传递。

---

## 心跳机制（Heartbeat）

Agent 支持后台心跳运行，在无用户输入时执行定期任务：

```typescript
// 文件路径：src/agents/embedded-agent-runner/run/attempt.ts
import { resolveHeartbeatSummaryForAgent } from "../../../infra/heartbeat-summary.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../../heartbeat-system-prompt.js";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
```

心跳运行与普通用户触发的运行共享相同的 attempt.ts 执行路径，但通过 `isHeartbeat` 标志区分处理逻辑。

---

## 小结

1. `attempt.ts`（5,377 行）是整个 Agent 引擎的核心，以"总装车间"模式编排 70+ 个子系统
2. 执行流程分 7 个阶段：准备 → Prompt 组装 → 上下文装配 → 工具注册 → LLM 调用 → 工具循环 → 持久化
3. 上下文引擎是可插拔的接口，默认按 token 预算截断，插件可实现向量检索等高级策略
4. 工具来源有 4 类：内置、插件、MCP、Skills（客户端）；启动时做冲突检查
5. 子 Agent 嵌套和心跳机制复用同一执行路径，通过标志位区分

## 延伸阅读

- [第 5 章：插件系统深解](05-plugin-system.html)
- [第 6 章：多 LLM 提供商抽象](06-llm-providers.html)
- [第 7 章：Skills 系统](07-skills.html)
- [第 9 章：会话与上下文管理](09-session-context.html)
