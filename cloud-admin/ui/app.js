import { imageUploadForm as prepareImageUploadForm } from './image-upload.js';
import '../../assets/motion.js';
import '../../assets/mobile.js';
import { mountStudioShell } from './shell.js';
import { feedback, confirmAction, mountEditorPanes } from './workflows.js';
import { configureImages } from './images.js';
import { configureShorts } from './shorts.js';
import { configureSiteIcon } from './site-icon.js';
import { configureMarkdownImport } from './markdown-import.js';
import {
  engineTask,
  renderPreview,
  invalidatePreview,
  disposePreview,
  configurePreview,
} from './preview.js';
import { editorStore } from './store.js';

const motion = window.CloudInkMotion;
motion.mount();
const shell = mountStudioShell();
let postFilter = 'all',
  postCursor = null,
  postCounts = null,
  listRevision = 0,
  searchTimer;

const $ = (id) => document.getElementById(id);
const keepOriginal = $('image-keep-original');
try {
  keepOriginal.checked = localStorage.getItem('cloudink-keep-original') === 'true';
} catch {}
keepOriginal.addEventListener('change', () => {
  try {
    localStorage.setItem('cloudink-keep-original', String(keepOriginal.checked));
  } catch {}
});
function imageUploadForm(file, options) {
  return prepareImageUploadForm(file, options || { compact: !keepOriginal.checked });
}
const fields = ['title', 'description', 'date', 'slug', 'body'];
let csrf = '',
  posts = [],
  site = null,
  doc = null,
  dirty = 0,
  savedVersion = 0,
  conflict = false,
  savePromise = null,
  autosaveTimer = null,
  previewTimer = null,
  settingsEtag = null;
const articleCache = new Map(),
  articleRequests = new Map();
let navigationVersion = 0,
  editorLocked = false,
  publishingBusy = false,
  publishRequest = false,
  lastPublished = '',
  polling = false,
  publishingId = '',
  publicInitialized = false;
let uploading = null;
const activeActions = new Set();
let noticeTimer;
let appConfig, configReady;
let booting = false;
let pendingWorkspace = null;
function showStartup(error = '') {
  $('startup-view').hidden = false;
  $('startup-view').dataset.state = error ? 'error' : 'loading';
  $('startup-view').setAttribute('aria-busy', String(!error));
  $('startup-message').setAttribute('role', error ? 'alert' : 'status');
  $('startup-message').textContent = error || '正在打开你的写作空间…';
  $('startup-retry').hidden = !error;
  $('startup-retry').disabled = !error;
  $('login-view').hidden = true;
  $('setup-view').hidden = true;
  $('app-view').hidden = true;
  $('studio-skip').hidden = true;
}
async function startWorkspace({ focus = false } = {}) {
  if (booting) return;
  booting = true;
  showStartup();
  configReady = api('/api/config').then((config) => {
    appConfig = config;
    configurePreview(config);
    $('site-link').href = config.siteUrl;
    $('service-site-link').href = config.siteUrl;
    $('service-site-link').textContent = config.siteUrl;
    return config;
  });
  try {
    // Settle both reads before choosing a view; an early 401 must not flash the login form.
    const [config, session] = await Promise.allSettled([configReady, api('/api/session')]);
    if (config.status === 'rejected') throw config.reason;
    if (!config.value.initialized) showLogin({ focus });
    else if (session.status === 'fulfilled') await signedIn(session.value, { focus });
    else if (session.reason.status === 401) showLogin({ focus });
    else throw session.reason;
  } catch (error) {
    if (error.status === 401) showLogin({ focus });
    else {
      showStartup(error.status ? error.message : '暂时无法打开写作空间，请检查网络后重试。');
      if (focus && document.activeElement === document.body)
        $('startup-retry').focus({ preventScroll: true });
    }
  } finally {
    booting = false;
  }
}
let illustrationPicker, illustrationLoader;
function loadIllustrationPicker() {
  illustrationLoader ||= import('/home-illustration.js')
    .then((module) => {
      illustrationPicker = module.configureHomeIllustration({ api, notice });
      return illustrationPicker;
    })
    .catch(() => {
      illustrationLoader = null;
      throw new Error('网站设置组件暂时无法加载，请刷新后台后重试。');
    });
  return illustrationLoader;
}
const iconPicker = configureSiteIcon({ api, notice });
function applySiteAppearance(config) {
  const palette = config?.themePalette || 'ink';
  window.CloudInkTheme?.setPalette(palette);
  iconPicker.apply(config);
  if (site) {
    site.themePalette = palette;
    site.siteIcon = config?.siteIcon || '';
    site.homeIllustration = config?.homeIllustration || '';
  }
}
function notice(message, tone = 'info') {
  $('notice').dataset.tone = tone;
  $('notice').textContent = message;
  $('notice').classList.add('visible');
  motion.enter($('notice'), { kind: 'toast' });
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    motion.exit($('notice'), { onFinish: () => $('notice').classList.remove('visible') });
  }, 6500);
}

const operationAreas = {
  'save-site': 'site-feedback',
  'publish-settings': 'site-feedback',
  'save-account': 'account-feedback',
  'download-backup': 'backup-status',
  'restore-backup': 'backup-status',
  'image-library-upload': 'image-library-status',
};
async function action(id, label, work, success = '') {
  if (activeActions.has(id)) return;
  const button = $(id),
    labelNode = button.querySelector('[data-action-label]') || button,
    original = labelNode.textContent,
    originalInlineSize = button.style.inlineSize,
    initialWidth = button.offsetWidth;
  activeActions.add(id);
  if (initialWidth) button.style.inlineSize = `min(${initialWidth}px, 100%)`;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  labelNode.textContent = label;
  feedback(operationAreas[id], label, 'pending');
  try {
    await work();
    const message =
      success || (id === 'publish-settings' ? '发布请求已处理，请查看上方发布状态。' : undefined);
    feedback(operationAreas[id], message, 'success');
    if (success) notice(success, 'success');
  } catch (error) {
    feedback(operationAreas[id], error.message, 'error');
    notice(error.message, 'error');
  } finally {
    activeActions.delete(id);
    button.removeAttribute('aria-busy');
    button.style.inlineSize = originalInlineSize;
    labelNode.textContent = original;
    button.disabled = false;
    publishingControls();
  }
}
function navigationStatus(message = '') {
  $('navigation-status').hidden = !message;
  $('navigation-status').textContent = message;
}
function cacheArticle(slug, data) {
  articleCache.delete(slug);
  articleCache.set(slug, structuredClone(data));
  if (articleCache.size > 20) articleCache.delete(articleCache.keys().next().value);
}
function fetchArticle(slug) {
  if (!articleRequests.has(slug))
    articleRequests.set(
      slug,
      api(`/api/posts/${slug}`)
        .then((data) => {
          cacheArticle(slug, data);
          return data;
        })
        .finally(() => articleRequests.delete(slug)),
    );
  return articleRequests.get(slug);
}
function prefetchArticle(slug) {
  if (!articleCache.has(slug)) void fetchArticle(slug).catch(() => {});
}
function lockEditor(locked) {
  editorLocked = locked;
  fields.forEach((id) => ($(id).readOnly = locked));
  $('slug').readOnly =
    locked || !!doc?.etag || posts.some((p) => p.slug === doc?.front_matter.slug && p.published);
}
function localSaved(draft, result) {
  const slug = draft.front_matter.slug,
    old = posts.find((p) => p.slug === slug),
    post = {
      ...draft.front_matter,
      published: old?.published ?? (doc?.front_matter.slug === slug ? !!doc.published : false),
      has_draft: true,
      changed: true,
      etag: result.etag,
    };
  posts = posts.filter((p) => p.slug !== slug);
  posts.push(post);
  if (result.created && postCounts) {
    postCounts.total++;
    postCounts.draft++;
  }
  cacheArticle(slug, {
    draft: result.draft,
    source: result.source,
    etag: result.etag,
  });
  renderLists();
}

const privateReads = new Map();
const invalidateReads = () => privateReads.clear();
window.addEventListener('focus', invalidateReads);
const readChannel =
  typeof BroadcastChannel === 'function' ? new BroadcastChannel('cloudink-content') : null;
if (readChannel)
  readChannel.onmessage = () => {
    invalidateReads();
    window.dispatchEvent(new Event('cloudink-content-changed'));
  };
async function api(path, options = {}) {
  const method = options.method || 'GET';
  if (!['GET', 'HEAD'].includes(method)) {
    invalidateReads();
    readChannel?.postMessage('changed');
  }
  const cacheable = method === 'GET' && /^\/api\/(?:posts|shorts)(?:\?|$)/.test(path);
  if (!cacheable) return requestApi(path, options);
  let entry = privateReads.get(path);
  if (!entry || entry.expires < Date.now()) {
    if (privateReads.size >= 16) privateReads.delete(privateReads.keys().next().value);
    entry = { expires: Date.now() + 10000, promise: requestApi(path, options) };
    privateReads.set(path, entry);
  }
  try {
    return structuredClone(await entry.promise);
  } catch (error) {
    if (error.status === 409) invalidateReads();
    else if (privateReads.get(path) === entry) privateReads.delete(path);
    throw error;
  }
}
async function requestApi(path, options = {}) {
  const { rawBody, ...init } = options;
  options = init;
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !rawBody) {
    headers.set('Content-Type', 'application/json');
    options.body = JSON.stringify(options.body);
  }
  if (options.method && options.method !== 'GET') headers.set('X-CSRF-Token', csrf);
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      credentials: 'same-origin',
      signal: options.signal || AbortSignal.timeout(45000),
    });
  } catch {
    throw new Error(
      navigator.onLine
        ? '请求暂时没有完成，请重试；当前文字仍保留在编辑器中。'
        : '网络已断开，当前文字仍保留在编辑器中，请联网后保存。',
    );
  }
  const data = await response.json().catch(() => ({ error: '服务暂时没有响应，请稍后重试。' }));
  if (!response.ok) {
    const error = new Error(data.error || '操作未完成。');
    error.status = response.status;
    if (response.status === 401) invalidateReads();
    if (response.status === 401 && path !== '/api/login' && !booting) showLogin({ focus: true });
    throw error;
  }
  if (options.method && !['GET', 'HEAD'].includes(options.method)) {
    invalidateReads();
    readChannel?.postMessage('changed');
    window.dispatchEvent(new Event('cloudink-content-changed'));
  }
  return data;
}
function showLogin({ focus = false } = {}) {
  pendingWorkspace = null;
  shell.close();
  $('studio-skip').hidden = true;
  motion.cancelWithin($('app-view'));
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  clearTimeout(autosaveTimer);
  $('app-view').hidden = true;
  const wizard = appConfig && !appConfig.initialized;
  $('setup-view').hidden = !wizard;
  $('login-view').hidden = wizard;
  $('startup-view').hidden = true;
  if (focus)
    (wizard ? $('setup-form').elements.token : $('login-form').elements.email).focus({
      preventScroll: true,
    });
  csrf = '';
  articleCache.clear();
  articleRequests.clear();
  disposePreview();
}
function setZen(active) {
  $('app-view').classList.toggle('zen-mode', active);
  const button = $('toggle-zen');
  button.setAttribute('aria-pressed', String(active));
  button.title = active ? '退出专注写作' : '进入专注写作';
  button.setAttribute('aria-label', button.title);
  button
    .querySelector('path')
    .setAttribute(
      'd',
      active ? 'M3 8h5V3m8 0v5h5M3 16h5v5m8 0v-5h5' : 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
    );
}
function view(name, { focus = true } = {}) {
  if (name !== 'editor') setZen(false);
  const changingView = $('app-view').dataset.view !== name;
  const sectionName = name === 'posts' ? 'home' : name;
  const fromNavigation = document.activeElement?.closest(
    '.studio-nav,#post-list,.article-card,[data-studio-shortcut],.brand',
  );
  shell.close();
  $('app-view').dataset.view = name;
  for (const button of document.querySelectorAll('[data-studio-nav]')) {
    const selected =
      button.dataset.studioNav === (name === 'editor' || name === 'posts' ? 'articles' : name);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const id of ['home', 'editor', 'images', 'shorts', 'settings']) {
    const section = $(id + '-view');
    if (id !== sectionName) motion.cancelWithin(section);
    section.hidden = id !== sectionName;
    section.tabIndex = -1;
  }
  if (changingView && $('article-search-slot'))
    $(name === 'editor' ? 'editor-search-slot' : 'article-search-slot').prepend(
      $('article-browser'),
    );
  $('article-browser').hidden = !['home', 'posts', 'editor'].includes(name);
  $('posts-title').hidden = name !== 'posts';
  $('home-view').setAttribute('aria-labelledby', name === 'posts' ? 'posts-title' : 'home-heading');
  motion.enter($(sectionName + '-view'), { kind: 'content' });
  $('workspace-title').textContent = {
    home: '工作台',
    posts: '所有文章',
    editor: '文章编辑',
    settings: '网站设置',
    images: '图片库',
    shorts: '短记',
  }[name];
  if (focus && (fromNavigation || changingView))
    $(sectionName + '-view').focus({ preventScroll: true });
}
async function signedIn(session, { focus = false, afterReady = null } = {}) {
  await configReady;
  csrf = session.csrf;
  appConfig.initialized = true;
  $('account-email').textContent = session.email;
  $('account-form').elements.email.value = session.email;
  pendingWorkspace = { session, afterReady };
  showStartup();
  try {
    await refresh();
  } catch (error) {
    if (error.status === 401) showLogin({ focus });
    else {
      showStartup(error.status ? error.message : '暂时无法读取工作区，请检查网络后重试。');
      if (focus && document.activeElement === document.body)
        $('startup-retry').focus({ preventScroll: true });
    }
    return false;
  }
  pendingWorkspace = null;
  $('startup-view').hidden = true;
  $('setup-view').hidden = true;
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  $('studio-skip').hidden = false;
  view('home', { focus: false });
  if (focus) $('workspace').focus({ preventScroll: true });
  (window.requestIdleCallback || setTimeout)(() => {
    void engineTask('warm').catch(() => {});
  });
  return true;
}
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  $('login-error').textContent = '';
  $('login-submit').disabled = true;
  $('login-submit').setAttribute('aria-busy', 'true');
  $('login-submit').textContent = '正在登录…';
  try {
    await signedIn(
      await api('/api/login', {
        method: 'POST',
        body: { email: form.elements.email.value, password: form.elements.password.value },
      }),
      { focus: true },
    );
    form.reset();
  } catch (error) {
    $('login-error').textContent = error.message;
  } finally {
    $('login-submit').disabled = false;
    $('login-submit').removeAttribute('aria-busy');
    $('login-submit').textContent = '登录';
  }
});
$('startup-retry').addEventListener('click', async () => {
  if (!pendingWorkspace) return void startWorkspace({ focus: true });
  if (booting) return;
  const pending = pendingWorkspace;
  booting = true;
  try {
    const ready = await signedIn(pending.session, { focus: true, afterReady: pending.afterReady });
    booting = false;
    if (ready) await pending.afterReady?.();
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    booting = false;
  }
});
void startWorkspace();

function setupStep(siteStep) {
  $('setup-account-step').hidden = siteStep;
  $('setup-site-step').hidden = !siteStep;
  $('setup-site-step').disabled = !siteStep;
  $('setup-progress-account').toggleAttribute('aria-current', !siteStep);
  $('setup-progress-site').toggleAttribute('aria-current', siteStep);
  if (siteStep) $('setup-progress-site').setAttribute('aria-current', 'step');
  else $('setup-progress-account').setAttribute('aria-current', 'step');
  $('setup-error').textContent = '';
  motion.enter($(siteStep ? 'setup-site-step' : 'setup-account-step'), { kind: 'content' });
  $('setup-form').elements[siteStep ? 'title' : 'token'].focus();
}
$('setup-next').addEventListener('click', () => {
  const form = $('setup-form');
  for (const input of $('setup-account-step').querySelectorAll('input'))
    if (!input.reportValidity()) return;
  if (form.elements.password.value !== form.elements.confirm.value) {
    $('setup-error').textContent = '两次输入的密码不一致。';
    return;
  }
  if (!form.elements.author.value)
    form.elements.author.value = form.elements.email.value.split('@')[0];
  setupStep(true);
});
$('setup-back').addEventListener('click', () => setupStep(false));
$('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!$('setup-account-step').hidden) {
    $('setup-next').click();
    return;
  }
  const form = event.currentTarget;
  await action('setup-submit', '正在创建博客…', async () => {
    $('setup-error').textContent = '';
    try {
      const session = await api('/api/setup', {
        method: 'POST',
        headers: { Authorization: `Bearer ${form.elements.token.value}` },
        body: {
          email: form.elements.email.value,
          password: form.elements.password.value,
          site: {
            title: form.elements.title.value,
            author: form.elements.author.value,
            subtitle: form.elements.subtitle.value,
            description: '',
            about: '',
          },
        },
      });
      form.reset();
      const afterReady = () => startPublish({ rebuild: true });
      if (await signedIn(session, { focus: true, afterReady })) await afterReady();
    } catch (error) {
      $('setup-error').textContent = error.message;
      if (error.status === 409) {
        appConfig.initialized = true;
        showLogin({ focus: true });
        $('login-error').textContent = '账号已经创建，请使用设置的邮箱和密码登录。';
      }
      throw error;
    }
  });
});
$('publish-welcome').addEventListener('click', () =>
  action('publish-welcome', '正在生成页面…', () => startPublish({ rebuild: true })),
);

function badge(post) {
  return post.published ? (post.changed ? '有未发布修改' : '已发布') : '草稿';
}
function renderLists() {
  const hasPosts = (postCounts?.total ?? posts.length) > 0;
  const query = $('search').value.trim().toLowerCase();
  const sorted = [...posts].sort((a, b) => b.date.localeCompare(a.date));
  const totalCount = postCounts?.total ?? posts.length;
  const publishedCount = postCounts?.published ?? posts.filter((p) => p.published).length;
  const draftCount = postCounts?.draft ?? posts.filter((p) => !p.published).length;

  $('post-count').textContent = totalCount;
  $('load-more-posts').hidden = $('load-more-switcher').hidden = !postCursor;
  document.querySelector('[data-post-count]').textContent = totalCount;
  for (const button of document.querySelectorAll('[data-post-filter]'))
    button.setAttribute('aria-pressed', String(button.dataset.postFilter === postFilter));

  const sidebarAll = $('sidebar-count-all');
  if (sidebarAll) sidebarAll.textContent = totalCount;
  const sidebarPub = $('sidebar-count-published');
  if (sidebarPub) sidebarPub.textContent = publishedCount;
  const sidebarDraft = $('sidebar-count-draft');
  if (sidebarDraft) sidebarDraft.textContent = draftCount;
  for (const item of document.querySelectorAll('[data-sidebar-filter]')) {
    const selected = item.dataset.sidebarFilter === postFilter;
    item.classList.toggle('is-active', selected);
    item.setAttribute('aria-pressed', String(selected));
  }

  let shown = 0;
  $('summary').textContent = `${publishedCount} 篇已发布 · ${draftCount} 篇草稿`;
  $('post-list').replaceChildren();
  $('article-grid').replaceChildren();
  for (const post of sorted) {
    if (query && !`${post.title} ${post.description} ${post.slug}`.toLowerCase().includes(query))
      continue;
    const button = document.createElement('button');
    button.className = 'post-item' + (doc?.front_matter.slug === post.slug ? ' active' : '');
    const title = document.createElement('span');
    title.textContent = post.title;
    const small = document.createElement('small');
    small.textContent = `${post.date} · ${badge(post)}`;
    button.append(title, small);
    button.addEventListener('pointerenter', () => prefetchArticle(post.slug));
    button.addEventListener('focus', () => prefetchArticle(post.slug));
    button.addEventListener('click', () =>
      openPost(post.slug).catch((error) => notice(error.message)),
    );
    $('post-list').append(button);
    if (
      (postFilter === 'published' && !post.published) ||
      (postFilter === 'draft' && post.published)
    )
      continue;
    shown++;
    const card = document.createElement('button');
    card.className = 'article-card';
    const tag = document.createElement('span');
    tag.className = 'badge' + (post.changed || !post.published ? ' draft' : '');
    tag.textContent = badge(post);
    const h = document.createElement('h3');
    h.textContent = post.title;
    const p = document.createElement('p');
    p.textContent = post.description || '没有摘要';
    const date = document.createElement('small');
    date.textContent = post.date;
    const arrow = document.createElement('span');
    arrow.className = 'article-card-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '→';
    card.append(tag, h, p, date, arrow);
    card.addEventListener('pointerenter', () => prefetchArticle(post.slug));
    card.addEventListener('focus', () => prefetchArticle(post.slug));
    card.addEventListener('click', () =>
      openPost(post.slug).catch((error) => notice(error.message)),
    );
    $('article-grid').append(card);
  }
  if (!shown) {
    const empty = document.createElement('div');
    empty.className = 'studio-empty';
    const title = document.createElement('h3'),
      text = document.createElement('p');
    title.textContent = hasPosts ? '还没有找到匹配的文章' : '你的第一篇文字，从这里开始。';
    text.textContent = hasPosts
      ? '换一个关键词，或查看全部文章。'
      : '点击“新文章”开始写作，也可以从更多操作导入原稿。';
    empty.append(title, text);
    if (hasPosts) {
      const reset = document.createElement('button');
      reset.textContent = '清除筛选';
      reset.addEventListener('click', () => {
        $('search').value = '';
        postFilter = 'all';
        void refresh().catch((error) => notice(error.message));
        $('search').focus();
      });
      empty.append(reset);
    }
    $('article-grid').append(empty);
  }
  if (!$('post-list').childElementCount) {
    const empty = document.createElement('p');
    empty.className = 'studio-list-empty';
    empty.textContent = hasPosts
      ? '没有匹配的文章，请修改搜索关键词。'
      : '还没有文章，先开始新文章。';
    $('post-list').append(empty);
  }
}
async function refresh({ append = false } = {}) {
  clearTimeout(searchTimer);
  const revision = ++listRevision;
  const params = new URLSearchParams({
    limit: '50',
    q: $('search').value.trim(),
    filter: postFilter,
  });
  if (append && postCursor) params.set('cursor', postCursor);
  let data;
  try {
    data = await api('/api/posts?' + params);
  } catch (error) {
    if (append && error.status === 409) return refresh();
    throw error;
  }
  if (revision !== listRevision) return;
  posts = append ? [...posts, ...data.posts] : data.posts;
  postCursor = data.cursor;
  postCounts = data.counts;
  publicInitialized = data.publicInitialized;
  const status = $('template-status');
  if (status) {
    const message =
      {
        outdated:
          '有新版排版待应用。点击“更新网站排版”即可更新公开页面，草稿和未发布设置保持私有。',
        current: '网站排版已是最新。',
      }[data.templateStatus] || '';
    status.hidden = !message;
    if (status.textContent !== message) status.textContent = message;
  }
  site = data.site;
  applySiteAppearance(data.appearance || data.site);
  $('site-brand-title').textContent = data.site.title;
  const userLabel = $('studio-user-label') || $('flclash-user-label');
  if (userLabel) userLabel.textContent = data.site.author || '云砚';
  const avatarLetter = (data.site.author || '云砚').charAt(0);
  const avatarEl = document.querySelector('.studio-user-avatar, .flclash-user-avatar');
  if (avatarEl) avatarEl.textContent = avatarLetter;
  $('home-heading').textContent = data.site.author
    ? '你好，' + data.site.author + '。'
    : '从一个想法开始。';
  for (const [slug, cached] of articleCache) {
    const post = posts.find((p) => p.slug === slug);
    if (!post || (post.etag && post.etag !== cached.etag)) articleCache.delete(slug);
  }
  renderLists();
  showPublishing(data.publishing);
  void updateSidebarShorts();
}
function currentDraft() {
  return {
    front_matter: {
      title: $('title').value,
      slug: $('slug').value,
      date: $('date').value,
      description: $('description').value,
      draft: true,
      ...(doc?.front_matter.updated ? { updated: doc.front_matter.updated } : {}),
      ...(doc?.front_matter.aliases?.length ? { aliases: doc.front_matter.aliases } : {}),
    },
    body_markdown: $('body').value,
  };
}
function preview() {
  if (
    !doc ||
    $('editor-view').hidden ||
    (!matchMedia('(min-width:1100px)').matches &&
      !$('editor-panes').classList.contains('preview-only')) ||
    $('editor-panes').classList.contains('writing-only')
  )
    return;
  const draft = currentDraft();
  draft.front_matter.title ||= '未命名文章';
  draft.front_matter.slug ||= 'preview';
  renderPreview(draft, site);
}
function fillEditor(draft, etag) {
  clearTimeout(previewTimer);
  invalidatePreview(true);
  doc = {
    ...draft,
    etag,
    published: posts.some((p) => p.slug === draft.front_matter.slug && p.published),
  };
  dirty = 0;
  savedVersion = 0;
  conflict = false;
  $('title').value = draft.front_matter.title;
  $('description').value = draft.front_matter.description;
  $('date').value = draft.front_matter.date;
  $('slug').value = draft.front_matter.slug;
  $('slug').readOnly =
    !!etag || posts.some((p) => p.slug === draft.front_matter.slug && p.published);
  $('body').value = draft.body_markdown;
  feedback('save-state', etag ? '草稿已保存' : '尚未保存草稿', etag ? 'success' : 'neutral');
  const published = posts.some((p) => p.slug === draft.front_matter.slug && p.published);
  $('unpublish-post').hidden = !published;
  $('delete-post').hidden = published;
  view('editor');
  renderLists();
  wordCount();
  void preview();
}
function saveLocalSnapshot(slug, draft) {
  if (!slug || !draft) return;
  try {
    const key = `cloudink-snapshots:${slug}`;
    const raw = localStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    if (list.length > 0 && Math.abs(now - list[0].time) < 30000) {
      list[0] = { time: now, title: draft.front_matter?.title || '', draft };
    } else {
      list.unshift({ time: now, title: draft.front_matter?.title || '', draft });
      if (list.length > 20) list.pop();
    }
    localStorage.setItem(key, JSON.stringify(list));
  } catch {}
}
function wordCount() {
  $('word-count').textContent =
    `${$('body').value.replace(/\s/g, '').length.toLocaleString()} 个字符`;
}
function changed() {
  if (!doc) return;
  invalidatePreview();
  dirty++;
  editorStore.update((s) => ({
    ...s,
    dirty,
    slug: doc?.front_matter?.slug || '',
    title: $('title')?.value || '',
  }));
  saveLocalSnapshot(doc.front_matter?.slug, currentDraft());
  feedback('save-state', '有未保存的修改', 'pending');
  wordCount();
  clearTimeout(autosaveTimer);
  if (!conflict)
    autosaveTimer = setTimeout(() => saveCurrent().catch((error) => notice(error.message)), 1500);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void preview(), 350);
}
fields.forEach((id) => $(id).addEventListener('input', changed));

$('open-draft-history')?.addEventListener('click', () => {
  const slug = doc?.front_matter?.slug;
  if (!slug) {
    notice('请先打开或新建一篇文章。', 'info');
    return;
  }
  const dialog = $('draft-history-dialog');
  const listEl = $('draft-history-list');
  listEl.replaceChildren();
  const key = `cloudink-snapshots:${slug}`;
  let snapshots = [];
  try {
    snapshots = JSON.parse(localStorage.getItem(key) || '[]');
  } catch {}
  if (snapshots.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.style.padding = '12px 0';
    empty.textContent = '当前文章暂无历史快照。继续编辑将自动生成。';
    listEl.append(empty);
  } else {
    for (const snap of snapshots) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:var(--paper);gap:12px;';
      const info = document.createElement('div');
      const timeStr = new Date(snap.time).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const chars = (snap.draft?.body_markdown || '').replace(/\s/g, '').length;
      info.innerHTML = `<strong>${timeStr}</strong> <span class="muted" style="font-size:12px;margin-left:8px;">${chars} 字符</span>`;
      const restoreBtn = document.createElement('button');
      restoreBtn.textContent = '恢复此快照';
      restoreBtn.className = 'quiet';
      restoreBtn.style.fontSize = '12px';
      restoreBtn.addEventListener('click', () => {
        if (confirm('确定恢复到该历史快照吗？当前编辑框内容将被替换。')) {
          $('body').value = snap.draft?.body_markdown || '';
          if (snap.draft?.front_matter?.title) $('title').value = snap.draft.front_matter.title;
          if (snap.draft?.front_matter?.description)
            $('description').value = snap.draft.front_matter.description;
          changed();
          dialog.close();
          notice('已恢复本地快照内容。', 'success');
        }
      });
      row.append(info, restoreBtn);
      listEl.append(row);
    }
  }
  dialog.showModal();
});
$('draft-history-close')?.addEventListener('click', () => {
  $('draft-history-dialog')?.close();
});
$('shortcuts-close')?.addEventListener('click', () => {
  const dlg = $('shortcuts-dialog');
  if (!dlg) return;
  if (window.CloudInkMotion?.closeDialog) window.CloudInkMotion.closeDialog(dlg);
  else dlg.close();
});
$('open-shortcuts')?.addEventListener('click', () => {
  const dlg = $('shortcuts-dialog');
  if (!dlg) return;
  if (window.CloudInkMotion?.openDialog) window.CloudInkMotion.openDialog(dlg);
  else dlg.showModal();
});
window.addEventListener('keydown', (e) => {
  if (
    (e.key === '?' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) ||
    ((e.ctrlKey || e.metaKey) && e.key === '/')
  ) {
    const dlg = $('shortcuts-dialog');
    if (!dlg) return;
    e.preventDefault();
    if (dlg.open) {
      if (window.CloudInkMotion?.closeDialog) window.CloudInkMotion.closeDialog(dlg);
      else dlg.close();
    } else {
      if (window.CloudInkMotion?.openDialog) window.CloudInkMotion.openDialog(dlg);
      else dlg.showModal();
    }
  }
});
async function saveCurrent() {
  clearTimeout(autosaveTimer);
  if (!doc || $('editor-view').hidden) return;
  if (conflict) throw new Error('当前内容与云端冲突，请先下载原稿，再重新打开文章。');
  if (savePromise) {
    await savePromise;
    if (dirty > savedVersion) return saveCurrent();
    return;
  }
  if (dirty === savedVersion && doc.etag) return;
  const captured = currentDraft();
  if (!captured.front_matter.title.trim()) {
    feedback('save-state', '填写标题后自动保存', 'neutral');
    return;
  }
  const version = dirty;
  const slug = captured.front_matter.slug;
  feedback('save-state', '正在保存到云端…', 'pending');
  savePromise = api(`/api/posts/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    body: { draft: captured, etag: doc.etag || null },
  })
    .then((result) => {
      doc.etag = result.etag;
      doc.front_matter.slug = slug;
      $('slug').readOnly = true;
      savedVersion = version;
      feedback(
        'save-state',
        dirty === version ? '已保存到云端' : '正在等待保存最新修改…',
        dirty === version ? 'success' : 'pending',
      );
      if (dirty !== version)
        autosaveTimer = setTimeout(
          () => saveCurrent().catch((error) => notice(error.message)),
          500,
        );
      localSaved(captured, result);
    })
    .catch((error) => {
      if (error.status === 409) conflict = true;
      feedback(
        'save-state',
        error.status === 409 ? '版本冲突，请下载原稿后重新打开' : '保存失败，请重试',
        'error',
      );
      throw error;
    })
    .finally(() => {
      savePromise = null;
    });
  await savePromise;
}
async function flush() {
  if (uploading) await uploading;
  if (doc && !$('editor-view').hidden) {
    await saveCurrent();
    if (dirty > savedVersion) throw new Error('请先填写文章标题并保存，或下载当前原稿。');
  }
}
async function openPost(slug) {
  if (editorLocked) {
    notice('正在处理当前文章，请稍等。');
    return;
  }
  const version = ++navigationVersion;
  if (doc?.front_matter.slug === slug && !$('editor-view').hidden) {
    shell.close(true);
    navigationStatus();
    return;
  }
  navigationStatus('正在打开文章…');
  const cached = articleCache.get(slug);
  const request = cached ? Promise.resolve(cached) : fetchArticle(slug);
  try {
    // Fetch the next document while saving the previous one; await both so a
    // rejected fetch is always handled and unsaved text is never discarded.
    const [, data] = await Promise.all([flush(), request]);
    if (version !== navigationVersion) return;
    clearTimeout(autosaveTimer);
    invalidatePreview(true);
    fillEditor(data.draft, data.etag);
    if (cached)
      void fetchArticle(slug)
        .then((fresh) => {
          if (
            version !== navigationVersion ||
            doc?.front_matter.slug !== slug ||
            fresh.etag === doc.etag
          )
            return;
          if (dirty === 0 && !savePromise) fillEditor(fresh.draft, fresh.etag);
          // If editing has begun, retain the input and its old ETag. The next save
          // reports a conflict instead of silently adopting another window's version.
        })
        .catch(() => {});
  } finally {
    if (version === navigationVersion) navigationStatus();
  }
}
async function newPost() {
  if (editorLocked) return;
  const version = ++navigationVersion;
  navigationStatus('正在准备新文章…');
  try {
    await flush();
    if (version !== navigationVersion) return;
    const today = new Date().toISOString().slice(0, 10);
    fillEditor(
      {
        front_matter: {
          title: '',
          slug: `post-${today.replaceAll('-', '')}-${crypto.randomUUID().slice(0, 8)}`,
          date: today,
          description: '',
          draft: true,
        },
        body_markdown: '',
      },
      null,
    );
    $('title').focus();
  } finally {
    if (version === navigationVersion) navigationStatus();
  }
}
$('new-post').addEventListener('click', () => newPost().catch((error) => notice(error.message)));
$('search').addEventListener('input', () => {
  renderLists();
  clearTimeout(searchTimer);
  if (postCursor || (postCounts && posts.length < postCounts.total))
    searchTimer = setTimeout(() => void refresh().catch((error) => notice(error.message)), 250);
});
for (const id of ['load-more-posts', 'load-more-switcher'])
  $(id).addEventListener('click', () => action(id, '正在读取…', () => refresh({ append: true })));
async function returnToList(name = 'home') {
  if (editorLocked) return;
  const version = ++navigationVersion;
  try {
    await flush();
    if (version !== navigationVersion) return;
    invalidatePreview(true);
    navigationStatus();
    doc = null;
    view(name);
    renderLists();
  } catch (error) {
    notice(error.message);
  }
}
document.querySelector('.brand').addEventListener('click', (event) => {
  event.preventDefault();
  void returnToList();
});
$('dashboard-nav').addEventListener('click', () => void returnToList());
$('articles-nav').addEventListener('click', () => void returnToList('posts'));
$('post-filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-post-filter]');
  if (!button) return;
  postFilter = button.dataset.postFilter;
  if (postCursor) void refresh().catch((error) => notice(error.message));
  else if (postCounts && posts.length < postCounts.total)
    void refresh().catch((error) => notice(error.message));
  else renderLists();
});

async function manualSave() {
  if (editorLocked) return;
  await action(
    'save-post',
    '正在保存…',
    async () => {
      await flush();
      if (!doc?.etag) throw new Error('请先填写文章标题。');
    },
    '草稿已保存到云端。',
  );
}
$('save-post').addEventListener('click', manualSave);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void manualSave();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (dirty > savedVersion && doc) {
    e.preventDefault();
    e.returnValue = '';
  }
});
mountEditorPanes({ preview, invalidate: invalidatePreview });
function download(data, name, type) {
  const a = document.createElement('a'),
    url = URL.createObjectURL(new Blob([data], { type }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
for (const id of ['download-post', 'change-post-address'])
  $(id)?.addEventListener('click', () => {
    if (!doc || (id === 'change-post-address' && (editorLocked || publishingBusy))) return;
    import('/post-address.js')
      .then(({ postAction }) =>
        postAction(id, {
          api,
          notice,
          flush,
          lock: lockEditor,
          publish: startPublish,
          get: () =>
            doc && {
              draft: currentDraft(),
              etag: doc.etag,
              published: posts.some((p) => p.slug === doc.front_matter.slug && p.published),
            },
          replace: async (slug) => {
            const data = await api('/api/posts/' + encodeURIComponent(slug));
            await refresh();
            ++navigationVersion;
            articleCache.clear();
            fillEditor(data.draft, data.etag);
          },
        }),
      )
      .catch((error) => notice(error.message, 'error'));
  });
function publishingControls() {
  for (const [id, label] of Object.entries({
    'publish-post': '发布这篇',
    'publish-settings': '发布网站信息',
    'publish-welcome': publicInitialized ? '更新网站排版' : '发布博客首页',
  })) {
    if (!activeActions.has(id)) {
      $(id).disabled = publishingBusy || publishRequest;
      $(id).textContent = publishingBusy || publishRequest ? '正在发布…' : label;
    }
  }
}
function showPublishing(state) {
  publishingId = state?.release_id || '';
  publishingBusy = !!state && ['queued', 'building', 'built'].includes(state.status);
  $('cancel-publish').hidden = !publishingBusy || publishRequest;
  publishingControls();
  if ($('change-post-address'))
    $('change-post-address').disabled = publishingBusy || publishRequest;
  const banner = $('publish-banner');
  banner.hidden = !state;
  if (!state) return;
  banner.classList.toggle('failed', state.status === 'failed');
  banner.dataset.tone =
    state.status === 'failed' ? 'error' : state.status === 'deployed' ? 'success' : 'pending';
  const messages = {
    queued: '正在准备发布，请保持此页面打开。',
    building: '正在排版文章并上传页面，请保持此页面打开。',
    built: '正在完成发布…',
  };
  banner.textContent =
    {
      ...messages,
      deployed: '最新发布已上线。',
      failed: state.error || '发布失败，草稿已保留，可以重试。',
    }[state.status] || '发布进行中';
}
async function startPublish(data) {
  if (publishRequest) throw new Error('正在提交发布，请稍等。');
  publishRequest = true;
  publishingControls();
  try {
    const { publishInBrowser } = await import('/publication.js').catch(() => {
      throw new Error('发布工具加载失败，请检查网络并刷新后台后重试。');
    });
    const result = await api('/api/publish', { method: 'POST', body: data });
    showPublishing(result);
    await publishInBrowser(result, { api, engineTask, showPublishing, refresh, notice });
  } finally {
    publishRequest = false;
    await refresh().catch(() => {});
  }
}
$('cancel-publish').addEventListener('click', () =>
  action(
    'cancel-publish',
    '正在取消…',
    async () => {
      const state = await api(`/api/publish/${publishingId}/cancel`, { method: 'POST', body: {} });
      showPublishing(state);
    },
    '发布状态已更新；草稿仍然保留。',
  ),
);
$('publish-post').addEventListener('click', () => {
  if (!doc || editorLocked) return;
  void action('publish-post', '正在提交发布…', async () => {
    lockEditor(true);
    try {
      await flush();
      if (!doc.etag || dirty > savedVersion || !$('title').value.trim())
        throw new Error('请先填写文章标题并保存最新内容。');
      await startPublish({ slug: doc.front_matter.slug, etag: doc.etag });
    } finally {
      lockEditor(false);
    }
  });
});
async function unpublish(slug) {
  if (
    !(await confirmAction('取消发布后，这篇文章将从网站移除，原稿保留为草稿。', {
      title: '取消发布这篇文章？',
      accept: '取消发布',
      danger: true,
    }))
  )
    return;
  await startPublish({ unpublish: slug });
}
$('unpublish-post').addEventListener('click', () =>
  unpublish(doc.front_matter.slug).catch((error) => notice(error.message)),
);
$('delete-post').addEventListener('click', async () => {
  if (!doc || editorLocked) return;
  if (
    !(await confirmAction('这份草稿将被永久删除，无法恢复。已上传的图片仍可在图片库管理。', {
      title: '删除这份草稿？',
      accept: '删除草稿',
      danger: true,
    }))
  )
    return;
  void action(
    'delete-post',
    '正在删除…',
    async () => {
      lockEditor(true);
      try {
        await flush();
        const slug = doc.front_matter.slug;
        await api(`/api/posts/${slug}`, { method: 'DELETE', body: { etag: doc.etag } });
        articleCache.delete(slug);
        posts = posts.filter((p) => p.slug !== slug);
        invalidatePreview(true);
        doc = null;
        dirty = 0;
        savedVersion = 0;
        view('home');
        await refresh();
      } finally {
        lockEditor(false);
      }
    },
    '草稿已删除。',
  );
});
async function pollPublication() {
  if (!csrf || !publishingBusy || polling || document.hidden) return;
  polling = true;
  try {
    const state = await api('/api/publish/status');
    showPublishing(state);
    if (state?.status === 'deployed' && lastPublished !== state.release_id) {
      lastPublished = state.release_id;
      await refresh();
      notice('发布完成，网站已更新。', 'success');
    }
  } catch {
  } finally {
    polling = false;
  }
}
setInterval(pollPublication, 6000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (publishingBusy) void pollPublication();
    else if (csrf) void refresh().catch(() => {});
  }
});
window.addEventListener('offline', () =>
  notice('网络已断开，请保留此页面；联网后可以继续保存，也可先下载原稿。', 'error'),
);
window.addEventListener('online', () => {
  notice('网络已恢复。');
  if (doc && dirty > savedVersion && !conflict)
    void saveCurrent().catch((error) => notice(error.message, 'error'));
});

async function upload(file, token) {
  const target = doc;
  const form = await imageUploadForm(file);
  if (doc !== target) throw new Error('文章已切换，请重新选择图片。');
  const result = await api('/api/upload', { method: 'POST', body: form });
  if (doc !== target) throw new Error('图片已上传，请返回原文章继续编辑。');
  insertImage({ ...result, name: file.name }, token);
}
function insertImage(image, token) {
  if (!doc || editorLocked) throw new Error('请先打开一篇文章。');
  const textarea = $('body');
  const name = image.name.replace(/[\[\]\\\n\r]/g, '');
  const escape = (value) =>
    String(value).replace(/[&<>"']/g, (c) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  const sized =
    Number.isInteger(image.width) &&
    image.width > 0 &&
    Number.isInteger(image.height) &&
    image.height > 0;
  const responsive = image.srcset
    ? ` srcset="${escape(image.srcset)}" sizes="(max-width: 759px) calc(100vw - 44px), 720px" data-full-src="${escape(image.fullUrl)}"`
    : '';
  const text = sized
    ? `\n\n<img src="${escape(image.displayUrl || image.url)}" alt="${escape(name)}" width="${image.width}" height="${image.height}"${responsive}>\n\n`
    : `\n\n![${name}](${image.url})\n\n`;
  view('editor');
  if (token && textarea.value.includes(token)) {
    textarea.value = textarea.value.replace(token, text.trim());
  } else {
    textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
  }
  textarea.focus();
  changed();
}
const imageTools = configureImages({
  rebuild: () => startPublish({ rebuild: true }),
  api,
  flush,
  notice,
  action,
  imageUploadForm,
  confirmAction,
  open: (back = false) => {
    ++navigationVersion;
    invalidatePreview();
    view(back ? 'editor' : 'images');
  },
  insert: insertImage,
  canInsert: () => !!doc && !editorLocked,
  siteUrl: () => appConfig.siteUrl,
  beginNavigation: () => {
    const version = ++navigationVersion;
    return () => version === navigationVersion;
  },
});
// Wire the sidebar button and the editor's image picker to the library.
for (const id of ['images', 'choose-library-image'])
  $(id).addEventListener('click', () => action(id, '正在打开…', () => imageTools.show()));
const shortTools = configureShorts({
  api,
  notice,
  action,
  onList: (data) => updateSidebarShorts(data),
  open: async () => {
    if (editorLocked) return false;
    const version = ++navigationVersion;
    await flush();
    if (version !== navigationVersion) return false;
    invalidatePreview();
    view('shorts');
    return true;
  },
  startPublish,
});
$('upload-image').addEventListener('click', () => $('image-files').click());
async function uploadFiles(files) {
  if (editorLocked || uploading || !doc) return;
  const textarea = $('body');
  const jobs = files.map((file, idx) => ({
    file,
    token: `<!-- uploading:${Date.now()}_${idx} -->\n![正在上传: ${file.name.replace(/[\[\]\\]/g, '')}...](/editorial-botanical.svg)\n`,
  }));

  if (textarea) {
    const placeholderText = jobs.map((j) => j.token).join('\n') + '\n';
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.setRangeText(placeholderText, start, end, 'end');
    changed();
  }

  uploading = (async () => {
    for (const job of jobs) {
      try {
        await upload(job.file, job.token);
      } catch (err) {
        if (textarea && textarea.value.includes(job.token)) {
          textarea.value = textarea.value.replace(job.token, '');
          changed();
        }
        throw err;
      }
    }
  })();
  try {
    await action('upload-image', '正在上传…', () => uploading, '图片已上传并插入正文。');
  } finally {
    uploading = null;
  }
}
$('image-files').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  try {
    await uploadFiles(files);
  } finally {
    e.target.value = '';
  }
});
$('body').addEventListener('paste', (e) => {
  const images = [...e.clipboardData.items].filter(
    (x) => x.kind === 'file' && x.type.startsWith('image/'),
  );
  if (!images.length) return;
  e.preventDefault();
  void uploadFiles(images.map((item) => item.getAsFile()).filter(Boolean));
});
$('body').addEventListener('dragenter', (e) => {
  if (e.dataTransfer.types.includes('Files')) {
    e.preventDefault();
    $('body').classList.add('is-dropzone');
  }
});
$('body').addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('Files')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    $('body').classList.add('is-dropzone');
  }
});
$('body').addEventListener('dragleave', (e) => {
  if (e.relatedTarget && $('body').contains(e.relatedTarget)) return;
  $('body').classList.remove('is-dropzone');
});
$('body').addEventListener('drop', (e) => {
  $('body').classList.remove('is-dropzone');
  const images = [...e.dataTransfer.files].filter((x) => x.type.startsWith('image/'));
  if (!images.length) return;
  e.preventDefault();
  void uploadFiles(images);
});

function setupEditorEnhancements() {
  const textarea = $('body');
  if (!textarea) return;

  function applyFormat(type) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const selected = text.slice(start, end);
    let replacement = '',
      newCursor = start;

    switch (type) {
      case 'bold':
        replacement = selected ? `**${selected}**` : '****';
        newCursor = selected ? end + 4 : start + 2;
        break;
      case 'italic':
        replacement = selected ? `*${selected}*` : '**';
        newCursor = selected ? end + 2 : start + 1;
        break;
      case 'code':
        if (selected.includes('\n')) {
          replacement = `\`\`\`\n${selected || ''}\n\`\`\`\n`;
          newCursor = selected ? end + 8 : start + 4;
        } else {
          replacement = selected ? `\`${selected}\`` : '``';
          newCursor = selected ? end + 2 : start + 1;
        }
        break;
      case 'quote':
        replacement = selected
          ? selected
              .split('\n')
              .map((l) => `> ${l}`)
              .join('\n')
          : '> ';
        newCursor = start + replacement.length;
        break;
      case 'ul':
        replacement = selected
          ? selected
              .split('\n')
              .map((l) => `- ${l}`)
              .join('\n')
          : '- ';
        newCursor = start + replacement.length;
        break;
      case 'ol':
        replacement = selected
          ? selected
              .split('\n')
              .map((l, i) => `${i + 1}. ${l}`)
              .join('\n')
          : '1. ';
        newCursor = start + replacement.length;
        break;
      case 'heading': {
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        const lineEnd = text.indexOf('\n', start);
        const fullLineEnd = lineEnd === -1 ? text.length : lineEnd;
        const currentLine = text.slice(lineStart, fullLineEnd);
        let newLine = currentLine;
        if (currentLine.startsWith('## ')) newLine = '### ' + currentLine.slice(3);
        else if (currentLine.startsWith('### ')) newLine = '#### ' + currentLine.slice(4);
        else if (currentLine.startsWith('#### ')) newLine = currentLine.slice(5);
        else newLine = '## ' + currentLine;
        textarea.setRangeText(newLine, lineStart, fullLineEnd, 'select');
        changed();
        textarea.focus();
        return;
      }
      case 'link':
        replacement = `[${selected || '链接文本'}](https://)`;
        newCursor = selected ? end + 11 : start + 1;
        break;
      case 'zen':
        setZen(!$('app-view').classList.contains('zen-mode'));
        return;
    }

    if (replacement) {
      textarea.setRangeText(replacement, start, end, 'end');
      textarea.setSelectionRange(newCursor, newCursor);
      textarea.focus();
      changed();
    }
  }

  document.querySelectorAll('.editor-format-actions [data-format]').forEach((btn) => {
    btn.addEventListener('click', () => applyFormat(btn.dataset.format));
  });

  textarea.addEventListener('keydown', (e) => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;

    if (e.key === 'Tab') {
      e.preventDefault();
      if (start === end) {
        textarea.setRangeText('  ', start, end, 'end');
      } else {
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        const lineEnd = text.indexOf('\n', end);
        const rangeEnd = lineEnd === -1 ? text.length : lineEnd;
        const lines = text.slice(lineStart, rangeEnd).split('\n');
        if (e.shiftKey) {
          const unindented = lines
            .map((l) => (l.startsWith('  ') ? l.slice(2) : l.startsWith(' ') ? l.slice(1) : l))
            .join('\n');
          textarea.setRangeText(unindented, lineStart, rangeEnd, 'select');
        } else {
          const indented = lines.map((l) => '  ' + l).join('\n');
          textarea.setRangeText(indented, lineStart, rangeEnd, 'select');
        }
      }
      changed();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const currentLine = text.slice(lineStart, start);
      const ulMatch = currentLine.match(/^(\s*)([-*+]\s+)/);
      const olMatch = currentLine.match(/^(\s*)(\d+)\.\s+/);
      if (ulMatch) {
        if (currentLine.trim() === ulMatch[2].trim()) {
          e.preventDefault();
          textarea.setRangeText('', lineStart, start, 'end');
          changed();
          return;
        }
        e.preventDefault();
        textarea.setRangeText('\n' + ulMatch[1] + ulMatch[2], start, end, 'end');
        changed();
        return;
      } else if (olMatch) {
        if (currentLine.trim() === olMatch[2] + '.') {
          e.preventDefault();
          textarea.setRangeText('', lineStart, start, 'end');
          changed();
          return;
        }
        e.preventDefault();
        const nextNum = parseInt(olMatch[2], 10) + 1;
        textarea.setRangeText('\n' + olMatch[1] + nextNum + '. ', start, end, 'end');
        changed();
        return;
      }
    }

    const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`', '*': '*', _: '_' };
    if (start !== end && pairs[e.key]) {
      e.preventDefault();
      const openChar = e.key;
      const closeChar = pairs[openChar];
      const selected = text.slice(start, end);
      textarea.setRangeText(`${openChar}${selected}${closeChar}`, start, end, 'select');
      changed();
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') {
        e.preventDefault();
        applyFormat('bold');
      } else if (k === 'i') {
        e.preventDefault();
        applyFormat('italic');
      } else if (k === 'k') {
        e.preventDefault();
        applyFormat('link');
      } else if (k === 's') {
        e.preventDefault();
        saveCurrent()
          .then(() => notice('草稿已保存。', 'success'))
          .catch((err) => notice(err.message, 'error'));
      }
    }

    if (e.key === 'Escape' && $('app-view')?.classList.contains('zen-mode')) {
      setZen(false);
    }
  });

  let scrollSyncing = false;
  textarea.addEventListener(
    'scroll',
    () => {
      if (scrollSyncing) return;
      const scrollable = textarea.scrollHeight - textarea.clientHeight;
      if (scrollable <= 0) return;
      const frameWin = $('preview-frame')?.contentWindow;
      const frameDoc = $('preview-frame')?.contentDocument;
      if (!frameWin || !frameDoc) return;
      const frameScrollable = frameDoc.documentElement.scrollHeight - frameWin.innerHeight;
      if (frameScrollable <= 0) return;

      const text = textarea.value;
      const lines = text.split('\n');
      const mdHeadings = [];
      lines.forEach((line, idx) => {
        if (/^#{1,6}\s+\S+/.test(line)) {
          mdHeadings.push(idx);
        }
      });
      const domHeadings = [
        ...frameDoc.querySelectorAll(
          '.article-shell h1, .article-shell h2, .article-shell h3, .article-shell h4, .article-shell h5, .article-shell h6',
        ),
      ];

      scrollSyncing = true;
      if (mdHeadings.length > 0 && domHeadings.length > 0 && lines.length > 1) {
        const count = Math.min(mdHeadings.length, domHeadings.length);
        const anchors = [{ t: 0, p: 0 }];
        for (let i = 0; i < count; i++) {
          anchors.push({
            t: (mdHeadings[i] / (lines.length - 1)) * scrollable,
            p: domHeadings[i].getBoundingClientRect().top + frameWin.scrollY,
          });
        }
        anchors.push({ t: scrollable, p: frameScrollable });

        const currentT = textarea.scrollTop;
        let segment = 0;
        for (let i = 0; i < anchors.length - 1; i++) {
          if (currentT >= anchors[i].t && currentT <= anchors[i + 1].t) {
            segment = i;
            break;
          }
        }
        const spanT = anchors[segment + 1].t - anchors[segment].t;
        const progress = spanT > 0 ? (currentT - anchors[segment].t) / spanT : 0;
        const targetP =
          anchors[segment].p + progress * (anchors[segment + 1].p - anchors[segment].p);
        frameWin.scrollTo({ top: Math.max(0, targetP), behavior: 'auto' });
      } else {
        const progress = textarea.scrollTop / scrollable;
        frameWin.scrollTo({ top: progress * frameScrollable, behavior: 'auto' });
      }

      requestAnimationFrame(() => {
        scrollSyncing = false;
      });
    },
    { passive: true },
  );

  const splitter = $('editor-splitter');
  const panes = $('editor-panes');
  if (splitter && panes) {
    try {
      const savedPercent = localStorage.getItem('cloudink-split-percent');
      if (savedPercent) {
        panes.style.setProperty('--editor-split-left', savedPercent);
        panes.style.setProperty('--editor-split-right', `${100 - parseFloat(savedPercent)}%`);
        panes.style.setProperty('--editor-split-percent', savedPercent);
      }
    } catch {}

    let dragging = false;
    splitter.addEventListener('pointerdown', (e) => {
      dragging = true;
      splitter.classList.add('is-dragging');
      splitter.setPointerCapture(e.pointerId);
    });
    splitter.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = panes.getBoundingClientRect();
      const percent = Math.min(80, Math.max(20, ((e.clientX - rect.left) / rect.width) * 100));
      panes.style.setProperty('--editor-split-left', `${percent}%`);
      panes.style.setProperty('--editor-split-right', `${100 - percent}%`);
      panes.style.setProperty('--editor-split-percent', `${percent}%`);
    });
    const stopDrag = () => {
      if (dragging) {
        dragging = false;
        splitter.classList.remove('is-dragging');
        try {
          localStorage.setItem(
            'cloudink-split-percent',
            panes.style.getPropertyValue('--editor-split-percent'),
          );
        } catch {}
      }
    };
    splitter.addEventListener('pointerup', stopDrag);
    splitter.addEventListener('pointercancel', stopDrag);
  }
}
setupEditorEnhancements();
configureMarkdownImport({
  api,
  engineTask,
  flush,
  locked: () => editorLocked || publishingBusy || publishRequest || !!uploading,
  lock: lockEditor,
  saved: localSaved,
  open: openPost,
  notice,
  closeMenu: () => shell.close(),
});
$('settings').addEventListener('click', async () => {
  if (editorLocked) return;
  const version = ++navigationVersion;
  navigationStatus('正在加载设置…');
  try {
    await flush();
    const data = await api('/api/settings');
    if (version !== navigationVersion) return;
    const [homePicker] = await Promise.all([loadIllustrationPicker(), loadBackup()]);
    if (version !== navigationVersion) return;
    settingsEtag = data.etag;
    iconPicker.load(data.site);
    homePicker.load(data.site);
    $('site-form').elements.themePalette.value = data.site.themePalette || 'ink';
    applySiteAppearance(data.site);
    for (const [key, value] of Object.entries(data.site))
      if ($('site-form').elements[key]) $('site-form').elements[key].value = value;
    for (const key of ['bigTitle', 'footer', 'clarityId', 'about'])
      if (!data.site[key]) $('site-form').elements[key].value = '';
    invalidatePreview();
    view('settings');
    void api('/api/maintenance')
      .then((status) => {
        const reason =
          {
            uninitialized: '尚未初始化',
            publication_settling: '刚刚发布，等待缓存稳定',
            publication_busy: '发布进行中',
            mutation_busy: '其他保存操作进行中',
            bounded_work_or_storage_conflict: '本批检查达到上限或存储状态变化',
            storage_error: '存储操作失败',
          }[status?.reason] || '';
        const label =
          { running: '进行中', success: '成功', skipped: '已跳过', failed: '失败' }[
            status?.status
          ] || '成功';
        $('storage-maintenance-status').textContent = status?.last_attempt_at
          ? '最近尝试：' +
            new Date(status.last_attempt_at).toLocaleString() +
            '，' +
            label +
            (reason ? '（' + reason + '）' : '') +
            '。已扫描 ' +
            (status.scanned_objects || 0) +
            ' 个对象，移除 ' +
            (status.deleted_objects || 0) +
            ' 个过期文件。' +
            (status.last_success_at
              ? '最近成功：' + new Date(status.last_success_at).toLocaleString() + '。'
              : '') +
            (Object.keys(status.cursors || {}).length ? '还有后续批次，将在下次继续。' : '')
          : status?.finished_at
            ? '最近清理：' + new Date(status.finished_at).toLocaleString()
            : '每日自动维护尚未运行。';
      })
      .catch(() => {
        $('storage-maintenance-status').textContent = '暂时无法读取清理记录；不影响保存与发布。';
      });
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    if (version === navigationVersion) navigationStatus();
  }
});
$('site-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  void action(
    'save-site',
    '正在保存…',
    async () => {
      await illustrationPicker?.ready();
      await iconPicker.ready();
      const values = Object.fromEntries(new FormData(form));
      const data = await api('/api/settings', {
        method: 'PUT',
        body: { site: values, etag: settingsEtag },
      });
      settingsEtag = data.etag;
      applySiteAppearance(data.site);
    },
    '网站信息已保存，点击发布后上线。',
  );
});
$('publish-settings').addEventListener('click', () =>
  action('publish-settings', '正在提交发布…', async () => {
    await illustrationPicker?.ready();
    await iconPicker.ready();
    const values = Object.fromEntries(new FormData($('site-form')));
    const saved = await api('/api/settings', {
      method: 'PUT',
      body: { site: values, etag: settingsEtag },
    });
    settingsEtag = saved.etag;
    applySiteAppearance(saved.site);
    await startPublish({ settings: true });
  }),
);
$('logout').addEventListener('click', async () => {
  if (editorLocked || !(await shortTools.confirmDiscard())) return;
  ++navigationVersion;
  try {
    await flush();
    await api('/api/logout', { method: 'POST', body: {} });
    shortTools.reset();
    doc = null;
    dirty = 0;
    savedVersion = 0;
    iconPicker.load(null);
    illustrationPicker?.load(null);
    iconPicker.apply(null);
    showLogin({ focus: true });
  } catch (error) {
    notice(error.message);
  }
});

$('account-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.elements.password.value !== form.elements.confirm.value) {
    feedback('account-feedback', '两次新密码不一致。', 'error');
    notice('两次新密码不一致。', 'error');
    return;
  }
  void action(
    'save-account',
    '正在更新账号…',
    async () => {
      const data = await api('/api/account', {
        method: 'PUT',
        body: Object.fromEntries(new FormData(form)),
      });
      csrf = data.csrf;
      form.reset();
      form.elements.email.value = data.email;
      $('account-email').textContent = data.email;
    },
    '账号已更新，其他设备需要重新登录。',
  );
});
let backupReady;
function loadBackup() {
  backupReady ||= import('/backup.js')
    .then(({ configureBackup }) => {
      configureBackup({
        confirmAction,
        api,
        flush,
        action,
        notice,
        download,
        refresh,
        getSettingsEtag: () => settingsEtag,
        restored: (result) => {
          settingsEtag = result.etag;
          for (const input of $('site-form').querySelectorAll(
            'input:not([type=radio]),textarea,select[name]',
          ))
            input.value = '';
          $('site-form').elements.themePalette.value = result.site.themePalette || 'ink';
          iconPicker.load(result.site);
          illustrationPicker?.load(result.site);
          applySiteAppearance(result.site);
          for (const [key, value] of Object.entries(result.site))
            if ($('site-form').elements[key]) $('site-form').elements[key].value = value;
        },
      });
    })
    .catch(() => {
      backupReady = null;
      throw new Error('备份工具暂时无法加载，请检查网络后重试。');
    });
  return backupReady;
}

if (typeof window !== 'undefined' && window.visualViewport) {
  const syncVisualViewport = () => {
    const vh = window.visualViewport.height;
    const top = window.visualViewport.offsetTop;
    document.documentElement.style.setProperty('--ci-visual-vh', `${vh}px`);
    document.documentElement.style.setProperty('--ci-visual-top', `${top}px`);
  };
  window.visualViewport.addEventListener('resize', syncVisualViewport, { passive: true });
  window.visualViewport.addEventListener('scroll', syncVisualViewport, { passive: true });
  syncVisualViewport();
}

async function updateSidebarShorts(value) {
  try {
    const data = value || (await api('/api/shorts?limit=1'));
    if (data && data.shorts) {
      const shortsCountEl = $('sidebar-shorts-count');
      if (shortsCountEl) shortsCountEl.textContent = data.total;
      const previewEl = $('sidebar-short-preview');
      if (previewEl)
        previewEl.textContent = data.shorts[0]?.snippet || '从这里随时记录此刻想法与简短日志…';
    }
  } catch {}
}

($('studio-sidebar-new-btn') || $('flclash-sidebar-new-btn'))?.addEventListener('click', () => {
  $('new-post')?.click();
});

document.addEventListener('click', (event) => {
  const sidebarFilterBtn = event.target.closest('[data-sidebar-filter]');
  if (sidebarFilterBtn) {
    const filter = sidebarFilterBtn.dataset.sidebarFilter;
    if (filter === 'all' || filter === 'published' || filter === 'draft') {
      document.querySelector(`[data-post-filter="${filter}"]`)?.click();
    }
  }
});

const quickShortBtn = $('studio-quick-short-btn') || $('flclash-quick-short-btn');
quickShortBtn?.addEventListener('click', () =>
  action(quickShortBtn.id, '正在打开…', async () => {
    if (await shortTools.show()) $('short-new').click();
  }),
);
($('studio-goto-shorts-link') || $('flclash-goto-shorts-link'))?.addEventListener('click', () => {
  $('shorts').click();
});
