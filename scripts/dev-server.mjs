import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const readText = (relPath) => fs.readFileSync(path.join(root, relPath), 'utf8');
const readBin = (relPath) => fs.readFileSync(path.join(root, relPath));

const DEV_ADMIN_EMAIL = process.env.DEV_ADMIN_EMAIL || 'admin@example.com';
const DEV_ADMIN_PASSWORD = process.env.DEV_ADMIN_PASSWORD || 'cloudink123';
const DEV_SESSION_COOKIE = 'cloudink_dev_session';
const DEV_CSRF = 'dev-preview-csrf-token';

const PUBLIC_CSS_FILES = [
  'assets/design-tokens.css',
  'crates/blog-core/src/assets/styles.css',
  'assets/design-foundation.css',
  'assets/motion.css',
  'assets/mobile.css',
  'assets/expressive.css',
  'crates/blog-core/src/assets/home.css',
  'crates/blog-core/src/assets/reader-tools.css',
  'crates/blog-core/src/assets/reader.css',
];

const PUBLIC_JS_FILES = [
  'node_modules/swup/dist/Swup.umd.js',
  'assets/motion.js',
  'assets/mobile.js',
  'assets/reader-runtime.js',
  'crates/blog-core/src/assets/client.js',
];

const ADMIN_CSS_FILES = [
  'assets/design-tokens.css',
  'cloud-admin/ui/style.css',
  'assets/design-foundation.css',
  'assets/motion.css',
  'cloud-admin/ui/studio.css',
  'cloud-admin/ui/workflows.css',
  'cloud-admin/ui/images.css',
  'assets/mobile.css',
  'assets/expressive.css',
  'cloud-admin/ui/prism.css',
];

const ADMIN_BUNDLES = {
  '/app.js': {
    entry: 'cloud-admin/ui/app.js',
    external: [
      '/blog_wasm.js',
      '/image-maintenance.js',
      '/home-illustration.js',
      '/post-address.js',
      '/publication.js',
      '/backup.js',
    ],
  },
  '/home-illustration.js': { entry: 'cloud-admin/ui/home-illustration.js', external: [] },
  '/post-address.js': { entry: 'cloud-admin/ui/post-address.js', external: [] },
  '/publication.js': { entry: 'cloud-admin/ui/publication.js', external: [] },
  '/image-maintenance.js': { entry: 'cloud-admin/ui/image-maintenance.js', external: [] },
  '/image.worker.js': { entry: 'cloud-admin/ui/image.worker.js', external: [] },
};

const BACKUP_DEV_SHIM = `
export function configureBackup({ notice }) {
  const status = document.getElementById('backup-status');
  if (status) status.textContent = '本地开发预览模式：打包备份请在 Cloudflare 正式环境使用。';
  for (const id of ['backup-export', 'backup-import']) {
    document.getElementById(id)?.addEventListener('click', () => {
      notice?.('本地开发预览暂不执行 ZIP 备份打包，可在正式部署环境中使用。');
    });
  }
}
`;

const bundleCache = new Map();
function buildAdminBundle(route) {
  if (bundleCache.has(route)) return bundleCache.get(route);
  const spec = ADMIN_BUNDLES[route];
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, spec.entry)],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: false,
    external: spec.external,
    write: false,
  });
  const code = result.outputFiles[0].text;
  bundleCache.set(route, code);
  return code;
}

const PREVIEW_WORKER_SHIM = `
function esc(s) {
  return String(s || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function renderMd(md) {
  return String(md || '')
    .split(/\\n{2,}/)
    .map((block) => {
      const t = block.trim();
      if (!t) return '';
      if (t.startsWith('### ')) return '<h3>' + esc(t.slice(4)) + '</h3>';
      if (t.startsWith('## ')) return '<h2>' + esc(t.slice(3)) + '</h2>';
      if (t.startsWith('# ')) return '<h1>' + esc(t.slice(2)) + '</h1>';
      if (t.startsWith('> ')) return '<blockquote><p>' + esc(t.slice(2)) + '</p></blockquote>';
      return '<p>' + esc(t).replaceAll('\\n', '<br>') + '</p>';
    })
    .join('\\n');
}
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'warm') return self.postMessage({ id: data.id, result: true });
    if (data.type === 'parse') {
      return self.postMessage({
        id: data.id,
        result: { front_matter: { title: '导入文章', slug: 'imported', date: new Date().toISOString().slice(0, 10), description: '' }, body_markdown: data.source || '' },
      });
    }
    const fm = data.draft?.front_matter || {};
    const html = '<article class="article-reading"><h1>' + esc(fm.title || '未命名文章') + '</h1>' +
      (fm.description ? '<p class="article-description">' + esc(fm.description) + '</p>' : '') +
      '<div class="article-body">' + renderMd(data.draft?.body_markdown) + '</div></article>';
    self.postMessage({ id: data.id, result: { html, css: 'body{font-family:system-ui,-apple-system,sans-serif;line-height:1.8;padding:24px;color:#2c241d;}h1{font-size:1.8rem;margin:0 0 12px;}' } });
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
`;

const ICONS = {
  home: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/></svg>',
  article:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H5v18h14V8z"/><path d="M14 3v5h5M8 12h8M8 16h6"/></svg>',
  shorts:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16v14H9l-5 3V4Z"/><path d="M8 9h8M8 13h5"/></svg>',
  archive:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>',
  about:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
  link: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.5-1.5"/></svg>',
};

const SITE = {
  title: 'CloudInk · 云砚',
  subtitle: '记录所见，整理所想，保留缓慢而清晰的文字。',
  bigTitle: '记录所见，整理所想，保留缓慢而清晰的文字。',
  author: '林深',
  description:
    '部署在 Cloudflare Workers 的极简个人博客与写作空间，专注中文长文排版与静心阅读体验。',
  footer: '林深 built this website using Rust.',
  themePalette: 'brown',
  readingFont: 'serif',
  siteIcon: '',
  homeIllustration: 'default',
  clarityId: '',
  about:
    '欢迎来到 CloudInk · 云砚。这是一个面向 Cloudflare Workers 与 R2 构建的个人写作与阅读空间，专注克制、安静且耐看的中文长文排版体验。',
};
let settingsVersion = 1;
const uploadedIcons = new Map();

const LONG_HEADINGS = Array.from({ length: 18 }, (_, index) => {
  const n = index + 1;
  const tag = n % 3 === 0 ? 'h3' : 'h2';
  return `<${tag} id="section-${n}">${n}. 章节示例：中文排版节奏与长文导航体验</${tag}>
<p>在面向中文长文阅读的界面设计中，合理的行宽（约 35–42 个汉字）、舒缓的行高与克制的色彩层次，远比密集的装饰性元素更重要。右侧目录栏在多章节文档中应当能够内部平滑滚动，同时保证阅读进度、文章元信息与继续阅读卡片始终完整可见。</p>`;
}).join('\n');

const SAMPLE_KDL_CODE = Array.from(
  { length: 14 },
  (_, i) =>
    `    workspace "dev-${String(i + 1).padStart(2, '0')}" { open-on-output "DP-1"; } // line ${i + 1}`,
).join('\n');

const POSTS = [
  {
    slug: 'niri-editorial-workflow',
    title: '从零构建 Niri 窗口管理器与中文排版阅读工作流',
    date: '2026-10-18',
    minutes: 12,
    published: true,
    changed: false,
    etag: 'post-etag-1',
    description:
      '探讨滚动平铺式窗口管理器的日常配置、KDL 语法结构，以及面向中文长文阅读的精细排版实践。',
    bodyPlain:
      '探讨滚动平铺式窗口管理器的日常配置、KDL 语法结构，以及面向中文长文阅读的精细排版实践。右侧目录栏支持长文内部滚动，代码块行号严格右对齐并与正文保持 24px 等行高。',
    bodyMarkdown:
      '> 优秀的中文排版应当让人忘记排版的存在，引用文字保持端正清晰，仅在行内保留语义强调。\n\n## 1. 滚动平铺式工作流\n\n探讨滚动平铺式窗口管理器的日常配置、KDL 语法结构，以及面向中文长文阅读的精细排版实践。',
    bodyHtml: `
<blockquote><p>优秀的中文排版应当让人忘记排版的存在，引用文字保持端正清晰，仅在行内保留语义强调。<em>—— 中文排版需求（W3C CLREQ）</em></p></blockquote>
<p>以下是一段带有 <code>language-kdl</code> 标记的配置示例，用于验证未内置语言不会触发控制台警告，且行号列与代码行严格对齐：</p>
<pre><code class="language-kdl">layout {\n${SAMPLE_KDL_CODE}\n}</code></pre>
${LONG_HEADINGS}`,
  },
  {
    slug: 'cloudflare-workers-edge',
    title: 'Cloudflare Workers 与 R2 静态博客架构实践',
    date: '2026-09-24',
    minutes: 8,
    published: true,
    changed: false,
    etag: 'post-etag-2',
    description: '',
    bodyPlain:
      '通过 Rust/WASM 在边缘构建静态页面并结合 Cloudflare Workers 与 R2 存储，实现低延迟全球分发、强 ETag 缓存协商与零外部字体 CDN 依赖的静态博客架构。',
    bodyMarkdown:
      '## 1. 为什么选择边缘静态化\n\n通过 Rust/WASM 在发布阶段预生成完整 HTML，并借助 Cloudflare Workers 与 R2 实现全球边缘分发。\n\n## 2. 强 ETag 与缓存策略\n\n针对不可变静态资源启用长缓存，针对文章与索引页通过版本号与条件请求减少回源开销。',
    bodyHtml: `
<h2 id="edge-overview">1. 为什么选择边缘静态化</h2>
<p>通过 Rust/WASM 在发布阶段预生成完整 HTML，并借助 Cloudflare Workers 与 R2 实现全球边缘分发，既保留动态后台的便捷写作体验，又具备纯静态站点的稳定与速度。</p>
<h2 id="cache-strategy">2. 强 ETag 与缓存策略</h2>
<p>针对不可变静态资源启用长缓存，针对文章与索引页通过版本号与条件请求减少回源开销。</p>
<pre><code class="language-rust">pub fn content_hash(input: &amp;str) -&gt; String {
    let digest = sha256(input.as_bytes());
    hex::encode(&amp;digest[..8])
}</code></pre>`,
  },
  {
    slug: 'chinese-typography-notes',
    title: '面向数字屏幕的中文排版与阅读器细节笔记',
    date: '2026-08-11',
    minutes: 6,
    published: true,
    changed: false,
    etag: 'post-etag-3',
    description: '记录字体栈回退、12px 最小字号底线、44px 触控热区与深色模式纸面层次的工程实践。',
    bodyPlain:
      '记录字体栈回退、12px 最小字号底线、44px 触控热区与深色模式纸面层次的工程实践，兼顾桌面三栏与移动端单手浏览体验。',
    bodyMarkdown:
      '## 1. 跨平台中文字体栈\n\n优先使用自托管 Noto Serif SC（400/600）呈现标题与阅读正文。\n\n## 2. 最小字号与触控热区\n\n确保界面内不出现低于 12px 的辅助文字，并将主要操作与导航热区提升至 44px 以上。',
    bodyHtml: `
<h2 id="font-stack">1. 跨平台中文字体栈</h2>
<p>优先使用自托管 Noto Serif SC（400/600）呈现标题与阅读正文，同时为 UI 控件配置覆盖 macOS、Linux 与 Windows 的无衬线中文字体回退栈。</p>
<h2 id="touch-targets">2. 最小字号与触控热区</h2>
<p>确保界面内不出现低于 12px 的辅助文字，并将主要操作与导航热区提升至 44px 以上。</p>`,
  },
];

const SHORTS = [
  {
    slug: '2026-10-20-evening',
    date: '2026-10-20 21:30',
    published: true,
    changed: false,
    etag: 'short-etag-1',
    text: '秋雨后的夜晚很安静，把书桌上的台灯调成暖黄色，顺手整理完了博客的深色模式细描边与目录滚动。',
  },
  {
    slug: '2026-10-15-morning',
    date: '2026-10-15 09:12',
    published: true,
    changed: false,
    etag: 'short-etag-2',
    text: '好的工具界面应当像一本装帧考究的笔记本：留白充分、边界清晰、没有任何多余的视觉噪音。',
  },
];

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function activeSiteIconUrl() {
  if (/^uploads\/icons\/[a-f0-9]{64}\.(svg|ico)$/.test(SITE.siteIcon)) {
    return '/site-icon/' + SITE.siteIcon.slice('uploads/icons/'.length);
  }
  return '/favicon.svg';
}

function navLinks(pageKind, dock) {
  const items = [
    ['home', '/', '首页'],
    ['posts', '/post/', '文章'],
    ['shorts', '/shorts/', '短记'],
    ['archive', '/archive/', '归档'],
    ['about', '/about/', '关于'],
  ];
  return items
    .filter(([key]) => !(dock && key === 'archive'))
    .map(([key, href, label]) => {
      const current =
        key === pageKind
          ? ' aria-current="page"'
          : key === 'posts' && (pageKind === 'post' || (dock && pageKind === 'archive'))
            ? ' aria-current="location"'
            : '';
      const iconKey = key === 'posts' ? 'article' : key;
      return `<a href="${href}" title="${label}" data-reader-nav="${key}"${current}>${ICONS[iconKey]}<span>${label}</span></a>`;
    })
    .join('');
}

function authorContext(showAboutLink = true) {
  const iconUrl = activeSiteIconUrl();
  const aboutLink = showAboutLink
    ? `<a class="plain-button" href="/about/">${ICONS.about}关于我</a>`
    : '';
  return `<section class="panel author-card"><div class="author-head"><span class="author-avatar" aria-hidden="true"><img src="${iconUrl}" width="42" height="42" alt=""></span><div><h2>你好，我是${escapeHtml(SITE.author)}。</h2><p class="author-sub">${escapeHtml(SITE.subtitle)}</p></div></div><p class="author-intro">${escapeHtml(SITE.description)}</p>${aboutLink}</section>`;
}

function homeContext() {
  const entries = SHORTS.map(
    (short) =>
      `<article class="blog-note"><time datetime="${short.date}">${short.date}</time><p><a href="/shorts/#note:${short.slug}">${escapeHtml(short.text)}</a></p></article>`,
  ).join('');
  return `${authorContext(true)}<section class="panel blog-notes"><div class="blog-section-heading"><h2>短记</h2><a class="blog-text-link plain-button" href="/shorts/" aria-label="查看全部短记">全部短记 →</a></div>${entries}</section><a class="panel archive-shortcut" href="/archive/">${ICONS.archive}<span>按月份浏览归档</span><span aria-hidden="true">→</span></a>`;
}

function renderShell(pageKind, title, body, context) {
  const themeBootstrap = readText('assets/theme.js');
  const iconUrl = activeSiteIconUrl();
  const iconType = iconUrl.endsWith('.ico') ? 'image/x-icon' : 'image/svg+xml';
  const palette = SITE.themePalette || 'brown';
  const readingFont = SITE.readingFont || 'serif';
  const codeStyle = body.includes('<pre><code')
    ? '\n  <link rel="stylesheet" data-reader-style="code" href="/reader-assets/code.css">'
    : '';
  return `<!doctype html>
<html lang="zh-CN" data-palette="${palette}" data-reading-font="${readingFont}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(SITE.description)}">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css">
  <link id="reader-font-styles" rel="stylesheet" href="/reader-assets/editorial-font.css">${codeStyle}
  <link rel="icon" type="${iconType}" href="${iconUrl}">
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#6d4327">
  <script>${themeBootstrap}</script>
</head>
<body class="reader-shell">
  <a class="reader-skip" href="#swup" data-no-swup>跳到正文</a>
  <aside class="reader-sidebar" id="primary-nav" aria-label="站点导航">
    <a class="site-brand" href="/" title="${escapeHtml(SITE.title)}"><span class="site-mark"><img src="${iconUrl}" width="24" height="24" alt=""></span><span class="site-title">${escapeHtml(SITE.title)}</span></a>
    <nav class="reader-side-nav" aria-label="博客导航">${navLinks(pageKind, false)}</nav>
    <p class="reader-sidebar-note">${escapeHtml(SITE.subtitle)}</p>
  </aside>
  <div class="wrapper reader-layout">
    <header class="site-header reader-header">
      <p class="reader-site-heading" title="${escapeHtml(SITE.title)}">${escapeHtml(SITE.title)}</p>
      <div class="reader-tools">
        <button id="site-search-btn" class="reader-icon search-btn" aria-label="搜索文章 / Search" aria-haspopup="dialog" aria-controls="search-modal"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg></button>
        <button id="theme-toggle-btn" class="reader-icon" data-reader-theme data-theme-toggle data-icon-only aria-label="切换明暗主题"><svg class="theme-moon" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z"/></svg><svg class="theme-sun" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/></svg></button>
      </div>
    </header>
    <main id="swup" class="blog-layout" data-palette="${palette}" data-site-icon="${iconUrl}" data-page="${pageKind}" tabindex="-1">
      <div id="reader-center" class="blog-main"><div id="reader-center-content" class="transition-fade" data-page="${pageKind}" data-palette="${palette}" data-site-icon="${iconUrl}" data-reading-font="${readingFont}" data-site-title="${escapeHtml(SITE.title)}">${body}</div></div>
      <aside id="reader-context" class="blog-aside" aria-label="相关内容"><div id="reader-context-content" class="transition-fade">${context}</div></aside>
    </main>
    <footer class="site-footer"><p>${escapeHtml(SITE.footer)}</p><a class="plain-button" href="/admin">写作后台</a></footer>
  </div>
  <nav class="reader-dock" aria-label="手机博客导航">${navLinks(pageKind, true)}</nav>
  <dialog id="search-modal" class="search-modal" role="dialog" aria-modal="true" aria-labelledby="search-heading" aria-describedby="search-status" aria-hidden="true" inert>
    <div class="search-content">
      <div class="search-heading"><h2 id="search-heading">搜索文章</h2><button id="search-close" class="search-close" aria-label="关闭搜索">&times;</button></div>
      <label class="search-input-wrapper" for="search-input"><span>标题、摘要或正文</span><input type="search" id="search-input" class="search-input" placeholder="寻找一段文字…" autocomplete="off" enterkeyhint="search" aria-controls="search-results"></label>
      <p id="search-status" class="search-status" role="status" aria-live="polite">输入关键词搜索文章…</p>
      <ul id="search-results" class="search-results"></ul>
      <p class="search-hint"><span>↑ ↓ 选择 · Enter 打开</span><span>Esc 关闭</span></p>
    </div>
  </dialog>
  <script src="/client.js"></script>
</body>
</html>`;
}

function renderHome() {
  const [featured, ...rest] = POSTS;
  const featuredMeta = `<div class="story-meta"><span>${escapeHtml(SITE.author)}</span><time datetime="${featured.date}">${featured.date}</time><span>${featured.minutes} 分钟阅读</span></div>`;
  const featuredCard = `<article class="post-card home-card home-feature panel featured-article"><div class="feature-copy"><div class="story-eyebrow">${ICONS.article}<span>最近发布</span></div><h2><a href="/posts/${featured.slug}/">${escapeHtml(featured.title)}</a></h2><p class="feature-summary">${escapeHtml(featured.description)}</p>${featuredMeta}<a class="plain-button primary feature-read" href="/posts/${featured.slug}/">阅读全文 <span aria-hidden="true">→</span></a></div><a class="feature-cover home-illustration" href="/posts/${featured.slug}/" aria-hidden="true" tabindex="-1"><img src="/editorial-botanical.webp" width="150" height="174" alt=""></a></article>`;
  const feedItems = rest
    .map(
      (post) =>
        `<article class="post-card home-card blog-post"><div class="post-copy"><h3><a href="/posts/${post.slug}/">${escapeHtml(post.title)}</a></h3><p>${escapeHtml(post.description || post.bodyPlain.slice(0, 72) + '…')}</p><div class="story-meta"><span>${escapeHtml(SITE.author)}</span><time datetime="${post.date}">${post.date}</time><span>${post.minutes} 分钟阅读</span></div></div></article>`,
    )
    .join('');
  const feed = `<section id="posts" class="panel blog-feed" aria-labelledby="posts-heading"><div class="blog-section-heading"><h2 id="posts-heading">更多文章</h2><a class="blog-text-link plain-button" href="/post/">全部文章 →</a></div>${feedItems}</section>`;
  const body = `<div class="reader-welcome"><h1>${escapeHtml(SITE.bigTitle || SITE.subtitle)}</h1></div><div class="home-layout">${featuredCard}${feed}</div>`;
  return renderShell('home', SITE.title, body, homeContext());
}

function renderPostsPage() {
  const items = POSTS.map(
    (post) =>
      `<li><article class="post-card blog-post"><div class="post-copy"><h2><a href="/posts/${post.slug}/">${escapeHtml(post.title)}</a></h2><div class="story-meta"><time datetime="${post.date}">${post.date}</time><span>${post.minutes} 分钟阅读</span></div></div></article></li>`,
  ).join('');
  const body = `<section class="panel blog-feed post-index" aria-labelledby="post-index-heading"><header class="blog-section-heading"><h1 id="post-index-heading">文章</h1><p class="post-index-count">共 ${POSTS.length} 篇</p></header><ol class="post-index-list" id="post-index-list" start="1">${items}</ol><nav class="post-index-pagination" aria-label="文章分页"><p id="post-list-status" role="status">已显示第 1–${POSTS.length} 篇，共 ${POSTS.length} 篇。</p><div><a class="plain-button" href="/archive/">按时间归档 →</a></div></nav></section>`;
  return renderShell('posts', `文章 · ${SITE.title}`, body, authorContext(true));
}

function renderPostPage(post) {
  const iconUrl = activeSiteIconUrl();
  const body = `<section class="article-shell reader-article"><article class="panel article-reading"><div class="article-inner"><div class="article-back-row"><a class="plain-button article-back" href="/post/">← 返回列表</a></div><header class="article-heading article-headline"><h1 id="article-title">${escapeHtml(post.title)}</h1><p class="article-description article-deck">${escapeHtml(post.description)}</p><div class="article-author article-metadata"><span class="author-avatar" aria-hidden="true"><img src="${iconUrl}" width="26" height="26" alt=""></span><span class="article-author-name">${escapeHtml(SITE.author)}</span><div class="article-details"><time datetime="${post.date}">${post.date}</time><span>约 ${post.minutes} 分钟阅读</span></div></div><div class="mobile-reader-tools"><button type="button" class="copy-article-link plain-button">${ICONS.link}复制链接</button></div></header><div class="article-body article-body-text">${post.bodyHtml}</div><footer class="article-end share-container"><a class="plain-button" href="/post/">← 返回文章列表</a><button id="share-btn" class="plain-button share-button">${ICONS.link}分享文章</button><span id="share-status" role="status"></span></footer></div></article></section>`;
  const related = POSTS.filter((p) => p.slug !== post.slug)
    .map(
      (p) =>
        `<a class="related-story" href="/posts/${p.slug}/"><span>${escapeHtml(p.title)}</span><time datetime="${p.date}">${p.date}</time></a>`,
    )
    .join('');
  const context = `<section class="panel article-toc-panel"><h2>文章目录</h2><div class="reader-toc-slot"></div><div class="reading-progress-widget"><div><span>阅读进度</span><strong id="reading-percent">0%</strong></div><div class="reading-progress-track"><div id="reading-progress" class="reading-progress" aria-hidden="true"></div></div></div></section><section class="panel article-info-panel"><h2>关于这篇文章</h2><dl><div><dt>作者</dt><dd>${escapeHtml(SITE.author)}</dd></div><div><dt>发布日期</dt><dd>${post.date}</dd></div><div><dt>阅读时长</dt><dd>约 ${post.minutes} 分钟</dd></div></dl><button class="plain-button copy-article-link" type="button">${ICONS.link}复制文章链接</button></section><section class="panel related-panel"><h2>继续阅读</h2><div id="related-stories">${related}</div></section>`;
  return renderShell('post', `${post.title} · ${SITE.title}`, body, context);
}

function renderShortsPage() {
  const items = SHORTS.map(
    (s) =>
      `<article class="short-card" id="note:${s.slug}" tabindex="-1"><time class="short-time" datetime="${s.date}">${s.date}</time><div class="short-body"><p>${escapeHtml(s.text)}</p></div></article>`,
  ).join('');
  const body = `<div class="shorts-layout"><h1 id="shorts-title">短记</h1><div class="shorts-feed">${items}</div></div>`;
  return renderShell('shorts', `短记 · ${SITE.title}`, body, authorContext(true));
}

function renderArchivePage() {
  const groups = new Map();
  for (const post of POSTS) {
    const key = post.date.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(post);
  }
  const sections = [...groups.entries()]
    .map(([ym, list]) => {
      const [year, month] = ym.split('-');
      const items = list
        .map(
          (p) =>
            `<li><a class="archive-entry" href="/posts/${p.slug}/"><time datetime="${p.date}">${p.date.slice(5)}</time><span>${escapeHtml(p.title)}</span></a></li>`,
        )
        .join('');
      return `<section class="archive-group" aria-label="${year} 年 ${Number(month)} 月"><h2>${year} 年 ${Number(month)} 月</h2><ul>${items}</ul></section>`;
    })
    .join('');
  const body = `<div class="archive-layout"><h1 id="archive-title">文章归档</h1>${sections}</div>`;
  return renderShell('archive', `文章归档 · ${SITE.title}`, body, authorContext(true));
}

function renderAboutPage() {
  const body = `<section class="article-shell reader-article reader-page"><article class="panel"><div class="article-inner"><header class="article-heading"><h1>关于本站</h1></header><div class="article-body"><p>${escapeHtml(SITE.about)}</p></div></div></article></section>`;
  return renderShell('about', `关于 · ${SITE.title}`, body, authorContext(false));
}

function renderNotFoundPage() {
  const body = `<section class="article-shell reader-article reader-page"><article class="panel"><div class="article-inner"><header class="article-heading"><h1>404 · 页面未找到</h1></header><div class="article-body"><p>你访问的页面不存在或已移动。<a href="/">返回首页</a> 继续浏览。</p></div></div></article></section>`;
  return renderShell('404', `404 · ${SITE.title}`, body, authorContext(true));
}

function isAuthed(req) {
  const cookies = String(req.headers.cookie || '');
  return cookies.split(/;\s*/).some((pair) => pair === `${DEV_SESSION_COOKIE}=ok`);
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function markdownToSimpleHtml(md) {
  return String(md || '')
    .split(/\n{2,}/)
    .map((block) => {
      const t = block.trim();
      if (!t) return '';
      if (t.startsWith('### ')) return `<h3>${escapeHtml(t.slice(4))}</h3>`;
      if (t.startsWith('## ')) return `<h2>${escapeHtml(t.slice(3))}</h2>`;
      if (t.startsWith('# ')) return `<h1>${escapeHtml(t.slice(2))}</h1>`;
      if (t.startsWith('> ')) return `<blockquote><p>${escapeHtml(t.slice(2))}</p></blockquote>`;
      return `<p>${escapeHtml(t).replaceAll('\n', '<br>')}</p>`;
    })
    .join('\n');
}

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;
  const proto = String(req.headers['x-forwarded-proto'] || 'http')
    .split(',')[0]
    .trim();
  const origin = `${proto}://${req.headers.host || `localhost:${port}`}`;
  const cookieAttrs =
    proto === 'https'
      ? 'Path=/; HttpOnly; SameSite=None; Secure'
      : 'Path=/; HttpOnly; SameSite=Lax';

  if (pathname === '/api/config' && method === 'GET') {
    return json(res, 200, {
      initialized: true,
      siteUrl: origin + '/',
      imageOrigin: origin + '/images/',
      releaseId: 'dev-preview',
    });
  }
  if (pathname === '/api/login' && method === 'POST') {
    const raw = (await readBodyBuffer(req)).toString('utf8');
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {}
    if (
      String(body.email || '')
        .trim()
        .toLowerCase() !== DEV_ADMIN_EMAIL.toLowerCase() ||
      String(body.password || '') !== DEV_ADMIN_PASSWORD
    ) {
      return json(res, 401, {
        error: `本地预览账户或密码错误（测试账户：${DEV_ADMIN_EMAIL} / ${DEV_ADMIN_PASSWORD}）。`,
      });
    }
    return json(
      res,
      200,
      { email: DEV_ADMIN_EMAIL, csrf: DEV_CSRF },
      {
        'set-cookie': `${DEV_SESSION_COOKIE}=ok; ${cookieAttrs}; Max-Age=86400`,
      },
    );
  }
  if (pathname === '/api/logout' && method === 'POST') {
    return json(
      res,
      200,
      { ok: true },
      { 'set-cookie': `${DEV_SESSION_COOKIE}=; ${cookieAttrs}; Max-Age=0` },
    );
  }
  if (!isAuthed(req)) {
    return json(res, 401, { error: '请先登录写作后台。' });
  }
  if (pathname === '/api/session' && method === 'GET') {
    return json(res, 200, { email: DEV_ADMIN_EMAIL, csrf: DEV_CSRF });
  }

  // Posts API
  if (pathname === '/api/posts' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const filter = url.searchParams.get('filter') || 'all';
    const items = POSTS.filter((p) => {
      if (filter === 'published' && !p.published) return false;
      if (filter === 'draft' && p.published) return false;
      if (q && !`${p.title} ${p.description} ${p.slug}`.toLowerCase().includes(q)) return false;
      return true;
    }).map((p) => ({
      slug: p.slug,
      title: p.title,
      date: p.date,
      description: p.description,
      published: p.published,
      changed: p.changed,
      etag: p.etag,
    }));
    const publishedCount = POSTS.filter((p) => p.published).length;
    return json(res, 200, {
      posts: items,
      cursor: null,
      counts: {
        all: POSTS.length,
        published: publishedCount,
        draft: POSTS.length - publishedCount,
      },
      publicInitialized: true,
      templateStatus: 'current',
      site: { ...SITE },
      appearance: { ...SITE },
      publishing: null,
    });
  }

  const postMatch = pathname.match(/^\/api\/posts\/([^/]+)$/);
  if (postMatch) {
    const slug = decodeURIComponent(postMatch[1]);
    if (method === 'GET') {
      const post = POSTS.find((p) => p.slug === slug);
      if (!post) return json(res, 404, { error: '文章不存在。' });
      return json(res, 200, {
        etag: post.etag,
        published: post.published,
        changed: post.changed,
        draft: {
          front_matter: {
            title: post.title,
            slug: post.slug,
            date: post.date,
            description: post.description,
            draft: !post.published,
          },
          body_markdown: post.bodyMarkdown,
        },
      });
    }
    if (method === 'PUT') {
      const payload = JSON.parse((await readBodyBuffer(req)).toString('utf8') || '{}');
      const fm = payload.draft?.front_matter || {};
      const bodyMarkdown = String(payload.draft?.body_markdown || '');
      let post = POSTS.find((p) => p.slug === slug);
      const nextEtag = 'post-etag-' + Date.now().toString(36);
      if (!post) {
        post = {
          slug,
          title: fm.title || '未命名文章',
          date: fm.date || new Date().toISOString().slice(0, 10),
          minutes: Math.max(1, Math.ceil(bodyMarkdown.length / 300)),
          published: false,
          changed: true,
          etag: nextEtag,
          description: fm.description || '',
          bodyPlain: bodyMarkdown.replace(/[#>*`]/g, '').slice(0, 160),
          bodyMarkdown,
          bodyHtml: markdownToSimpleHtml(bodyMarkdown),
        };
        POSTS.unshift(post);
      } else {
        post.title = fm.title || post.title;
        post.date = fm.date || post.date;
        post.description = fm.description ?? post.description;
        post.bodyMarkdown = bodyMarkdown;
        post.bodyPlain = bodyMarkdown.replace(/[#>*`]/g, '').slice(0, 160);
        post.bodyHtml = markdownToSimpleHtml(bodyMarkdown);
        post.minutes = Math.max(1, Math.ceil(bodyMarkdown.length / 300));
        post.changed = true;
        post.etag = nextEtag;
      }
      return json(res, 200, {
        etag: post.etag,
        slug: post.slug,
        published: post.published,
        changed: post.changed,
      });
    }
    if (method === 'DELETE') {
      const idx = POSTS.findIndex((p) => p.slug === slug);
      if (idx !== -1) POSTS.splice(idx, 1);
      return json(res, 200, { ok: true });
    }
  }

  // Shorts API
  if (pathname === '/api/shorts' && method === 'GET') {
    return json(res, 200, {
      shorts: SHORTS.map((s) => ({
        slug: s.slug,
        date: s.date,
        snippet: s.text.slice(0, 140),
        published: s.published,
        changed: s.changed,
        etag: s.etag,
      })),
      cursor: null,
      publishing: null,
    });
  }

  const shortMatch = pathname.match(/^\/api\/shorts\/([^/]+)$/);
  if (shortMatch) {
    const slug = decodeURIComponent(shortMatch[1]);
    if (method === 'GET') {
      const item = SHORTS.find((s) => s.slug === slug);
      if (!item) return json(res, 404, { error: '短记不存在。' });
      return json(res, 200, {
        etag: item.etag,
        published: item.published,
        changed: item.changed,
        draft: {
          front_matter: {
            slug: item.slug,
            date: item.date,
            draft: !item.published,
          },
          body_markdown: item.text,
        },
      });
    }
    if (method === 'PUT') {
      const payload = JSON.parse((await readBodyBuffer(req)).toString('utf8') || '{}');
      const fm = payload.draft?.front_matter || {};
      const text = String(payload.draft?.body_markdown || '').trim();
      const nextEtag = 'short-etag-' + Date.now().toString(36);
      let item = SHORTS.find((s) => s.slug === slug);
      if (!item) {
        item = {
          slug,
          date: fm.date || new Date().toISOString().slice(0, 16).replace('T', ' '),
          published: false,
          changed: true,
          etag: nextEtag,
          text,
        };
        SHORTS.unshift(item);
      } else {
        item.date = fm.date || item.date;
        item.text = text;
        item.changed = true;
        item.etag = nextEtag;
      }
      return json(res, 200, { etag: item.etag, slug: item.slug });
    }
    if (method === 'DELETE') {
      const idx = SHORTS.findIndex((s) => s.slug === slug);
      if (idx !== -1) SHORTS.splice(idx, 1);
      return json(res, 200, { ok: true });
    }
  }

  // Settings & Site Icon API
  if (pathname === '/api/settings' && method === 'GET') {
    return json(res, 200, { site: { ...SITE }, etag: `settings-${settingsVersion}` });
  }
  if (pathname === '/api/settings' && method === 'PUT') {
    const payload = JSON.parse((await readBodyBuffer(req)).toString('utf8') || '{}');
    if (payload.site && typeof payload.site === 'object') {
      Object.assign(SITE, payload.site);
      settingsVersion++;
    }
    return json(res, 200, { site: { ...SITE }, etag: `settings-${settingsVersion}` });
  }
  if (pathname === '/api/site-icon' && method === 'POST') {
    const buf = await readBodyBuffer(req);
    if (!buf.length || buf.length > 256 * 1024) {
      return json(res, 400, { error: '网站图标需为 1 字节至 256 KB。' });
    }
    const isIco = buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0;
    const head = buf.slice(0, 256).toString('utf8').trimStart();
    const isSvg = head.startsWith('<svg') || head.startsWith('<?xml');
    if (!isIco && !isSvg) {
      return json(res, 400, { error: '仅支持有效的 SVG 或 ICO 文件。' });
    }
    const ext = isIco ? '.ico' : '.svg';
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const filename = hash + ext;
    const key = 'uploads/icons/' + filename;
    uploadedIcons.set(filename, {
      bytes: buf,
      type: isIco ? 'image/x-icon' : 'image/svg+xml',
    });
    return json(res, 200, { key, size: buf.length });
  }

  // Maintenance / Publish / Images / Backup dev preview stubs
  if (pathname === '/api/maintenance' && method === 'GET') {
    return json(res, 200, { status: 'skipped', reason: 'uninitialized', last_attempt_at: null });
  }
  if (pathname === '/api/publish/status' && method === 'GET') {
    return json(res, 200, { publishing: null });
  }
  if (pathname === '/api/publish' && method === 'POST') {
    for (const p of POSTS) {
      p.published = true;
      p.changed = false;
    }
    for (const s of SHORTS) {
      s.published = true;
      s.changed = false;
    }
    return json(res, 200, {
      status: 'completed',
      published: true,
      message: '本地开发预览已同步更新公开页面。',
    });
  }
  if (pathname === '/api/images' && method === 'GET') {
    return json(res, 200, { images: [], cursor: null, indexStale: false });
  }
  if (pathname === '/api/backup/jobs' && method === 'GET') {
    return json(res, 200, null);
  }

  return json(res, 404, { error: '本地预览服务器未实现该接口：' + pathname });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const reqPath = url.pathname;

  try {
    if (reqPath.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }

    if (reqPath.startsWith('/site-icon/')) {
      const filename = reqPath.slice('/site-icon/'.length);
      const stored = uploadedIcons.get(filename);
      if (stored) {
        res.writeHead(200, { 'content-type': stored.type, 'cache-control': 'no-store' });
        return res.end(stored.bytes);
      }
      res.writeHead(404);
      return res.end('Not found');
    }

    if (ADMIN_BUNDLES[reqPath]) {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(buildAdminBundle(reqPath));
    }
    if (reqPath === '/backup.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(BACKUP_DEV_SHIM);
    }
    if (reqPath === '/preview.worker.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(PREVIEW_WORKER_SHIM);
    }

    if (reqPath === '/styles.css') {
      res.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(PUBLIC_CSS_FILES.map(readText).join('\n'));
    }
    if (reqPath === '/client.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(PUBLIC_JS_FILES.map(readText).join('\n'));
    }
    if (reqPath === '/style.css') {
      res.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(ADMIN_CSS_FILES.map(readText).join('\n'));
    }
    if (reqPath === '/admin-theme.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return res.end(readText('assets/theme.js'));
    }
    if (reqPath === '/sw.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(readText('assets/sw.js'));
    }
    if (reqPath === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' });
      return res.end(readText('assets/manifest.webmanifest'));
    }
    if (reqPath === '/favicon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end(readBin('assets/cloudink.svg'));
    }
    if (reqPath === '/editorial-botanical.webp') {
      res.writeHead(200, { 'content-type': 'image/webp' });
      return res.end(readBin('assets/editorial-botanical.webp'));
    }
    if (reqPath === '/editorial-botanical.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end(readBin('assets/editorial-botanical.svg'));
    }
    if (reqPath === '/writing-illustration.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end(readBin('assets/writing-illustration.svg'));
    }
    if (reqPath === '/reader-assets/editorial-font.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      return res.end('');
    }
    if (reqPath === '/reader-assets/code.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      return res.end(
        ':root:not([data-theme="dark"]) .hljs-keyword{color:#cf222e}:root:not([data-theme="dark"]) .hljs-title{color:#8250df}:root:not([data-theme="dark"]) .hljs-type{color:#0550ae}:root:not([data-theme="dark"]) .hljs-string{color:#0a3069}:root:not([data-theme="dark"]) .hljs-number{color:#0550ae}:root:not([data-theme="dark"]) .hljs-comment{color:#6e7781}' +
          ':root[data-theme="dark"] .hljs-keyword{color:#ff7b72}:root[data-theme="dark"] .hljs-title{color:#d2a8ff}:root[data-theme="dark"] .hljs-type{color:#79c0ff}:root[data-theme="dark"] .hljs-string{color:#a5d6ff}:root[data-theme="dark"] .hljs-number{color:#79c0ff}:root[data-theme="dark"] .hljs-comment{color:#8b949e}',
      );
    }
    if (reqPath === '/reader-assets/highlight.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return res.end(
        'window.CloudInkHighlighter = {' +
          'getLanguage(l) { return ["rust","js","javascript","ts","typescript"].includes(String(l).toLowerCase()) ? {} : undefined; },' +
          'highlightElement(el) {' +
          '  const raw = el.textContent || "";' +
          '  const esc = raw.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");' +
          '  const html = esc.replace(/\\b(pub|fn|let|const|return|async|await)\\b/g, "<span class=\\"hljs-keyword\\">$1</span>")' +
          '    .replace(/\\b(String|str|u8|usize)\\b/g, "<span class=\\"hljs-type\\">$1</span>")' +
          '    .replace(/\\b(\\d+)\\b/g, "<span class=\\"hljs-number\\">$1</span>");' +
          '  el.innerHTML = html;' +
          '  el.classList.add("hljs");' +
          '  el.dataset.highlighted = "yes";' +
          '}' +
          '};',
      );
    }
    if (reqPath === '/search_index.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(
        JSON.stringify(
          POSTS.map((p) => ({
            slug: p.slug,
            title: p.title,
            description: p.description,
            body: p.bodyPlain,
          })),
        ),
      );
    }

    if (reqPath === '/admin' || reqPath === '/admin/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(readText('cloud-admin/ui/index.html'));
    }
    if (reqPath === '/' || reqPath === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(renderHome());
    }
    if (reqPath === '/post' || reqPath === '/post/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(renderPostsPage());
    }
    if (reqPath === '/shorts' || reqPath === '/shorts/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(renderShortsPage());
    }
    if (reqPath === '/archive' || reqPath === '/archive/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(renderArchivePage());
    }
    if (reqPath === '/about' || reqPath === '/about/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(renderAboutPage());
    }
    const postMatch = reqPath.match(/^\/posts\/([^/]+)\/?$/);
    if (postMatch) {
      const post = POSTS.find((p) => p.slug === decodeURIComponent(postMatch[1]));
      if (post) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(renderPostPage(post));
      }
    }

    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(renderNotFoundPage());
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Dev preview error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

server.listen(port, host, () => {
  console.log(`CloudInk UI dev server listening on http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
