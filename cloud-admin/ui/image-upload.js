/** Shared by picker, paste/drop and library. A failed optimizer preserves the original. */
export async function imageUploadForm(file) {
  if (file.size > 10 * 1024 * 1024) throw new Error('每张图片最多 10 MB。');
  const form = new FormData();
  form.append('file', file);
  const variants = await new Promise((resolve) => {
    let worker, timer;
    const finish = (value) => { clearTimeout(timer); worker?.terminate(); resolve(value); };
    try {
      worker = new Worker('/image.worker.js', { type: 'module' });
      timer = setTimeout(() => finish([]), 30000);
      worker.onmessage = ({ data }) => finish(data);
      worker.onerror = () => finish([]);
      worker.postMessage(file);
    } catch { finish([]); }
  });
  for (const { width, blob } of variants) form.append('w' + width, blob, width + '.webp');
  return form;
}
