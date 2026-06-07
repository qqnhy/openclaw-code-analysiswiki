# 项目概览

## 什么是 OpenClaw？

OpenClaw 是一个开源的**个人 AI 助手网关**（Personal AI Assistant Gateway），核心理念是：AI 助手运行在你自己的设备上，通过你已经在用的即时通讯频道与你对话。

官方口号：**"EXFOLIATE! EXFOLIATE!"**

项目定位用一句话概括：**你的 AI，在你的频道，按你的规则运行。**

---

## 支持的频道

| 类别 | 频道 |
|---|---|
| 主流社交 | WhatsApp、Telegram、Discord、Slack、LINE |
| 企业协作 | Microsoft Teams、Google Chat、Mattermost、Feishu（飞书） |
| 开放/去中心化 | Matrix、Signal、IRC、Nostr |
| 中国平台 | WeChat、QQ、Zalo、Zalo Personal |
| 自建/专用 | iMessage、Synology Chat、Nextcloud Talk、Tlon、Twitch |
| 内置 | WebChat（内置 Web 界面） |

---

## 源码规模（截至 2026-06-07）

| 指标 | 数值 |
|---|---|
| TypeScript 文件总数 | 8,781 个 |
| 源码文件（非测试） | 5,156 个 |
| 测试文件 | 3,625 个 |
| 非测试源码行数 | ~228,000 行 |
| packages 子包 | 22 个 |
| 最大单文件 | `attempt.ts`（5,377 行） |
| 版本号 | 2026.6.2 |

---

## 技术栈

- **运行时**：Node.js 22.19+（推荐 Node 24）
- **包管理**：pnpm workspace
- **主语言**：TypeScript（ESM）
- **构建工具**：tsdown（基于 esbuild）
- **测试框架**：Vitest
- **通信层**：WebSocket + HTTP（Express 风格）
- **CLI 框架**：Commander.js

---

## 本站分析方法

本站所有分析均基于以下原则：

1. **源码为第一手证据**：每个结论都附有文件路径 + 关键代码片段
2. **截至时间明确**：所有分析基于 **2026-06-07** 的源码快照，后续版本可能有变化
3. **分层递进**：从整体架构到具体实现，从高层设计到底层细节
4. **仅供学习**：本站内容用于技术研究与学习，不用于其他目的

---

## 阅读建议

**初学者路线**（了解整体）：
第 1 章 → 第 2 章 → 第 3 章 → 第 7 章

**开发者路线**（理解扩展机制）：
第 5 章 → 第 6 章 → 第 7 章 → 第 10 章

**安全研究路线**：
第 8 章 → 第 1 章 → 第 4 章

**全量阅读**：按章节顺序 1→10
