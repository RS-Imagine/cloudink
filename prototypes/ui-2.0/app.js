/* Isolated design study. No network, account, persistence or publishing API. */
const app = document.getElementById('app');
const root = document.documentElement;
const svg = (content) => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + content + '</svg>';
const icons = {
  arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  back: svg('<path d="M19 12H5m6-6-6 6 6 6"/>'),
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>'),
  theme: svg('<path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  home: svg('<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>'),
  file: svg('<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4M9 12h6m-6 4h5"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-5 4 3 4-6 4 5"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1 1 4-2 2 2 3 3-1 2 3 3-1 1-3 3-1-1-4 2-2-2-3-3 1-2-3Z"/>'),
  external: svg('<path d="M14 4h6v6m0-6L10 14M10 4H5v15h15v-5"/>'),
  more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  check: svg('<path d="m5 12 4 4L19 6"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/>'),
  link: svg('<path d="m10 13 4-4m-6 1-2 2a4 4 0 0 0 6 6l2-2m-4-8 2-2a4 4 0 0 1 6 6l-2 2"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>'),
  write: svg('<path d="m4 16 12-12 4 4L8 20H4Zm9-9 4 4"/>'),
  cloud: svg('<path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13 1 4.5 4.5 0 0 1 0 9Z"/>'),
};
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const brand = () => '<a class="brand" href="#home"><span class="brand-mark"><img src="../../assets/cloudink.svg" alt="" width="26" height="26"></span><span>CloudInk<span class="muted"> · 云砚</span></span></a>';
const posts = [
  { title: '把日子，写成一封长信', description: '在平凡的缝隙里，收集那些值得被记住的瞬间。关于写作，也关于慢一点生活。', type: '生活随笔', date: '10 月 12 日', status: '已发布', minutes: '5 分钟', slug: 'slow-days' },
  { title: '给生活留一点空白', description: '不必填满每一页。空白，也是表达的一部分。', type: '日常观察', date: '10 月 08 日', status: '草稿', minutes: '3 分钟', slug: 'white-space' },
  { title: '一个人的数字花园', description: '在自己的小小角落，种下想法，让它们慢慢生长。', type: '创作手记', date: '10 月 03 日', status: '已发布', minutes: '6 分钟', slug: 'digital-garden' },
  { title: '在山间，找回自己的节奏', description: '一次短暂的远行，一段与自己重新相遇的时间。', type: '山野来信', date: '09 月 26 日', status: '草稿', minutes: '4 分钟', slug: 'mountain-letter' },
];
let draftText = '## 一些值得被记住的小事\n\n清晨的光落在窗台上，咖啡还冒着热气。\n忽然觉得，这样的时刻也值得被认真写下。\n\n> 写作，是与生活保持联系的一种方式。\n\n## 慢下来，才看得见\n\n我们总是在赶路，偶尔也需要停下来，\n看看身边那些安静发生的事情。\n\n**不必急着完成，先开始就好。**';
let titleText = posts[0].title;
let descriptionText = '在平凡的缝隙里，收集那些值得被记住的瞬间。';
let filter = '全部';
let current = '';
let toastTimer;
let searchTrigger;
let libraryTrigger;
let saveTimer;
const toast = (text) => {
  const element = document.getElementById('toast');
  clearTimeout(toastTimer);
  element.textContent = text;
  element.classList.add('visible');
  toastTimer = setTimeout(() => element.classList.remove('visible'), 2600);
};
const art = (kind = 'one', label = 'A LETTER FROM THE EVERYDAY') => '<div class="art art-' + kind + '" aria-hidden="true"><span class="sun"></span><span class="art-label">' + label + '</span></div>';
const themeButton = () => '<button class="icon-button" data-theme-toggle aria-label="切换明暗主题">' + icons.theme + '</button>';
const header = (article = false) => '<header class="reader-header">' + brand() + '<nav class="reader-nav" aria-label="博客导航"><a href="#home"' + (!article ? ' aria-current="page"' : '') + '>文章</a><a href="#article">关于写作</a><button class="icon-button" data-search aria-label="搜索文章" aria-haspopup="dialog">' + icons.search + '</button>' + themeButton() + '</nav></header>';
const footer = () => '<footer class="reader-footer"><span>保持好奇，慢慢生长。</span><span>由 CloudInk 云砚驱动</span></footer>';
const postCard = (p) => '<a class="post-card card" href="#article"><span class="badge neutral">' + p.type + '</span><h3>' + p.title + '</h3><p>' + p.description + '</p><div class="meta"><time>' + p.date + ' · ' + p.minutes + '</time>' + icons.arrow + '</div></a>';

function home() {
  return '<div class="container screen">' + header() + '<main id="content" tabindex="-1"><section class="hero"><div><div class="eyebrow"><span class="dot"></span> 一个安静的文字角落</div><h1>记录所见，<br>也记录<span>心之所向。</span></h1><p>关于生活、思考与创造。用文字收藏片刻，让每一个平凡的日子，都有迹可循。</p><div class="author-chip"><span class="avatar">林</span><div>林间<small>写作者 · 生活观察者</small></div></div></div><aside class="hero-note" aria-hidden="true"><div class="note-icon">' + icons.write + '</div><p>让想法落笔，<br>让文字生长。</p><small>NOTES, NOT NOISE.</small></aside></section><section aria-labelledby="latest-heading"><div class="section-title"><h2 id="latest-heading">最近的文字</h2><small>慢慢写，慢慢读</small></div><a class="feature" href="#article"><div class="feature-copy"><span class="badge">最新随笔</span><h2>' + posts[0].title + '</h2><p>' + posts[0].description + '</p><div class="meta"><time>2026 年 10 月 12 日</time><span>阅读约 5 分钟</span>' + icons.arrow + '</div></div>' + art() + '</a><div class="post-grid">' + posts.slice(1).map(postCard).join('') + '</div></section></main>' + footer() + '</div>';
}
function article() {
  return '<div class="container screen">' + header(true) + '<main id="content" class="article-layout" tabindex="-1"><article class="article-main"><a class="back" href="#home">' + icons.back + '所有文章</a><h1>' + posts[0].title + '</h1><p class="article-description">' + posts[0].description + '</p><div class="article-author"><span class="avatar">林</span><div>林间<div class="meta"><time>2026 年 10 月 12 日</time><span>5 分钟阅读</span></div></div></div><div class="article-body"><p>清晨的光落在窗台上，咖啡还冒着热气。忽然觉得，这样的时刻也值得被认真写下。</p><p>我们总以为，只有宏大的事情才配得上记录。可当我翻开旧日的笔记，真正让人停留的，却是一顿简单的晚饭、一段没有目的的散步，或者某个阳光很好的下午。</p><h2 id="small-things">一些值得被记住的小事</h2><p>写作不一定要从一个完整的想法开始。有时候，只需要留意一个细节：风吹过树叶的声音，街角新开的花店，还有朋友说过的一句温柔的话。</p><blockquote>写作，是与生活保持联系的一种方式。</blockquote><figure>' + art('one', 'COLLECT THE SMALL MOMENTS') + '<figcaption>山间的风，和一个不赶时间的下午。</figcaption></figure><h2 id="slow-down">慢下来，才看得见</h2><p>把记录当作一种习惯，并不意味着每天都要写下很多文字。哪怕只有几行，也是在认真回应自己的生活。</p><p>给自己留一点空间，让语言有呼吸的余地。那些不经意写下的句子，可能会在未来的某一天，成为重新认识自己的线索。</p><h2 id="begin">不必急着完成，先开始就好</h2><p>一个想法，一页笔记，一次小小的开始。让文字慢慢生长，让日子留下回声。</p><pre tabindex="0" aria-label="代码示例，可横向滚动"><code>const day = { curiosity: true };\nwrite(day, { hurry: false });</code></pre></div><div class="article-end"><a class="button quiet" href="#home">' + icons.back + '返回文章</a><button class="button soft" data-demo="原型演示：正式版本保留文章链接复制">' + icons.link + '分享文章</button></div></article><aside class="article-toc" aria-label="文章目录"><p>这篇文章</p><a href="#small-things" data-anchor="small-things">值得被记住的小事</a><a href="#slow-down" data-anchor="slow-down">慢下来，才看得见</a><a href="#begin" data-anchor="begin">先开始就好</a></aside></main>' + footer() + '</div>';
}
function studioNavigation(view) {
  const nav = (key, icon, title, href = '#' + key) => '<a href="' + href + '" aria-label="' + title + '"' + (view === key ? ' aria-current="page"' : '') + '>' + icons[icon] + '<span class="nav-label">' + title + '</span>' + (key === 'editor' ? '<span class="count">4</span>' : '') + '</a>';
  return '<aside class="sidebar">' + brand() + '<nav aria-label="写作空间导航">' + nav('dashboard', 'home', '工作台') + nav('editor', 'file', '所有文章') + '<button data-library aria-haspopup="dialog" aria-label="图片库">' + icons.image + '<span class="nav-label">图片库</span></button><button data-demo="网站设置的详细原型将在 PR-06 完成" aria-label="网站设置">' + icons.settings + '<span class="nav-label">网站设置</span></button></nav><div class="sidebar-bottom"><a class="button quiet" href="#home">' + icons.external + '查看博客</a><div class="profile"><span class="avatar">林</span><div>林间<small>我的写作空间</small></div></div></div></aside>';
}
function mobileNav(view) {
  return '<nav class="mobile-studio-nav" aria-label="手机写作导航"><a href="#dashboard"' + (view === 'dashboard' ? ' aria-current="page"' : '') + '>' + icons.home + '工作台</a><a href="#editor"' + (view === 'editor' ? ' aria-current="page"' : '') + '>' + icons.file + '文章</a><button data-library aria-haspopup="dialog">' + icons.image + '图片库</button><a href="#home">' + icons.external + '博客</a></nav>';
}
function studio(view, content) {
  return '<div class="studio screen">' + studioNavigation(view) + '<main id="content" tabindex="-1" class="workspace' + (view === 'editor' ? ' editor-workspace' : '') + '"><header class="workspace-topbar"><div class="breadcrumb">写作空间 <span aria-hidden="true">/</span> <strong>' + (view === 'dashboard' ? '工作台' : '文章编辑') + '</strong></div><div class="actions"><a href="#home" class="button quiet top-site">' + icons.external + '查看博客</a>' + themeButton() + '</div></header>' + content + '</main>' + mobileNav(view) + '</div>';
}
function rows() {
  const list = posts.filter((p) => filter === '全部' || p.status === filter);
  return list.map((p) => '<div class="writing-row"><a href="#editor" class="row-title"><h3>' + p.title + '</h3><p>' + p.type + ' · ' + p.minutes + '</p></a><span class="badge' + (p.status === '草稿' ? ' neutral' : '') + '"><span class="dot"></span>' + p.status + '</span><time>' + p.date + '</time><a class="icon-button" href="#editor" aria-label="编辑：' + p.title + '">' + icons.arrow + '</a></div>').join('');
}
function dashboard() {
  return studio('dashboard', '<section class="studio-intro"><div><div class="eyebrow">属于你的写作时间</div><h1>你好，林间。</h1><p>有些想法，值得被好好留下。</p><a class="button primary" href="#editor" style="margin-top:24px">' + icons.plus + '开始新文章</a></div><img class="intro-mark" src="../../assets/cloudink.svg" alt="" width="110" height="110"></section><section aria-labelledby="writing-heading"><div class="dashboard-heading"><h2 id="writing-heading">我的文章 <span class="muted" style="font-size:14px">4</span></h2><div class="segment" role="group" aria-label="文章筛选">' + ['全部', '草稿', '已发布'].map((item) => '<button data-filter="' + item + '" aria-pressed="' + (filter === item) + '">' + item + '</button>').join('') + '</div></div><div class="writing-list card" id="writing-list">' + rows() + '</div></section><div class="dashboard-bottom"><section class="tip-card card"><span class="tip-icon">' + icons.image + '</span><div><h3>让文字，也有画面</h3><p>整理图片，收藏下一篇文章的灵感。</p><button class="button quiet" data-library aria-haspopup="dialog">打开图片库 ' + icons.arrow + '</button></div></section><section class="tip-card card"><span class="tip-icon">' + icons.cloud + '</span><div><h3>写下的，都好好留着</h3><p>草稿与发布分开，每一步都从容一点。</p><button class="button quiet" data-demo="备份与恢复界面将在 PR-06 设计">管理备份 ' + icons.arrow + '</button></div></section></div>');
}
function preview() {
  // Deliberately text-only: this study does not implement the production Markdown engine.
  return draftText.split('\n\n').map((part) => {
    if (part.startsWith('## ')) return '<h2>' + escape(part.slice(3)) + '</h2>';
    if (part.startsWith('> ')) return '<blockquote>' + escape(part.slice(2)) + '</blockquote>';
    return '<p>' + escape(part).replace(/\n/g, '<br>') + '</p>';
  }).join('');
}
function editor() {
  return studio('editor', '<div class="editor-bar"><span id="save-indicator" class="save-indicator">' + icons.check + '演示草稿 · 仅本页保留</span><div class="actions"><button class="button" id="demo-save">保存草稿</button><button class="button primary" id="demo-publish">' + icons.external + '发布文章</button></div></div><section class="editor-card card" data-pane="split"><label class="sr-only" for="demo-title">文章标题</label><input id="demo-title" class="title-input" value="' + escape(titleText) + '" maxlength="300"><label class="sr-only" for="demo-description">文章摘要</label><input id="demo-description" class="description-input" value="' + escape(descriptionText) + '"><div class="editor-meta"><span>' + icons.clock + ' 2026 年 10 月 12 日</span><span class="badge neutral">生活随笔</span><button class="button quiet" data-demo="文章地址：/posts/slow-days/">文章地址 ' + icons.link + '</button></div><div class="editor-tools"><div class="actions"><button class="icon-button" data-insert="**加粗文字**" aria-label="插入加粗"><strong>B</strong></button><button class="icon-button" data-insert="## 新标题" aria-label="插入标题">H₂</button><button class="icon-button" data-insert="> 引用内容" aria-label="插入引用">❞</button><button class="icon-button" data-library aria-label="从图片库选择" aria-haspopup="dialog">' + icons.image + '</button><button class="icon-button" data-insert="[链接文字](https://example.com)" aria-label="插入链接">' + icons.link + '</button></div><div class="segment" role="group" aria-label="编辑视图"><button data-pane="writing" aria-pressed="false">写作</button><button data-pane="split" aria-pressed="true">分栏</button><button data-pane="preview" aria-pressed="false">预览</button></div></div><div class="editor-panes"><label class="sr-only" for="demo-body">Markdown 正文</label><textarea id="demo-body" class="markdown" spellcheck="false">' + escape(draftText) + '</textarea><section class="preview-pane" aria-label="文章预览"><div class="article-body" id="demo-preview">' + preview() + '</div></section></div><div class="editor-foot"><span id="demo-wordcount">' + draftText.length + ' 字符 · 约 2 分钟阅读</span><span>Markdown · 随时开始，慢慢完成</span></div></section>');
}
const views = { home, article, dashboard, editor };
function route() {
  clearTimeout(saveTimer);
  const id = location.hash.slice(1);
  if (!views[id] && current === 'article' && document.getElementById(id)) return;
  const view = views[id] ? id : 'home';
  const from = current;
  current = view;
  app.innerHTML = views[view]();
  document.title = ({ home: '记录心之所向', article: posts[0].title, dashboard: '写作工作台', editor: '文章编辑' })[view] + ' · CloudInk 2.0 原型';
  document.querySelectorAll('[data-view]').forEach((link) => {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (from) document.getElementById('content').focus({ preventScroll: true });
}
function updateEditor() {
  draftText = document.getElementById('demo-body').value;
  document.getElementById('demo-preview').innerHTML = preview();
  document.getElementById('demo-wordcount').textContent = draftText.length + ' 字符 · 原型演示';
  document.getElementById('save-indicator').textContent = '有未保存的演示修改';
}
document.addEventListener('input', (event) => {
  if (event.target.id === 'demo-body') updateEditor();
  if (event.target.id === 'demo-title') titleText = event.target.value;
  if (event.target.id === 'demo-description') descriptionText = event.target.value;
});
document.addEventListener('click', (event) => {
  const element = event.target.closest('button,a');
  if (!element) return;
  if (element.matches('[data-theme-toggle]')) {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('cloudink-prototype-theme', root.dataset.theme); } catch {}
  }
  if (element.id === 'palette') {
    const neutral = root.dataset.palette !== 'neutral';
    root.dataset.palette = neutral ? 'neutral' : 'ink';
    element.setAttribute('aria-pressed', String(neutral));
    element.textContent = neutral ? '中性' : '墨绿';
  }
  if (element.hasAttribute('data-search')) {
    searchTrigger = element;
    const dialog = document.getElementById('search-dialog');
    document.getElementById('search-input').value = '';
    renderSearch('');
    dialog.showModal();
    document.getElementById('search-input').focus();
  }
  if (element.hasAttribute('data-library')) {
    libraryTrigger = element;
    document.getElementById('library-dialog').showModal();
  }
  if (element.hasAttribute('data-demo')) toast(element.dataset.demo);
  if (element.hasAttribute('data-filter')) {
    filter = element.dataset.filter;
    document.getElementById('writing-list').innerHTML = rows();
    document.querySelectorAll('[data-filter]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.filter === filter)));
  }
  if (element.hasAttribute('data-pane')) {
    document.querySelector('.editor-card').dataset.pane = element.dataset.pane;
    document.querySelectorAll('button[data-pane]').forEach((button) => button.setAttribute('aria-pressed', String(button === element)));
  }
  if (element.hasAttribute('data-insert')) {
    const textarea = document.getElementById('demo-body');
    textarea.setRangeText(element.dataset.insert, textarea.selectionStart, textarea.selectionEnd, 'end');
    updateEditor();
    textarea.focus();
  }
  if (element.hasAttribute('data-anchor')) {
    event.preventDefault();
    document.getElementById(element.dataset.anchor).scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  if (element.id === 'demo-save' || element.id === 'demo-publish') {
    clearTimeout(saveTimer);
    const publishing = element.id === 'demo-publish';
    element.disabled = true;
    element.setAttribute('aria-busy', 'true');
    element.textContent = publishing ? '演示发布中…' : '演示保存中…';
    saveTimer = setTimeout(() => {
      element.disabled = false;
      element.removeAttribute('aria-busy');
      element.textContent = publishing ? '发布文章' : '保存草稿';
      const status = document.getElementById('save-indicator');
      if (status) status.textContent = publishing ? '发布演示完成' : '演示草稿已保存';
      toast('交互演示完成；没有写入存储或发布内容');
    }, 450);
  }
});
function renderSearch(query) {
  const list = posts.filter((p) => (p.title + p.description).includes(query.trim()));
  document.getElementById('search-results').innerHTML = list.length ? list.map((p) => '<a href="#article">' + p.title + '<small>' + p.description + '</small></a>').join('') : '<p>还没有找到匹配的文字。试试“生活”或“写作”？</p>';
}
document.getElementById('search-input').addEventListener('input', (event) => renderSearch(event.target.value));
document.getElementById('search-dialog').addEventListener('click', (event) => {
  if (event.target.closest('a')) document.getElementById('search-dialog').close();
});
document.getElementById('search-dialog').addEventListener('close', () => {
  if (searchTrigger?.isConnected) searchTrigger.focus({ preventScroll: true });
});
document.getElementById('library-dialog').addEventListener('close', () => {
  if (libraryTrigger?.isConnected) libraryTrigger.focus({ preventScroll: true });
});
window.addEventListener('hashchange', route);
document.getElementById('palette').textContent = root.dataset.palette === 'neutral' ? '中性' : '墨绿';
document.getElementById('palette').setAttribute('aria-pressed', String(root.dataset.palette === 'neutral'));
route();
