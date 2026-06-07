# 第 6 章：多 LLM 提供商抽象

## 本章信息

| | |
|--|--|
| **本章目标** | 理解 OpenClaw 如何统一适配 8 个 LLM 提供商，以及 OpenAI 兼容流式传输的核心实现 |
| **适合读者** | 对多模型接入、流式响应处理感兴趣的开发者 |
| **前置知识** | 第 4 章、第 5 章 |
| **核心结论** | OpenClaw 以 OpenAI Transport Stream 为基础适配层，通过 4313 行的流式传输核心支持 Chat Completions、Responses API、Azure 变体等多种接口形式，并用统一的 AssistantMessage 事件流屏蔽各提供商差异 |

---

## 核心结论

**OpenClaw 的 LLM 层以 `openai-transport-stream.ts`（4,313 行）为核心，实现了对 OpenAI 兼容 API 的完整流式传输处理，包括工具调用、推理（Reasoning）、缓存等高级特性，并通过统一的 `AssistantMessage` 事件流对上层屏蔽各提供商差异。**

---

## 支持的 LLM 提供商

```
src/llm/providers/
├── anthropic.ts               # Anthropic (Claude)
├── openai-completions.ts      # OpenAI Chat Completions
├── openai-responses.ts        # OpenAI Responses API
├── openai-chatgpt-responses.ts# ChatGPT OAuth 接入
├── azure-openai-responses.ts  # Azure OpenAI
├── google.ts                  # Google AI (Gemini)
├── google-vertex.ts           # Google Vertex AI
├── mistral.ts                 # Mistral AI
├── cloudflare.ts              # Cloudflare AI
├── github-copilot-headers.ts  # GitHub Copilot 认证头
└── register-builtins.ts       # 内置提供商注册入口
```

| 提供商 | 接口类型 | 认证方式 |
|---|---|---|
| Anthropic | 原生 SDK | API Key / OAuth |
| OpenAI | Chat Completions + Responses | API Key |
| Azure OpenAI | Azure Deployments | API Key + Endpoint |
| Google AI | Gemini API | API Key |
| Google Vertex | Vertex AI | GCP 凭证 |
| Mistral | OpenAI 兼容 | API Key |
| Cloudflare | Workers AI | API Token |
| GitHub Copilot | OpenAI 兼容 + 特殊头 | GitHub OAuth |

---

## 统一 LLM 类型层

`src/llm/types.ts` 定义了 OpenClaw 内部的 LLM 抽象类型：

```typescript
// 文件路径：src/llm/types.ts（推断结构）
export type AssistantMessage = {
  type: "assistant";
  content: AssistantContent[];
  usage?: TokenUsage;
};

export type AssistantContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "thinking"; thinking: string }
  | { type: "redacted_thinking" };

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

// Provider 流函数签名
export type Api = {
  stream: (params: StreamParams) => AsyncIterable<StreamEvent>;
};
```

---

## OpenAI Transport Stream 核心

`src/agents/openai-transport-stream.ts`（4,313 行）是整个 LLM 层的最核心文件，其文件头注释清楚地声明了职责：

```typescript
// 文件路径：src/agents/openai-transport-stream.ts
/**
 * OpenAI-compatible streaming transport.
 *
 * Handles Chat Completions, Responses, Azure variants, tool-call replay,
 * reasoning events, and provider-specific payload policy before converting
 * SDK streams into OpenClaw assistant events.
 */
import OpenAI, { AzureOpenAI } from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseOutputMessage,
  ResponseReasoningItem,
} from "openai/resources/responses/responses.js";
```

它同时处理了两套 OpenAI API 规范：

- **Chat Completions API**（旧版，`/v1/chat/completions`）
- **Responses API**（新版，`/v1/responses`）

### 流式事件转换

```typescript
// 文件路径：src/agents/openai-transport-stream.ts（推断结构）
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";

// 将 OpenAI SDK 的流事件转换为 OpenClaw 统一事件格式
export async function* createOpenAICompatStream(
  params: OpenAICompatStreamParams,
): AsyncGenerator<AssistantStreamEvent> {
  const stream = await openaiClient.chat.completions.create({
    stream: true,
    messages: params.messages,
    tools: params.tools,
    ...
  });

  for await (const chunk of stream) {
    // 处理文本 delta
    if (chunk.choices[0]?.delta?.content) {
      yield { type: "text_delta", text: chunk.choices[0].delta.content };
    }
    // 处理工具调用
    if (chunk.choices[0]?.delta?.tool_calls) {
      // 聚合工具调用 delta（OpenAI 的工具调用是分片的）
      yield* aggregateToolCallDeltas(chunk.choices[0].delta.tool_calls);
    }
    // 处理推理内容（reasoning tokens）
    if (chunk.choices[0]?.delta?.reasoning_content) {
      yield { type: "thinking", thinking: chunk.choices[0].delta.reasoning_content };
    }
  }
}
```

### 工具调用 JSON 修复

OpenClaw 内置了工具调用参数 JSON 修复逻辑，因为某些模型在流式传输中会产生不完整的 JSON：

```typescript
// 文件路径：src/packages/tool-call-repair/
// 当工具调用参数 JSON 解析失败时，尝试修复截断的 JSON
```

### Prompt 缓存支持

```typescript
// 文件路径：src/agents/openai-transport-stream.ts
import { clampOpenAIPromptCacheKey } from "../llm/providers/openai-prompt-cache.js";

// OpenAI 的 Prompt Cache 通过特殊的 cache_control 标记实现
// OpenClaw 追踪缓存命中情况并在日志中报告
```

---

## Anthropic 提供商

```typescript
// 文件路径：src/llm/providers/anthropic.ts
// Anthropic Claude 提供商使用原生 Anthropic SDK
// 支持：
// - Messages API（claude-3-5-sonnet 等）
// - Extended Thinking（claude-3-7-sonnet 等的推理模式）
// - Prompt Caching（claude-3-5-sonnet 原生缓存）
// - Vision（图像输入）
```

### 扩展思考（Extended Thinking）

```typescript
// 文件路径：src/llm/providers/anthropic.ts
// 当检测到 claude-3-7-* 等模型时，自动启用 thinking 参数
// 将 <thinking> 内容作为 AssistantContent.type = "thinking" 返回
```

---

## Google 提供商

```typescript
// 文件路径：src/llm/providers/google-shared.ts
// Google 提供商需要处理消息格式转换（Google 使用 "parts" 而非 "content"）
// 特殊处理：Gemma4 模型的工具调用格式不同
import { isGemma4ModelId } from "../../shared/google-models.js";
```

---

## 模型目录

```
src/model-catalog/
└── provider-index/
    # 维护每个提供商的模型列表、能力矩阵
    # 包含：context window、支持工具、vision、reasoning 等属性
```

---

## Provider 路由与模型选择

```typescript
// 文件路径：src/agents/model-selection.ts
export async function resolveDefaultModelForAgent(
  config: OpenClawConfig,
  agentConfig: AgentConfig,
): Promise<ResolvedModel> {
  // 1. 检查 agent 级别的模型覆盖
  // 2. 检查用户全局模型配置
  // 3. 使用提供商的默认模型
}
```

插件也可以通过 `beforeModelResolve` 钩子覆盖模型选择：

```typescript
// 文件路径：src/plugins/hook-types.ts
export type PluginHookBeforeModelResolveResult = {
  modelOverride?: string;     // 覆盖使用的模型 ID
  providerOverride?: string;  // 覆盖使用的提供商
};
```

---

## OpenAI 兼容 HTTP 接口

除了作为 Agent 使用 LLM，OpenClaw 的 Gateway 还对外暴露了 OpenAI 兼容的 HTTP 接口：

```typescript
// 文件路径：src/gateway/openai-http.ts
// GET /v1/models   — 列出可用模型
// POST /v1/chat/completions — OpenAI 兼容的聊天完成接口
// POST /v1/responses — OpenAI Responses API 兼容接口
```

这使得任何支持 OpenAI API 的客户端（如 Cherry Studio、Open WebUI）都可以直接连接到 OpenClaw Gateway。

---

## 模型价格缓存

```typescript
// 文件路径：src/gateway/model-pricing-cache.ts
// Gateway 维护一个模型价格缓存
// 用于在 Control UI 中显示每次对话的估算费用
export type ModelPricingCacheEntry = {
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cachedInputPricePerMillion?: number;
};
```

---

## 小结

1. OpenClaw 支持 8 个 LLM 提供商，通过 OpenAI 兼容层统一处理大多数提供商
2. `openai-transport-stream.ts`（4,313 行）是流式传输核心，处理 Chat Completions 和 Responses 两套 API
3. 统一的 `AssistantMessage` 事件流屏蔽了各提供商的格式差异
4. 内置工具调用 JSON 修复，解决部分模型流式输出的格式问题
5. Gateway 同时对外暴露 OpenAI 兼容接口，支持第三方客户端接入

## 延伸阅读

- [第 4 章：Agent 执行引擎](04-agent-engine.html)
- [第 9 章：会话与上下文管理](09-session-context.html)
