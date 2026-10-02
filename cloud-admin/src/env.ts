// Binding types are generated from the only deployment configuration at the repository root.
export type CloudInkEnv = { [K in keyof WebEnv]: WebEnv[K] extends string ? string : WebEnv[K] };
