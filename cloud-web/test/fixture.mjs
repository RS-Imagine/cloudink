import { Miniflare, convertV4MiniflareOptions } from '../../cloud-admin/node_modules/miniflare/dist/src/index.js';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
export const owner = 'reader@example.net', password = 'first-private-password-26', origin = 'https://notes.reader.workers.dev';
export const draft = (slug = 'public', text = 'Public **Markdown** $x^2$') => ({ front_matter: { title: 'A blog post', slug, date: '2026-10-01', description: 'Summary', draft: true }, body_markdown: text });
export function workerOptions(bindings = {}) {
  return { name: 'web', scriptPath: resolve('cloud-web/dist/index.js'), modules: true,
    compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
    assets: { directory: resolve('build-work/web-public'), binding: 'ASSETS', run_worker_first: true, routerConfig: { has_user_worker: true }, assetConfig: { html_handling: 'auto-trailing-slash', not_found_handling: '404-page' } },
    r2Buckets: ['CONTENT', 'IMAGES'], ratelimits: { LOGIN_LIMITER: { namespace_id: '1002', simple: { limit: 50, period: 60 } } },
    bindings: { OWNER_EMAIL: owner, INITIAL_PASSWORD: password, ...bindings } };
}
export async function fixture(t, bindings = {}) {
  const mf = new Miniflare(convertV4MiniflareOptions(workerOptions(bindings)));t.after(() => mf.dispose());
  let cookie = '', csrf = '';
  async function request(path, method = 'GET', body, extra = {}) {
    const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' && method !== 'HEAD' ? { Origin: origin, 'X-CSRF-Token': csrf } : {}), ...extra };
    if (body !== undefined) headers['Content-Type'] = typeof body === 'string' ? 'text/plain' : 'application/json';
    return mf.dispatchFetch(origin + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  }
  async function login(value = password) {
    const response = await request('/api/login', 'POST', { email: owner, password: value });
    assert.equal(response.status, 200, await response.clone().text());
    cookie = response.headers.get('Set-Cookie').split(';')[0];csrf = (await response.json()).csrf;
  }
  async function prepare(body = { rebuild: true }) {
    const response = await request('/api/publish', 'POST', body);assert.equal(response.status, 202, await response.clone().text());return response.json();
  }
  async function stage(state, skip = [], html = '<!doctype html><html><head><title>Published</title></head><body><h1>Published version</h1></body></html>') {
    for (const path of state.files) {
      if (skip.includes(path)) continue;
      const value = path === '_release.json' ? JSON.stringify({ id: state.release_id }) : path.endsWith('.html') ? html : path === 'search_index.json' ? '[]' : 'staged asset';
      const response = await request(`/api/publish/${state.release_id}/file?path=${encodeURIComponent(path)}`, 'PUT', value);assert.equal(response.status, 200, await response.clone().text());
    }
  }
  async function commit(state) { return request(`/api/publish/${state.release_id}/commit`, 'POST', {}); }
  return { mf, request, login, prepare, stage, commit, setInitialPassword: value => mf.setOptions(convertV4MiniflareOptions(workerOptions({ ...bindings, INITIAL_PASSWORD: value }))) };
}
