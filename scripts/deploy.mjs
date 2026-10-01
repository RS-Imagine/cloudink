import { loadConfig, prepareConfigs, configPath } from './deployment-config.mjs';
import { command, wrangler } from './commands.mjs';
const kind = process.argv[2] || 'site';
if (!['site', 'admin', 'images', 'configure'].includes(kind)) throw new Error('Expected site, admin, images, or configure.');
const config = await loadConfig();
await prepareConfigs(config);
if (kind === 'configure') console.log('Generated local deployment configs in .deploy/.');
else {
  if (kind === 'images' && config.externalImages) throw new Error('Image hosting is external; deploy:images will not replace it.');
  if (kind === 'admin') await command('npm', ['--prefix', 'cloud-admin', 'run', 'ui']);
  await command(process.execPath, [wrangler, 'deploy', '--config', configPath(kind)]);
}
