// Shorts ("短记") management: list, compose, save draft, publish, delete.
import { $ } from './dom.js';
import { confirmAction, feedback } from './workflows.js';
import { markdownToShortPreview } from './admin-text-utils.js';
function nowMinute() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function slugFor(date) {
  return 'short-' + date.replace(/\D/g, '').slice(0, 12) + '-' + crypto.randomUUID().slice(0, 8);
}
export function configureShorts({ api, notice, action, open, startPublish, onList }) {
  let shorts = [],
    totalShorts = null,
    cursor = null,
    loadRevision = 0,
    hasLoaded = false;
  const more = document.createElement('button');
  more.id = 'short-more';
  more.textContent = '加载更多短记';
  more.hidden = true;
  $('short-list').after(more);
  more.addEventListener('click', () => action('short-more', '正在加载…', () => load(true)));
  const editorEl = $('short-editor');
  const editorHomeParent = editorEl?.parentNode || null;
  const editorHomeNext = $('short-list');
  let editing = null, // { slug, etag } or null for new
    editorRevision = 0,
    savedEditorValue = '',
    returnContext = null; // { slug, scrollY, cardTop }
  function isInlineEditorMode() {
    return !window.matchMedia('(min-width: 1150px)').matches;
  }
  function findShortCard(slug) {
    if (!slug) return null;
    for (const card of $('short-list').querySelectorAll('.short-admin-card')) {
      if (card.dataset.shortSlug === slug) return card;
    }
    return null;
  }
  function restoreEditorHome() {
    if (!editorEl || !editorHomeParent) return;
    editorEl.classList.remove('is-inline');
    if (editorEl.parentNode !== editorHomeParent) {
      editorHomeParent.insertBefore(editorEl, editorHomeNext);
    }
  }
  function syncEditingHighlight(slug) {
    for (const card of $('short-list').querySelectorAll('.short-admin-card.is-editing')) {
      card.classList.remove('is-editing');
    }
    const active = findShortCard(slug);
    if (active) active.classList.add('is-editing');
    return active;
  }
  function mountEditorForSlug(slug) {
    const activeCard = syncEditingHighlight(slug);
    if (slug && activeCard && isInlineEditorMode()) {
      editorEl.classList.add('is-inline');
      activeCard.after(editorEl);
      return activeCard;
    }
    restoreEditorHome();
    return activeCard;
  }
  function isElementInViewport(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.bottom > 80 && rect.top < window.innerHeight - 40;
  }
  function restoreCardPosition(slug, cardTop, fallbackScrollY) {
    const card = findShortCard(slug);
    if (card) {
      if (typeof cardTop === 'number') {
        const delta = card.getBoundingClientRect().top - cardTop;
        if (Math.abs(delta) > 1) window.scrollBy(0, delta);
      }
      const rect = card.getBoundingClientRect();
      const bottomSafe = window.innerWidth <= 767 ? 116 : 28;
      if (rect.top < 84 || rect.bottom > window.innerHeight - bottomSafe) {
        card.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
      card.querySelector('.short-edit-btn')?.focus({ preventScroll: true });
      return;
    }
    if (typeof fallbackScrollY === 'number') {
      window.scrollTo({ top: fallbackScrollY, behavior: 'instant' });
    }
  }
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
  const fullShortCache = new Map();
  const shortRequests = new Map();
  function cacheFullShort(slug, data) {
    fullShortCache.delete(slug);
    fullShortCache.set(slug, { draft: structuredClone(data.draft), etag: data.etag || null });
    if (fullShortCache.size > 50) fullShortCache.delete(fullShortCache.keys().next().value);
    if (typeof data.draft?.body_markdown === 'string')
      contentCache.set(slug, data.draft.body_markdown);
  }
  function fetchShort(slug) {
    if (!shortRequests.has(slug))
      shortRequests.set(
        slug,
        api(`/api/shorts/${encodeURIComponent(slug)}`)
          .then((data) => {
            cacheFullShort(slug, data);
            return data;
          })
          .finally(() => shortRequests.delete(slug)),
      );
    return shortRequests.get(slug);
  }
  function prefetchShort(item) {
    if (!item?.slug) return;
    const cached = fullShortCache.get(item.slug);
    if (cached && (!item.etag || cached.etag === item.etag)) return;
    void fetchShort(item.slug).catch(() => {});
  }
  function status(message, tone = '') {
    const el = $('short-status');
    el.textContent = message;
    el.dataset.tone = tone;
  }
  async function refreshPublished() {
    feedback('short-operation-status', '短记已上线，原稿已保留。', 'success');
    await load().catch(() => {
      feedback('short-operation-status', '短记已上线，列表暂未刷新，请重新打开短记。', 'success');
    });
  }
  function updateWordCount() {
    const body = $('short-body')?.value || '';
    const count = body.replace(/\s/g, '').length;
    status(count ? `${count} 个字符` : '');
  }
  $('short-body')?.addEventListener('input', updateWordCount);
  function render() {
    const list = $('short-list');
    const editingSlug = !editorEl.hidden && editing?.slug ? editing.slug : null;
    const activeCardTopBefore = editingSlug
      ? (findShortCard(editingSlug)?.getBoundingClientRect().top ?? null)
      : null;
    if (editorEl && editorEl.parentNode === list) {
      restoreEditorHome();
    }
    list.replaceChildren();
    $('short-empty').hidden = shorts.length > 0;
    for (const item of shorts) {
      const card = document.createElement('article');
      card.className = 'short-admin-card';
      card.dataset.shortSlug = item.slug;

      const header = document.createElement('div');
      header.className = 'short-card-header';

      const meta = document.createElement('div');
      meta.className = 'short-card-meta';

      const time = document.createElement('time');
      time.className = 'muted';
      time.textContent = item.date;

      const badge = document.createElement('span');
      badge.className = 'badge' + (item.published ? '' : ' draft');
      badge.textContent = item.published
        ? item.has_draft
          ? '已发布 · 原稿保留'
          : '已发布'
        : '草稿';

      meta.append(time, badge);

      const actions = document.createElement('div');
      actions.className = 'short-card-actions';
      const edit = document.createElement('button');
      edit.className = 'plain-button short-edit-btn';
      edit.textContent = '编辑';
      edit.addEventListener('click', () => openEditor(item));
      const pub = document.createElement('button');
      pub.id = 'short-publish-' + item.slug;
      pub.textContent = item.published ? (item.has_draft ? '重新发布' : '已发布') : '发布';
      pub.disabled = item.published && !item.has_draft;
      pub.classList.add('primary');
      pub.addEventListener('click', async () => {
        if (
          !(await confirmAction(
            `将发布这条短记（${item.date}）的已保存原稿，只有当前短记会上线，其他草稿保持私有。`,
            {
              title: item.published ? '重新发布这条短记？' : '发布这条短记？',
              accept: '确认发布',
            },
          ))
        )
          return;
        await action('short-publish-' + item.slug, '正在发布…', async () => {
          await startPublish({ shortSlug: item.slug, etag: item.etag || '' });
          await refreshPublished();
        });
      });
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
          fullShortCache.delete(item.slug);
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
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openEditor(item);
        }
      });
      const warm = () => prefetchShort(item);
      card.addEventListener('pointerenter', warm, { passive: true });
      card.addEventListener('pointerdown', warm, { passive: true });
      card.addEventListener('touchstart', warm, { passive: true });
      bodyWrapper.addEventListener('focus', warm, { passive: true });
      edit.addEventListener('focus', warm, { passive: true });

      const preview = document.createElement('p');
      preview.className = 'short-card-preview';
      const cached = contentCache.get(item.slug);
      if (cached) {
        const clean = markdownToShortPreview(cached);
        const hasImage = /!\[.*?\]\(.*?\)|<img\b/i.test(cached);
        const hasCode = /```|~~~/.test(cached);
        preview.textContent = clean || (hasImage ? '图片短记' : '空白短记');
        bodyWrapper.append(preview);

        const footer = document.createElement('div');
        footer.className = 'short-card-footer';
        const count = (clean || cached).replace(/\s/g, '').length;
        const countSpan = document.createElement('span');
        countSpan.className = 'short-count-pill';
        countSpan.textContent = `${count} 字`;
        footer.append(countSpan);
        if (hasImage) {
          const imgBadge = document.createElement('span');
          imgBadge.className = 'short-feature-pill';
          imgBadge.textContent = '含图片';
          footer.append(imgBadge);
        }
        if (hasCode) {
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
    if (editingSlug) {
      const remounted = mountEditorForSlug(editingSlug);
      if (remounted && typeof activeCardTopBefore === 'number') {
        const delta = remounted.getBoundingClientRect().top - activeCardTopBefore;
        if (Math.abs(delta) > 1) window.scrollBy(0, delta);
      }
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
    totalShorts = typeof data.total === 'number' ? data.total : shorts.length;
    hasLoaded = true;
    cursor = data.cursor;
    const totalEl = $('short-total-count');
    if (totalEl) {
      totalEl.textContent = `共 ${totalShorts} 条`;
      totalEl.hidden = false;
    }
    for (const item of shorts) {
      const full = fullShortCache.get(item.slug);
      if (full && item.etag && full.etag && full.etag !== item.etag)
        fullShortCache.delete(item.slug);
      const validFull = fullShortCache.get(item.slug);
      contentCache.set(
        item.slug,
        validFull ? validFull.draft.body_markdown || '' : item.snippet || '',
      );
    }
    render();
    more.hidden = !cursor;
  }
  async function openEditor(item = null) {
    if (!(await confirmDiscard())) return;
    const revision = ++editorRevision;
    const prevScrollY = window.scrollY;
    const sourceCard = item ? findShortCard(item.slug) : null;
    const sourceCardTop = sourceCard ? sourceCard.getBoundingClientRect().top : null;
    returnContext = {
      slug: item?.slug || null,
      scrollY: prevScrollY,
      cardTop: sourceCardTop,
    };
    const cached = item ? fullShortCache.get(item.slug) : null;
    const cacheFresh = Boolean(cached && (!item.etag || !cached.etag || cached.etag === item.etag));
    editing = item
      ? { slug: item.slug, etag: (cacheFresh ? cached.etag : item.etag) || null }
      : null;
    const target = editing;
    $('short-date').value = cacheFresh
      ? cached.draft.front_matter.date
      : item
        ? item.date
        : nowMinute();
    // List snippets are truncated. Only fill immediately when a verified full draft is cached.
    $('short-body').value = cacheFresh ? cached.draft.body_markdown || '' : '';
    const waiting = Boolean(item && !cacheFresh);
    $('short-body').readOnly = $('short-date').readOnly = waiting;
    $('short-save').disabled = $('short-publish').disabled = waiting;
    const activeCard = mountEditorForSlug(item?.slug || null);
    editorEl.hidden = false;
    window.CloudInkMotion.enter(editorEl, { kind: 'content' });
    savedEditorValue = editorValue();
    updateWordCount();
    if (waiting) status('正在加载短记正文…');

    if (item && activeCard) {
      if (typeof sourceCardTop === 'number') {
        const delta = activeCard.getBoundingClientRect().top - sourceCardTop;
        if (Math.abs(delta) > 1) window.scrollBy(0, delta);
      }
      if (editorEl.classList.contains('is-inline')) {
        const edRect = editorEl.getBoundingClientRect();
        const bottomSafe = window.innerWidth <= 767 ? 110 : 24;
        const maxBottom = window.innerHeight - bottomSafe;
        if (edRect.top < 84) {
          window.scrollBy(0, edRect.top - 84);
        } else if (edRect.bottom > maxBottom) {
          const shift = Math.min(edRect.bottom - maxBottom, Math.max(0, edRect.top - 84));
          if (shift > 0) window.scrollBy(0, shift);
        }
      }
    } else if (!item && !isElementInViewport(editorEl)) {
      editorEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    if (item) {
      fetchShort(item.slug).then(
        (data) => {
          const body = data.draft.body_markdown || '';
          if (editing === target && revision === editorRevision) {
            const changed = !cacheFresh || data.etag !== editing.etag;
            if (changed && (waiting || !hasUnsavedChanges())) {
              $('short-date').value = data.draft.front_matter.date;
              $('short-body').value = body;
              editing.etag = data.etag;
              savedEditorValue = editorValue();
              $('short-body').readOnly = $('short-date').readOnly = false;
              $('short-save').disabled = $('short-publish').disabled = false;
              updateWordCount();
            }
          }
          render();
        },
        (error) => {
          if (editing === target && waiting) status(error.message, 'error');
        },
      );
    }
    if (window.innerWidth > 767 && isElementInViewport(editorEl)) {
      $('short-date').focus({ preventScroll: true });
    }
  }
  function closeEditor({ restoreScroll = true } = {}) {
    ++editorRevision;
    const ctx = returnContext;
    returnContext = null;
    window.CloudInkMotion.cancelWithin(editorEl);
    editorEl.hidden = true;
    restoreEditorHome();
    syncEditingHighlight(null);
    editing = null;
    $('short-body').value = $('short-date').value = '';
    savedEditorValue = editorValue();
    if (restoreScroll && ctx) {
      restoreCardPosition(ctx.slug, ctx.cardTop, ctx.scrollY);
    }
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
      const error = new Error('发布时间格式不正确，请用 YYYY-MM-DD HH:MM。');
      status(error.message, 'error');
      throw error;
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
      cacheFullShort(slug, { draft, etag: result.etag });
      await load();
    }),
  );
  $('short-publish').addEventListener('click', async () => {
    const confirmedRevision = editorRevision,
      confirmedValue = editorValue();
    if (
      !(await confirmAction('保存最新原稿后，只发布当前这条短记。其他草稿保持私有。', {
        title: '发布这条短记？',
        accept: '确认发布',
      }))
    )
      return;
    if (confirmedRevision !== editorRevision || confirmedValue !== editorValue()) return;
    await editorAction('short-publish', '正在发布…', async () => {
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
      cacheFullShort(slug, { draft, etag: saved.etag });
      if (revision === editorRevision) {
        editing = { slug, etag: saved.etag };
        savedEditorValue = editorValue(draft);
      }
      await startPublish({ shortSlug: slug, etag: saved.etag });
      const publishReturn = returnContext
        ? { ...returnContext, slug }
        : { slug, cardTop: null, scrollY: window.scrollY };
      let closedAfterPublish = false;
      if (revision === editorRevision) {
        if (
          $('short-body').value === draft.body_markdown &&
          $('short-date').value.trim() === draft.front_matter.date
        ) {
          closeEditor({ restoreScroll: false });
          closedAfterPublish = true;
        } else status('短记已发布；当前修改尚未保存。');
      }
      await refreshPublished();
      if (closedAfterPublish) {
        restoreCardPosition(publishReturn.slug, publishReturn.cardTop, publishReturn.scrollY);
      }
    });
  });
  async function show() {
    const hadData = hasLoaded && shorts.length > 0;
    const list = $('short-list');
    // Start fetching shorts in parallel with flushing/switching views so network I/O
    // overlaps with saving any active article draft.
    const fetchPromise = load();
    fetchPromise.catch(() => {});
    if ((await open()) === false) return false;
    if (hadData) {
      // Stale-while-revalidate: keep previously rendered shorts interactive immediately
      // while refreshing from the server in the background.
      void fetchPromise.catch((error) => notice(error.message, 'error'));
      return true;
    }
    if (!hasLoaded && !shorts.length && list) {
      const loading = document.createElement('p');
      loading.className = 'muted';
      loading.textContent = '正在读取短记…';
      list.replaceChildren(loading);
    }
    await fetchPromise;
    return true;
  }
  return {
    show,
    confirmDiscard,
    reset() {
      hasLoaded = false;
      shorts = [];
      cursor = null;
      fullShortCache.clear();
      shortRequests.clear();
      closeEditor({ restoreScroll: false });
    },
  };
}
