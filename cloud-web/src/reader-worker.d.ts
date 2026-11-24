declare module '*/reader-worker/index.js' {
  type ReaderServices = {
    admin(request: Request, withContext: boolean): Promise<Response>;
    asset(request: Request): Promise<Response>;
    iconType(key: string): string | null;
    icons(value: unknown): { apple: string; icon512: string; faviconIco: string } | null;
  };

  export default class RustReaderWorker {
    protected readonly env: WebEnv;
    protected readonly ctx: ExecutionContext;
    protected maintain_storage(
      storage: R2Bucket,
      hooks: import('../../cloud-admin/src/maintenance').MaintenanceHooks,
    ): Promise<import('../../cloud-admin/src/maintenance').MaintenanceStatus>;
    protected site_settings(
      request: Request,
      storage: R2Bucket,
      hooks: import('../../cloud-admin/src/settings').SettingsHooks,
    ): Promise<Response>;
    protected image_request(
      request: Request,
      storage: R2Bucket,
      hooks: import('../../cloud-admin/src/images').ImageHooks,
    ): Promise<Response>;
    protected content_request(
      request: Request,
      storage: R2Bucket,
      session: import('../../cloud-admin/src/auth').Session,
      hooks: import('../../cloud-admin/src/content').ContentHooks,
    ): Promise<Response>;
    protected backup_request(
      request: Request,
      storage: R2Bucket,
      session: import('../../cloud-admin/src/auth').Session,
      hooks: import('../../cloud-admin/src/content').ContentHooks,
    ): Promise<Response>;
    protected route_request(
      request: Request,
      storage: R2Bucket,
      context: ExecutionContext,
      services: ReaderServices,
      templateVersion: string,
      responseVersion: string,
    ): Promise<Response>;
  }
}
