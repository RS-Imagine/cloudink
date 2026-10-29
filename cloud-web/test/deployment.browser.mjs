import { svgBytes, icoBytes } from './icon-fixtures.mjs';
import { acceptConfirmation } from './workflows.browser.mjs';
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
  await expect(page.locator('#deployment-form')).toHaveCount(0);
  await page.locator('#site-form input[name=title]').fill('Browser deployed blog');
  await page.locator('#site-form input[name=author]').fill('Reader');
  await page.locator('#site-form input[name=themePalette][value=brown]').check();
  await page
    .locator('#site-icon-file')
    .setInputFiles({ name: 'site.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svgBytes) });
  await expect(page.locator('#site-icon-status')).toHaveAttribute('data-tone', 'success');
  const svgIconKey = await page.locator('#site-icon-value').inputValue();
  const svgIconURL = '/site-icon/' + svgIconKey.split('/').pop();
  await page.locator('#site-form button[type=submit]').click();
  await expect(page.locator('#notice')).toContainText('网站信息已保存');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'brown');
  await page.reload();
  await expect(page.locator('#home-view')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'brown');
  const beforeThemePublish = await browser.newPage();
  await beforeThemePublish.goto('http://localhost:8791/');
  await expect(beforeThemePublish.locator('html')).toHaveAttribute('data-palette', 'ink');
  await expect(beforeThemePublish.locator('head link[rel=icon]')).toHaveAttribute(
    'href',
    '/favicon.svg',
  );
  await beforeThemePublish.close();
  await page.locator('#settings').click();
  await expect(page.locator('#site-form input[name=themePalette][value=brown]')).toBeChecked();
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
  await expect(live.locator('head link[rel=icon]')).toHaveAttribute('href', svgIconURL);
  await expect(live.locator('.site-mark img')).toHaveAttribute('src', svgIconURL);
  await expect
    .poll(() =>
      live.locator('.site-mark img').evaluate((image) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  await expect(live.locator('html')).toHaveAttribute('data-palette', 'brown');
  await page.locator('#new-post').click();
  await page.locator('#title').fill('Browser published mathematics');
  const body =
    '## A heading\n\n## A heading\n\n| Column | Value |\n| --- | --- |\n| Example | Content |\n\n**Browser publication** $x^2$\n\n```rust\nlet x = 1;\n```\n\n<img src="x" onerror="window.BAD_SCRIPT=1">\n<script>window.BAD_SCRIPT=1</script>';
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
  await expect(page.frameLocator('#preview-frame').locator('html')).toHaveAttribute(
    'data-palette',
    'brown',
  );
  assert.equal(
    await page
      .frameLocator('#preview-frame')
      .locator('html')
      .evaluate((node) => getComputedStyle(node).getPropertyValue('--ci-primary').trim()),
    '#805232',
  );
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
  const noScript = await browser.newContext({ javaScriptEnabled: false, colorScheme: 'dark' });
  const staticPage = await noScript.newPage();
  await staticPage.goto('http://localhost:8791/');
  await expect(staticPage.locator('html')).toHaveAttribute('data-palette', 'brown');
  await expect(staticPage.locator('body')).toHaveCSS('background-color', 'rgb(33, 26, 22)');
  await expect(staticPage.locator('head link[rel=icon]')).toHaveAttribute('href', svgIconURL);
  await staticPage.goto(`http://localhost:8791/posts/${slug}/`);
  await expect(staticPage.locator('article h1')).toHaveText('Browser published mathematics');
  await expect(staticPage.locator('.site-mark img')).toHaveAttribute('src', svgIconURL);
  await expect(staticPage.locator('html')).toHaveAttribute('data-palette', 'brown');
  await noScript.close();
  // The preview embeds the same Rust stylesheet; headings must remain visible.
  await expect(page.frameLocator('#preview-frame').locator('.article-heading h1')).toBeVisible();
  const readingStyle = (node) => {
    const style = getComputedStyle(node);
    return { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight };
  };
  const previewWidth = await page
    .frameLocator('#preview-frame')
    .locator('.article-body')
    .evaluate(() => innerWidth);
  await live.setViewportSize({ width: previewWidth, height: 1000 });
  assert.deepEqual(
    await live.locator('.article-body').evaluate(readingStyle),
    await page.frameLocator('#preview-frame').locator('.article-body').evaluate(readingStyle),
  );
  await live.setViewportSize({ width: 1440, height: 1000 });
  await expect(live.locator('.katex')).toHaveCount(1);
  await expect(live.locator('code.hljs')).toHaveCount(1);
  assert.equal(await live.evaluate(() => window.BAD_SCRIPT), undefined);
  const image = live.locator('img[alt="photo.png"]');
  await expect
    .poll(() => image.evaluate((node) => node.complete && node.naturalWidth > 0))
    .toBe(true);
  await expect(image).toHaveAttribute('width', '1');
  await expect(image).toHaveAttribute('height', '1');
  await image.focus();
  await live.keyboard.press('Enter');
  await expect(live.locator('.reader-dialog')).toBeVisible();
  await expect(live.locator('.reader-dialog-close')).toBeFocused();
  await live.keyboard.press('Escape');
  await expect(live.locator('.reader-dialog')).toHaveCount(0);
  await expect(image).toBeFocused();
  await expect(live.locator('body')).not.toHaveCSS('overflow', 'hidden');
  // Reopening must not leave old dialogs or keep background scrolling locked.
  for (let attempt = 0; attempt < 3; attempt++) {
    await live.keyboard.press('Enter');
    await expect(live.locator('.reader-dialog')).toHaveCount(1);
    await live.locator('.reader-dialog-close').click();
    await expect(live.locator('.reader-dialog')).toHaveCount(0);
    await expect(image).toBeFocused();
    await expect(live.locator('body')).not.toHaveCSS('overflow', 'hidden');
  }
  await expect(live.locator('.copy-code')).toHaveCount(1);
  await live.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.COPIED_TEXT = text;
        },
      },
    });
  });
  await live.locator('.copy-code').click();
  assert.equal(await live.evaluate(() => window.COPIED_TEXT), 'let x = 1;\n');
  await live.locator('#copy-link').click();
  assert.equal(await live.evaluate(() => window.COPIED_TEXT), live.url());
  await live.locator('#share-btn').click();
  await expect(live.locator('.share-download')).toHaveAttribute('download', 'cloudink-share.png');
  await live.keyboard.press('Escape');
  await expect(live.locator('#share-btn')).toBeFocused();
  const headingIds = await live
    .locator('.article-body h2')
    .evaluateAll((nodes) => nodes.map((n) => n.id));
  assert.equal(new Set(headingIds).size, headingIds.length);
  await expect(live.locator('.article-body table')).toHaveAttribute('tabindex', '0');
  await live.locator('#theme-toggle-btn').click();
  await expect(live.locator('html')).toHaveAttribute('data-theme', 'dark');
  await live.locator('#site-search-btn').click();
  await expect(live.locator('#search-input')).toBeFocused();
  await live.locator('#search-input').fill('mathematics');
  await expect(live.locator('#search-results a')).toHaveCount(1);
  await live.keyboard.press('Escape');
  await expect(live.locator('#site-search-btn')).toBeFocused();
  await live.locator('#site-search-btn').click();
  await expect(live.locator('#search-input')).toBeFocused();
  await live.locator('#search-input').fill('mathematics');
  await expect(live.locator('#search-results a')).toHaveCount(1);
  await live.locator('#search-results a').click();
  await expect(live.locator('#search-modal')).not.toHaveClass(/active/);
  await expect(live.locator('body')).not.toHaveCSS('overflow', 'hidden');
  await live.setViewportSize({ width: 1280, height: 900 });
  await live.locator('#theme-toggle-btn').click();
  await expect(live.locator('body')).toHaveCSS('background-color', 'rgb(248, 246, 241)');
  await live.screenshot({ path: resolve('cloud-web/dist/article.desktop.png'), fullPage: true });
  await live.goto('http://localhost:8791/');
  await expect(live.locator('.post-card')).toHaveCount(1);
  await live.screenshot({ path: resolve('cloud-web/dist/home.desktop.png'), fullPage: true });
  await live.locator('.post-card h2 a').click();
  await expect(live.locator('article h1')).toHaveText('Browser published mathematics');
  await expect(live.locator('.toc-container')).toHaveCount(1);
  await live.goBack();
  await expect(live.locator('.hero h1')).toHaveText('Browser deployed blog');
  await expect(live.locator('.toc-container')).toHaveCount(0);
  await live.setViewportSize({ width: 390, height: 844 });
  assert.equal(await live.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await live.screenshot({ path: resolve('cloud-web/dist/home.mobile.png'), fullPage: true });
  await live.emulateMedia({ reducedMotion: 'reduce' });
  await live.locator('.post-card h2 a').click();
  await expect(live.locator('article h1')).toHaveText('Browser published mathematics');
  assert.equal(await live.evaluate(() => window.swup.options.animationSelector), false);
  await expect(live.locator('html')).toHaveCSS('scroll-behavior', 'auto');
  await live.locator('.mobile-toc-btn').click();
  await expect(live.locator('.mobile-toc-btn')).toHaveAttribute('aria-expanded', 'true');
  await expect(live.locator('.toc-link').first()).toBeFocused();
  await live.keyboard.press('Escape');
  await expect(live.locator('.mobile-toc-btn')).toBeFocused();
  await live.locator('.mobile-toc-btn').click();
  await live.locator('.toc-link').first().click();
  await expect(live.locator('.mobile-toc-btn')).toHaveAttribute('aria-expanded', 'false');
  assert.equal(await live.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await live.locator('#theme-toggle-btn').click();
  await live.screenshot({
    path: resolve('cloud-web/dist/article.mobile.dark.png'),
    fullPage: true,
  });
  await live.locator('#site-search-btn').click();
  await expect(live.locator('#search-input')).toBeFocused();
  await live.locator('#search-close').click();
  await expect(live.locator('#site-search-btn')).toBeFocused();
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
  await page.locator('#site-form input[name=themePalette][value=ink]').check();
  await page.locator('#site-form button[type=submit]').click();
  await expect(page.locator('#notice')).toContainText('网站信息已保存');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'ink');
  await live.reload();
  await expect(live.locator('html')).toHaveAttribute('data-palette', 'brown');
  await page.locator('#site-form input[name=themePalette][value=brown]').check();
  await page.locator('#save-site').click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'brown');
  await page
    .locator('#site-icon-file')
    .setInputFiles({ name: 'site.ico', mimeType: 'image/x-icon', buffer: Buffer.from(icoBytes()) });
  await expect(page.locator('#site-icon-status')).toHaveAttribute('data-tone', 'success');
  const icoIconKey = await page.locator('#site-icon-value').inputValue();
  await page.locator('#save-site').click();
  await expect(page.locator('head link[rel=icon]')).toHaveAttribute(
    'href',
    '/site-icon/' + icoIconKey.split('/').pop(),
  );
  const downloaded = page.waitForEvent('download');
  await page.locator('#download-backup').click();
  const backup = await downloaded;
  const backupPath = resolve('cloud-web/dist/browser-backup.zip');
  await backup.saveAs(backupPath);
  await expect(page.locator('#backup-status')).toContainText('3 个图片文件');
  await page.locator('#reset-site-icon').click();
  await page.locator('#site-form input[name=themePalette][value=blue]').check();
  await page.locator('#save-site').click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'blue');
  await page.locator('#backup-file').setInputFiles(backupPath);
  await acceptConfirmation(page);
  await expect(page.locator('#backup-status')).toContainText('已恢复');
  await expect(page.locator('#site-icon-value')).toHaveValue(icoIconKey);
  await expect(page.locator('head link[rel=icon]')).toHaveAttribute(
    'href',
    '/site-icon/' + icoIconKey.split('/').pop(),
  );
  await expect(page.locator('#site-form input[name=themePalette][value=brown]')).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'brown');
  assert.deepEqual(
    await page
      .locator('#site-form input[name=themePalette]')
      .evaluateAll((inputs) => inputs.map((input) => input.value)),
    ['ink', 'neutral', 'brown', 'blue', 'violet', 'rose'],
  );
  await page.locator('#publish-settings').click();
  await expect(page.locator('#publish-settings')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#publish-banner')).toContainText('已上线');
  await live.goto('http://localhost:8791/');
  await expect(live.locator('head link[rel=icon]')).toHaveAttribute(
    'href',
    '/site-icon/' + icoIconKey.split('/').pop(),
  );
  await page.locator('#reset-site-icon').click();
  await page.locator('#publish-settings').click();
  await expect(page.locator('#publish-settings')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#publish-banner')).toContainText('已上线');
  await live.locator('.post-card h2 a').first().click();
  await expect(live.locator('article h1')).toBeVisible();
  await expect(live.locator('head link[rel=icon]')).toHaveAttribute('href', '/favicon.svg');
  await expect(live.locator('.site-mark img')).toHaveAttribute('src', '/favicon.svg');
  await page.locator('#account-form input[name=email]').fill('new-reader@example.net');
  await page.locator('#account-form input[name=current_password]').fill(password);
  await page.locator('#save-account').click();
  await expect(page.locator('#account-email')).toHaveText('new-reader@example.net');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve('cloud-web/dist/settings.mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#studio-tools summary').click();
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
