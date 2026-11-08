const $ = (id) => document.getElementById(id);
const kinds = {
  published: '已发布',
  draft: '草稿',
  settings: '网站设置',
  pending: '正在发布',
  backup: '备份任务',
};
function size(bytes) {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function configureImages({
  imageUploadForm,
  confirmAction,
  api,
  flush,
  notice,
  action,
  open,
  insert,
  canInsert,
  siteUrl,
  beginNavigation,
  rebuild,
}) {
  let images = [],
    cursor = null,
    requestVersion = 0,
    loading = false,
    referenceError = '',
    loadError = '',
    loadedAt = 0,
    completeCatalog = false,
    visibleLimit = 24;
  const selected = new Set();
  function updateBatch() {
    const bar = $('image-batch-bar');
    if (!bar) return;
    bar.hidden = selected.size === 0;
    $('image-batch-count').textContent = `已选择 ${selected.size} 项`;
  }
  for (const [id, operation] of [
    ['image-library-optimize', 'optimize'],
    ['image-library-republish', 'republish'],
  ])
    $(id).addEventListener('click', () =>
      action(id, '正在处理…', async () => {
        const { maintainImages } = await import('/image-maintenance.js');
        await maintainImages(operation, {
          api,
          flush,
          notice,
          load,
          rebuild,
          imageUploadForm: (file) => imageUploadForm(file, { compact: false }),
          confirmAction,
        });
      }),
    );
  window.addEventListener('cloudink-content-changed', () => {
    loadedAt = 0;
  });
  function status(message) {
    $('image-library-status').textContent = message;
  }
  function render() {
    const grid = $('image-library-grid');
    grid.replaceChildren();
    grid.setAttribute('aria-busy', String(loading));
    const query = $('image-library-search').value.trim().toLowerCase();
    const unused = $('image-library-unused').checked;
    const visible = images.filter(
      (image) =>
        `${image.name} ${image.key}`.toLowerCase().includes(query) &&
        (!unused || (image.referencesChecked && !image.references.length)),
    );
    if (loading && !images.length) {
      grid.innerHTML =
        '<div class="image-card image-skeleton" aria-hidden="true" inert><div class="image-thumbnail"></div><div class="image-card-body"><span></span><span></span><span></span></div></div>'.repeat(
          6,
        );
    } else {
      $('image-library-summary').textContent =
        `${images.length} 张已加载 · ${size(images.reduce((total, image) => total + (image.totalSize || image.size), 0))}`;
      const cards = [];
      let cardIdx = 0;
      for (const image of visible.slice(0, visibleLimit)) {
        const isSelected = selected.has(image.key);
        const helpId = 'image-help-' + cardIdx++;
        const canDel =
          !loading && !loadError && image.referencesChecked && !image.references.length;
        const helpText =
          loading || loadError
            ? '刷新中受保护。'
            : !image.referencesChecked
              ? '检查中受保护。'
              : image.references.length
                ? '使用中受保护。'
                : '删除受保护。';
        const badgeText = !image.referencesChecked
          ? '引用检查未完成'
          : image.references.length
            ? '正在使用'
            : '未发现引用';
        const badgeCls =
          'badge' + (image.referencesChecked && !image.references.length ? ' draft' : '');
        const dim =
          image.width > 0 && image.height > 0
            ? ` width="${image.width}" height="${image.height}"`
            : '';
        const refs = image.references.length
          ? `<details><summary>查看 ${image.references.length} 处引用</summary><ul>${image.references.map((r) => `<li>${kinds[r.kind]} · ${r.title}</li>`).join('')}</ul></details>`
          : '';
        const skipped =
          image.optimization === 'skipped' ? '<p class="muted">无需转换或无法优化。</p>' : '';
        const meta = `${image.srcset ? '网页 ' + size(image.displaySize) + ' / 原图 ' : ''}${size(image.size)} · ${new Date(image.uploaded).toLocaleDateString()}`;

        cards.push(
          `<article class="image-card${isSelected ? ' is-selected' : ''}" data-key="${image.key}" draggable="true">` +
            `<label class="image-select-wrap"><input type="checkbox" class="image-select-check" aria-label="选择"${isSelected ? ' checked' : ''}></label>` +
            `<button class="image-thumbnail" aria-label="预览" data-act="preview">` +
            `<img src="/images/${encodeURI(image.thumbnailKey || image.key)}?version=${encodeURIComponent(image.etag)}" alt="${image.name}" loading="lazy" decoding="async"${dim} class="is-ready">` +
            `</button>` +
            `<div class="image-card-body">` +
            `<h3>${image.name}</h3>` +
            `<p class="muted">${meta}</p>` +
            `<span class="${badgeCls}">${badgeText}</span>` +
            skipped +
            refs +
            `<p id="${helpId}" class="image-protection">${helpText}</p>` +
            `<div class="image-actions">` +
            `<button data-act="copy">复制链接</button>` +
            `<button data-act="insert"${canInsert() ? '' : ' disabled'}>插入当前文章</button>` +
            `<button data-act="del" class="danger" aria-describedby="${helpId}"${canDel ? '' : ' disabled'}>删除</button>` +
            `</div></div></article>`,
        );
      }
      grid.innerHTML = cards.join('');
    }
    $('image-library-empty').hidden = visible.length > 0 || loading;
    $('image-library-retry').hidden = !loadError || loading;
    $('image-library-empty').textContent = loadError
      ? '图片库暂时无法读取，请重新加载。'
      : images.length
        ? '没有符合筛选条件的图片。'
        : '还没有图片。可以在这里上传，也可以在编辑器中粘贴或拖入图片。';
    $('image-library-more').hidden =
      (completeCatalog ? visible.length <= visibleLimit : !cursor) || loading || !!loadError;
    $('image-library-back').hidden = !canInsert();
    $('image-library-warning').hidden = !referenceError;
    $('image-library-warning').textContent = referenceError
      ? `${referenceError} 仍可预览和使用图片，删除暂不可用。`
      : '';
    updateBatch();
  }
  async function load(reset = true) {
    if (!reset && completeCatalog) {
      visibleLimit += 24;
      render();
      return;
    }
    if (reset) visibleLimit = 24;
    const version = ++requestVersion;
    loading = true;
    loadError = '';
    $('image-library-status').dataset.tone = 'pending';
    status('正在读取图片库和引用信息…');
    if (!images.length) render();
    else {
      // Retain the last successful cards and thumbnails during a refresh.
      $('image-library-grid').setAttribute('aria-busy', 'true');
      $('image-library-grid')
        .querySelectorAll('.danger')
        .forEach((button) => {
          button.disabled = true;
        });
      $('image-library-more').hidden = true;
      $('image-library-retry').hidden = true;
    }
    try {
      const data = await api(
        '/api/images' + (!reset && cursor ? `?cursor=${encodeURIComponent(cursor)}` : '?catalog=1'),
      );
      if (version !== requestVersion) return;
      const page = data.images.map((image) => ({
        ...image,
        referencesChecked: data.referencesChecked,
      }));
      const combined = new Map((reset ? [] : images).map((image) => [image.key, image]));
      for (const image of page) combined.set(image.key, image);
      images = [...combined.values()];
      $('image-library-reindex').hidden = !data.reindexRequired;
      cursor = data.cursor;
      completeCatalog = data.catalog === true;
      loadedAt = Date.now();
      referenceError = data.referenceError || (reset ? '' : referenceError);
      status(
        cursor || (completeCatalog && images.length > visibleLimit)
          ? '还有更多图片，可继续加载。筛选只作用于已加载图片。'
          : '图片库已加载。',
      );
      $('image-library-status').dataset.tone = 'success';
    } catch (error) {
      if (version === requestVersion) {
        loadError = error.message;
        status(error.message);
        $('image-library-status').dataset.tone = 'error';
      }
      throw error;
    } finally {
      if (version === requestVersion) {
        loading = false;
        render();
      }
    }
  }
  async function show(current = beginNavigation()) {
    await flush();
    if (!current()) return;
    open();
    if (loadedAt && Date.now() - loadedAt < 30_000 && !loadError && !loading) render();
    else await load();
  }
  $('image-library-reindex').addEventListener('click', () =>
    action('image-library-reindex', '正在更新…', async () => {
      let next = {},
        updated = 0;
      do {
        const result = await api('/api/images/reindex', { method: 'POST', body: next });
        updated += result.updated;
        next = result.next;
        status('已更新 ' + updated + ' 份原稿的引用索引…');
      } while (next);
      await load();
      notice('引用索引已更新，原稿内容保持不变。', 'success');
    }),
  );
  for (const [id, lbl, arg] of [
    ['image-library-refresh', '正在刷新…'],
    ['image-library-retry', '正在重试…'],
    ['image-library-more', '正在加载…', false],
  ])
    $(id).addEventListener('click', () => action(id, lbl, () => load(arg)));
  $('image-library-search').addEventListener('input', render);
  $('image-library-unused').addEventListener('change', render);
  const grid = $('image-library-grid');
  grid.addEventListener('change', (e) => {
    const check = e.target.closest('.image-select-check');
    if (!check) return;
    const card = check.closest('.image-card');
    const key = card?.dataset.key;
    if (!key) return;
    if (check.checked) {
      selected.add(key);
      card.classList.add('is-selected');
    } else {
      selected.delete(key);
      card.classList.remove('is-selected');
    }
    updateBatch();
  });
  grid.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.image-card');
    const image = card && images.find((i) => i.key === card.dataset.key);
    if (image) {
      e.dataTransfer.setData(
        'text/plain',
        `![${image.name.replace(/[\[\]\\]/g, '')}](${image.url})`,
      );
    }
  });
  grid.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled || btn.getAttribute('aria-busy') === 'true') return;
    const card = btn.closest('.image-card');
    const image = card && images.find((i) => i.key === card.dataset.key);
    if (!image) return;
    const act = btn.dataset.act;
    if (act === 'preview') {
      $('image-preview-title').textContent = image.name;
      $('image-preview-full').src = '/images/' + encodeURI(image.key);
      window.CloudInkMotion.openDialog($('image-preview-dialog'));
      return;
    }
    if (act === 'copy') {
      await navigator.clipboard.writeText(new URL(image.url, siteUrl()).href);
      notice('图片链接已复制。', 'success');
      return;
    }
    if (act === 'insert') {
      insert(image);
      return;
    }
    if (act === 'del') {
      if (
        !(await confirmAction(`“${image.name}”将从存储桶永久移除，无法撤销。`, {
          title: '删除这张图片？',
          accept: '永久删除',
          danger: true,
        }))
      )
        return;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      await flush();
      try {
        await api('/api/images', {
          method: 'DELETE',
          body: { key: image.key, etag: image.etag },
        });
      } catch (error) {
        await load().catch(() => {});
        status(error.message);
        $('image-library-status').dataset.tone = 'error';
        notice(error.message, 'error');
        return;
      } finally {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
      images = images.filter((item) => item.key !== image.key);
      render();
      $('image-library-refresh').focus({ preventScroll: true });
      notice('图片已从存储桶删除。', 'success');
    }
  });
  const getChosen = () => images.filter((img) => selected.has(img.key));
  $('image-batch-insert')?.addEventListener('click', () => {
    const chosen = getChosen();
    chosen.forEach(insert);
    selected.clear();
    render();
    notice(`已将 ${chosen.length} 张图片插入正文。`, 'success');
  });
  $('image-batch-copy')?.addEventListener('click', async () => {
    const chosen = getChosen();
    await navigator.clipboard.writeText(
      chosen.map((img) => `![${img.name.replace(/[\[\]\\]/g, '')}](${img.url})`).join('\n\n'),
    );
    notice(`已复制 ${chosen.length} 张图片的 Markdown。`, 'success');
  });
  $('image-batch-clear')?.addEventListener('click', () => {
    selected.clear();
    render();
  });
  $('image-library-back').addEventListener('click', () => open(true));
  $('image-preview-close').addEventListener('click', () =>
    window.CloudInkMotion.closeDialog($('image-preview-dialog')),
  );
  $('image-preview-dialog').addEventListener('close', () => {
    if (!$('image-preview-dialog').open) $('image-preview-full').removeAttribute('src');
  });
  $('image-library-upload').addEventListener('click', () => $('image-library-files').click());
  $('image-library-files').addEventListener('change', async (event) => {
    const files = [...event.target.files];
    if (!files.length) return;
    try {
      await action('image-library-upload', '正在上传…', async () => {
        await flush();
        let done = 0;
        for (const file of files) {
          const body = await imageUploadForm(file);
          await api('/api/upload', { method: 'POST', body });
          status(`已上传 ${++done} / ${files.length} 张…`);
        }
        await load();
        notice(`已上传 ${done} 张图片，可复制链接或插入文章。`, 'success');
      });
    } finally {
      event.target.value = '';
    }
  });
  return { show };
}
