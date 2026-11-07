import { activeBackup } from './backup-jobs';
import type { CloudInkEnv } from './env';
import { HttpError, readJson, type Publishing } from './models';
import { withContentMutation, CONTENT_LEASE_MS } from './storage-mutations';
import type { BrowserPointer, PageManifest } from './browser-publishing';
import { REFERENCE_ROOT, pruneReferenceShard } from './image-reference-index';

const STATUS_KEY = 'state/maintenance.json';
const UUID = '[a-f0-9-]{36}';
const GRACE = 24 * 60 * 60_000;
type Prefix = 'public' | 'releases' | 'backup-tasks' | 'references' | 'sessions';
export interface MaintenanceStatus {
  last_attempt_at?: string;
  status?: 'running' | 'success' | 'skipped' | 'failed';
  reason?: string;
  stage?: string;
  last_success_at?: string;
  finished_at?: string;
  scanned_objects?: number;
  deleted_objects?: number;
  deleted_bytes?: number;
  pruned_references?: number;
  expired_sessions?: number;
  cursors?: Partial<Record<Prefix, string>>;
}
export async function maintainStorage(env: CloudInkEnv): Promise<MaintenanceStatus> {
  const attempted = new Date().toISOString();
  let acquired = false;
  try {
    return await withContentMutation(env.STORAGE, async (storage) => {
      acquired = true;
      const prior = await readJson<MaintenanceStatus>(storage, STATUS_KEY);
      const state: MaintenanceStatus = {
        ...prior,
        last_success_at: prior?.last_success_at || prior?.finished_at,
        last_attempt_at: attempted,
        status: 'running',
        reason: undefined,
        stage: 'initializing',
        scanned_objects: 0,
        deleted_objects: 0,
        deleted_bytes: 0,
        pruned_references: 0,
        expired_sessions: 0,
        cursors: { ...prior?.cursors },
      };
      const started = await storage.put(STATUS_KEY, JSON.stringify(state));
      if (!started) throw new Error('Maintenance status write failed');
      async function finish(status: MaintenanceStatus['status'], reason?: string) {
        state.status = status;
        state.reason = reason;
        if (status === 'success')
          state.last_success_at = state.finished_at = new Date().toISOString();
        // CAS also protects status against a successor after an invocation interruption.
        const saved = await env.STORAGE.put(STATUS_KEY, JSON.stringify(state), {
          onlyIf: { etagMatches: started!.etag },
        });
        if (!saved) throw new HttpError(409, '维护状态已由后续任务更新。');
        return state;
      }
      try {
        const pointer = await readJson<BrowserPointer>(storage, 'state/published.json');
        if (!pointer) return finish('skipped', 'uninitialized');
        if (pointer.published_at && Date.now() - Date.parse(pointer.published_at) < 5 * 60_000)
          return finish('skipped', 'publication_settling');
        const pending = await readJson<Publishing>(storage, 'state/pending.json');
        if (
          pending &&
          ['queued', 'building', 'built'].includes(pending.status) &&
          Date.now() - Date.parse(pending.started_at) <= 30 * 60_000
        )
          return finish('skipped', 'publication_busy');
        const task = await activeBackup(storage);
        const retained = new Set([
          pointer.id,
          ...(pointer.previous_ids || []),
          ...(task?.mode === 'export' && task.releaseId ? [task.releaseId] : []),
        ]);
        const referenced = new Set(Object.values(pointer.pages || {}));
        state.stage = 'retained_manifests';
        for (const id of retained) {
          const manifest = await readJson<PageManifest>(
            storage,
            'releases/' + id + '.manifest.json',
          );
          if (manifest) {
            if (
              !manifest.pages ||
              Object.values(manifest.pages).some((hash) => !/^[a-f0-9]{64}$/.test(hash))
            )
              throw new Error('Invalid retained publication manifest');
            for (const hash of Object.values(manifest.pages)) referenced.add(hash);
          } else if (id === pointer.id && pointer.pages)
            throw new Error('Missing live publication manifest');
        }
        for (const prefix of ['public', 'releases', 'backup-tasks'] as const) {
          state.stage = prefix;
          const page = await storage.list({
            prefix: prefix + '/',
            limit: prefix === 'public' ? 250 : 100,
            cursor: state.cursors?.[prefix],
          });
          state.scanned_objects! += page.objects.length;
          const remove: string[] = [];
          let bytes = 0;
          for (const object of page.objects) {
            if (object.uploaded.getTime() > Date.now() - GRACE) continue;
            const content = object.key.match(/^public\/content\/([a-f0-9]{64})$/);
            const version = object.key.match(
              new RegExp(
                '^(?:public/(' +
                  UUID +
                  ')/|releases/(' +
                  UUID +
                  ')(?:\\.manifest|\\.posts)?\\.json$)',
              ),
            );
            const temporary = object.key.match(
              /^backup-tasks\/([a-f0-9-]{36})\/(?:state|chunks\/\d+)\.json$/,
            );
            const obsolete = temporary
              ? temporary[1] !== task?.id
              : content
                ? !referenced.has(content[1])
                : version && !retained.has(version[1] || version[2]);
            if (obsolete) {
              remove.push(object.key);
              bytes += object.size;
            }
          }
          if (remove.length) await storage.delete(remove);
          state.deleted_objects! += remove.length;
          state.deleted_bytes! += bytes;
          if (page.truncated) state.cursors![prefix] = page.cursor;
          else delete state.cursors![prefix];
        }
        state.stage = 'references';
        const refs = await storage.list({
          prefix: REFERENCE_ROOT,
          limit: 1,
          cursor: state.cursors?.references,
        });
        for (const object of refs.objects) {
          state.scanned_objects!++;
          if (
            /^image-reference-index\/[a-f0-9]{2}\.json$/.test(object.key) &&
            object.uploaded.getTime() <= Date.now() - GRACE
          )
            state.pruned_references! += await pruneReferenceShard(storage, object.key);
        }
        if (refs.truncated) state.cursors!.references = refs.cursor;
        else delete state.cursors!.references;
        state.stage = 'sessions';
        const sessions = await storage.list({
          prefix: 'auth/sessions/',
          limit: 32,
          cursor: state.cursors?.sessions,
          include: ['customMetadata'],
        });
        const expired: string[] = [];
        for (const object of sessions.objects) {
          state.scanned_objects!++;
          if (!/^auth\/sessions\/[a-f0-9]{64}$/.test(object.key)) continue;
          let expiry = Number(object.customMetadata?.expires || NaN);
          if (!Number.isFinite(expiry)) {
            const legacy = await storage.get(object.key);
            if (legacy && legacy.size <= 4096) {
              try {
                expiry = Number((await legacy.json<{ expires?: number }>()).expires);
              } catch {
                /* Unknown objects are retained. */
              }
            } else if (legacy) await legacy.body.cancel();
          }
          if (Number.isFinite(expiry) && expiry > 0 && expiry < Date.now())
            expired.push(object.key);
        }
        if (expired.length) await storage.delete(expired);
        state.expired_sessions = expired.length;
        if (sessions.truncated) state.cursors!.sessions = sessions.cursor;
        else delete state.cursors!.sessions;
        state.stage = 'complete';
        return finish('success');
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'storage_maintenance_failed',
            stage: state.stage,
            type: error instanceof Error ? error.name : 'unknown',
          }),
        );
        return finish(
          'failed',
          error instanceof HttpError ? 'bounded_work_or_storage_conflict' : 'storage_error',
        );
      }
    });
  } catch (error) {
    if (acquired) throw error;
    const object = await env.STORAGE.get(STATUS_KEY);
    const prior = object ? await object.json<MaintenanceStatus>() : null;
    // Do not hide a maintenance task that is still running in another invocation.
    if (
      prior?.status === 'running' &&
      prior.last_attempt_at &&
      Date.now() - Date.parse(prior.last_attempt_at) < CONTENT_LEASE_MS
    )
      return prior;
    const skipped: MaintenanceStatus = {
      ...prior,
      last_success_at: prior?.last_success_at || prior?.finished_at,
      last_attempt_at: attempted,
      status: error instanceof HttpError && error.status === 503 ? 'skipped' : 'failed',
      reason:
        error instanceof HttpError && error.status === 503 ? 'mutation_busy' : 'storage_error',
      stage: 'lease',
    };
    await env.STORAGE.put(STATUS_KEY, JSON.stringify(skipped), {
      onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' },
    });
    return skipped;
  }
}
