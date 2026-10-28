const $ = (selector) => document.querySelector(selector);
const routes = {
  home: 'home',
  article: 'article',
  space: 'article',
  rain: 'article',
  about: 'about',
};
const titles = {
  article: '把日子过成喜欢的样子',
  space: '为自己的博客，留一点空白',
  rain: '雨停之后，去走一走',
};
let menuOpen = false;
function closeMenu(restore = false) {
  menuOpen = false;
  $('#mobile-menu').hidden = true;
  $('#menu').setAttribute('aria-expanded', 'false');
  $('#menu').setAttribute('aria-label', '打开导航');
  if (restore) $('#menu').focus();
}
function route() {
  const key = location.hash.slice(1) || 'home';
  if (['moments', 'slow', 'practice', 'ending'].includes(key)) return;
  const view = routes[key] || 'home';
  for (const id of ['home', 'article', 'about']) $('#' + id).hidden = id !== view;
  if (view === 'article') {
    $('#article-title').textContent = titles[key] || titles.article;
    $('#article-meta').textContent =
      key === 'space'
        ? '技术思考 · 2026.10.16'
        : key === 'rain'
          ? '日常记录 · 2026.10.03'
          : '生活随笔 · 2026.10.28';
  }
  document.querySelectorAll('[data-nav]').forEach((link) => {
    if (link.dataset.nav === (view === 'article' ? 'home' : view))
      link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  closeMenu();
  window.scrollTo(0, 0);
  $('#main').focus({ preventScroll: true });
  document.title =
    (view === 'article'
      ? $('#article-title').textContent
      : view === 'about'
        ? '关于设计原型'
        : '云砚手记') + ' · CloudInk 原型';
}
$('#illustration').addEventListener('change', (event) =>
  document.body.classList.toggle('no-art', event.target.value === 'off'),
);
$('#theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#theme').setAttribute('aria-label', dark ? '切换为浅色主题' : '切换为深色主题');
});
$('#menu').addEventListener('click', () => {
  menuOpen = !menuOpen;
  $('#mobile-menu').hidden = !menuOpen;
  $('#menu').setAttribute('aria-expanded', String(menuOpen));
  $('#menu').setAttribute('aria-label', menuOpen ? '关闭导航' : '打开导航');
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menuOpen) closeMenu(true);
});
const data = [
  { key: 'article', title: titles.article, description: '有些答案，藏在那些不赶时间的日子里。' },
  { key: 'space', title: titles.space, description: '空白不是缺席，而是一种选择。' },
  { key: 'rain', title: titles.rain, description: '空气格外清澈，重新开始的可能。' },
];
function search() {
  const query = $('#query').value.trim().toLocaleLowerCase();
  const results = data.filter((item) =>
    (item.title + item.description).toLocaleLowerCase().includes(query),
  );
  $('#results').replaceChildren();
  for (const item of results) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#' + item.key;
    a.textContent = item.title;
    const detail = document.createElement('small');
    detail.textContent = item.description;
    a.append(detail);
    a.addEventListener('click', () => $('#search').close());
    li.append(a);
    $('#results').append(li);
  }
  $('#search-status').textContent = results.length
    ? results.length + ' 篇示例文章'
    : '没有找到匹配的文章，试试其他关键词。';
}
$('#search-open').addEventListener('click', () => {
  closeMenu();
  $('#search').showModal();
  search();
  $('#query').focus();
});
$('#search-close').addEventListener('click', () => $('#search').close());
$('#search').addEventListener('close', () => $('#search-open').focus());
$('#query').addEventListener('input', search);
$('#copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    $('#copy-status').textContent = '链接已复制';
  } catch {
    $('#copy-status').textContent = '无法自动复制，请复制浏览器地址。';
  }
});
const observer = new IntersectionObserver(
  (entries) => {
    const current = entries.find((entry) => entry.isIntersecting);
    if (!current) return;
    document
      .querySelectorAll('.toc a')
      .forEach((link) => link.classList.toggle('active', link.hash === '#' + current.target.id));
  },
  { rootMargin: '-10% 0px -65% 0px' },
);
document.querySelectorAll('.prose h2').forEach((heading) => observer.observe(heading));
window.addEventListener('hashchange', route);
route();
