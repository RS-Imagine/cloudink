import { storageStats } from '../../cloud-admin/src/request-stats';
import { maintenanceHooks } from '../../cloud-admin/src/maintenance';
import { imageHooks } from '../../cloud-admin/src/images';
import { createContentHooks } from '../../cloud-admin/src/content';
import admin from '../../cloud-admin/src/index';
import { createSettingsHooks } from '../../cloud-admin/src/settings';
import type { CloudInkEnv } from '../../cloud-admin/src/env';
import {
  siteIconDerivedKeys,
  siteIconMime,
  validSiteIconAssetKey,
} from '../../cloud-admin/src/models';
import { PUBLIC_RESPONSE_VERSION } from '../../cloud-admin/src/assets.generated';
import { CURRENT_TEMPLATE_VERSION } from '../../cloud-admin/src/template-version.generated';
import RustReaderWorker from '../../build-work/reader-worker/index.js';

export type WebBindings = CloudInkEnv;

export default class CloudInkWorker extends RustReaderWorker {
  async fetch(request: Request): Promise<Response> {
    const { env, ctx } = this;
    const stats = storageStats(env.STORAGE),
      started = Date.now(),
      id = crypto.randomUUID();
    const storage = stats.bucket;
    const hostEnv = {
      ...env,
      STORAGE: storage,
      maintainStorage: (binding: R2Bucket) => this.maintain_storage(binding, maintenanceHooks),
      imageRequest: (input: Request, binding: R2Bucket) =>
        this.image_request(input, binding, imageHooks),
      contentRequest: (
        input: Request,
        binding: R2Bucket,
        session: import('../../cloud-admin/src/auth').Session,
      ) => this.content_request(input, binding, session, createContentHooks(env)),
      siteSettings: (input: Request, binding: R2Bucket) =>
        this.site_settings(input, binding, createSettingsHooks(env)),
      backupRequest: (
        input: Request,
        binding: R2Bucket,
        session: import('../../cloud-admin/src/auth').Session,
      ) => this.backup_request(input, binding, session, createContentHooks(env)),
    };
    const response = await this.route_request(
      request,
      storage,
      ctx,
      {
        admin: (input, withContext) =>
          withContext ? admin.fetch(input, hostEnv, ctx) : admin.fetch(input, hostEnv),
        asset: (input) => env.ASSETS.fetch(input),
        iconType: (key) => (validSiteIconAssetKey(key) ? siteIconMime(key) : null),
        icons: siteIconDerivedKeys,
      },
      CURRENT_TEMPLATE_VERSION,
      PUBLIC_RESPONSE_VERSION,
    );
    const route = new URL(request.url).pathname
      .split('/')
      .slice(0, 3)
      .join('/')
      .replace(/\/[A-Za-z0-9_-]{20,}/g, '/:id');
    stats.report(id, route, request.method, response.status, started);
    const headers = new Headers(response.headers);
    headers.set('X-Request-ID', id);
    return new Response(response.body, { status: response.status, headers });
  }

  async scheduled(_event: ScheduledController): Promise<void> {
    this.ctx.waitUntil(
      this.maintain_storage(this.env.STORAGE, maintenanceHooks).catch((error) => {
        console.error(
          JSON.stringify({
            event: 'storage_maintenance_failed',
            type: error instanceof Error ? error.name : 'unknown',
          }),
        );
      }),
    );
  }
}
