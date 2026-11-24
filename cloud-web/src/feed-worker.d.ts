declare module '*/feed-worker/index.js' {
  export default class RustFeedWorker {
    protected readonly env: WebEnv;
    protected readonly ctx: ExecutionContext;
    protected rss_response(
      origin: string,
      storage: R2Bucket,
      release: string | null,
      pages: Record<string, string> | undefined,
      templateVersion: string,
      responseVersion: string,
    ): Promise<Response>;
  }
}
