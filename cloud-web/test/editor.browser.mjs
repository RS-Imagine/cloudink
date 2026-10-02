import { workerOptions, owner, password, setupToken } from './fixture.mjs';
import {
  Miniflare,
  convertV4MiniflareOptions,
} from '../../cloud-admin/node_modules/miniflare/dist/src/index.js';
import { chromium, expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
const mf = new Miniflare(convertV4MiniflareOptions({ ...workerOptions(), port: 8788 }));
let browser;
try {
  await mf.ready;
  const initialized = await mf.dispatchFetch('http://localhost:8788/api/setup', {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:8788',
      Authorization: `Bearer ${setupToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: owner,
      password,
      site: { title: 'Test blog', subtitle: 'Hello', author: 'Test', description: '', about: '' },
    }),
  });
  assert.equal(initialized.status, 200);
  const bucket = await mf.getR2Bucket('STORAGE');
  for (const slug of ['alpha', 'beta', 'gamma'])
    await bucket.put(
      `drafts/${slug}.md`,
      `+++\ntitle = "${slug}"\nslug = "${slug}"\ndate = "2026-10-01"\ndescription = ""\ndraft = true\n+++\n\n## ${slug}\n\n**正文** $x^2$\n\n![slow image](http://localhost:8788/images/uploads/test.png)`,
      { customMetadata: { title: slug, date: '2026-10-01', description: '' } },
    );
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const counts = { list: 0, poll: 0 };
  let delayList = 0,
    delayGet = 0,
    delaySave = 0,
    delayHistory = 0,
    imageRequested = false,
    imageFinished = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()),
      method = route.request().method();
    if (url.pathname === '/api/posts') {
      counts.list++;
      await sleep(delayList);
    }
    if (url.pathname === '/api/publish/status') counts.poll++;
    if (/^\/api\/posts\//.test(url.pathname)) await sleep(method === 'PUT' ? delaySave : delayGet);
    if (url.pathname.startsWith('/api/history/')) await sleep(delayHistory);
    if (url.pathname === '/api/image') {
      imageRequested = true;
      await sleep(3000);
      imageFinished = true;
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfYQAAAAASUVORK5CYII=',
          'base64',
        ),
      });
    }
    return route.continue();
  });
  // Local test does not depend on CDN connectivity or the runner's browser CA.
  await page.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.goto('http://localhost:8788/admin');
  await page.locator('#login-form input[name=email]').fill(owner);
  await page.locator('#login-form input[name=password]').fill(password);
  await page.locator('#login-submit').click();
  await page.locator('#home-view').waitFor({ state: 'visible' });
  await expect(page.locator('#site-link')).toHaveAttribute('href', 'http://localhost:8788');
  await expect(page.locator('#site-brand-title')).toHaveText('Test blog');
  await page.locator('.post-item').filter({ hasText: 'alpha' }).click();
  await expect(page.locator('#title')).toHaveValue('alpha');
  await page.frameLocator('#preview-frame').locator('.katex').first().waitFor();
  assert.equal(imageFinished, false, 'Text preview must render before images finish');
  await expect.poll(() => imageRequested).toBe(true);
  assert.equal(
    await page.evaluate(() =>
      document.querySelector('#preview-frame').sandbox.contains('allow-scripts'),
    ),
    false,
  );
  const initialLists = counts.list;
  delaySave = 500;
  delayList = 1500;
  delayGet = 700;
  await page.locator('#body').fill('Edited alpha **content** $y^2$');
  await page.locator('#save-post').click();
  await expect(page.locator('#save-post')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#notice')).toContainText('草稿已保存');
  assert.equal(counts.list, initialLists, 'Saving must not refetch the entire article list');
  await page.locator('#body').fill('Latest alpha content');
  const start = Date.now();
  await page.locator('.post-item').filter({ hasText: 'beta' }).click();
  await expect(page.locator('#navigation-status')).toBeVisible();
  await expect(page.locator('#title')).toHaveValue('beta');
  const uncachedMs = Date.now() - start;
  assert.ok(uncachedMs < 1600, `save/fetch should overlap: ${uncachedMs}ms`);
  const cachedStart = Date.now();
  await page.locator('.post-item').filter({ hasText: 'alpha' }).click();
  await expect(page.locator('#title')).toHaveValue('alpha');
  const cachedMs = Date.now() - cachedStart;
  assert.ok(cachedMs < 600, `cached switch should not wait for network: ${cachedMs}ms`);
  await expect(page.locator('#body')).toHaveValue('Latest alpha content');
  // Rapid selection must leave the last selected article visible.
  await page.locator('.post-item').filter({ hasText: 'gamma' }).click();
  await page.locator('.post-item').filter({ hasText: 'beta' }).click();
  await expect(page.locator('#title')).toHaveValue('beta');
  await sleep(900);
  await expect(page.locator('#title')).toHaveValue('beta');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-post').click();
  await downloadPromise;
  await expect(page.locator('#notice')).toContainText('已开始下载原稿');
  delayHistory = 800;
  await page.locator('#history-post').click();
  await expect(page.locator('#history-dialog')).toBeVisible();
  await expect(page.locator('#history-list')).toHaveText('正在读取历史版本…');
  await expect(page.locator('#history-list')).toHaveText('还没有保存过的历史版本。');
  await page.locator('#close-history').click();
  const polls = counts.poll;
  await sleep(6500);
  assert.equal(counts.poll, polls, 'Idle editor must not poll publication status');
  // Import parsing also runs in the preview worker.
  await page
    .locator('#import-files')
    .setInputFiles({
      name: 'import.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(
        '+++\ntitle = "Imported"\nslug = "imported"\ndate = "2026-10-01"\ndescription = ""\ndraft = true\n+++\n\nOriginal source',
      ),
    });
  await expect(page.locator('#notice')).toContainText('已导入 1 篇');
  // A failed save must retain text and offer a visible error; never navigate away.
  await page.route('**/api/posts/beta', async (route) => {
    if (route.request().method() === 'PUT')
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: '这篇文章在另一个窗口中发生了修改。' }),
      });
    return route.fallback();
  });
  await page.locator('#body').fill('DO NOT LOSE THIS DRAFT');
  await page.locator('#save-post').click();
  await expect(page.locator('#notice')).toContainText('另一个窗口');
  await expect(page.locator('#body')).toHaveValue('DO NOT LOSE THIS DRAFT');
  await page.locator('.post-item').filter({ hasText: 'alpha' }).click();
  await expect(page.locator('#notice')).toContainText('云端冲突');
  await expect(page.locator('#title')).toHaveValue('beta');
  await page.screenshot({ path: resolve('cloud-web/dist/editor.browser.png'), fullPage: true });
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log(
    JSON.stringify({
      checks:
        'non-blocking preview, parallel navigation, session cache, latest-click selection, save/download/history feedback, idle polling, conflict retention',
      uncachedSwitchMs: uncachedMs,
      cachedSwitchMs: cachedMs,
      extraListRequestsDuringSave: 0,
    }),
  );

  const publicPage = await browser.newPage();
  const client = await readFile(resolve('crates/blog-core/src/assets/client.js'), 'utf8');
  await publicPage.route('https://reader-public.example.net/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><button id="site-search-btn">Search</button><div id="search-modal"><input id="search-input"><ul id="search-results"></ul></div><script>window.Swup=class{constructor(){this.hooks={on(){}};}};</script><script>${client}</script>`,
    }),
  );
  await publicPage.route('**/search_index.json', async (route) => {
    await sleep(600);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ title: 'Needle entry', description: '', body: '', slug: 'needle' }]),
    });
  });
  await publicPage.goto('https://reader-public.example.net/');
  await publicPage.locator('#site-search-btn').click();
  await publicPage.locator('#search-input').fill('needle');
  await expect(publicPage.locator('#search-results a')).toHaveCount(1);
  await publicPage.close();
  console.log(JSON.stringify({ typingBeforeSearchIndexLoads: true }));
} finally {
  await browser?.close();
  await mf.dispose();
}
