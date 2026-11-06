import type { CloudInkEnv } from './env';
import { readJson, type Publishing } from './models';
import { withContentMutation } from './storage-mutations';
import type { BrowserPointer, PageManifest } from './browser-publishing';

const STATUS_KEY = 'state/maintenance.json';
const UUID = '[a-f0-9-]{36}';
const GRACE = 24 * 60 * 60_000;
export interface MaintenanceStatus {
  finished_at?: string;
  deleted_objects?: number;
  deleted_bytes?: number;
  cursors?: { public?: string; releases?: string };
}
// Bounded daily work: two LIST calls, at most 350 deletes. Never inspect or
// delete user sources, media, accounts, settings or concurrency tombstones.
export async function maintainStorage(env: CloudInkEnv): Promise<MaintenanceStatus | null> {
  return withContentMutation(env.STORAGE, async () => {
    const pointer = await readJson<BrowserPointer>(env.STORAGE, 'state/published.json');
    if (!pointer) return null;
    const pending = await readJson<Publishing>(env.STORAGE, 'state/pending.json');
    if (pending && ['queued', 'building', 'built'].includes(pending.status) &&
        Date.now() - Date.parse(pending.started_at) <= 30 * 60_000) return null;
    const retained = new Set([pointer.id, ...(pointer.previous_ids || [])]);
    const referenced = new Set(Object.values(pointer.pages || {}));
    for (const id of retained) {
      const manifest = await readJson<PageManifest>(env.STORAGE, `releases/${id}.manifest.json`);
      if (manifest) {
        if (!manifest.pages || Object.values(manifest.pages).some(value => !/^[a-f0-9]{64}$/.test(value)))
          throw new Error('Invalid retained publication manifest');
        for (const hash of Object.values(manifest.pages)) referenced.add(hash);
      } else if (id === pointer.id && pointer.pages) throw new Error('Missing live publication manifest');
    }
    const prior = await readJson<MaintenanceStatus>(env.STORAGE, STATUS_KEY);
    const cursors: MaintenanceStatus['cursors'] = {};
    let deleted_objects = 0, deleted_bytes = 0;
    for (const prefix of ['public', 'releases'] as const) {
      const page = await env.STORAGE.list({ prefix: prefix + '/', limit: prefix === 'public' ? 250 : 100, cursor: prior?.cursors?.[prefix] });
      const remove: string[] = [];
      for (const object of page.objects) {
        if (object.uploaded.getTime() > Date.now() - GRACE) continue;
        const content = object.key.match(/^public\/content\/([a-f0-9]{64})$/);
        const version = object.key.match(new RegExp('^(?:public/(' + UUID + ')/|releases/(' + UUID + ')(?:\\.manifest)?\\.json$)'));
        const obsolete = content ? !referenced.has(content[1]) : version && !retained.has(version[1] || version[2]);
        if (obsolete) { remove.push(object.key); deleted_bytes += object.size; }
      }
      if (remove.length) await env.STORAGE.delete(remove);
      deleted_objects += remove.length;
      if (page.truncated) cursors[prefix] = page.cursor;
    }
    const status: MaintenanceStatus = { finished_at: new Date().toISOString(), deleted_objects, deleted_bytes, cursors };
    await env.STORAGE.put(STATUS_KEY, JSON.stringify(status));
    return status;
  });
}
