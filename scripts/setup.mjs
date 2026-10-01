import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, prepareConfigs, generated, configPath, root } from './deployment-config.mjs';
import { wrangler } from './commands.mjs';

const config = await loadConfig();
await prepareConfigs(config);
const path = resolve(generated, 'secrets.json');
async function readSecrets() {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value.BUILD_TOKEN || !value.WORKERS_BUILD_TOKEN || !value.SETUP_TOKEN) throw new Error('Local setup credentials are incomplete.');
  return value;
}
const action = process.argv[2];
if (action === 'secrets') {
  let secrets;
  try { secrets = await readSecrets(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const build = randomBytes(32).toString('hex');
    secrets = { BUILD_TOKEN: build, WORKERS_BUILD_TOKEN: build, SETUP_TOKEN: randomBytes(32).toString('hex') };
    await writeFile(path, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  // This command is for a NEW installation. Never silently reset an existing account.
  const response = await fetch(new URL('/api/config', config.urls.admin), { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Deploy the admin Worker before configuring setup secrets.');
  const state = await response.json();
  if (state.initialized !== false) throw new Error('This admin is already initialized; use the documented existing-site upgrade process.');
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [wrangler, 'secret', 'bulk', '--config', configPath('admin')], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('exit', code => code === 0 ? accept() : reject(new Error('Could not configure admin secrets.')));
    child.stdin.end(JSON.stringify(secrets));
  });
  await writeFile(resolve(generated, 'first-login.txt'), `${config.urls.admin}/#setup=${secrets.SETUP_TOKEN}\n`, { mode: 0o600 });
  console.log('Setup credentials saved privately in .deploy/secrets.json. Open .deploy/first-login.txt locally to set your password; do not share either file.');
} else if (action === 'content') {
  const secrets = await readSecrets();
  const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const release = { schema_version: 1, id: randomUUID(), created_at: new Date().toISOString(), site: config.site, markdown_posts: {}, legacy_posts: [], assets: {}, about_markdown: `+++\ntitle = "About"\ndescription = ""\n+++\n\n${escape(config.site.author)}\n` };
  const response = await fetch(new URL('/internal/bootstrap', config.urls.admin), { method: 'POST', headers: { Authorization: `Bearer ${secrets.WORKERS_BUILD_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(release), signal: AbortSignal.timeout(30_000) });
  if (response.status === 409) console.log('Content already exists. No articles, drafts, or settings were changed.');
  else if (!response.ok) throw new Error(`Content initialization failed (${response.status}).`);
  else console.log('Initialized an empty blog in private R2.');
} else throw new Error('Expected secrets or content.');
