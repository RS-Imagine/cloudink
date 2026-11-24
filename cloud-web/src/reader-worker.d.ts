declare module '*/reader-worker/index.js' {
  export default class RustReaderWorker {
    protected readonly env: WebEnv;
    protected readonly ctx: ExecutionContext;
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
