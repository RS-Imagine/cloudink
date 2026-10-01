import { loadConfig } from './deployment-config.mjs';
import { command } from './commands.mjs';
// Existing deployments keep their explicit, private three-Worker profile.
if (await loadConfig({ optional: true })) await import('./build-site.mjs');
else await command('bash', ['scripts/build-web.sh']);
