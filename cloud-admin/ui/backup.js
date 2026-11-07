import { backupEntry, backupSource, legacyHistoryKey } from '../src/backup-contract.ts';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

const MAX_ARCHIVE = 100 * 1024 * 1024;
const $ = (id) => document.getElementById(id);
function status(text) {
  $('backup-status').textContent = text;
  $('backup-status').dataset.tone = 'pending';
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
  confirmAction,
}) {
  let controller = null,
    cancelled = false;
  function begin() {
    if (controller) throw new Error('当前备份任务仍在进行，请等待或取消。');
    controller = new AbortController();
    cancelled = false;
  }
  function jobApi(path, options = {}) {
    controller.signal.throwIfAborted();
    return api(path, {
      ...options,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
    });
  }
  $('cancel-backup').addEventListener('click', () =>
    action('cancel-backup', '正在取消…', async () => {
      cancelled = true;
      controller?.abort();
      const task = await api('/api/backup/jobs');
      if (task) await api('/api/backup/jobs/' + task.id + '/cancel', { method: 'POST', body: {} });
      status('未完成任务已取消；已恢复的草稿和图片保留，线上版本不变。');
    }),
  );
  $('download-backup').addEventListener('click', () =>
    action('download-backup', '正在准备备份…', async () => {
      begin();
      try {
        await flush();
        const task = await jobApi('/api/backup/jobs', { method: 'POST', body: { mode: 'export' } });
        const manifest = task.manifest,
          files = {},
          textChecksums = {};
        let index = 0,
          done = 0;
        do {
          const batch = await jobApi('/api/backup/jobs/' + task.id + '/read', {
            method: 'POST',
            body: { index },
          });
          for (const [path, source] of Object.entries(batch.files)) {
            const bytes = strToU8(source);
            files['content/' + path] = bytes;
            textChecksums[path] = await checksum(bytes);
            done++;
          }
          status('已读取 ' + done + ' / ' + task.total + ' 份原稿…');
          index = batch.next;
        } while (index !== null);
        done = 0;
        for (const image of manifest.images) {
          status('正在备份图片 ' + ++done + ' / ' + manifest.images.length + '…');
          const response = await fetch('/api/image?key=' + encodeURIComponent(image.key), {
            credentials: 'same-origin',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
          });
          if (!response.ok || response.headers.get('ETag') !== image.etag)
            throw new Error('图片在备份期间发生变化，请取消后重新备份。');
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length !== image.size) throw new Error('图片未下载完整，请重试。');
          image.sha256 = await checksum(bytes);
          files['media/' + image.key] = bytes;
        }
        files['manifest.json'] = strToU8(
          JSON.stringify({ ...manifest, files: textChecksums }, null, 2),
        );
        const zip = zipSync(files, { level: 0 });
        await jobApi('/api/backup/jobs/' + task.id + '/finish', { method: 'POST', body: {} });
        download(
          zip,
          'cloudink-site-' + new Date().toISOString().slice(0, 10) + '.zip',
          'application/zip',
        );
        status(
          '备份已下载，包含 ' +
            Object.keys(textChecksums).length +
            ' 份原稿、' +
            manifest.images.length +
            ' 个图片文件（含压缩版本）。',
        );
      } catch (error) {
        if (cancelled) status('任务已取消，已保存内容保留。');
        else {
          $('backup-status').textContent = error.message + ' 可重新下载或取消未完成任务。';
          $('backup-status').dataset.tone = 'error';
          throw error;
        }
      } finally {
        controller = null;
      }
    }),
  );
  $('restore-backup').addEventListener('click', () => $('backup-file').click());
  $('backup-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (
        !(await confirmAction(
          '恢复会导入草稿、图片和待发布设置。登录账号与线上版本会保留，已有不同原稿不会被覆盖。',
          { title: '从备份恢复？', accept: '恢复为草稿' },
        ))
      )
        return;
      await action('restore-backup', '正在恢复…', async () => {
        begin();
        try {
          await flush();
          if (file.size > MAX_ARCHIVE + 8_000_000)
            throw new Error('这份备份超过网页恢复限制，请通过 Cloudflare R2 恢复。');
          let total = 0,
            count = 0;
          const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), {
            filter(entry) {
              total += entry.originalSize;
              if (++count > 10001 || total > MAX_ARCHIVE + 8_000_000)
                throw new Error('备份解压后的大小或文件数量超过限制。');
              if (!backupEntry(entry.name)) throw new Error('备份包含不支持的文件。');
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
            typeof manifest.files !== 'object' ||
            Array.isArray(manifest.files)
          )
            throw new Error('请使用 CloudInk 下载的网站备份。');
          const sources = {},
            entries = [];
          for (const [path, hash] of Object.entries(manifest.files)) {
            const bytes = archive['content/' + path];
            if (!bytes || (await checksum(bytes)) !== hash)
              throw new Error('备份原稿与清单不一致。');
            if (legacyHistoryKey(path)) continue;
            if (!backupSource(path)) throw new Error('备份原稿路径不正确。');
            sources[path] = strFromU8(bytes);
            entries.push({ path, hash, size: bytes.length });
          }
          for (const image of manifest.images) {
            const bytes = archive['media/' + image.key];
            if (!bytes || bytes.length !== image.size || (await checksum(bytes)) !== image.sha256)
              throw new Error('备份图片缺失或校验失败。');
          }
          let task = await jobApi('/api/backup/jobs', {
            method: 'POST',
            body: {
              mode: 'restore',
              manifest: {
                format: manifest.format,
                schema_version: 1,
                entries,
                site: manifest.site,
                images: manifest.images,
              },
              settings_etag: getSettingsEtag(),
            },
          });
          const paths = task.entries;
          let done = 0;
          for (const image of manifest.images) {
            status('正在恢复图片 ' + ++done + ' / ' + manifest.images.length + '…');
            await jobApi('/api/backup/image?key=' + encodeURIComponent(image.key), {
              method: 'PUT',
              body: archive['media/' + image.key],
              rawBody: true,
            });
          }
          while (task.verifiedImages < task.imageCount) {
            task = await jobApi('/api/backup/jobs/' + task.id + '/verify-images', {
              method: 'POST',
              body: { index: task.verifiedImages },
            });
          }
          while (task.phase === 'preflight') {
            const files = {};
            let bytes = 0;
            for (const path of paths.slice(task.preflight, task.preflight + 32)) {
              const size = strToU8(sources[path]).length;
              if (Object.keys(files).length && bytes + size > 1_000_000) break;
              files[path] = sources[path];
              bytes += size;
            }
            status('正在预检原稿 ' + task.preflight + ' / ' + task.total + '…');
            task = await jobApi('/api/backup/jobs/' + task.id + '/preflight', {
              method: 'POST',
              body: { index: task.preflight, files },
            });
          }
          while (task.applied < task.batches) {
            status('正在恢复批次 ' + (task.applied + 1) + ' / ' + task.batches + '…');
            task = await jobApi('/api/backup/jobs/' + task.id + '/apply', {
              method: 'POST',
              body: { batch: task.applied },
            });
          }
          const completed = await jobApi('/api/backup/jobs/' + task.id + '/finish', {
            method: 'POST',
            body: {},
          });
          const result = completed.result;
          restored(result);
          await refresh();
          status(
            '已恢复 ' +
              result.drafts +
              ' 篇文章草稿、' +
              result.shorts +
              ' 条短记；检查设置和内容后再发布。',
          );
          notice('备份已恢复为草稿，线上版本与账号均保留。', 'success');
        } catch (error) {
          if (cancelled) status('任务已取消，已恢复内容保留。');
          else throw error;
        } finally {
          controller = null;
        }
      });
    } catch (error) {
      $('backup-status').textContent =
        error.message + ' 重新选择同一份备份可继续，或取消未完成任务后重新开始。';
      $('backup-status').dataset.tone = 'error';
      notice(error.message, 'error');
    } finally {
      event.target.value = '';
    }
  });
}
