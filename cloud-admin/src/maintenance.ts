import { REFERENCE_ROOT, pruneReferenceShard } from './image-reference-index';
import { HttpError } from './models';
import { CONTENT_LEASE_MS, withContentMutation } from './storage-mutations';

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

export const maintenanceHooks = {
  withContentMutation,
  pruneReferenceShard,
  leaseMs: CONTENT_LEASE_MS,
  referenceRoot: REFERENCE_ROOT,
  errorStatus(error: unknown): number | null {
    return error instanceof HttpError ? error.status : null;
  },
  conflict() {
    return new HttpError(409, '维护状态已由后续任务更新。');
  },
};

export type MaintenanceHooks = typeof maintenanceHooks;
