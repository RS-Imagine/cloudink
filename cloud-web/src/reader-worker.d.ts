declare module '*/reader-worker/index.js' {
  type ReaderServices = {
    admin(request: Request, withContext: boolean): Promise<Response>;
    asset(request: Request): Promise<Response>;
    image(request: Request): Promise<Response>;
    icon(request: Request): Promise<Response>;
    sanitize(html: string): Promise<string>;
    mime(path: string): string;
    icons(value: unknown): { apple: string; icon512: string; faviconIco: string } | null;
    legacyImagePath(input: string, origin: string): string | null;
  };

  export default class RustReaderWorker {
    protected readonly env: WebEnv;
    protected readonly ctx: ExecutionContext;
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
