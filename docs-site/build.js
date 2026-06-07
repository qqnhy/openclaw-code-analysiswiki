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
    label: '源码分析',
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
  let html = `<div class="site-brand"><a href="${root}index.html">OpenClaw<br>源码分析</a></div>`;

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
  <title>${title} - OpenClaw 源码分析</title>
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
    heading: '源码分析',
    cards: [
      { file: 'chapters/01-architecture', label: '第 1 章：项目概览与架构全景', desc: '7 层分层架构，Gateway 是控制平面，插件是扩展骨架' },
      { file: 'chapters/02-startup', label: '第 2 章：启动流程与 CLI 命令树', desc: 'openclaw.mjs 编译缓存 Respawn 机制，命令树懒加载' },
      { file: 'chapters/03-channels', label: '第 3 章：多通道系统', desc: '20+ 通道以绑定-路由-Turn 三层模型统一管理' },
      { file: 'chapters/04-agent-engine', label: '第 4 章：Agent 执行引擎', desc: 'attempt.ts（5,377 行）7 阶段执行流' },
      { file: 'chapters/05-plugin-system', label: '第 5 章：插件系统深解', desc: '40+ 生命周期钩子，manifest→安装→加载全流程' },
      { file: 'chapters/06-llm-providers', label: '第 6 章：多 LLM 提供商抽象', desc: 'openai-transport-stream.ts（4,313 行）统一 8 个提供商' },
      { file: 'chapters/07-skills', label: '第 7 章：Skills 系统', desc: 'Markdown 文件即 Skill，~ 路径压缩节省 400-600 tokens' },
      { file: 'chapters/08-security', label: '第 8 章：安全审计机制', desc: 'audit-* 14 维度审计，doctor --fix 自愈系统' },
      { file: 'chapters/09-session-context', label: '第 9 章：会话与上下文管理', desc: 'JSONL Session Store，ContextEngine 可插拔接口' },
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
  <title>OpenClaw 源码分析</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="layout">
    <aside class="sidebar">${sidebar}</aside>
    <main class="content">
      <div class="home-hero">
        <h1>OpenClaw 源码分析</h1>
        <p class="tagline">核心模块逐章拆解 · 实际源码片段 · 源码截至 2026-06-07</p>
        <div class="stats">
          <span>🔬 10 章源码深度分析</span>
          <span>📦 源码规模 228,000+ 行</span>
          <span>🔗 关键类型与调用链</span>
          <span>💡 设计决策与取舍解析</span>
        </div>
      </div>

      <div class="home-intro">
        本站以工程师为目标读者，逐章拆解 OpenClaw 的核心模块，结合实际源码片段讲解关键类型、调用链和设计决策。所有分析基于 2026-06-07 源码快照。
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
