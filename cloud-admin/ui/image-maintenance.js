const $ = (id) => document.getElementById(id);
let busy = false;
export async function maintainImages(operation, { api, flush, notice, load, rebuild, imageUploadForm, confirmAction }) {
  if (busy) throw new Error('图片维护正在进行，请等待完成或暂停。');
  busy = true;
  let stopped = false;
  const pause = () => { stopped = true; $('image-library-pause').disabled = true; };
  const status = (text) => { $('image-optimize-status').textContent = text; };
  const controls = ['image-library-upload', 'image-library-refresh', 'image-library-more', 'image-library-optimize', 'image-library-republish', 'image-optimize-recheck'];
  const before = controls.map((id) => $(id).disabled);
  controls.forEach((id) => { $(id).disabled = true; });
  $('image-library-grid').inert = true;
  try {
    await flush();
    if (operation === 'republish') {
      if (!(await confirmAction('将按当前已发布内容重新生成全部网页，让优化图片生效。草稿和未发布设置不会上线。', { title: '更新已发布文章的图片？', accept: '更新网页' }))) return;
      status('正在更新已发布页面，请保持此页面打开…');
      await rebuild();
      status('已发布页面已更新。草稿和未发布设置保持原样。');
      notice('已更新文章图片。', 'success');
      return;
    }
    status('正在扫描全部图片…');
    $('image-optimize-errors').replaceChildren();
    const all = [];
    let cursor = null;
    do {
      const data = await api('/api/images' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
      all.push(...data.images);
      cursor = data.cursor;
    } while (cursor);
    const candidates = all.filter((image) => image.canOptimize || ($('image-optimize-recheck').checked && image.optimization === 'skipped'));
    if (!candidates.length) { status('没有待优化的图片。已优化、动画及小图片会跳过。'); return; }
    const originalBytes = candidates.reduce((sum, image) => sum + image.size, 0);
    const addedLimit = candidates.reduce((sum, image) => sum + Math.min(6_000_000, image.size * 2.55), 0);
    const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';
    if (!(await confirmAction('共 ' + candidates.length + ' 张待检查，需下载约 ' + mb(originalBytes) + ' 原图到浏览器；生成的小尺寸文件最多新增约 ' + mb(addedLimit) + ' 存储，实际通常更少。不会自动更新线上文章。', { title: '开始优化已有图片？', accept: '开始优化' }))) { status('尚未开始优化。'); return; }
    const progress = $('image-optimize-progress');
    progress.hidden = false; progress.max = candidates.length; progress.value = 0;
    $('image-library-pause').hidden = false;
    $('image-library-pause').disabled = false;
    $('image-library-pause').addEventListener('click', pause);
    let optimized = 0, skipped = 0, failed = 0, added = 0;
    for (const image of candidates) {
      if (stopped) break;
      status('正在处理 ' + (progress.value + 1) + ' / ' + candidates.length + '：' + image.name);
      try {
        const response = await fetch('/api/image?key=' + encodeURIComponent(image.key), { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(45000) });
        if (!response.ok) throw new Error('无法读取原图，请刷新后重试。');
        if (response.headers.get('ETag')?.replace(/^W\//, '').replaceAll('"', '') !== image.etag)
          throw new Error('原图已变化，请刷新后重试。');
        const blob = await response.blob();
        const form = await imageUploadForm(new File([blob], image.name, { type: blob.type }));
        form.delete('file');
        form.append('key', image.key); form.append('etag', image.etag);
        const result = await api('/api/images/optimize', { method: 'POST', body: form });
        if (result.optimized) optimized++; else skipped++;
        added += result.addedBytes;
      } catch (error) {
        failed++;
        if ($('image-optimize-errors').childElementCount < 20) {
          const item = document.createElement('li');
          item.textContent = image.name + '：' + error.message;
          $('image-optimize-errors').append(item);
        }
        if (error.status === 401 || !navigator.onLine) stopped = true;
      }
      progress.value++;
    }
    await load();
    status((stopped ? '已暂停。' : '处理完成。') + '优化 ' + optimized + ' 张，跳过 ' + skipped + ' 张，失败 ' + failed + ' 张；新增存储 ' + mb(added) + '。' + (failed || stopped ? '再次运行可继续，已完成项会自动跳过。' : '') + (optimized ? '点击“更新已发布文章的图片”使线上页面生效。' : ''));
  } finally {
    busy = false;
    $('image-library-grid').inert = false;
    controls.forEach((id, index) => { $(id).disabled = before[index]; });
    $('image-library-pause').hidden = true;
    $('image-library-pause').removeEventListener('click', pause);
  }
}
