const $ = (id) => document.getElementById(id);
const kinds = {
  published: '已发布',
  draft: '草稿',
  history: '历史版本',
  settings: '网站设置',
  pending: '正在发布',
};
function size(bytes) {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function configureImages({
  api,
  flush,
  notice,
  action,
  open,
  insert,
  canInsert,
  siteUrl,
  beginNavigation,
}) {
  let images = [],
    cursor = null,
    requestVersion = 0,
    loading = false,
    referenceError = '';
  function status(message) {
    $('image-library-status').textContent = message;
  }
  function render() {
    const grid = $('image-library-grid');
    grid.replaceChildren();
    const query = $('image-library-search').value.trim().toLowerCase();
    const unused = $('image-library-unused').checked;
    const visible = images.filter(
      (image) =>
        `${image.name} ${image.key}`.toLowerCase().includes(query) &&
        (!unused || (image.referencesChecked && !image.references.length)),
    );
    $('image-library-summary').textContent =
      `${images.length} 张已加载 · ${size(images.reduce((total, image) => total + image.size, 0))}`;
    for (const image of visible) {
      const card = document.createElement('article');
      card.className = 'image-card';
      card.dataset.key = image.key;
      const preview = document.createElement('button');
      preview.className = 'image-thumbnail';
      preview.setAttribute('aria-label', `预览 ${image.name}`);
      const thumbnail = document.createElement('img');
      thumbnail.src = `/api/image?key=${encodeURIComponent(image.key)}&version=${encodeURIComponent(image.etag)}`;
      thumbnail.alt = image.name;
      thumbnail.loading = 'lazy';
      thumbnail.decoding = 'async';
      preview.append(thumbnail);
      preview.addEventListener('click', () => {
        $('image-preview-title').textContent = image.name;
        $('image-preview-full').src = thumbnail.src;
        $('image-preview-dialog').showModal();
      });
      const body = document.createElement('div');
      body.className = 'image-card-body';
      const name = document.createElement('h3');
      name.textContent = image.name;
      name.title = image.key;
      const meta = document.createElement('p');
      meta.className = 'muted';
      meta.textContent = `${size(image.size)} · ${new Date(image.uploaded).toLocaleDateString()}`;
      const badge = document.createElement('span');
      badge.className =
        'badge' + (image.referencesChecked && !image.references.length ? ' draft' : '');
      badge.textContent = !image.referencesChecked
        ? '引用检查未完成'
        : image.references.length
          ? '正在使用'
          : '未发现引用';
      body.append(name, meta, badge);
      if (image.references.length) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = `查看 ${image.references.length} 处引用`;
        const list = document.createElement('ul');
        for (const ref of image.references) {
          const item = document.createElement('li');
          item.textContent = `${kinds[ref.kind]} · ${ref.title}`;
          list.append(item);
        }
        details.append(summary, list);
        body.append(details);
      }
      const actions = document.createElement('div');
      actions.className = 'image-actions';
      function button(text, work) {
        const element = document.createElement('button');
        element.textContent = text;
        element.addEventListener('click', async () => {
          if (element.disabled) return;
          element.disabled = true;
          try {
            await work();
          } catch (error) {
            notice(error.message, 'error');
          } finally {
            element.disabled = false;
          }
        });
        actions.append(element);
        return element;
      }
      button('复制链接', async () => {
        await navigator.clipboard.writeText(new URL(image.url, siteUrl()).href);
        notice('图片链接已复制。', 'success');
      });
      const use = button('插入当前文章', () => insert(image));
      use.disabled = !canInsert();
      if (use.disabled) use.title = '先打开或新建一篇文章，再从编辑器进入图片库。';
      const remove = button('删除', async () => {
        if (!confirm(`永久删除“${image.name}”？图片将从存储桶移除，无法撤销。`)) return;
        await flush();
        try {
          await api('/api/images', {
            method: 'DELETE',
            body: { key: image.key, etag: image.etag },
          });
        } catch (error) {
          await load().catch(() => {});
          throw error;
        }
        images = images.filter((item) => item.key !== image.key);
        render();
        notice('图片已从存储桶删除。', 'success');
      });
      remove.classList.add('danger');
      remove.disabled = !image.referencesChecked || image.references.length > 0;
      remove.title = !image.referencesChecked
        ? '引用检查未完成，暂时不能删除。'
        : image.references.length
          ? '先处理文章、历史版本或网站设置中的引用。'
          : '永久删除这张图片';
      body.append(actions);
      card.append(preview, body);
      grid.append(card);
    }
    $('image-library-empty').hidden = visible.length > 0 || loading;
    $('image-library-empty').textContent = images.length
      ? '没有符合筛选条件的图片。'
      : '还没有图片。可以在这里上传，也可以在编辑器中粘贴或拖入图片。';
    $('image-library-more').hidden = !cursor;
    $('image-library-back').hidden = !canInsert();
    $('image-library-warning').hidden = !referenceError;
    $('image-library-warning').textContent = referenceError
      ? `${referenceError} 仍可预览和使用图片，删除暂不可用。`
      : '';
  }
  async function load(reset = true) {
    const version = ++requestVersion;
    loading = true;
    status('正在读取图片库和引用信息…');
    if (reset) {
      images = [];
      cursor = null;
      referenceError = '';
      render();
    }
    try {
      const data = await api(
        '/api/images' + (!reset && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
      );
      if (version !== requestVersion) return;
      const page = data.images.map((image) => ({
        ...image,
        referencesChecked: data.referencesChecked,
      }));
      const combined = new Map((reset ? [] : images).map((image) => [image.key, image]));
      for (const image of page) combined.set(image.key, image);
      images = [...combined.values()];
      cursor = data.cursor;
      referenceError = data.referenceError || referenceError;
      status(cursor ? '还有更多图片，可继续加载。筛选只作用于已加载图片。' : '图片库已加载。');
    } finally {
      if (version === requestVersion) {
        loading = false;
        render();
      }
    }
  }
  async function show() {
    const current = beginNavigation();
    await flush();
    if (!current()) return;
    open();
    await load();
  }
  for (const id of ['images', 'choose-library-image'])
    $(id).addEventListener('click', () => action(id, '正在打开…', show));
  $('image-library-refresh').addEventListener('click', () =>
    action('image-library-refresh', '正在刷新…', () => load()),
  );
  $('image-library-more').addEventListener('click', () =>
    action('image-library-more', '正在加载…', () => load(false)),
  );
  $('image-library-search').addEventListener('input', render);
  $('image-library-unused').addEventListener('change', render);
  $('image-library-back').addEventListener('click', () => open(true));
  $('image-preview-close').addEventListener('click', () => $('image-preview-dialog').close());
  $('image-preview-dialog').addEventListener('close', () =>
    $('image-preview-full').removeAttribute('src'),
  );
  $('image-library-upload').addEventListener('click', () => $('image-library-files').click());
  $('image-library-files').addEventListener('change', async (event) => {
    const files = [...event.target.files];
    if (!files.length) return;
    try {
      await action('image-library-upload', '正在上传…', async () => {
        await flush();
        let done = 0;
        for (const file of files) {
          const body = new FormData();
          body.append('file', file);
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
}
