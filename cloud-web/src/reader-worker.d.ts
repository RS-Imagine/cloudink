declare module '*/reader-worker/index.js' {
  type ReaderServices = {
    admin(request: Request, withContext: boolean): Promise<Response>;
    asset(request: Request): Promise<Response>;
    image(request: Request): Promise<Response>;
    iconType(key: string): string | null;
    sanitize(html: string): Promise<string>;
    mime(path: string): string;
    icons(value: unknown): { apple: string; icon512: string; faviconIco: string } | null;
    legacyImagePath(input: string, origin: string): string | null;
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
    protected inspect_site_icon(
      bytes: Uint8Array,
      hooks: import('../../cloud-admin/src/settings').SettingsHooks,
    ): Promise<import('../../cloud-admin/src/settings').InspectedSiteIcon>;
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
