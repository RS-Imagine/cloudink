import { readFile } from 'node:fs/promises';

export async function loadReaderWorker() {
  const directory = new URL('../../build-work/reader-worker/', import.meta.url);
  const workerSource = await readFile(new URL('index.js', directory), 'utf8');
  const workerShim =
    'data:text/javascript,' +
    encodeURIComponent(
      'export class WorkerEntrypoint {} export const tracing = { getActiveSpan() {} };',
    );
  const source =
    'const addEventListener = () => {};\n' +
    workerSource
      .replaceAll('"cloudflare:workers"', JSON.stringify(workerShim))
      .replace('"./index_bg.wasm"', JSON.stringify(new URL('index_bg.wasm', directory).href));
  const { default: Worker } = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  return new Worker();
}
