import { command, wrangler } from './commands.mjs';
await command(process.execPath, [wrangler, 'types', '--env-interface', 'WebEnv', '--env-file', '.dev.vars.example']);
