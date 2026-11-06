// Shorts ("短记") management: list, compose, save draft, publish, delete.
import { confirmAction } from './workflows.js';
const $ = (id) => document.getElementById(id);
function nowMinute() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function slugFor(date) {
  return 'short-' + date.replace(/\D/g, '').slice(0, 12);
}
export function configureShorts({ api, notice, action, open, startPublish }) {
  let shorts = [];
  let editing = null; // { slug, etag } or null for new
  const contentCache = new Map();
  function status(message, tone = '') {
    const el = $('short-status');
    el.textContent = message;
    el.dataset.tone = tone;
  }
  function updateWordCount() {
    const body = $('short-body')?.value || '';
    const count = body.replace(/\s/g, '').length;
    status(count ? `${count} 个字符` : '');
  }
  $('short-body')?.addEventListener('input', updateWordCount);
  function render() {
    const list = $('short-list');
    list.replaceChildren();
    $('short-empty').hidden = shorts.length > 0;
    for (const item of shorts) {
      const card = document.createElement('article');
      card.className = 'short-admin-card';

      const header = document.createElement('div');
      header.className = 'short-card-header';

      const meta = document.createElement('div');
      meta.className = 'short-card-meta';

      const time = document.createElement('time');
      time.className = 'muted';
      time.textContent = item.date;

      const badge = document.createElement('span');
      badge.className = 'badge' + (item.published ? '' : ' draft');
      badge.textContent = item.published ? (item.has_draft ? '已发布·有草稿' : '已发布') : '草稿';

      meta.append(time, badge);

      const actions = document.createElement('div');
      actions.className = 'image-actions';
      const edit = document.createElement('button');
      edit.textContent = '编辑';
      edit.addEventListener('click', () => openEditor(item));
      const pub = document.createElement('button');
      pub.id = 'short-publish-' + item.slug;
      pub.textContent = item.published && !item.has_draft ? '已发布' : '发布';
      pub.disabled = item.published && !item.has_draft;
      pub.classList.add('primary');
      pub.addEventListener('click', () =>
        action('short-publish-' + item.slug, '正在发布…', async () => {
          await startPublish({ shortSlug: item.slug, etag: item.etag || '' });
          notice('短记已发布。', 'success');
          await load();
        }),
      );
      const del = document.createElement('button');
      del.id = 'short-delete-' + item.slug;
      del.textContent = '删除';
      del.classList.add('danger');
      del.addEventListener('click', async () => {
        if (
          !(await confirmAction(`确定删除这条短记（${item.date}）吗？`, {
            title: '删除短记？',
            accept: '删除',
            danger: true,
          }))
        )
          return;
        await action('short-delete-' + item.slug, '正在删除…', async () => {
          if (item.published) await startPublish({ unpublishShort: item.slug });
          await api(`/api/shorts/${encodeURIComponent(item.slug)}`, {
            method: 'DELETE',
            body: { etag: item.etag || '' },
          });
          contentCache.delete(item.slug);
          notice('短记已删除。', 'success');
          await load();
        });
      });
      actions.append(edit, pub, del);
      header.append(meta, actions);

      const bodyWrapper = document.createElement('div');
      bodyWrapper.className = 'short-card-content';
      bodyWrapper.setAttribute('role', 'button');
      bodyWrapper.setAttribute('tabindex', '0');
      bodyWrapper.setAttribute('title', '点击编辑此短记');
      bodyWrapper.addEventListener('click', () => openEditor(item));
      bodyWrapper.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') openEditor(item);
      });

      const preview = document.createElement('p');
      preview.className = 'short-card-preview';
      const cached = contentCache.get(item.slug);
      if (cached) {
        const clean = cached.replace(/^#+\s+/gm, '').trim();
        preview.textContent = clean;
        bodyWrapper.append(preview);

        const footer = document.createElement('div');
        footer.className = 'short-card-footer';
        const count = cached.replace(/\s/g, '').length;
        const countSpan = document.createElement('span');
        countSpan.className = 'short-count-pill';
        countSpan.textContent = `${count} 字`;
        footer.append(countSpan);
        if (/!\[.*?\]\(.*?\)/.test(cached)) {
          const imgBadge = document.createElement('span');
          imgBadge.className = 'short-feature-pill';
          imgBadge.textContent = '含图片';
          footer.append(imgBadge);
        }
        if (/```/.test(cached)) {
          const codeBadge = document.createElement('span');
          codeBadge.className = 'short-feature-pill';
          codeBadge.textContent = '含代码';
          footer.append(codeBadge);
        }
        bodyWrapper.append(footer);
      } else {
        preview.textContent = '正在载入内容…';
        preview.classList.add('is-loading');
        bodyWrapper.append(preview);
      }

      card.append(header, bodyWrapper);
      list.append(card);
    }
  }
  async function load() {
    const data = await api('/api/shorts');
    shorts = data.shorts || [];
    for (const item of shorts) {
      if (item.snippet) {
        contentCache.set(item.slug, item.snippet);
      }
    }
    render();
    const missing = shorts.filter((item) => !contentCache.has(item.slug));
    if (missing.length > 0) {
      for (const item of missing.slice(0, 10)) {
        api(`/api/shorts/${encodeURIComponent(item.slug)}`)
          .then((res) => {
            const body = res?.draft?.body_markdown || '';
            if (body) {
              contentCache.set(item.slug, body);
              render();
            }
          })
          .catch(() => {});
      }
    }
  }
  function openEditor(item = null) {
    editing = item ? { slug: item.slug, etag: item.etag || null } : null;
    $('short-date').value = item ? item.date : nowMinute();
    $('short-body').value = (item && contentCache.get(item.slug)) || '';
    $('short-editor').hidden = false;
    updateWordCount();
    if (item) {
      api(`/api/shorts/${encodeURIComponent(item.slug)}`).then(
        (data) => {
          const body = data.draft.body_markdown || '';
          contentCache.set(item.slug, body);
          if (editing && editing.slug === item.slug) {
            $('short-body').value = body;
            editing.etag = data.etag;
            updateWordCount();
          }
          render();
        },
        (error) => status(error.message, 'error'),
      );
    }
    $('short-date').focus();
  }
  function closeEditor() {
    $('short-editor').hidden = true;
    editing = null;
  }
  async function collect() {
    const date = $('short-date').value.trim();
    const body = $('short-body').value;
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(date)) {
      status('发布时间格式不正确，请用 YYYY-MM-DD HH:MM。', 'error');
      return null;
    }
    const slug = editing ? editing.slug : uniqueSlug(slugFor(date));
    return {
      front_matter: { date, slug, draft: true },
      body_markdown: body,
    };
  }
  function uniqueSlug(base) {
    // 同一分钟发多条时自动加 -2、-3 后缀，避免覆盖。
    let slug = base;
    for (let i = 2; shorts.some((s) => s.slug === slug); i++) slug = `${base}-${i}`;
    return slug;
  }
  $('short-new').addEventListener('click', () => openEditor());
  $('short-cancel').addEventListener('click', closeEditor);
  $('short-save').addEventListener('click', () =>
    action('short-save', '正在保存…', async () => {
      const draft = await collect();
      if (!draft) return;
      const slug = draft.front_matter.slug;
      contentCache.set(slug, draft.body_markdown);
      const result = await api(`/api/shorts/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        body: { ...draft, etag: editing?.etag || null },
      });
      if (editing) editing.etag = result.etag;
      else editing = { slug, etag: result.etag };
      status('草稿已保存。', 'success');
      await load();
    }),
  );
  $('short-publish').addEventListener('click', () =>
    action('short-publish', '正在发布…', async () => {
      const draft = await collect();
      if (!draft) return;
      const slug = draft.front_matter.slug;
      contentCache.set(slug, draft.body_markdown);
      const saved = await api(`/api/shorts/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        body: { ...draft, etag: editing?.etag || null },
      });
      await startPublish({ shortSlug: slug, etag: saved.etag });
      notice('短记已发布。', 'success');
      closeEditor();
      await load();
    }),
  );
  async function show() {
    open();
    await load().catch((error) => status(error.message, 'error'));
  }
  $('shorts').addEventListener('click', () => action('shorts', '正在打开…', show));
  return { show };
}
