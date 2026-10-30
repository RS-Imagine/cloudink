import { imageUploadForm } from './image-upload.js';
import '../../assets/motion.js';
import '../../assets/mobile.js';
import { mountStudioShell } from './shell.js';
import { feedback, confirmAction, mountEditorPanes } from './workflows.js';
import { zipSync, strToU8 } from 'fflate';
import { configureBackup } from './backup.js';
import { configureImages } from './images.js';
import { configureSiteIcon } from './site-icon.js';
import { configureMarkdownImport } from './markdown-import.js';
import {
  engineTask,
  renderPreview,
  invalidatePreview,
  disposePreview,
  configurePreview,
} from './preview.js';

const motion = window.CloudInkMotion;
motion.mount();
const shell = mountStudioShell();
let postFilter = 'all';

const $ = (id) => document.getElementById(id);
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
  publishingId = '';
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
  window.CloudInkTheme?.setPalette(config?.themePalette || 'ink');
  iconPicker.apply(config);
  if (site) {
    site.themePalette = document.documentElement.dataset.palette || 'ink';
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
    labelNode.textContent =
      publishingBusy && ['publish-post', 'publish-settings'].includes(id) ? '正在发布…' : original;
    button.disabled = publishingBusy && ['publish-post', 'publish-settings'].includes(id);
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
      published: !!old?.published,
      has_draft: true,
      changed: true,
      etag: result.etag,
    };
  posts = posts.filter((p) => p.slug !== slug);
  posts.push(post);
  cacheArticle(slug, {
    draft: result.draft,
    source: result.source,
    etag: result.etag,
  });
  renderLists();
}

async function api(path, options = {}) {
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
    if (response.status === 401 && path !== '/api/login' && !booting) showLogin({ focus: true });
    throw error;
  }
  return data;
}
function showLogin({ focus = false } = {}) {
  pendingWorkspace = null;
  shell.close();
  $('studio-skip').hidden = true;
  motion.cancelWithin($('app-view'));
  if ($('image-preview-dialog').open) $('image-preview-dialog').close();
  if ($('confirmation-dialog').open) $('confirmation-dialog').close();
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
function view(name, { focus = true } = {}) {
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
  for (const id of ['home', 'editor', 'images', 'settings']) {
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
  const query = $('search').value.trim().toLowerCase();
  const sorted = [...posts].sort((a, b) => b.date.localeCompare(a.date));
  $('post-count').textContent = posts.length;
  document.querySelector('[data-post-count]').textContent = posts.length;
  for (const button of document.querySelectorAll('[data-post-filter]'))
    button.setAttribute('aria-pressed', String(button.dataset.postFilter === postFilter));
  let shown = 0;
  $('summary').textContent =
    `${posts.filter((p) => p.published).length} 篇已发布 · ${posts.filter((p) => !p.published).length} 篇草稿`;
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
    title.textContent = posts.length ? '还没有找到匹配的文章' : '你的第一篇文字，从这里开始。';
    text.textContent = posts.length
      ? '换一个关键词，或查看全部文章。'
      : '点击“新文章”开始写作，也可以从更多操作导入原稿。';
    empty.append(title, text);
    if (posts.length) {
      const reset = document.createElement('button');
      reset.textContent = '清除筛选';
      reset.addEventListener('click', () => {
        $('search').value = '';
        postFilter = 'all';
        renderLists();
        $('search').focus();
      });
      empty.append(reset);
    }
    $('article-grid').append(empty);
  }
  if (!$('post-list').childElementCount) {
    const empty = document.createElement('p');
    empty.className = 'studio-list-empty';
    empty.textContent = posts.length
      ? '没有匹配的文章，请修改搜索关键词。'
      : '还没有文章，先开始新文章。';
    $('post-list').append(empty);
  }
}
async function refresh() {
  const data = await api('/api/posts');
  posts = data.posts;
  $('publish-welcome').textContent = data.publicInitialized ? '更新网站排版' : '发布博客首页';
  site = data.site;
  applySiteAppearance(data.appearance || data.site);
  $('site-brand-title').textContent = data.site.title;
  $('home-heading').textContent = data.site.author
    ? '你好，' + data.site.author + '。'
    : '从一个想法开始。';
  for (const [slug, cached] of articleCache) {
    const post = posts.find((p) => p.slug === slug);
    if (!post || (post.etag && post.etag !== cached.etag)) articleCache.delete(slug);
  }
  renderLists();
  showPublishing(data.publishing);
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
  doc = { ...draft, etag };
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
function wordCount() {
  $('word-count').textContent =
    `${$('body').value.replace(/\s/g, '').length.toLocaleString()} 个字符`;
}
function changed() {
  if (!doc) return;
  invalidatePreview();
  dirty++;
  feedback('save-state', '有未保存的修改', 'pending');
  wordCount();
  clearTimeout(autosaveTimer);
  if (!conflict)
    autosaveTimer = setTimeout(() => saveCurrent().catch((error) => notice(error.message)), 1500);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void preview(), 350);
}
fields.forEach((id) => $(id).addEventListener('input', changed));
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
for (const id of ['new-post', 'home-new'])
  $(id).addEventListener('click', () => newPost().catch((error) => notice(error.message)));
$('search').addEventListener('input', renderLists);
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
  renderLists();
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
  $(id).addEventListener('click', () => {
    if (!doc || (id === 'change-post-address' && (editorLocked || publishingBusy))) return;
    import('/post-address.js')
      .then(({ postAction }) => postAction(id, {
        api, notice, flush, lock: lockEditor, publish: startPublish,
        get: () => doc && {
          draft: currentDraft(), etag: doc.etag,
          published: posts.some((p) => p.slug === doc.front_matter.slug && p.published),
        },
        replace: async (slug) => {
          const data = await api('/api/posts/' + encodeURIComponent(slug));
          await refresh();
          ++navigationVersion;
          articleCache.clear();
          fillEditor(data.draft, data.etag);
        },
      }))
      .catch((error) => notice(error.message, 'error'));
  });
function showPublishing(state) {
  publishingId = state?.release_id || '';
  publishingBusy = !!state && ['queued', 'building', 'built'].includes(state.status);
  $('cancel-publish').hidden = !publishingBusy || publishRequest;
  for (const id of ['publish-post', 'publish-settings']) {
    if (!activeActions.has(id)) {
      $(id).disabled = publishingBusy || publishRequest;
      $(id).textContent = publishingBusy
        ? '正在发布…'
        : id === 'publish-post'
          ? '发布这篇'
          : '发布网站信息';
    }
  }
  $('publish-welcome').disabled = publishingBusy || publishRequest;
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
async function publishInBrowser(result) {
  try {
    showPublishing({ ...result, status: 'building' });
    const rendered = await engineTask('site', { release: result.browser_release });
    const files = [...result.files];
    const uploads = await Promise.allSettled(
      Array.from({ length: Math.min(3, files.length) }, async () => {
        while (files.length) {
          const path = files.shift();
          if (typeof rendered[path] !== 'string') throw new Error('网页生成不完整，请重新发布。');
          await api(`/api/publish/${result.release_id}/file?path=${encodeURIComponent(path)}`, {
            method: 'PUT',
            body: rendered[path],
            rawBody: true,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      }),
    );
    const failure = uploads.find((upload) => upload.status === 'rejected');
    if (failure) throw failure.reason;
    showPublishing({ ...result, status: 'built' });
    const done = await api(`/api/publish/${result.release_id}/commit`, {
      method: 'POST',
      body: {},
    });
    showPublishing(done);
  } catch (error) {
    const stopped = await api(`/api/publish/${result.release_id}/cancel`, {
      method: 'POST',
      body: {},
    }).catch(() => null);
    if (stopped?.status === 'deployed') showPublishing(stopped);
    else {
      showPublishing(
        stopped || {
          ...result,
          status: 'failed',
          error: '发布未完成，草稿和上次上线版本已保留。联网后可取消这次发布并重试。',
        },
      );
      throw error;
    }
  }
  await refresh();
  notice('发布完成，网站已更新。', 'success');
}
async function startPublish(data) {
  if (publishRequest) throw new Error('正在提交发布，请稍等。');
  publishRequest = true;
  try {
    const result = await api('/api/publish', { method: 'POST', body: data });
    showPublishing(result);
    await publishInBrowser(result);
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
        renderLists();
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

async function upload(file) {
  const target = doc;
  const form = await imageUploadForm(file);
  if (doc !== target) throw new Error('文章已切换，请重新选择图片。');
  const result = await api('/api/upload', { method: 'POST', body: form });
  if (doc !== target) throw new Error('图片已上传，请返回原文章继续编辑。');
  insertImage({ ...result, name: file.name });
}
function insertImage(image) {
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
  textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
  textarea.focus();
  changed();
}
configureImages({
  rebuild: () => startPublish({ rebuild: true }),
  api,
  flush,
  notice,
  action,
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
$('upload-image').addEventListener('click', () => $('image-files').click());
async function uploadFiles(files) {
  if (editorLocked || uploading) return;
  uploading = (async () => {
    for (const file of files) await upload(file);
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
$('body').addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('Files')) e.preventDefault();
});
$('body').addEventListener('drop', (e) => {
  const images = [...e.dataTransfer.files].filter((x) => x.type.startsWith('image/'));
  if (!images.length) return;
  e.preventDefault();
  void uploadFiles(images);
});
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
$('export-posts').addEventListener('click', async () => {
  try {
    await flush();
    const backup = await api('/api/export'),
      files = {};
    for (const [path, source] of Object.entries(backup.files)) files[path] = strToU8(source);
    download(
      zipSync(files),
      `cloudink-backup-${new Date().toISOString().slice(0, 10)}.zip`,
      'application/zip',
    );
    notice('原稿已导出；完整图片与设置备份请使用网站设置中的“下载网站备份”。');
  } catch (error) {
    notice(error.message);
  }
});
$('settings').addEventListener('click', async () => {
  if (editorLocked) return;
  const version = ++navigationVersion;
  navigationStatus('正在加载设置…');
  try {
    await flush();
    const data = await api('/api/settings');
    if (version !== navigationVersion) return;
    const homePicker = await loadIllustrationPicker();
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
  if (editorLocked) return;
  ++navigationVersion;
  try {
    await flush();
    await api('/api/logout', { method: 'POST', body: {} });
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
configureBackup({
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
