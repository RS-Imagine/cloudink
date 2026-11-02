export async function publishInBrowser(result, { api, engineTask, showPublishing, refresh, notice }) {
  try {
    showPublishing({ ...result, status: 'building' });
    const rendered = await engineTask('site', { release: result.browser_release });
    const marker = JSON.parse(rendered['_release.json'] || 'null');
    if (result.template_version && marker?.template_version !== result.template_version)
      throw new Error('后台版本已更新，请刷新页面后重试；草稿和线上内容仍保留。');
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
