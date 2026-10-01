import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, generated } from './deployment-config.mjs';
import { command } from './commands.mjs';
const config = await loadConfig();
const env = { ...process.env, BLOG_ADMIN_URL: config.urls.admin, BLOG_PRODUCTION_BRANCH: config.productionBranch };
if (!env.BLOG_BUILD_TOKEN) {
  const secrets = JSON.parse(await readFile(resolve(generated, 'secrets.json'), 'utf8'));
  env.BLOG_BUILD_TOKEN = secrets.WORKERS_BUILD_TOKEN;
}
await command('bash', ['scripts/cloudflare-build.sh'], { env });
