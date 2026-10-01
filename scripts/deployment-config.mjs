import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const generated = resolve(root, '.deploy');
function required(value, field, pattern) {
  if (typeof value !== 'string' || !value || (pattern && !pattern.test(value))) throw new Error(`Invalid deployment field: ${field}`);
  return value;
}
function origin(value, field) {
  const url = new URL(required(value, field));
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`${field} must be an HTTPS origin without a path.`);
  return url.origin;
}
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Deployment configuration must be an object.');
  const names = {};
  for (const kind of ['site', 'admin', 'images']) names[kind] = required(input.workers?.[kind], `workers.${kind}`, /^[a-z0-9][a-z0-9-]{0,62}$/);
  if (new Set(Object.values(names)).size !== 3) throw new Error('The three Worker names must be different.');
  const buckets = {};
  for (const kind of ['content', 'images']) buckets[kind] = required(input.buckets?.[kind], `buckets.${kind}`, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
  if (buckets.content === buckets.images) throw new Error('Content and image buckets must be different.');
  if (input.accountId && !/^[a-f0-9]{32}$/.test(input.accountId)) throw new Error('accountId must be a Cloudflare account ID.');
  const urls = {};
  for (const kind of ['site', 'admin', 'images']) {
    if (input.urls?.[kind]) urls[kind] = origin(input.urls[kind], `urls.${kind}`);
    else {
      const subdomain = required(input.workersSubdomain, 'workersSubdomain', /^[a-z0-9][a-z0-9-]{0,62}$/);
      urls[kind] = `https://${names[kind]}.${subdomain}.workers.dev`;
    }
  }
  if (new Set(Object.values(urls)).size !== 3) throw new Error('Site, admin, and image origins must be different.');
  for (const kind of ['site', 'admin', 'images']) {
    const hostname = new URL(urls[kind]).hostname;
    if (hostname.endsWith('.workers.dev') && !hostname.startsWith(`${names[kind]}.`)) throw new Error(`urls.${kind} must match its Worker name.`);
  }
  if (!Array.isArray(input.siteAliases ?? [])) throw new Error('siteAliases must be an array.');
  const aliases = (input.siteAliases ?? []).map(x => origin(x, 'siteAliases'));
  if (aliases.some(x => x === urls.admin || x === urls.images || new URL(x).hostname.endsWith('.workers.dev'))) throw new Error('Site aliases must be custom domains separate from admin and images.');
  const site = input.site || {};
  const content = {};
  for (const field of ['title', 'bigTitle', 'subtitle', 'author', 'description', 'footer', 'clarityId']) {
    const value = site[field] ?? '';
    if (typeof value !== 'string' || value.length > 2000) throw new Error(`Invalid site.${field}`);
    content[field] = value;
  }
  required(content.title, 'site.title'); required(content.author, 'site.author');
  if (content.clarityId && !/^[A-Za-z0-9]{1,64}$/.test(content.clarityId)) throw new Error('site.clarityId must be an analytics project ID.');
  return { accountId: input.accountId || '', workers: names, buckets, urls, siteAliases: [...new Set(aliases)], ownerEmail: required(input.ownerEmail, 'ownerEmail', /^[^\s@]+@[^\s@]+\.[^\s@]+$/), productionBranch: required(input.productionBranch, 'productionBranch'), externalImages: input.externalImages === true, site: content };
}
export async function loadConfig({ optional = false } = {}) {
  let raw = process.env.BLOG_DEPLOY_CONFIG_JSON;
  if (!raw) {
    try { raw = await readFile(resolve(root, process.env.BLOG_DEPLOY_CONFIG || 'deployment.json'), 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (optional) return null;
      throw new Error('Copy deployment.example.json to deployment.json and configure it, or set BLOG_DEPLOY_CONFIG_JSON.');
    }
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('Deployment configuration is not valid JSON.'); }
  return validateConfig(value);
}
export function workerConfigs(config) {
  const base = { compatibility_date: '2026-10-01', preview_urls: false, ...(config.accountId ? { account_id: config.accountId } : {}) };
  const routing = (url, aliases = []) => {
    const domains = [url, ...aliases].filter(x => !new URL(x).hostname.endsWith('.workers.dev'));
    return { workers_dev: new URL(url).hostname.endsWith('.workers.dev'), ...(domains.length ? { routes: domains.map(x => ({ pattern: new URL(x).hostname, custom_domain: true })) } : {}) };
  };
  return {
    site: { ...base, name: config.workers.site, ...routing(config.urls.site, config.siteAliases), assets: { directory: resolve(root, 'build-work/public'), html_handling: 'auto-trailing-slash', not_found_handling: '404-page' } },
    admin: { ...base, name: config.workers.admin, main: resolve(root, 'cloud-admin/src/index.ts'), compatibility_flags: ['nodejs_compat'], ...routing(config.urls.admin), observability: { enabled: true, head_sampling_rate: 1 }, vars: { OWNER_EMAIL: config.ownerEmail, SITE_URL: config.urls.site, IMAGE_ORIGIN: config.urls.images, SITE_WORKER_NAME: config.workers.site, PRODUCTION_BRANCH: config.productionBranch, FOOTER_TEXT: config.site.footer, CLARITY_ID: config.site.clarityId }, r2_buckets: [{ binding: 'CONTENT', bucket_name: config.buckets.content }, { binding: 'IMAGES', bucket_name: config.buckets.images }], ratelimits: [{ name: 'LOGIN_LIMITER', namespace_id: '1001', simple: { limit: 5, period: 60 } }] },
    images: { ...base, name: config.workers.images, main: resolve(root, 'cloud-images/src/index.ts'), compatibility_flags: ['nodejs_compat'], ...routing(config.urls.images), observability: { enabled: true, head_sampling_rate: 1 }, vars: { ALLOWED_ORIGINS: JSON.stringify([config.urls.site, ...config.siteAliases]) }, r2_buckets: [{ binding: 'IMAGES', bucket_name: config.buckets.images }] }
  };
}
export async function prepareConfigs(config) {
  config ||= await loadConfig();
  await mkdir(generated, { recursive: true });
  const configs = workerConfigs(config);
  for (const [kind, value] of Object.entries(configs)) await writeFile(resolve(generated, `${kind}.jsonc`), JSON.stringify(value, null, 2) + '\n');
  return configs;
}
export function configPath(kind) { return resolve(generated, `${kind}.jsonc`); }
