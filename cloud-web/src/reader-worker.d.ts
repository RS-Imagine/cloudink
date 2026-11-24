declare module '*/reader-worker/index.js' {
  export default class RustReaderWorker {
    protected readonly env: WebEnv;
    protected readonly ctx: ExecutionContext;
    protected reader_html(
      response: Response,
      url: URL,
      analytics: boolean,
      appleIcon: string | undefined,
      fallbackIcon: string | undefined,
      legacyImagePath: (input: string, origin: string) => string | null,
    ): Promise<Response>;
    protected reader_etag(
      value: string,
      url: URL,
      siteIcon: string,
      templateVersion: string,
      responseVersion: string,
    ): Promise<string>;
    protected discovery_response(
      path: string,
      origin: string,
      storage: R2Bucket,
      release: string | null,
      pages: Record<string, string> | undefined,
      templateVersion: string,
      responseVersion: string,
    ): Promise<Response>;
  }
}
