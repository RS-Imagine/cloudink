import { sha256Hex } from './dom.js';

export async function publishInBrowser(
  result,
  { api, engineTask, showPublishing, refresh, notice },
) {
  let deployed;
  try {
    showPublishing({ ...result, status: 'building' });
    const rendered = await engineTask('site', {
      release: result.browser_release,
      paths: result.render_files,
    });
    const marker = JSON.parse(rendered['_release.json'] || 'null');
    if (marker?.id !== result.release_id) throw new Error('网页版本与当前发布不一致，请重新生成。');
    if (result.template_version && marker?.template_version !== result.template_version)
      throw new Error('后台版本已更新，请刷新页面后重试；草稿和线上内容仍保留。');
    let files = [...(result.render_files || result.files)];
    const receipts = {};
    if (result.incremental) {
      const sources = {};
      for (const path of files.filter(
        (path) => !['styles.css', 'client.js', 'favicon.svg', 'sw.js'].includes(path),
      )) {
        if (typeof rendered[path] !== 'string') throw new Error('网页生成不完整，请重新发布。');
        sources[path] = await sha256Hex(rendered[path]);
      }
      files = (
        await api(`/api/publish/${result.release_id}/plan`, { method: 'POST', body: { sources } })
      ).files;
    }
    const uploads = await Promise.allSettled(
      Array.from({ length: Math.min(3, files.length) }, async () => {
        while (files.length) {
          const path = files.shift();
          if (typeof rendered[path] !== 'string') throw new Error('网页生成不完整，请重新发布。');
          const uploaded = await api(
            `/api/publish/${result.release_id}/file?path=${encodeURIComponent(path)}`,
            {
              method: 'PUT',
              body: rendered[path],
              rawBody: true,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            },
          );
          if (uploaded.receipt) receipts[path] = uploaded.receipt;
        }
      }),
    );
    const failure = uploads.find((upload) => upload.status === 'rejected');
    if (failure) throw failure.reason;
    showPublishing({ ...result, status: 'built' });
    const done = await api(`/api/publish/${result.release_id}/commit`, {
      method: 'POST',
      body: { receipts },
    });
    if (done.status !== 'deployed' || done.release_id !== result.release_id)
      throw new Error('尚未确认这次发布已上线，请检查发布状态。');
    deployed = done;
    showPublishing(done);
  } catch (error) {
    const stopped = await api(`/api/publish/${result.release_id}/cancel`, {
      method: 'POST',
      body: {},
    }).catch(() => null);
    if (stopped?.status === 'deployed' && stopped.release_id === result.release_id) {
      deployed = stopped;
      showPublishing(stopped);
    } else {
      const unconfirmed = '发布结果尚未确认，请联网后检查发布状态；原稿仍然保留。';
      showPublishing(
        (stopped?.release_id === result.release_id && stopped.status !== 'deployed'
          ? stopped
          : null) || {
          ...result,
          status: 'failed',
          error: unconfirmed,
        },
      );
      throw stopped ? error : new Error(unconfirmed);
    }
  }
  try {
    await refresh();
    notice('发布完成，网站已更新。', 'success');
  } catch {
    notice('发布已上线，管理列表暂未刷新，请稍后重试。', 'info');
  }
  return deployed;
}
