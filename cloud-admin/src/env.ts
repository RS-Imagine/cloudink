// Runtime strings can differ from the example values in generated Wrangler types.
export type CloudInkEnv = { [K in keyof Env]: Env[K] extends string ? string : Env[K] } & {
  browserPublishing?: boolean;
  initialPassword?: string;
};
