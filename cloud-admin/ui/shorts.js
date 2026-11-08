// Shorts ("短记") management: list, compose, save draft, publish, delete.
import { confirmAction } from './workflows.js';
const $ = (id) => document.getElementById(id);
function nowMinute() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function slugFor(date) {
  return 'short-' + date.replace(/\D/g, '').slice(0, 12) + '-' + crypto.randomUUID().slice(0, 8);
}
export function configureShorts({
  api,
  notice,
  action,
  open,
  startPublish,
  onList,
  convertToPost,
}) {
  let shorts = [],
    cursor = null,
    loadRevision = 0;
  const more = document.createElement('button');
  more.id = 'short-more';
  more.textContent = '加载更多短记';
  more.hidden = true;
  $('short-list').after(more);
  more.addEventListener('click', () => action('short-more', '正在加载…', () => load(true)));
  let editing = null, // { slug, etag } or null for new
    editorRevision = 0,
    savedEditorValue = '';
  function editorValue(draft = null) {
    return JSON.stringify(
      draft
        ? [draft.front_matter.date, draft.body_markdown]
        : [$('short-date').value.trim(), $('short-body').value],
    );
  }
  function hasUnsavedChanges() {
    return !$('short-editor').hidden && editorValue() !== savedEditorValue;
  }
  async function confirmDiscard() {
    if (!hasUnsavedChanges()) return true;
    const revision = editorRevision;
    return (
      (await confirmAction(
        '当前短记有未保存的修改。可暂不操作返回编辑并保存，或明确放弃这些修改。',
        {
          title: '放弃未保存的短记修改？',
          accept: '放弃修改',
          danger: true,
        },
      )) && revision === editorRevision
    );
  }
  window.addEventListener('beforeunload', (event) => {
    if (hasUnsavedChanges()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
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
      const conv = document.createElement('button');
      conv.textContent = '转为文章';
      conv.title = '以本条短记为起点新建文章';
      conv.addEventListener('click', async () => {
        let body = contentCache.get(item.slug);
        if (body === undefined) {
          try {
            body =
              (await api(`/api/shorts/${encodeURIComponent(item.slug)}`)).draft?.body_markdown ||
              '';
            contentCache.set(item.slug, body);
          } catch {
            body = '';
          }
        }
        convertToPost?.({ date: item.date, body });
      });
      actions.append(edit, conv, pub, del);
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
      const cached = contentCache.get(item.slug) || item.snippet;
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
        preview.textContent = '空白短记';
        bodyWrapper.append(preview);
      }

      card.append(header, bodyWrapper);
      list.append(card);
    }
  }
  async function load(append = false) {
    const revision = ++loadRevision;
    let data;
    try {
      data = await api(
        '/api/shorts?limit=50' + (append && cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      );
    } catch (error) {
      if (append && error.status === 409) return load();
      throw error;
    }
    if (revision !== loadRevision) return;
    if (!append) onList?.(data);
    shorts = append ? [...shorts, ...(data.shorts || [])] : data.shorts || [];
    cursor = data.cursor;
    render();
    more.hidden = !cursor;
  }
  async function openEditor(item = null) {
    if (!(await confirmDiscard())) return;
    ++editorRevision;
    editing = item ? { slug: item.slug, etag: item.etag || null } : null;
    const target = editing;
    $('short-date').value = item ? item.date : nowMinute();
    // List snippets are truncated. Do not let them overwrite the full source or
    // replace text the author starts typing while the read is still in flight.
    $('short-body').value = '';
    $('short-body').readOnly = $('short-date').readOnly = !!item;
    $('short-save').disabled = $('short-publish').disabled = !!item;
    $('short-editor').hidden = false;
    savedEditorValue = editorValue();
    updateWordCount();
    if (item) {
      api(`/api/shorts/${encodeURIComponent(item.slug)}`).then(
        (data) => {
          const body = data.draft.body_markdown || '';
          contentCache.set(item.slug, body);
          if (editing === target) {
            $('short-date').value = data.draft.front_matter.date;
            $('short-body').value = body;
            editing.etag = data.etag;
            savedEditorValue = editorValue();
            $('short-body').readOnly = $('short-date').readOnly = false;
            $('short-save').disabled = $('short-publish').disabled = false;
            updateWordCount();
          }
          render();
        },
        (error) => {
          if (editing === target) status(error.message, 'error');
        },
      );
    }
    $('short-date').focus();
  }
  function closeEditor() {
    ++editorRevision;
    $('short-editor').hidden = true;
    editing = null;
    $('short-body').value = $('short-date').value = '';
    savedEditorValue = editorValue();
  }
  async function editorAction(id, label, work) {
    await action(id, label, work);
    if ($('short-body').readOnly) $(id).disabled = true;
  }
  async function collect() {
    if ($('short-body').readOnly) throw new Error('短记原稿尚未载入，请稍后重试。');
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
  $('short-cancel').addEventListener('click', async () => {
    if (await confirmDiscard()) closeEditor();
  });
  $('short-save').addEventListener('click', () =>
    editorAction('short-save', '正在保存…', async () => {
      const revision = editorRevision,
        target = editing;
      const draft = await collect();
      if (!draft) return;
      const slug = draft.front_matter.slug;
      contentCache.set(slug, draft.body_markdown);
      const result = await api(`/api/shorts/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        body: { ...draft, etag: target?.etag || null },
      });
      if (revision === editorRevision) {
        editing = { slug, etag: result.etag };
        savedEditorValue = editorValue(draft);
        status('草稿已保存。', 'success');
      }
      await load();
    }),
  );
  $('short-publish').addEventListener('click', () =>
    editorAction('short-publish', '正在发布…', async () => {
      const revision = editorRevision,
        target = editing;
      const draft = await collect();
      if (!draft) return;
      const slug = draft.front_matter.slug;
      contentCache.set(slug, draft.body_markdown);
      const saved = await api(`/api/shorts/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        body: { ...draft, etag: target?.etag || null },
      });
      if (revision === editorRevision) {
        editing = { slug, etag: saved.etag };
        savedEditorValue = editorValue(draft);
      }
      await startPublish({ shortSlug: slug, etag: saved.etag });
      notice('短记已发布。', 'success');
      if (revision === editorRevision) {
        if (
          $('short-body').value === draft.body_markdown &&
          $('short-date').value.trim() === draft.front_matter.date
        )
          closeEditor();
        else status('短记已发布；当前修改尚未保存。');
      }
      await load();
    }),
  );
  async function show() {
    if ((await open()) === false) return false;
    await load();
    return true;
  }
  $('shorts').addEventListener('click', () => action('shorts', '正在打开…', show));
  return { show, confirmDiscard, reset: closeEditor };
}
