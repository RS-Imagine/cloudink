import { command, wrangler } from './commands.mjs';
await command(process.execPath, [wrangler, 'types', '--env-interface', 'WebEnv', '--include-runtime', 'false']);
await command('npm', ['--prefix', 'cloud-admin', 'run', 'types']);
await command(process.execPath, [wrangler, 'types', '--config', 'cloud-images/wrangler.jsonc', '--env-interface', 'ImagesEnv', '--include-runtime', 'false', 'cloud-images/worker-configuration.d.ts']);
