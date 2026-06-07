import { marked } from 'marked';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(__dirname, 'docs');
const DIST = path.join(__dirname, 'dist');

// ── Navigation structure ──────────────────────────────────────────────────
const NAV = [
  {
    label: '阅读指南',
    items: [
      { title: '项目概览', file: 'guide/overview' },
    ],
  },
  {
    label: '◆ 架构师深度解析',
    items: [
      { title: '第 1 章：项目定位与技术演进', file: 'chapters/arch/01-positioning' },
      { title: '第 2 章：整体架构设计', file: 'chapters/arch/02-architecture' },
      { title: '第 3 章：Agent Runtime 深度解析', file: 'chapters/arch/03-runtime' },
      { title: '第 4 章：Skill Architecture', file: 'chapters/arch/04-skill' },
      { title: '第 5 章：Tool Architecture', file: 'chapters/arch/05-tool' },
      { title: '第 6 章：Memory Architecture', file: 'chapters/arch/06-memory' },
      { title: '第 7 章：Multi-Agent Architecture', file: 'chapters/arch/07-multi-agent' },
      { title: '第 8 章：Gateway Architecture', file: 'chapters/arch/08-gateway' },
      { title: '第 9 章：Security Architecture', file: 'chapters/arch/09-security' },
      { title: '第 10 章：vs Claude Code 深度对比', file: 'chapters/arch/10-vs-claude-code' },
      { title: '第 11 章：vs Hermes Agent 深度对比', file: 'chapters/arch/11-vs-hermes' },
      { title: '第 12 章：企业级 Agent 平台设计', file: 'chapters/arch/12-enterprise-platform' },
      { title: '第 13 章：核心源码深度解析', file: 'chapters/arch/13-core-code' },
    ],
  },
  {
    label: '◇ 源码速查（基础版）',
    items: [
      { title: '第 1 章：项目概览与架构全景', file: 'chapters/01-architecture' },
      { title: '第 2 章：启动流程与 CLI 命令树', file: 'chapters/02-startup' },
      { title: '第 3 章：多通道系统', file: 'chapters/03-channels' },
      { title: '第 4 章：Agent 执行引擎', file: 'chapters/04-agent-engine' },
      { title: '第 5 章：插件系统深解', file: 'chapters/05-plugin-system' },
      { title: '第 6 章：多 LLM 提供商抽象', file: 'chapters/06-llm-providers' },
      { title: '第 7 章：Skills 系统', file: 'chapters/07-skills' },
      { title: '第 8 章：安全审计机制', file: 'chapters/08-security' },
      { title: '第 9 章：会话与上下文管理', file: 'chapters/09-session-context' },
      { title: '第 10 章：ACP、MCP 与语音', file: 'chapters/10-acp-mcp-voice' },
    ],
  },
];

// ── Custom marked renderer ────────────────────────────────────────────────
const renderer = new marked.Renderer();

renderer.code = function (code, lang) {
  if (lang === 'mermaid') {
    return `<div class="mermaid">${code}</div>\n`;
  }
  const escaped = String(code)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<pre><code class="language-${lang || ''}">${escaped}</code></pre>\n`;
};

marked.use({ renderer });

// ── Helpers ───────────────────────────────────────────────────────────────
function stripFrontmatter(md) {
  return md.replace(/^---[\s\S]*?---\n?/, '');
}

function extractTitle(md) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

function buildSidebar(currentFile, depth) {
  const root = '../'.repeat(depth);
  let html = `<div class="site-brand"><a href="${root}index.html">OpenClaw<br>深度解析</a></div>`;

  for (const group of NAV) {
    html += `<div class="nav-group"><div class="nav-group-label">${group.label}</div>`;
    for (const item of group.items) {
      const href = root + item.file + '.html';
      const active = currentFile === item.file ? ' active' : '';
      html += `<a href="${href}" class="nav-link${active}">${item.title}</a>`;
    }
    html += `</div>`;
  }
  return html;
}

function buildPage({ title, body, currentFile, depth, hasMermaid }) {
  const root = '../'.repeat(depth);
  const mermaidScripts = hasMermaid
    ? `<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script>mermaid.initialize({ startOnLoad: true, theme: 'neutral', fontFamily: 'Microsoft YaHei, PingFang SC, sans-serif' });</script>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - OpenClaw 深度解析</title>
  <link rel="stylesheet" href="${root}style.css">
</head>
<body>
  <div class="layout">
    <aside class="sidebar">${buildSidebar(currentFile, depth)}</aside>
    <main class="content">
      ${body}
      <div class="page-footer">
        <a href="${root}index.html">← 返回首页</a>
        &nbsp;·&nbsp;
        <a href="https://github.com/qqnhy/openclaw-code-analysiswiki" target="_blank">GitHub</a>
        &nbsp;·&nbsp;
        <span>© 2026 openclaw-code-analysis contributors</span>
      </div>
    </main>
  </div>
  ${mermaidScripts}
</body>
</html>`;
}

function processMarkdown(relFile) {
  const src = path.join(DOCS, relFile + '.md');
  if (!fs.existsSync(src)) {
    console.warn(`  [skip] ${relFile}.md not found`);
    return;
  }

  const raw = fs.readFileSync(src, 'utf8');
  const md = stripFrontmatter(raw);
  const title = extractTitle(md);
  const hasMermaid = md.includes('```mermaid');
  const body = marked.parse(md);
  const depth = relFile.split('/').length - 1;
  const html = buildPage({ title, body, currentFile: relFile, depth, hasMermaid });

  const out = path.join(DIST, relFile + '.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`  ✓ ${relFile}.html`);
}

// ── Homepage ──────────────────────────────────────────────────────────────
const HOME_SECTIONS = [
  {
    heading: '◆ 架构师深度解析（企业级视角）',
    cards: [
      { file: 'chapters/arch/01-positioning', label: '第 1 章：项目定位与技术演进', desc: 'Agent OS 演进路径，OpenClaw 在 Agent Runtime 到 Agent Platform 的定位' },
      { file: 'chapters/arch/02-architecture', label: '第 2 章：整体架构设计', desc: '请求生命周期、上下文生命周期、系统架构图与调用时序图' },
      { file: 'chapters/arch/03-runtime', label: '第 3 章：Agent Runtime 深度解析', desc: 'RuntimePlan 模式、Attempt 事务模型、与 LangGraph/AutoGen 的本质区别' },
      { file: 'chapters/arch/04-skill', label: '第 4 章：Skill Architecture', desc: 'Skill vs Prompt vs Tool vs Workflow，Skill 为何是 OpenClaw 的核心创新' },
      { file: 'chapters/arch/05-tool', label: '第 5 章：Tool Architecture', desc: '工具治理、权限模型、沙盒隔离，企业级 Tool Center 设计' },
      { file: 'chapters/arch/06-memory', label: '第 6 章：Memory Architecture', desc: '为何委托给插件，Context Engine 接口设计，企业 Memory Platform 方案' },
      { file: 'chapters/arch/07-multi-agent', label: '第 7 章：Multi-Agent Architecture', desc: 'ACP 协议、子 Agent 派生、任务委托，单 Agent 的瓶颈与演进' },
      { file: 'chapters/arch/08-gateway', label: '第 8 章：Gateway Architecture', desc: 'Gateway 为什么是 Agent OS 的内核，身份映射与消息路由设计' },
      { file: 'chapters/arch/09-security', label: '第 9 章：Security Architecture', desc: '攻击面分析、威胁模型、Prompt Injection 到 Tool Injection 防御' },
      { file: 'chapters/arch/10-vs-claude-code', label: '第 10 章：vs Claude Code 深度对比', desc: 'Runtime/Memory/Tool/Security/Enterprise Readiness 全维度对比矩阵' },
      { file: 'chapters/arch/11-vs-hermes', label: '第 11 章：vs Hermes Agent 深度对比', desc: '记忆优先 vs 能力优先，两种 Agent 哲学的本质差异与未来融合' },
      { file: 'chapters/arch/12-enterprise-platform', label: '第 12 章：企业级 Agent 平台设计', desc: '基于三者优点的下一代企业 Agent 平台完整架构设计' },
      { file: 'chapters/arch/13-core-code', label: '第 13 章：核心源码深度解析', desc: '20% 核心代码决定 80% 架构——最关键的模块、类、接口与流程' },
    ],
  },
  {
    heading: '◇ 源码速查（基础版）',
    cards: [
      { file: 'chapters/01-architecture', label: '第 1 章：项目概览与架构全景', desc: '7 层分层架构，Gateway 是控制平面，插件是扩展骨架' },
      { file: 'chapters/02-startup', label: '第 2 章：启动流程与 CLI 命令树', desc: 'openclaw.mjs 编译缓存 Respawn 机制，命令树懒加载' },
      { file: 'chapters/03-channels', label: '第 3 章：多通道系统', desc: '20+ 通道以绑定-路由-Turn 三层模型统一管理' },
      { file: 'chapters/04-agent-engine', label: '第 4 章：Agent 执行引擎', desc: 'attempt.ts（5,377 行）7 阶段执行流' },
      { file: 'chapters/05-plugin-system', label: '第 5 章：插件系统深解', desc: '40+ 生命周期钩子，manifest→安装→加载全流程' },
      { file: 'chapters/06-llm-providers', label: '第 6 章：多 LLM 提供商抽象', desc: 'openai-transport-stream.ts（4,313 行）统一 8 个提供商' },
      { file: 'chapters/07-skills', label: '第 7 章：Skills 系统', desc: 'Markdown 文件即 Skill，~ 路径压缩节省 400-600 tokens' },
      { file: 'chapters/08-security', label: '第 8 章：安全审计机制', desc: 'audit-* 14 维度审计，doctor --fix 自愈系统' },
      { file: 'chapters/09-session-context', label: '第 9 章：会话与上下文管理', desc: '文件系统 Session Store，ContextEngine 可插拔接口' },
      { file: 'chapters/10-acp-mcp-voice', label: '第 10 章：ACP、MCP 与语音', desc: 'ACP 桥接 Codex、MCP stdio 服务器、TTS+ASR 语音链路' },
    ],
  },
];

function buildHomepage() {
  const sidebar = buildSidebar('', 0);

  let sectionsHtml = '';
  for (const section of HOME_SECTIONS) {
    sectionsHtml += `<div class="section-heading">${section.heading}</div><div class="chapter-grid">`;
    for (const card of section.cards) {
      sectionsHtml += `<div class="chapter-card">
        <a href="${card.file}.html">${card.label}</a>
        <p class="card-desc">${card.desc}</p>
      </div>`;
    }
    sectionsHtml += `</div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenClaw 企业级 Agent Runtime 架构深度解析</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="layout">
    <aside class="sidebar">${sidebar}</aside>
    <main class="content">
      <div class="home-hero">
        <h1>OpenClaw：企业级 Agent Runtime 架构深度解析</h1>
        <p class="tagline">架构师视角 · 从设计哲学到企业落地 · 源码截至 2026-06-07</p>
        <div class="stats">
          <span>📐 13 章架构师深度分析</span>
          <span>🔬 源码规模 228,000+ 行</span>
          <span>⚖️ 对比 Claude Code / Hermes / LangGraph</span>
          <span>🏗️ 企业级落地建议</span>
        </div>
      </div>

      <div class="home-intro">
        本站以高级工程师、架构师、Agent 平台负责人为目标读者，从企业级 Agent Runtime 的设计哲学出发，深度分析 OpenClaw 的架构决策、设计思想与工程取舍。不是源码阅读笔记，而是架构师视角的系统性解析。所有分析基于 2026-06-07 源码快照。
      </div>

      ${sectionsHtml}

      <div class="page-footer">
        <a href="https://github.com/qqnhy/openclaw-code-analysiswiki" target="_blank">GitHub</a>
        &nbsp;·&nbsp;
        <span>© 2026 openclaw-code-analysis contributors</span>
        &nbsp;·&nbsp;
        <span>本项目仅供学术研究与技术学习使用</span>
      </div>
    </main>
  </div>
</body>
</html>`;

  fs.writeFileSync(path.join(DIST, 'index.html'), html);
  console.log('  ✓ index.html');
}

// ── Main ──────────────────────────────────────────────────────────────────
async function build() {
  console.log('Building docs...\n');

  if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
  fs.mkdirSync(DIST);

  fs.copyFileSync(path.join(__dirname, 'style.css'), path.join(DIST, 'style.css'));
  console.log('  ✓ style.css');

  buildHomepage();

  const allFiles = NAV.flatMap(g => g.items.map(i => i.file));
  for (const f of allFiles) processMarkdown(f);

  console.log('\nBuild complete!');
}

build().catch(err => { console.error(err); process.exit(1); });
