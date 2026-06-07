# 第 6 章：多 LLM 提供商抽象

> **核心结论**：`openai-transport-stream.ts`（4,313 行）是 OpenClaw 的 LLM 传输核心，以 OpenAI 兼容格式为基础，统一适配 8 个提供商的 Chat Completions / Responses API / Azure 变体，并通过统一的 `AssistantMessage` 事件流屏蔽所有提供商差异。

---

## 支持的 LLM 提供商

| 提供商 | 接口类型 | 传输文件 | 特殊处理 |
|---|---|---|---|
| Anthropic | 原生 SDK | `anthropic.ts` | 思考 Token、长缓存 |
| OpenAI | Chat Completions | `openai-completions.ts` | GPT-5.5 严格工具 Schema |
| OpenAI | Responses API | `openai-responses.ts` | Reasoning Replay |
| Azure OpenAI | Azure Deployments | `azure-openai-responses.ts` | 部署名映射 |
| Google AI | Gemini API | `google.ts` | Gemma4 模型过滤 |
| Google Vertex | Vertex AI | `google-vertex.ts` | GCP 凭证 |
| Cloudflare | Workers AI | `cloudflare.ts` | OpenAI 兼容 |
| GitHub Copilot | OpenAI 兼容 | `openai-transport-stream.ts` | 动态认证头 |

---

## openai-transport-stream.ts 的关键常量

这些常量揭示了实现的复杂细节：

```typescript
// src/agents/openai-transport-stream.ts
const DEFAULT_AZURE_OPENAI_API_VERSION = "preview";
const OPENAI_CODEX_RESPONSES_EMPTY_INPUT_TEXT = " ";   // Codex 不接受空输入，用空格代替
const OPENAI_CODEX_RESPONSES_DEFAULT_INSTRUCTIONS = "Follow the user request.";
const GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP = "skip_thought_signature_validator";
const AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS = 30_000; // Azure 首个 SSE 事件超时 30s
const MODEL_STREAM_COOPERATIVE_YIELD_INTERVAL_MS = 12;  // 协作式让出 CPU 的间隔
const MODEL_STREAM_COOPERATIVE_YIELD_MAX_EVENTS = 64;   // 连续处理事件上限后让出
const MAX_OPENAI_STRICT_TOOL_DOWNGRADE_DIAGNOSTIC_KEYS = 256;
const OPENAI_CODEX_RESPONSES_PROVIDERS = new Set(["openai"]);

// Reasoning Replay 的元数据结构
type OpenAIResponsesReasoningReplayMetadata = {
  v: 1;                  // 版本号（用于向后兼容）
  source: "openai-responses";
  provider: string;
  api: Api;
  model: string;
  baseUrlHash?: string;   // 哈希而非明文（防止泄露 base URL）
  sessionHash?: string;
  authProfileHash?: string;
};
```

**协作式让出（Cooperative Yield）的意义**：Node.js 是单线程的，流式 LLM 响应可能每秒发出数百个事件。如果不主动让出 CPU，其他定时器（如 heartbeat、WebSocket ping）会被饿死。每处理 64 个事件后主动 `await`，允许事件循环处理其他待处理的回调。

---

## Reasoning Replay 机制

OpenAI Responses API 支持"推理重放"——将模型的思考过程保存下来，后续轮次可以重新利用，避免重新推理：

```typescript
// Reasoning Replay 的 metadata 保存到 Session
type ReplayableResponseReasoningItem = Omit<ResponseReasoningItem, "id"> & {
  id?: string;
  [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]?: OpenAIResponsesReasoningReplayMetadata;
};

// 重放时的 Session ID 长度限制（防止过长的 ID 污染 Prompt）
const OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH = 64;
```

**实际意义**：复杂推理问题（如数学证明、代码架构分析）中，模型的思考过程本身包含有价值的中间结论。将这个推理过程保存并在下一轮注入，可以让模型在已有推理基础上继续，而不是每次从零开始推理，节省大量 token 和时间。

---

## OpenAI Strict Tool Schema 降级机制

当 OpenAI 开启 `strict: true` 模式时，工具 Schema 必须满足严格约束（不支持 `oneOf`、`anyOf` 等）。但某些插件提供的工具 Schema 无法满足严格模式：

```typescript
// src/agents/openai-transport-stream.ts
const MAX_OPENAI_STRICT_TOOL_DOWNGRADE_DIAGNOSTIC_KEYS = 256;
const loggedOpenAIStrictToolDowngradeDiagnosticKeys = new Set<string>();

// 自动降级：检测到严格 Schema 问题时，降级为非严格模式
function resolveOpenAIStrictToolFlagForInventory(
  tools: FunctionTool[],
): { strict: boolean; diagnostics: StrictToolDiagnostic[] } {
  const diagnostics = findOpenAIStrictToolSchemaDiagnostics(tools);
  if (diagnostics.length === 0) { return { strict: true, diagnostics: [] }; }
  // 有问题时自动降级（并记录诊断，日志去重避免刷屏）
  if (diagnostics.length <= MAX_OPENAI_STRICT_TOOL_DOWNGRADE_DIAGNOSTIC_KEYS) {
    logDiagnosticsOnce(diagnostics);
  }
  return { strict: false, diagnostics };
}
```

**为什么需要这个机制？** 保证向后兼容性——旧版插件提供的工具 Schema 可能不满足 strict 模式，如果直接报错，用户无法使用这些插件。自动降级 + 记录诊断是更好的折衷：功能不中断，同时告知开发者需要更新 Schema。

---

## Copilot 动态认证头

GitHub Copilot 的 API 认证机制比标准 OpenAI API 复杂——需要根据请求内容（是否有视觉输入）动态构建认证头：

```typescript
// src/agents/copilot-dynamic-headers.ts
export function buildCopilotDynamicHeaders(params: {
  hasVisionInput: boolean;
  authToken: string;
  requestId: string;
}): Record<string, string> {
  return {
    "Authorization": `Bearer ${params.authToken}`,
    "Copilot-Integration-Id": "vscode-chat",
    "X-Github-Api-Version": "2024-02-15",
    // 视觉输入需要额外的能力声明头
    ...(params.hasVisionInput ? { "X-Copilot-Feature-Flags": "vision" } : {}),
  };
}

export function hasCopilotVisionInput(messages: unknown[]): boolean {
  // 检查 messages 中是否包含 image 类型的内容
  return messages.some(/* 递归检查 content 数组 */);
}
```

---

## DeepSeek 文本过滤器

针对 DeepSeek 模型的特殊处理：

```typescript
// src/agents/deepseek-text-filter.ts
// DeepSeek 模型会在输出中插入特殊的思考标记 <think>...</think>
// 该过滤器用于在特定上下文下剥离这些标记，只保留最终回答
export function createDeepSeekTextFilter(opts: {
  stripThinkingTags: boolean;
}): (text: string) => string;
```

---

## 统一事件流：StreamFn 类型

所有 LLM Provider 最终都适配成同一个 `StreamFn` 类型：

```typescript
// src/agents/runtime/index.ts（推断）
export type StreamFn = (params: {
  messages: AgentMessage[];
  systemPrompt: string;
  tools: ToolDefinition[];
  maxTokens: number;
  thinkingLevel?: AgentRuntimeThinkLevel;
  abortSignal?: AbortSignal;
}) => AsyncIterable<AssistantEvent>;

// 事件类型（统一格式，屏蔽各 Provider 差异）
export type AssistantEvent =
  | { type: "text_delta";   delta: string }
  | { type: "thinking";     thinking: string }      // 模型思考过程
  | { type: "tool_use";     id: string; name: string; input: unknown }
  | { type: "end";          stopReason: StopReason; usage: TokenUsage }
  | { type: "error";        error: TransportError };
```

---

## Provider 路由与配置

```typescript
// src/agents/provider-transport-stream.ts（精简）
// 根据 model 字符串和 config 选择对应的 Provider 传输函数
export function registerProviderStreamForModel(params: {
  model: string;          // "claude-opus-4" | "gpt-4.1" | "gemini-2.5-pro" ...
  config: OpenClawConfig;
  providerHandle: ProviderRuntimePluginHandle;
  transport: AgentRuntimeTransport;
}): StreamFn {
  const providerFamily = resolveProviderFamily(params.model);
  // 按 Provider 家族选择传输实现
  switch (providerFamily) {
    case "anthropic":
      return createAnthropicStream(params);
    case "openai":
    case "azure-openai":
    case "github-copilot":
      return createOpenAIStream(params);   // 都走 openai-transport-stream.ts
    case "google":
    case "google-vertex":
      return createGoogleStream(params);
    default:
      return createOpenAICompatStream(params); // 第三方兼容 Provider
  }
}
```

---

## 工具 Schema 处理：provider 差异的典型案例

不同 Provider 对工具 Schema 的支持有细微差异：

```typescript
// src/agents/openai-tool-schema.ts
// OpenAI Strict 模式要求：
// 1. 不支持 anyOf / oneOf / allOf
// 2. 所有对象属性必须在 "required" 数组中
// 3. 不支持额外属性（additionalProperties: false）

// Anthropic 的限制：
// 不支持 enum 类型的 anyOf 包装（需要展平为 enum）

// OpenClaw 的处理策略：
// 检测 → 自动归一化 → 不可归一化时降级（对 OpenAI 关闭 strict）
export function normalizeOpenAIStrictToolParameters(
  schema: JsonSchemaObject,
): JsonSchemaObject {
  // 递归展平不兼容的 Schema 结构
}
```

---

## 小结

1. **openai-transport-stream.ts 是核心**（4313 行）：统一处理 OpenAI 兼容 API 的所有变体（Chat Completions / Responses / Azure），其他 Provider 各自有更短的适配文件
2. **协作式 CPU 让出**：每 64 个流式事件后主动让出，防止 LLM 流饿死其他 Node.js 定时器
3. **Reasoning Replay**：将模型的推理过程序列化存储，后续轮次重新利用，节省 token
4. **Strict Tool Schema 自动降级**：遇到不兼容的工具 Schema 时自动关闭 strict 模式，保证功能不中断
5. **统一 StreamFn 接口**：所有 Provider 最终统一成同一个 `AsyncIterable<AssistantEvent>` 格式，attempt.ts 完全不感知 Provider 差异

## 延伸阅读

- [第 4 章：Agent 执行引擎](04-agent-engine.html)
- [第 5 章：插件系统深解](05-plugin-system.html)
