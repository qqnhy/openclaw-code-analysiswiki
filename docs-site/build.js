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
    label: '架构级源码解析',
    items: [
      { title: 'Ch00 — 架构全景', file: 'chapters/00-architecture-overview' },
      { title: 'Ch01 — Agent Runtime 主循环', file: 'chapters/01-agent-runtime-main-loop' },
      { title: 'Ch02 — Context & Prompt 组装', file: 'chapters/02-context-prompt-assembly' },
      { title: 'Ch03 — LLM Provider 抽象', file: 'chapters/03-llm-provider-abstraction' },
      { title: 'Ch04 — 工具注册与调用', file: 'chapters/04-tool-registry-and-calling' },
      { title: 'Ch05 — 记忆系统', file: 'chapters/05-memory-system' },
      { title: 'Ch06 — 技能系统', file: 'chapters/06-skill-system' },
      { title: 'Ch07 — Trajectory & 事件追踪', file: 'chapters/07-trajectory-event-trace' },
      { title: 'Ch08 — Reflection & Learning', file: 'chapters/08-reflection-learning-loop' },
      { title: 'Ch09 — Eval & Feedback', file: 'chapters/09-eval-feedback' },
      { title: 'Ch10 — 错误处理与降级', file: 'chapters/10-error-retry-fallback' },
      { title: 'Ch11 — 阅读路线图', file: 'chapters/11-reading-roadmap' },
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
    heading: '架构级源码解析（基于实际源码深度阅读）',
    cards: [
      { file: 'chapters/00-architecture-overview', label: 'Ch00 — 架构全景', desc: '项目定位 · 7 大模块关系 · 完整执行链路 · 与 Claude Code/OpenHands/Archon 对比矩阵' },
      { file: 'chapters/01-agent-runtime-main-loop', label: 'Ch01 — Agent Runtime 主循环', desc: '双层 while 设计 · 工具并发执行 · steering/follow-up 队列 · 状态机生命周期' },
      { file: 'chapters/02-context-prompt-assembly', label: 'Ch02 — Context & Prompt 组装', desc: 'Prompt Pipeline · convertToLlm() 消息转换 · Context Window 管理 · Compaction 压缩' },
      { file: 'chapters/03-llm-provider-abstraction', label: 'Ch03 — LLM Provider 抽象', desc: 'StreamFn 统一接口 · 100+ Provider Extension · Failover 设计 · 动态 API Key 刷新' },
      { file: 'chapters/04-tool-registry-and-calling', label: 'Ch04 — 工具注册与调用', desc: 'TypeBox Schema · parallel/sequential 执行 · beforeToolCall/afterToolCall · MCP 集成' },
      { file: 'chapters/05-memory-system', label: 'Ch05 — 记忆系统', desc: 'sqlite-vec 向量存储 · BM25+cosine 混合检索 · RRF 融合 · Dreaming 记忆整合机制' },
      { file: 'chapters/06-skill-system', label: 'Ch06 — 技能系统', desc: 'Markdown frontmatter Skill · ClawHub 市场 · 多来源优先级加载 · 安全扫描' },
      { file: 'chapters/07-trajectory-event-trace', label: 'Ch07 — Trajectory & 事件追踪', desc: 'JSONL 版本化事件流 · OpenTelemetry Span 映射 · Prometheus 指标 · 轨迹重放调试' },
      { file: 'chapters/08-reflection-learning-loop', label: 'Ch08 — Reflection & Learning', desc: '现有隐式机制分析 · Dreaming 学习回路 · 用钩子实现 Reflection 的工程方案' },
      { file: 'chapters/09-eval-feedback', label: 'Ch09 — Eval & Feedback', desc: 'QA Lab/Matrix · LLM Judge (G-Eval) · Rule Judge · Trajectory 驱动的 Offline Eval' },
      { file: 'chapters/10-error-retry-fallback', label: 'Ch10 — 错误处理与降级', desc: '错误分类体系 · AgentHarnessError 归一化 · 熔断器实现 · Graceful Degradation' },
      { file: 'chapters/11-reading-roadmap', label: 'Ch11 — 阅读路线图', desc: '新人/高级/架构师三条路径 · Top 20 必看文件 · 二次开发扩展点 · 常见坑避雷' },
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
        <h1>OpenClaw 架构级源码分析</h1>
        <p class="tagline">Agent Framework Architect 视角 · 深度源码解剖 · 源码截至 2026-06-07</p>
        <div class="stats">
          <span>📐 12 章架构级深度分析</span>
          <span>📦 源码规模 228,000+ 行</span>
          <span>🔗 Mermaid 架构图 + 时序图</span>
          <span>💡 与 Claude Code / OpenHands / Archon 横向对比</span>
        </div>
      </div>

      <div class="home-intro">
        本站从 <strong>Agent Framework Architect</strong> 视角对 OpenClaw 进行架构级源码解剖。每章均包含：Mermaid 架构/时序/类图、精确源码定位（文件路径+行号）、设计动机与 Trade-off 分析、企业落地建议、面试题（含参考答案），以及与 Claude Code / OpenAI Codex / OpenHands / Archon 的横向对比。所有分析基于对实际源码的深度阅读，源码快照截至 2026-06-07。
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
