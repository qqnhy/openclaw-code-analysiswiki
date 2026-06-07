# OpenClaw 架构级源码分析

> **源码截止日期**：2026-06-07  
> **分析视角**：Agent Framework Architect / AI Infrastructure Engineer  
> **目标读者**：Agent 开发工程师 / AI 平台研发 / Java·Go 后端 / LLM Application Engineer

---

## 项目简介

OpenClaw 是一个**个人 AI 助手框架**（Personal AI Assistant Framework），运行在用户自己的设备上，通过 20+ 消息通道（WhatsApp、Telegram、Slack、Discord 等）与用户交互。

**不是** API 代理 / 聊天机器人服务 / 云端 AI 服务  
**是** 本地运行的、多通道的、有持久记忆的个人 AI 系统

---

## 章节目录

| 章节 | 主题 | 核心文件 |
|---|---|---|
| [00 — 架构全景](./00-architecture-overview.md) | 总体设计、模块关系、完整执行链路 | README · AGENTS.md |
| [01 — Agent Runtime 主循环](./01-agent-runtime-main-loop.md) | 双层 while 循环、工具并发执行、事件流 | `packages/agent-core/src/agent-loop.ts` |
| [02 — Context & Prompt 组装](./02-context-prompt-assembly.md) | Prompt Pipeline、消息转换、上下文压缩 | `packages/agent-core/src/harness/messages.ts` |
| [03 — LLM Provider 抽象](./03-llm-provider-abstraction.md) | StreamFn 统一接口、100+ Provider 扩展、Failover | `packages/llm-core/src/types.ts` |
| [04 — 工具注册与调用](./04-tool-registry-and-calling.md) | TypeBox Schema、并行/串行执行、MCP 集成 | `packages/agent-core/src/types.ts:437` |
| [05 — 记忆系统](./05-memory-system.md) | sqlite-vec 向量搜索、BM25、Dreaming 整合 | `extensions/memory-core/` |
| [06 — 技能系统](./06-skill-system.md) | Markdown frontmatter、ClawHub 市场、Skill 生命周期 | `src/skills/` |
| [07 — Trajectory & 事件追踪](./07-trajectory-event-trace.md) | JSONL 轨迹、OTEL 集成、Prometheus | `src/trajectory/` |
| [08 — Reflection & Learning](./08-reflection-learning-loop.md) | 现有机制分析、Dreaming 学习回路、补充方案 | `extensions/memory-core/src/dreaming.ts` |
| [09 — Eval & Feedback](./09-eval-feedback.md) | QA 工具、LLM Judge 设计、离线 Eval Pipeline | `extensions/qa-lab/` |
| [10 — 错误处理与降级](./10-error-retry-fallback.md) | 错误分类、重试策略、熔断器设计 | `packages/agent-core/src/harness/agent-harness.ts` |
| [11 — 阅读路线图](./11-reading-roadmap.md) | 新人/高级/架构师阅读顺序、Top 20 必看文件 | — |

---

## 架构一览

```
用户消息 (Channel/CLI)
    ↓
CoreAgentHarness (agent-harness.ts)
  ├── createTurnState() → systemPrompt + tools + memory
  └── runAgentLoop() → AgentLoop (agent-loop.ts)
        ├── steering messages 注入
        ├── streamAssistantResponse() → LLM Provider (100+ Extensions)
        ├── executeToolCalls() → AgentTool.execute() [parallel/sequential]
        └── prepareNextTurn() → Session 持久化 + Context 刷新

持久化层：
  ├── Session JSONL (~/.openclaw/sessions/)
  ├── Memory SQLite + sqlite-vec (~/.openclaw/memory/)
  └── Trajectory JSONL (~/.openclaw/trajectory/)
```

---

## 与同类框架核心差异

| 维度 | OpenClaw | Claude Code | OpenHands | Archon |
|---|---|---|---|---|
| 定位 | 个人 AI 助手 | 编码助手 | 软件开发 Agent | Meta-Agent 构建器 |
| 通道 | 20+ 消息通道 | CLI 终端 | Web UI | API |
| 记忆 | 本地向量 DB + Dreaming | CLAUDE.md 文件 | 无 | 可选向量 DB |
| 工具并发 | ✅ 原生 parallel | ❌ 串行 | ❌ 串行 | ❌ 串行 |
| Skill | ✅ Markdown frontmatter | Slash commands | ❌ | ❌ |

---

## 核心设计原则（来自 AGENTS.md）

1. **Core 保持插件无关**：`packages/agent-core` 不硬编码任何 Provider ID、通道名或 Skill
2. **扩展即一切**：所有具体能力通过 `extensions/` 插件声明和注册
3. **工具失败 = 信息而非错误**：工具执行失败转换为 `isError: true` 的结果，让 LLM 决策
4. **AgentLoopConfig 10 个扩展点**：所有平台差异化行为通过回调注入，不修改核心

---

## 快速定位关键源码

```bash
# 主循环
packages/agent-core/src/agent-loop.ts:213   # runLoop()

# Agent 公共 API
packages/agent-core/src/agent.ts:369         # prompt()

# 工具接口
packages/agent-core/src/types.ts:437         # AgentTool

# LLM 抽象
packages/llm-core/src/types.ts               # StreamFn, Model, KnownApi

# 记忆检索
extensions/memory-core/src/memory/manager-search.ts  # hybridSearch()

# Dreaming
extensions/memory-core/src/dreaming.ts       # runDreaming()

# Skill 解析
src/skills/loading/frontmatter.ts            # parseFrontmatter()

# 轨迹类型
src/trajectory/types.ts                      # TrajectoryEvent
```
