/** Shared by picker, paste/drop and library. A failed optimizer preserves the original. */
export async function imageUploadForm(file, { compact = false } = {}) {
  if (file.size > 10 * 1024 * 1024) throw new Error('每张图片最多 10 MB。');
  const form = new FormData();
  const result = await new Promise((resolve) => {
    let worker, timer;
    const finish = (value) => {
      clearTimeout(timer);
      worker?.terminate();
      resolve(value);
    };
    try {
      worker = new Worker('/image.worker.js', { type: 'module' });
      timer = setTimeout(() => finish([]), 30000);
      worker.onmessage = ({ data }) => finish(data);
      worker.onerror = () => finish([]);
      worker.postMessage(compact ? { file, compact: true } : file);
    } catch {
      finish([]);
    }
  });
  const main = result.main;
  const variants = Array.isArray(result) ? result : result.variants;
  form.append(
    'file',
    main
      ? new File([main], file.name.replace(/\.[^.]*$/, '') + '.webp', { type: 'image/webp' })
      : file,
  );
  for (const { width, blob } of variants) form.append('w' + width, blob, width + '.webp');
  return form;
}
