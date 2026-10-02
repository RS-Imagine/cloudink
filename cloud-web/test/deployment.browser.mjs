import {
  Miniflare,
  convertV4MiniflareOptions,
} from '../../cloud-admin/node_modules/miniflare/dist/src/index.js';
import { chromium, expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { workerOptions, owner, password, setupToken } from './fixture.mjs';

const mf = new Miniflare(convertV4MiniflareOptions({ ...workerOptions(), port: 8791 }));
let browser;
try {
  await mf.ready;
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.goto('http://localhost:8791/admin');
  await expect(page.locator('#setup-view')).toBeVisible();
  await page.screenshot({ path: resolve('cloud-web/dist/setup.browser.png'), fullPage: true });
  await page.locator('#setup-form input[name=token]').fill(setupToken);
  await page.locator('#setup-form input[name=email]').fill(owner);
  await page.locator('#setup-form input[name=password]').fill(password);
  await page.locator('#setup-form input[name=confirm]').fill(password);
  await page.locator('#setup-next').click();
  await page.locator('#setup-form input[name=title]').fill('First run blog');
  await page.locator('#setup-form input[name=author]').fill('Reader');
  await page.locator('#setup-submit').click();
  await page.locator('#home-view').waitFor({ state: 'visible' });
  await expect(page.locator('#publish-banner')).toContainText('已上线');
  await expect(page.locator('#site-link')).toHaveAttribute('href', 'http://localhost:8791');
  await page.locator('#settings').click();
  await expect(page.locator('#deployment-form')).toBeHidden();
  await page.locator('#site-form input[name=title]').fill('Browser deployed blog');
  await page.locator('#site-form input[name=author]').fill('Reader');
  await page.locator('#publish-settings').click();
  await expect(page.locator('#publish-settings')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#publish-banner')).toContainText('已上线');
  const live = await browser.newPage();
  live.on('pageerror', (e) => errors.push(e.message));
  await live.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await live.goto('http://localhost:8791/');
  await expect(live.locator('.hero h1')).toHaveText('Browser deployed blog');
  await page.locator('#new-post').click();
  await page.locator('#title').fill('Browser published mathematics');
  const body =
    '## A heading\n\n**Browser publication** $x^2$\n\n```rust\nlet x = 1;\n```\n\n<img src="x" onerror="window.BAD_SCRIPT=1">\n<script>window.BAD_SCRIPT=1</script>';
  await page.locator('#body').fill(body);
  const slug = await page.locator('#slug').inputValue();
  await page.locator('#image-files').setInputFiles({
    name: 'photo.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfYQAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(page.locator('#notice')).toContainText('图片已上传');
  await page.frameLocator('#preview-frame').locator('.katex').first().waitFor();
  await expect
    .poll(() =>
      page
        .frameLocator('#preview-frame')
        .locator('img[alt="photo.png"]')
        .evaluate((image) => image.src.startsWith('blob:')),
    )
    .toBe(true);
  await page.locator('#publish-post').click();
  await expect(page.locator('#publish-post')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#publish-banner')).toContainText('已上线');
  await live.goto(`http://localhost:8791/posts/${slug}/`);
  await expect(live.locator('article h1')).toHaveText('Browser published mathematics');
  await expect(live.locator('.katex')).toHaveCount(1);
  await expect(live.locator('code.hljs')).toHaveCount(1);
  assert.equal(await live.evaluate(() => window.BAD_SCRIPT), undefined);
  const image = live.locator('img[alt="photo.png"]');
  await expect
    .poll(() => image.evaluate((node) => node.complete && node.naturalWidth > 0))
    .toBe(true);
  await live.locator('#theme-toggle-btn').click();
  await expect(live.locator('html')).toHaveAttribute('data-theme', 'dark');
  await live.locator('#site-search-btn').click();
  await live.locator('#search-input').fill('mathematics');
  await expect(live.locator('#search-results a')).toHaveCount(1);
  await live.keyboard.press('Escape');
  // Fail one upload: the online pointer must remain the successful release.
  const original = await (await mf.dispatchFetch('http://localhost:8791/_release.json')).json();
  await page.locator('#body').fill('New version that must remain a draft after failure.');
  await page.route('**/api/publish/*/file?**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Test upload failure' }),
    }),
  );
  await page.locator('#publish-post').click();
  await expect(page.locator('#notice')).toContainText('Test upload failure');
  await expect(page.locator('#body')).toHaveValue(
    'New version that must remain a draft after failure.',
  );
  const after = await (await mf.dispatchFetch('http://localhost:8791/_release.json')).json();
  assert.equal(after.id, original.id);
  await page.unroute('**/api/publish/*/file?**');
  await page.locator('#publish-post').click();
  await expect(page.locator('#publish-post')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#publish-banner')).toContainText('已上线');
  await live.goto(`http://localhost:8791/posts/${slug}/`);
  await expect(live.locator('article')).toContainText(
    'New version that must remain a draft after failure.',
  );
  await page.locator('#settings').click();
  await expect(page.locator('#account-form')).toBeVisible();
  await expect(page.locator('#backup-card')).toBeVisible();
  await page.screenshot({ path: resolve('cloud-web/dist/settings.browser.png'), fullPage: true });
  const downloaded = page.waitForEvent('download');
  await page.locator('#download-backup').click();
  const backup = await downloaded;
  const backupPath = resolve('cloud-web/dist/browser-backup.zip');
  await backup.saveAs(backupPath);
  await expect(page.locator('#backup-status')).toContainText('1 张图片');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#backup-file').setInputFiles(backupPath);
  await expect(page.locator('#backup-status')).toContainText('已恢复');
  await page.locator('#account-form input[name=email]').fill('new-reader@example.net');
  await page.locator('#account-form input[name=current_password]').fill(password);
  await page.locator('#save-account').click();
  await expect(page.locator('#account-email')).toHaveText('new-reader@example.net');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve('cloud-web/dist/settings.mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#logout').click();
  await expect(page.locator('#login-view')).toBeVisible();
  await expect(page.locator('#setup-view')).toBeHidden();
  await page.locator('#login-form input[name=email]').fill('new-reader@example.net');
  await page.locator('#login-form input[name=password]').fill(password);
  await page.locator('#login-submit').click();
  await expect(page.locator('#home-view')).toBeVisible();
  await page.screenshot({ path: resolve('cloud-web/dist/deployment.browser.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      setupWizard: true,
      singleBucket: true,
      firstHomePublication: true,
      backupRoundTrip: true,
      accountChange: true,
      mobile: true,
      noDeployHook: true,
      settings: true,
      wasmPublish: true,
      imageUploadAndPreview: true,
      mathAndHighlight: true,
      publicSearchAndTheme: true,
      unsafeHtmlRemoved: true,
      failedUploadPreservesLiveVersionAndDraft: true,
      retry: true,
    }),
  );
} finally {
  await browser?.close();
  await mf.dispose();
}
