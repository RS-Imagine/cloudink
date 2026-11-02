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
  function status(message, tone = '') {
    const el = $('short-status');
    el.textContent = message;
    el.dataset.tone = tone;
  }
  function render() {
    const list = $('short-list');
    list.replaceChildren();
    $('short-empty').hidden = shorts.length > 0;
    for (const item of shorts) {
      const card = document.createElement('article');
      card.className = 'short-admin-card';
      const time = document.createElement('time');
      time.className = 'muted';
      time.textContent = item.date;
      const actions = document.createElement('div');
      actions.className = 'image-actions';
      const edit = document.createElement('button');
      edit.textContent = '编辑';
      edit.addEventListener('click', () => openEditor(item));
      const pub = document.createElement('button');
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
          notice('短记已删除。', 'success');
          await load();
        });
      });
      actions.append(edit, pub, del);
      const badge = document.createElement('span');
      badge.className = 'badge' + (item.published ? '' : ' draft');
      badge.textContent = item.published ? (item.has_draft ? '已发布·有草稿' : '已发布') : '草稿';
      card.append(time, badge, actions);
      list.append(card);
    }
  }
  async function load() {
    const data = await api('/api/shorts');
    shorts = data.shorts || [];
    render();
  }
  function openEditor(item = null) {
    editing = item ? { slug: item.slug, etag: item.etag || null } : null;
    $('short-date').value = item ? item.date : nowMinute();
    $('short-body').value = '';
    $('short-editor').hidden = false;
    status('');
    if (item) {
      api(`/api/shorts/${encodeURIComponent(item.slug)}`).then(
        (data) => {
          if (editing && editing.slug === item.slug) {
            $('short-body').value = data.draft.body_markdown || '';
            editing.etag = data.etag;
          }
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
      const result = await api(`/api/shorts/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        body: draft,
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
      const saved = await api(`/api/shorts/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        body: draft,
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
