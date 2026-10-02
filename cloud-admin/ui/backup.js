import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

const MAX_ARCHIVE = 100 * 1024 * 1024;
const $ = (id) => document.getElementById(id);
function status(text) {
  $('backup-status').textContent = text;
}
async function checksum(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export function configureBackup({
  api,
  flush,
  action,
  notice,
  download,
  refresh,
  getSettingsEtag,
  restored,
}) {
  $('download-backup').addEventListener('click', () =>
    action('download-backup', '正在准备备份…', async () => {
      await flush();
      const manifest = await api('/api/backup');
      const files = {},
        textChecksums = {};
      for (const [path, source] of Object.entries(manifest.files)) {
        const bytes = strToU8(source);
        files[`content/${path}`] = bytes;
        textChecksums[path] = await checksum(bytes);
      }
      // Fetch one image at a time. Binary data stays out of JSON and is never
      // buffered in the Worker; a changed object aborts this backup explicitly.
      let done = 0;
      for (const image of manifest.images) {
        status(`正在备份图片 ${++done} / ${manifest.images.length}…`);
        const response = await fetch(`/api/image?key=${encodeURIComponent(image.key)}`, {
          credentials: 'same-origin',
          signal: AbortSignal.timeout(45000),
        });
        if (!response.ok || response.headers.get('ETag') !== image.etag)
          throw new Error('图片在备份期间发生了修改或下载失败，请重试。');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== image.size) throw new Error('图片未下载完整，请重试。');
        image.sha256 = await checksum(bytes);
        files[`media/${image.key}`] = bytes;
      }
      files['manifest.json'] = strToU8(
        JSON.stringify({ ...manifest, files: textChecksums }, null, 2),
      );
      download(
        zipSync(files, { level: 0 }),
        `cloudink-site-${new Date().toISOString().slice(0, 10)}.zip`,
        'application/zip',
      );
      status(
        `备份已下载，包含 ${Object.keys(manifest.files).length} 份原稿与历史、${manifest.images.length} 张图片。`,
      );
    }),
  );
  $('restore-backup').addEventListener('click', () => $('backup-file').click());
  $('backup-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (
        !confirm(
          '恢复会导入草稿、历史、图片和待发布设置。登录账号与线上版本会保留，已有不同原稿不会被覆盖。继续吗？',
        )
      )
        return;
      await action('restore-backup', '正在恢复…', async () => {
        await flush();
        if (file.size > MAX_ARCHIVE + 2_000_000)
          throw new Error('这份备份超过网页恢复限制，请通过 Cloudflare R2 恢复。');
        let total = 0,
          count = 0;
        const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), {
          filter(entry) {
            total += entry.originalSize;
            if (++count > 5000 || total > MAX_ARCHIVE + 2_000_000)
              throw new Error('备份解压后的大小或文件数量超过限制。');
            if (
              entry.name !== 'manifest.json' &&
              !/^(?:content\/(?:published|drafts|history)\/|media\/uploads\/)/.test(entry.name)
            )
              throw new Error('备份包含不支持的文件。');
            return true;
          },
        });
        if (!archive['manifest.json'] || archive['manifest.json'].length > 16_120_000)
          throw new Error('备份清单缺失或过大。');
        const manifest = JSON.parse(strFromU8(archive['manifest.json']));
        if (
          manifest.format !== 'cloudink-backup' ||
          manifest.schema_version !== 1 ||
          !Array.isArray(manifest.images) ||
          !manifest.files ||
          typeof manifest.files !== 'object'
        )
          throw new Error('请使用 CloudInk 的“下载网站备份”生成的 ZIP 文件。');
        const sources = {};
        for (const [path, hash] of Object.entries(manifest.files)) {
          const bytes = archive[`content/${path}`];
          if (!bytes || (await checksum(bytes)) !== hash)
            throw new Error('备份原稿与清单不一致，请检查备份文件。');
          sources[path] = strFromU8(bytes);
        }
        // Check every image before uploading any of them.
        for (const image of manifest.images) {
          const bytes = archive[`media/${image.key}`];
          if (!bytes || bytes.length !== image.size || (await checksum(bytes)) !== image.sha256)
            throw new Error('备份图片缺失或校验失败。');
        }
        let done = 0;
        for (const image of manifest.images) {
          status(`正在恢复图片 ${++done} / ${manifest.images.length}…`);
          await api(`/api/backup/image?key=${encodeURIComponent(image.key)}`, {
            method: 'PUT',
            body: archive[`media/${image.key}`],
            rawBody: true,
          });
        }
        status('正在恢复原稿与网站设置…');
        const result = await api('/api/backup/restore', {
          method: 'POST',
          body: { backup: { ...manifest, files: sources }, settings_etag: getSettingsEtag() },
        });
        restored(result);
        await refresh();
        status(
          `已恢复 ${result.drafts} 篇草稿、${result.history} 份历史；检查网站设置和文章后再发布。`,
        );
        notice('备份已恢复为草稿，线上版本与账号均保留。', 'success');
      });
    } catch (error) {
      notice(error.message, 'error');
    } finally {
      event.target.value = '';
    }
  });
}
