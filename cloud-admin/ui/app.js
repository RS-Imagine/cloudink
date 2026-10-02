import { zipSync, strToU8 } from 'fflate';
import { configureBackup } from './backup.js';
import {
  engineTask,
  renderPreview,
  invalidatePreview,
  disposePreview,
  configurePreview,
} from './preview.js';

const $ = (id) => document.getElementById(id);
const fields = ['title', 'description', 'date', 'slug', 'body'];
let csrf = '',
  posts = [],
  site = null,
  doc = null,
  legacySlug = '',
  dirty = 0,
  savedVersion = 0,
  conflict = false,
  savePromise = null,
  autosaveTimer = null,
  previewTimer = null,
  settingsEtag = null;
let setupToken = new URLSearchParams(location.hash.slice(1)).get('setup') || '';
if (setupToken) history.replaceState(null, '', location.pathname);
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
let deploymentConfig;
const configReady = api('/api/config').then((config) => {
  deploymentConfig = config;
  configurePreview(config);
  $('site-link').href = config.siteUrl;
  $('site-worker-name').textContent = config.siteWorkerName;
  $('production-branch').textContent = config.productionBranch;
  if (config.setupWizard) {
    $('deployment-form').hidden = true;
    $('password-form').hidden = true;
    for (const id of ['account-form', 'backup-card', 'service-card']) $(id).hidden = false;
    $('service-site-link').href = config.siteUrl;
    $('service-site-link').textContent = config.siteUrl;
    if (!config.initialized) showLogin();
  } else {
    document.querySelector('.settings-nav').hidden = true;
    for (const detail of $('site-form').querySelectorAll('details')) {
      detail.hidden = true;
      for (const input of detail.querySelectorAll('input,textarea')) input.disabled = true;
    }
  }
  return config;
});
void configReady.catch((error) => {
  $('login-error').textContent = error.message;
});
function notice(message, tone = 'info') {
  $('notice').dataset.tone = tone;
  $('notice').textContent = message;
  $('notice').classList.add('visible');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => $('notice').classList.remove('visible'), 6500);
}

async function action(id, label, work, success = '') {
  if (activeActions.has(id)) return;
  const button = $(id),
    original = button.textContent;
  activeActions.add(id);
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = label;
  try {
    await work();
    if (success) notice(success, 'success');
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    activeActions.delete(id);
    button.removeAttribute('aria-busy');
    button.textContent =
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
      legacy: false,
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
    legacy: false,
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
    if (response.status === 401 && path !== '/api/login') showLogin();
    throw error;
  }
  return data;
}
function showLogin() {
  clearTimeout(autosaveTimer);
  $('app-view').hidden = true;
  const wizard = deploymentConfig?.setupWizard && !deploymentConfig.initialized;
  $('setup-view').hidden = !wizard;
  $('login-view').hidden = wizard;
  csrf = '';
  if (!setupToken) {
    $('login-form').elements.email.readOnly = false;
    $('login-form').elements.email.required = true;
    $('login-form').elements.email.closest('label').hidden = false;
    $('confirm-row').hidden = true;
    $('login-title').textContent = '登录写作空间';
    $('login-submit').textContent = '登录';
  }
  articleCache.clear();
  articleRequests.clear();
  disposePreview();
}
function view(name) {
  for (const id of ['home', 'editor', 'legacy', 'settings']) $(`${id}-view`).hidden = id !== name;
  $('workspace-title').textContent = {
    home: '文章管理',
    editor: '写作与预览',
    legacy: '导入文章原稿',
    settings: '网站设置',
  }[name];
}
async function signedIn(session) {
  await configReady;
  csrf = session.csrf;
  setupToken = '';
  deploymentConfig.initialized = true;
  $('setup-view').hidden = true;
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  $('account-email').textContent = session.email;
  $('account-form').elements.email.value = session.email;
  await refresh();
  view('home');
  (window.requestIdleCallback || setTimeout)(() => {
    void engineTask('warm').catch(() => {});
  });
}
if (setupToken) {
  $('login-title').textContent = '设置你的登录密码';
  $('login-description').textContent = '为你的写作空间设置一个至少 12 个字符的密码。';
  $('login-submit').textContent = '设置密码并进入后台';
  $('confirm-row').hidden = false;
  $('login-form').elements.email.readOnly = true;
  $('login-form').elements.email.required = false;
  $('login-form').elements.email.closest('label').hidden = true;
  $('login-form').elements.password.autocomplete = 'new-password';
  $('login-form').elements.password.minLength = 12;
}
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  $('login-error').textContent = '';
  if (setupToken && form.elements.password.value !== form.elements.confirm.value) {
    $('login-error').textContent = '两次输入的密码不一致。';
    return;
  }
  $('login-submit').disabled = true;
  try {
    await signedIn(
      await api(setupToken ? '/api/setup' : '/api/login', {
        method: 'POST',
        headers: setupToken ? { Authorization: `Bearer ${setupToken}` } : {},
        body: { email: form.elements.email.value, password: form.elements.password.value },
      }),
    );
    form.reset();
  } catch (error) {
    $('login-error').textContent = error.message;
  } finally {
    $('login-submit').disabled = false;
  }
});
if (!setupToken)
  api('/api/session')
    .then(signedIn)
    .catch(() => {});

function setupStep(siteStep) {
  $('setup-account-step').hidden = siteStep;
  $('setup-site-step').hidden = !siteStep;
  $('setup-site-step').disabled = !siteStep;
  $('setup-progress-account').toggleAttribute('aria-current', !siteStep);
  $('setup-progress-site').toggleAttribute('aria-current', siteStep);
  if (siteStep) $('setup-progress-site').setAttribute('aria-current', 'step');
  else $('setup-progress-account').setAttribute('aria-current', 'step');
  $('setup-error').textContent = '';
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
      await signedIn(session);
      await startPublish({ rebuild: true });
    } catch (error) {
      $('setup-error').textContent = error.message;
      if (error.status === 409) {
        deploymentConfig.initialized = true;
        showLogin();
        $('login-error').textContent = '账号已经创建，请使用设置的邮箱和密码登录。';
      }
      throw error;
    }
  });
});
$('publish-welcome').addEventListener('click', () =>
  action('publish-welcome', '正在发布首页…', () => startPublish({ rebuild: true })),
);

function badge(post) {
  return post.legacy
    ? '待导入原稿'
    : post.published
      ? post.changed
        ? '有未发布修改'
        : '已发布'
      : '草稿';
}
function renderLists() {
  const query = $('search').value.trim().toLowerCase();
  const sorted = [...posts].sort((a, b) => b.date.localeCompare(a.date));
  $('post-count').textContent = posts.length;
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
    const card = document.createElement('button');
    card.className = 'article-card';
    const tag = document.createElement('span');
    tag.className =
      'badge' + (post.legacy ? ' legacy' : post.changed || !post.published ? ' draft' : '');
    tag.textContent = badge(post);
    const h = document.createElement('h3');
    h.textContent = post.title;
    const p = document.createElement('p');
    p.textContent = post.description || '没有摘要';
    const date = document.createElement('small');
    date.textContent = post.date;
    card.append(tag, h, p, date);
    card.addEventListener('pointerenter', () => prefetchArticle(post.slug));
    card.addEventListener('focus', () => prefetchArticle(post.slug));
    card.addEventListener('click', () =>
      openPost(post.slug).catch((error) => notice(error.message)),
    );
    $('article-grid').append(card);
  }
  if (!posts.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '还没有文章，从新建或导入原稿开始。';
    $('article-grid').append(empty);
  }
}
function showDeployment(deployment) {
  $('deployment-state').textContent = deployment.managed
    ? '发布服务已连接，可以直接发布文章。'
    : deployment.configured
      ? '发布连接已配置，可随时替换。'
      : '尚未连接发布服务，请完成首次设置。';
  $('deployment-help').hidden = !!deployment.managed;
  $('deployment-help').open = !deployment.configured;
  for (const element of $('deployment-form').querySelectorAll('label,button'))
    element.hidden = !!deployment.managed;
}
async function refresh() {
  const data = await api('/api/posts');
  posts = data.posts;
  $('publish-welcome').hidden = !deploymentConfig.setupWizard || data.publicInitialized;
  site = { ...data.site, ...deploymentConfig.appearance };
  $('site-brand-title').textContent = data.site.title;
  for (const [slug, cached] of articleCache) {
    const post = posts.find((p) => p.slug === slug);
    if (!post || (post.etag && post.etag !== cached.etag) || post.legacy !== cached.legacy)
      articleCache.delete(slug);
  }
  renderLists();
  showPublishing(data.publishing);
  showDeployment(data.deployment);
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
    },
    body_markdown: $('body').value,
  };
}
function markdownSource(draft) {
  const f = draft.front_matter;
  const quote = (s) => JSON.stringify(s);
  return `+++\ntitle = ${quote(f.title)}\nslug = ${quote(f.slug)}\ndate = ${quote(f.date)}\ndescription = ${quote(f.description)}\ndraft = ${!!f.draft}\n${f.updated ? `updated = ${quote(f.updated)}\n` : ''}+++\n\n${draft.body_markdown}`;
}
function preview() {
  if (
    !doc ||
    $('editor-view').hidden ||
    (!matchMedia('(min-width:1100px)').matches &&
      !$('editor-panes').classList.contains('preview-only'))
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
  $('save-state').textContent = etag ? '草稿已保存' : '尚未保存草稿';
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
  $('save-state').textContent = '有未保存的修改';
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
    $('save-state').textContent = '填写标题后自动保存';
    return;
  }
  const version = dirty;
  const slug = captured.front_matter.slug;
  $('save-state').textContent = '正在保存到云端…';
  savePromise = api(`/api/posts/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    body: { draft: captured, etag: doc.etag || null },
  })
    .then((result) => {
      doc.etag = result.etag;
      doc.front_matter.slug = slug;
      $('slug').readOnly = true;
      savedVersion = version;
      $('save-state').textContent = dirty === version ? '已保存到云端' : '正在等待保存最新修改…';
      if (dirty !== version)
        autosaveTimer = setTimeout(
          () => saveCurrent().catch((error) => notice(error.message)),
          500,
        );
      localSaved(captured, result);
    })
    .catch((error) => {
      if (error.status === 409) conflict = true;
      $('save-state').textContent =
        error.status === 409 ? '版本冲突，请下载原稿后重新打开' : '保存失败，请重试';
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
    if (data.legacy) {
      doc = null;
      legacySlug = slug;
      view('legacy');
      $('legacy-title').textContent = data.front_matter.title;
      $('legacy-link').href = new URL(`/posts/${slug}/`, deploymentConfig.siteUrl).href;
      renderLists();
    } else fillEditor(data.draft, data.etag);
    if (cached)
      void fetchArticle(slug)
        .then((fresh) => {
          if (
            version !== navigationVersion ||
            doc?.front_matter.slug !== slug ||
            fresh.etag === doc.etag
          )
            return;
          if (dirty === 0 && !savePromise && !fresh.legacy) fillEditor(fresh.draft, fresh.etag);
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
document.querySelector('.brand').addEventListener('click', async (e) => {
  e.preventDefault();
  if (editorLocked) return;
  const version = ++navigationVersion;
  try {
    await flush();
    if (version !== navigationVersion) return;
    invalidatePreview(true);
    navigationStatus();
    doc = null;
    view('home');
    renderLists();
  } catch (error) {
    notice(error.message);
  }
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
$('show-preview').addEventListener('click', () => {
  $('editor-panes').classList.add('preview-only');
  $('show-preview').classList.add('active');
  $('show-writing').classList.remove('active');
  preview();
});
$('show-writing').addEventListener('click', () => {
  $('editor-panes').classList.remove('preview-only');
  $('show-writing').classList.add('active');
  $('show-preview').classList.remove('active');
  if (!matchMedia('(min-width:1100px)').matches) invalidatePreview();
});
matchMedia('(min-width:1100px)').addEventListener('change', () => preview());
function download(data, name, type) {
  const a = document.createElement('a'),
    url = URL.createObjectURL(new Blob([data], { type }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('download-post').addEventListener('click', () =>
  action(
    'download-post',
    '正在准备下载…',
    async () => {
      if (doc) download(markdownSource(currentDraft()), `${$('slug').value}.md`, 'text/markdown');
    },
    '已开始下载原稿，请查看浏览器下载列表。',
  ),
);
function showPublishing(state) {
  publishingId = state?.release_id || '';
  publishingBusy = !!state && ['queued', 'building', 'built'].includes(state.status);
  $('cancel-publish').hidden =
    !deploymentConfig?.browserPublishing || !publishingBusy || publishRequest;
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
  const banner = $('publish-banner');
  banner.hidden = !state;
  if (!state) return;
  banner.classList.toggle('failed', state.status === 'failed');
  const messages = deploymentConfig?.browserPublishing
    ? {
        queued: '正在准备发布，请保持此页面打开。',
        building: '正在排版文章并上传页面，请保持此页面打开。',
        built: '正在完成发布…',
      }
    : {
        queued: '发布已提交，正在等待 Cloudflare 构建。草稿仍可继续编辑。',
        building: '正在生成网站，完成部署后这里会显示“已上线”。',
        built: '网页已生成，正在等待 Cloudflare 部署上线。',
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
    if (result.browser_release) await publishInBrowser(result);
    else notice('发布已提交，完成后会自动显示状态。', 'success');
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
  if (!confirm('取消发布后，这篇文章将从网站移除。已有原稿和历史版本会保留。继续吗？')) return;
  await startPublish({ unpublish: slug });
}
$('unpublish-post').addEventListener('click', () =>
  unpublish(doc.front_matter.slug).catch((error) => notice(error.message)),
);
$('legacy-unpublish').addEventListener('click', () =>
  unpublish(legacySlug).catch((error) => notice(error.message)),
);
$('delete-post').addEventListener('click', () => {
  if (!doc || editorLocked || !confirm('删除这份草稿？历史版本仍会保留。')) return;
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
  const form = new FormData();
  form.append('file', file);
  const result = await api('/api/upload', { method: 'POST', body: form });
  if (doc !== target) throw new Error('图片已上传，请返回原文章继续编辑。');
  const textarea = $('body');
  const name = file.name.replace(/[\[\]\\\n\r]/g, '');
  const text = `\n\n![${name}](${result.url})\n\n`;
  const start = textarea.selectionStart,
    end = textarea.selectionEnd;
  textarea.setRangeText(text, start, end, 'end');
  textarea.focus();
  changed();
}
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
for (const id of ['import-posts', 'legacy-import'])
  $(id).addEventListener('click', () => $('import-files').click());
$('import-files').addEventListener('change', async (e) => {
  try {
    await flush();
    let count = 0;
    for (const file of e.target.files) {
      const source = await file.text(),
        draft = await engineTask('parse', { source });
      const existing = posts.find((p) => p.slug === draft.front_matter.slug);
      if (
        existing?.has_draft &&
        !confirm(`“${draft.front_matter.title}”已经有在线草稿。用这个文件替换吗？`)
      )
        continue;
      const old = existing?.has_draft ? await api(`/api/posts/${draft.front_matter.slug}`) : null;
      await api(`/api/posts/${draft.front_matter.slug}`, {
        method: 'PUT',
        body: { source, etag: old?.etag || null },
      });
      count++;
    }
    await refresh();
    notice(`已导入 ${count} 篇原稿，作为草稿保存。需要点击发布才能更新线上内容。`);
  } catch (error) {
    notice(error.message);
  } finally {
    e.target.value = '';
  }
});
$('export-posts').addEventListener('click', async () => {
  try {
    await flush();
    const backup = await api('/api/export'),
      files = {};
    for (const [path, source] of Object.entries(backup.files))
      files[path === 'site.toml' ? 'site.json' : path] = strToU8(source);
    files['archived-pages.json'] = strToU8(JSON.stringify(backup.legacy_posts, null, 2));
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
    settingsEtag = data.etag;
    for (const [key, value] of Object.entries(data.site))
      if ($('site-form').elements[key]) $('site-form').elements[key].value = value;
    for (const key of ['bigTitle', 'footer', 'clarityId', 'about'])
      if (!data.site[key]) $('site-form').elements[key].value = '';
    showDeployment(data.deployment);
    invalidatePreview();
    view('settings');
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    if (version === navigationVersion) navigationStatus();
  }
});
$('site-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const values = Object.fromEntries(new FormData(e.currentTarget));
    const data = await api('/api/settings', {
      method: 'PUT',
      body: { site: values, etag: settingsEtag },
    });
    settingsEtag = data.etag;
    notice('网站信息已保存，点击发布后上线。');
  } catch (error) {
    notice(error.message);
  }
});
$('publish-settings').addEventListener('click', () =>
  action('publish-settings', '正在提交发布…', async () => {
    const values = Object.fromEntries(new FormData($('site-form')));
    const saved = await api('/api/settings', {
      method: 'PUT',
      body: { site: values, etag: settingsEtag },
    });
    settingsEtag = saved.etag;
    await startPublish({ settings: true });
  }),
);
$('deployment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/settings/deployment', {
      method: 'PUT',
      body: { url: e.currentTarget.elements.url.value },
    });
    e.currentTarget.reset();
    $('deployment-state').textContent = '发布连接已配置。';
    $('deployment-help').open = false;
    notice('发布连接已保存。');
  } catch (error) {
    notice(error.message);
  }
});
$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  if (form.elements.password.value !== form.elements.confirm.value) {
    notice('两次新密码不一致。');
    return;
  }
  try {
    const data = await api('/api/password', {
      method: 'POST',
      body: {
        current_password: form.elements.current_password.value,
        password: form.elements.password.value,
      },
    });
    csrf = data.csrf;
    form.reset();
    notice('密码已更新，其他设备需要重新登录。');
  } catch (error) {
    notice(error.message);
  }
});
$('logout').addEventListener('click', async () => {
  if (editorLocked) return;
  ++navigationVersion;
  try {
    await flush();
    await api('/api/logout', { method: 'POST', body: {} });
    doc = null;
    dirty = 0;
    savedVersion = 0;
    showLogin();
  } catch (error) {
    notice(error.message);
  }
});
$('history-post').addEventListener('click', () => {
  if (!doc || editorLocked) return;
  void action('history-post', '正在读取…', async () => {
    $('history-list').textContent = '正在读取历史版本…';
    $('history-dialog').showModal();
    try {
      await flush();
      const slug = doc.front_matter.slug,
        versions = await api(`/api/history/${slug}`);
      $('history-list').replaceChildren();
      for (const item of versions) {
        const button = document.createElement('button');
        button.textContent = new Date(item.saved_at).toLocaleString();
        const span = document.createElement('span');
        span.textContent = '恢复为草稿';
        button.append(span);
        button.addEventListener('click', async () => {
          if (editorLocked || !confirm('将此历史版本恢复为草稿？当前版本也已保存在历史记录中。'))
            return;
          lockEditor(true);
          button.disabled = true;
          span.textContent = '正在恢复…';
          try {
            if (doc?.front_matter.slug !== slug) throw new Error('请重新打开这篇文章的历史版本。');
            await flush();
            const previous = await api(`/api/history/${slug}?key=${encodeURIComponent(item.key)}`);
            const etag = doc.etag;
            fillEditor(previous.draft, etag);
            lockEditor(true);
            changed();
            await saveCurrent();
            $('history-dialog').close();
            notice('已恢复并保存为草稿，点击发布后更新网站。', 'success');
          } catch (error) {
            notice(error.message, 'error');
          } finally {
            lockEditor(false);
            button.disabled = false;
            span.textContent = '恢复为草稿';
          }
        });
        $('history-list').append(button);
      }
      if (!versions.length) $('history-list').textContent = '还没有保存过的历史版本。';
    } catch (error) {
      $('history-list').textContent = error.message;
      throw error;
    }
  });
});
$('close-history').addEventListener('click', () => $('history-dialog').close());

$('account-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.elements.password.value !== form.elements.confirm.value) {
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
    for (const input of $('site-form').querySelectorAll('input,textarea')) input.value = '';
    for (const [key, value] of Object.entries(result.site))
      if ($('site-form').elements[key]) $('site-form').elements[key].value = value;
  },
});
