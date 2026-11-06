/** Shared by picker, paste/drop and library. A failed optimizer preserves the original. */
const MAX_CONCURRENT_WORKERS = Math.max(
  1,
  Math.min(
    2,
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? Math.floor(navigator.hardwareConcurrency / 2) || 1
      : 2,
  ),
);
let activeWorkers = 0;
const workerQueue = [];

function runWorkerTask(task) {
  return new Promise((resolve, reject) => {
    workerQueue.push({ task, resolve, reject });
    dequeueWorker();
  });
}

function dequeueWorker() {
  if (activeWorkers >= MAX_CONCURRENT_WORKERS || !workerQueue.length) return;
  const { task, resolve, reject } = workerQueue.shift();
  activeWorkers++;
  task()
    .then(resolve, reject)
    .finally(() => {
      activeWorkers--;
      dequeueWorker();
    });
}

export async function imageUploadForm(file, { compact = false } = {}) {
  if (file.size > 10 * 1024 * 1024) throw new Error('每张图片最多 10 MB。');
  const form = new FormData();
  const result = await runWorkerTask(
    () =>
      new Promise((resolve) => {
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
      }),
  );
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
