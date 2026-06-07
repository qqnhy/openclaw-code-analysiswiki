# Chapter 03 — LLM Provider 抽象层

> **核心文件**：  
> - `packages/llm-core/src/types.ts` — 统一类型定义  
> - `packages/llm-runtime/src/stream.ts` — StreamFn 实现  
> - `src/llm/api-registry.ts` — Provider 注册表  
> - `extensions/anthropic/ · openai/ · google/ · bedrock/ ...` — Provider Adapters

---

## 设计动机

OpenClaw 支持 100+ LLM Provider，但每个 Provider 的 API 格式、认证方式、流式协议都不同（OpenAI 用 SSE，Anthropic 用 SSE，Bedrock 用 SDK，Google 用 REST）。核心挑战：**如何让 AgentLoop 完全不关心具体 Provider，同时支持每个 Provider 的特殊能力（思考模式、函数调用格式差异）**。

### Pain Point

1. 各 Provider 的流式响应格式不统一（SSE delta 格式各异）
2. Tool calling 的 JSON Schema 格式各 Provider 不同
3. Token 计费、缓存（Prompt Cache）策略差异
4. 认证方式多样（API Key / OAuth Token / AWS SigV4）
5. 速率限制和重试策略需要统一处理

---

## Provider 架构总览

```mermaid
classDiagram
    class StreamFn {
        <<type alias>>
        +(model: Model, context: Context, options: SimpleStreamOptions) AssistantMessageEventStream
    }

    class AgentLoopConfig {
        +model: Model
        +apiKey: string
        +getApiKey(provider): Promise~string~
        +streamFn: StreamFn
    }

    class Model {
        +id: string
        +name: string
        +api: Api
        +provider: string
        +baseUrl: string
        +contextWindow: number
        +maxTokens: number
        +reasoning: boolean
        +cost: ModelCost
    }

    class KnownApi {
        <<enum>>
        openai-completions
        openai-responses
        openai-chatgpt-responses
        azure-openai-responses
        anthropic-messages
        bedrock-converse-stream
        google-generative-ai
        google-vertex
        mistral-conversations
    }

    class Context {
        +systemPrompt: string
        +messages: Message[]
        +tools: Tool[]
    }

    class AssistantMessageEventStream {
        <<AsyncIterable>>
        +start: partial AssistantMessage
        +text_delta: string
        +toolcall_delta: partial ToolCall
        +thinking_delta: string
        +done/error
    }

    StreamFn --> Model : uses
    StreamFn --> Context : uses
    StreamFn --> AssistantMessageEventStream : returns
    AgentLoopConfig --> StreamFn : invokes
    Model --> KnownApi : api: Api
```

---

## 支持的 Provider 及特殊处理

### 内置 API 族

| API ID | Provider | 特殊处理 |
|---|---|---|
| `openai-completions` | OpenAI (Chat Completions) | Legacy format, `stream=true` |
| `openai-responses` | OpenAI (Responses API) | 新格式，支持背景任务 |
| `openai-chatgpt-responses` | ChatGPT (OAuth) | OAuth token 刷新 |
| `azure-openai-responses` | Azure OpenAI | SigV4 / Azure AD 认证 |
| `anthropic-messages` | Anthropic Claude | `x-api-key` 头，thinking blocks |
| `bedrock-converse-stream` | AWS Bedrock | AWS SDK SigV4，不支持 HTTP 头注入 |
| `google-generative-ai` | Google AI Studio | REST + SSE，多模态原生 |
| `google-vertex` | Google Vertex AI | Service Account 认证 |
| `mistral-conversations` | Mistral | Conversations API 格式 |

### Extension 层 Provider（100+）

位于 `extensions/` 下，通过 `openclaw.plugin.json` 声明，动态加载：

- **OpenAI Compatible**：deepseek、groq、mistral、together、fireworks、novita、cerebras、vllm、lmstudio、sglang、ollama...
- **Cloud Provider**：alibaba（通义千问）、qianfan（文心）、volcengine（豆包）、moonshot（月之暗面）、minimax...
- **特殊路由**：openrouter（多模型路由）、litellm（统一代理）、cloudflare-ai-gateway...

---

## Adapter Pattern（流式统一）

```mermaid
sequenceDiagram
    participant Loop as AgentLoop
    participant SF as StreamFn (llm-runtime)
    participant Reg as API Registry
    participant Adapt as Provider Adapter
    participant API as Provider API

    Loop->>SF: streamFn(model, context, options)
    SF->>Reg: 根据 model.api 查找 Adapter
    Reg-->>SF: Provider-specific StreamFn
    SF->>Adapt: 调用 Provider Adapter
    Adapt->>Adapt: 转换 Context → Provider Request格式
    Adapt->>API: HTTP POST / SDK 调用
    API-->>Adapt: SSE / WebSocket 流
    
    loop 流式解析
        Adapt->>Adapt: 解析 Provider delta → AssistantMessageEvent
        Adapt-->>SF: {type: "text_delta", partial: ...}
        SF-->>Loop: yield AssistantMessageEvent
    end
    
    Adapt->>Adapt: 汇总最终 AssistantMessage
    Adapt-->>SF: {type: "done"}
    SF-->>Loop: stream结束, result() → AssistantMessage
```

### 统一事件流格式

每个 Provider Adapter 必须将原始 API 响应转换为统一的 `AssistantMessageEvent`：

```typescript
// llm-core/src/types.ts（核心事件类型）
type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; partial: AssistantMessage }
  | { type: "text_delta"; delta: string; partial: AssistantMessage }
  | { type: "text_end"; partial: AssistantMessage }
  | { type: "thinking_start"; partial: AssistantMessage }
  | { type: "thinking_delta"; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; partial: AssistantMessage }
  | { type: "toolcall_start"; partial: AssistantMessage }
  | { type: "toolcall_delta"; partial: AssistantMessage }
  | { type: "toolcall_end"; partial: AssistantMessage }
  | { type: "done" }
  | { type: "error"; error: unknown };
```

---

## 流式输出实现

### SSE（Server-Sent Events）

OpenAI、Anthropic、大多数 Provider 使用 SSE：

```typescript
// 典型 SSE 解析（extensions/openai/...）
for await (const chunk of response.body) {
  const lines = chunk.toString().split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));
      yield transformDelta(data);  // → AssistantMessageEvent
    }
  }
}
```

### WebSocket

部分 Provider（如 OpenAI Realtime API）使用 WebSocket，通过 `transport: "websocket"` 选项选择：

```typescript
// llm-core/types.ts
type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
```

### Bedrock SDK

AWS Bedrock 通过 SDK 调用，不支持直接 HTTP headers：

```typescript
// extensions/amazon-bedrock/...
const client = new BedrockRuntimeClient({ region, credentials });
const response = await client.send(new ConverseStreamCommand(input));
for await (const chunk of response.stream) { ... }
```

---

## 多模型路由与切换

### 运行时模型选择

```typescript
// agent-loop.ts:296-309 — prepareNextTurn 返回值
const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
if (nextTurnSnapshot) {
  // 更新 model（当前轮完成后生效）
  config = Object.assign({}, config, {
    model: nextTurnSnapshot.model ?? config.model,
    reasoning: nextTurnSnapshot.thinkingLevel === "off"
      ? undefined
      : nextTurnSnapshot.thinkingLevel,
  });
}
```

**关键设计**：模型切换在 **turn 边界**生效（当前 turn 完成后），避免中途切换导致 API 格式不匹配。

### Model 元数据

```typescript
// llm-core/types.ts::Model
interface Model {
  id: string;          // 模型 ID（如 "claude-opus-4-5"）
  name: string;        // 显示名称
  api: Api;            // 使用哪个 API 格式（如 "anthropic-messages"）
  provider: string;    // Provider ID（如 "anthropic"）
  baseUrl: string;     // API 基础 URL
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;  // 是否支持思考模式
  cost: { input: number; output: number; ... };
}
```

Model 的 `api` 字段决定使用哪个 Adapter，`provider` 字段用于认证和路由。

---

## Failover 设计

OpenClaw 的 Failover 通过两个机制实现：

### 1. Provider-Level 重试

```typescript
// llm-core/types.ts::StreamOptions
interface StreamOptions {
  maxRetries?: number;          // SDK 级别重试次数（默认 2）
  maxRetryDelayMs?: number;     // 最大重试等待时间（默认 60s）
}
```

当 Provider 返回 429（Rate Limit）或 5xx，SDK 自动重试。`maxRetryDelayMs` 限制最大等待时间，超过则抛出错误，让上层决策。

### 2. `prepareNextTurn` Failover

在 turn 级别实现 Failover（Primary → Fallback）：

```typescript
prepareNextTurn: async ({ message }) => {
  if (message.stopReason === "error") {
    return { model: fallbackModel };  // 切换到备用模型
  }
  return undefined;
}
```

### 3. `getApiKey` 动态令牌刷新

```typescript
// types.ts:195 — getApiKey
getApiKey?: (provider: string) => Promise<string | undefined>;

// 在 agent-loop.ts:373 每次 LLM 调用时刷新
const resolvedApiKey = await config.getApiKey?.(config.model.provider) || config.apiKey;
```

用于处理 OAuth 短期 token（如 GitHub Copilot），每次调用前刷新。

---

## API Registry 机制

```typescript
// src/llm/api-registry.ts — 动态 API 注册
const registry = new ApiRegistry();
registry.register("openai-completions", openaiCompletionsStreamFn);
registry.register("anthropic-messages", anthropicMessagesStreamFn);
// ... Extension 安装时追加注册

// 查找过程
function resolveStreamFn(api: Api): StreamFn {
  return registry.get(api) ?? defaultStreamFn;
}
```

Extension 在加载时向 Registry 注册自己的 StreamFn，实现运行时 Provider 扩展。

---

## 与四大框架对比

| 维度 | **OpenClaw** | **Claude Code** | **OpenAI Codex** | **OpenHands** | **Archon** |
|---|---|---|---|---|---|
| **抽象方式** | StreamFn 类型别名 + Extension Registry | 单一 SDK（@anthropic-ai/sdk） | 单一 SDK（openai）| LiteLLM 代理层 | LangChain ChatModel |
| **Provider 数量** | 100+（Extension 生态） | 1（Claude） | 1（OpenAI） | 70+（LiteLLM） | LangChain 支持的所有 |
| **流式协议** | SSE / WebSocket / SDK 统一为事件流 | SSE | SSE | SSE（LiteLLM） | LangChain 流式 |
| **Tool Schema** | TypeBox → 各 Provider 格式 | Anthropic tool_use 格式 | OpenAI function_call 格式 | LiteLLM 统一转换 | Pydantic / JSON Schema |
| **认证** | 动态 getApiKey（OAuth 支持） | Anthropic API Key | OpenAI API Key | LiteLLM 配置 | 各 Provider API Key |
| **Failover** | prepareNextTurn 切换模型 | 无 | 无 | LiteLLM fallback | LangChain fallback |
| **Thinking 模式** | ThinkingLevel enum + token budget | 无 | 无 | 无 | 无 |
| **Cache** | CacheRetention + sessionId（prompt cache） | 无 | 无 | 无 | 无 |

---

## 扩展点

1. **添加新 Provider**：在 `extensions/` 创建新目录，实现 `StreamFn`，在 `openclaw.plugin.json` 声明，系统自动加载。
2. **自定义 API 格式**：通过 `onPayload` 钩子拦截并修改发送给 Provider 的 raw payload（`types.ts::StreamOptions.onPayload`）。
3. **响应拦截**：通过 `onResponse` 钩子检查 HTTP 响应头（如 `x-ratelimit-remaining`）（`types.ts::StreamOptions.onResponse`）。
4. **Provider 路由**：在 `getApiKey` 中根据负载情况返回不同 API Key（多账号轮换）。
5. **自定义 Transport**：实现 `Transport = "websocket"` 变体适配 WebSocket-only Provider。

---

## 企业实践建议

1. **API Key 轮换**：在 `getApiKey` 中实现多 API Key 轮换，绕过单账号速率限制。
2. **成本监控**：在 `onResponse` 中解析响应头的 token 用量，上报到成本监控系统。
3. **Provider SLA 监控**：监控 `message.usage`（每次 LLM 调用后记录），计算 P99 延迟和成功率。
4. **私有化部署**：对于 vLLM/SGLang 私有化模型，使用对应 Extension 并配置 `baseUrl` 指向内网地址。
5. **混合策略**：敏感任务使用私有化模型（不出数据），普通任务使用云端模型（低成本）。

---

## 面试题

**Q1：OpenClaw 如何在不修改 Core 代码的情况下支持新的 LLM Provider？**

> **参考答案**：通过 Extension 系统。每个 Provider 实现一个符合 `StreamFn` 类型签名的函数，在 `openclaw.plugin.json` 中声明，安装后系统通过 API Registry 动态加载。Core 层的 `resolveStreamFn` 通过 `model.api` 查找对应的 StreamFn，完全解耦。

**Q2：为什么流式事件要有 `partial` 字段而非只有 `delta`？**

> **参考答案**：`delta` 是增量文本，`partial` 是当前完整状态。UI 层可以直接使用 `partial` 渲染当前内容，而不需要自行累加 delta。对于工具调用参数（JSON 字符串的 delta），`partial` 包含当前已解析的部分 JSON，方便调试和实时显示。Core 层总是维护最新的 `partial`（`agent-loop.ts:407`）。

**Q3：`maxRetryDelayMs` 的设计意图是什么？**

> **参考答案**：当 Provider 返回 429 并要求等待很长时间（如 60 分钟），如果无限等待会阻塞用户。`maxRetryDelayMs` 设置上限（默认 60 秒），超过时立刻以错误形式返回，让上层决策（通知用户、降级到其他 Provider、取消任务）。这是"快速失败"原则在重试场景的应用。
