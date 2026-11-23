declare module '*/feed-worker/index.js' {
  export default class RustFeedWorker {
    protected readonly env: WebEnv;
    protected readonly ctx: ExecutionContext;
    protected rss_response(
      request: Request,
      storage: R2Bucket,
      ctx: ExecutionContext,
      templateVersion: string,
      responseVersion: string,
    ): Promise<[Response, boolean | null]>;
  }
}
