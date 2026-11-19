import { navigateStudio } from './studio-navigation.mjs';
import { verifyImageMaintenance } from './image-maintenance.browser.mjs';
import { verifyImagePerformance } from './image-performance.browser.mjs';
import { verifyUiStability } from './ui-stability.browser.mjs';
import { acceptConfirmation } from './workflows.browser.mjs';
import {
  Miniflare,
  convertV4MiniflareOptions,
} from '../../cloud-admin/node_modules/miniflare/dist/src/index.js';
import { chromium, expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { workerOptions, owner, password, setupToken } from './fixture.mjs';
const origin = 'http://localhost:8793';
const mf = new Miniflare(convertV4MiniflareOptions({ ...workerOptions(), port: 8793 }));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfYQAAAAASUVORK5CYII=',
  'base64',
);
let browser;
try {
  await mf.ready;
  const setup = await mf.dispatchFetch(origin + '/api/setup', {
    method: 'POST',
    headers: {
      Origin: origin,
      Authorization: `Bearer ${setupToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: owner,
      password,
      site: {
        title: 'Image library test',
        author: 'Reader',
        subtitle: '',
        description: '',
        about: '',
      },
    }),
  });
  assert.equal(setup.status, 200);
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  await page.goto(origin + '/admin');
  await page.locator('#login-form input[name=email]').fill(owner);
  await page.locator('#login-form input[name=password]').fill(password);
  await page.locator('#login-submit').click();
  await expect(page.locator('#home-view')).toBeVisible();
  await navigateStudio(page, 'images');
  await expect(page.locator('#images-view')).toBeVisible();
  await expect(page.locator('#image-library-empty')).toContainText('还没有图片');
  await page
    .locator('#image-library-files')
    .setInputFiles({ name: 'Reusable photo.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.image-card')).toHaveCount(1);
  const reusable = page.locator('.image-card').filter({ hasText: 'Reusable photo.png' });
  await expect(reusable.getByText('未发现引用', { exact: true })).toBeVisible();
  await expect(reusable.getByRole('button', { name: '插入当前文章' })).toBeDisabled();
  const thumbnail = reusable.getByRole('button', { name: '预览 Reusable photo.png' });
  await thumbnail.click();
  await expect(page.locator('#image-preview-dialog')).toBeVisible();
  await expect
    .poll(() => page.locator('#image-preview-full').evaluate((image) => image.naturalWidth))
    .toBe(1);
  await page.locator('#image-preview-close').click();
  await expect(thumbnail).toBeFocused();
  await page.setViewportSize({ width: 443, height: 900 });
  await thumbnail.click();
  await expect(page.locator('#image-preview-close')).toBeHidden();
  await expect(page.locator('#image-preview-dialog .ci-sheet-grip')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#image-preview-dialog')).toBeHidden();
  await expect(thumbnail).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await reusable.getByRole('button', { name: '复制链接' }).click();
  await expect(page.locator('#notice')).toContainText('链接已复制');
  assert.ok(
    (await page.evaluate(() => navigator.clipboard.readText())).startsWith(
      origin + '/images/uploads/',
    ),
  );
  await page.locator('#new-post').click();
  await page.locator('#show-split').click();
  await page.locator('#title').fill('An article using an existing image');
  await page.locator('#body').fill('Original text');
  await page.locator('#choose-library-image').click();
  await expect(page.locator('#images-view')).toBeVisible();
  await reusable.getByRole('button', { name: '插入当前文章' }).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  await expect(page.locator('#body')).toHaveValue(/Original text/);
  assert.match(
    await page.locator('#body').inputValue(),
    /<img src="\/images\/uploads\/[^"]+" alt="Reusable photo.png" width="1" height="1">/,
  );
  await page.locator('#save-post').click();
  await expect(page.locator('#notice')).toContainText('草稿已保存');
  await navigateStudio(page, 'images');
  await expect(reusable.getByText('正在使用', { exact: true })).toBeVisible();
  await expect(reusable.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await reusable.locator('summary').click();
  await expect(reusable.locator('ul')).toContainText('草稿');
  await page
    .locator('#image-library-files')
    .setInputFiles({ name: 'same-photo.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('#image-library-upload')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.image-card')).toHaveCount(1);
  const differentPng = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      canvas.getContext('2d').fillRect(0, 0, 1, 1);
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );
  await page
    .locator('#image-library-files')
    .setInputFiles({ name: 'unused.png', mimeType: 'image/png', buffer: differentPng });
  await expect(page.locator('.image-card')).toHaveCount(2);
  await page.locator('#image-library-unused').check();
  await expect(page.locator('.image-card')).toHaveCount(1);
  const unused = page.locator('.image-card');
  await expect(unused.locator('h3')).toHaveText('unused.png');
  const key = await unused.getAttribute('data-key');
  await page.locator('#image-library-search').fill('does-not-exist');
  await expect(page.locator('#image-library-empty')).toContainText('没有符合筛选条件');
  await page.locator('#image-library-search').fill('');
  await unused.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.locator('#confirmation-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#confirmation-dialog')).toBeHidden();
  await expect(unused.getByRole('button', { name: '删除', exact: true })).toBeFocused();
  assert.notEqual(await (await mf.getR2Bucket('STORAGE')).head(key), null);
  await unused.getByRole('button', { name: '删除', exact: true }).click();
  await acceptConfirmation(page);
  await expect(page.locator('#notice')).toContainText('已从存储桶删除');
  assert.equal(await (await mf.getR2Bucket('STORAGE')).head(key), null);
  await page.locator('#image-library-unused').uncheck();
  await expect(page.locator('.image-card')).toHaveCount(1);
  let releaseRefresh;
  const imageListRoute = (url) => url.pathname === '/api/images';
  await page.route(imageListRoute, async (route) => {
    await new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    await route.continue().catch(() => {});
  });
  const refresh = page.locator('#image-library-refresh');
  const layoutSize = (button) => ({ width: button.offsetWidth, height: button.offsetHeight });
  const beforeRefresh = await refresh.evaluate(layoutSize);
  const originalLabel = await refresh.textContent();
  try {
    await refresh.click();
    await expect(refresh).toHaveAttribute('aria-busy', 'true');
    assert.equal(await refresh.textContent(), originalLabel);
    const busy = await refresh.evaluate(layoutSize);
    assert.ok(Math.abs(busy.width - beforeRefresh.width) <= 1);
    assert.ok(Math.abs(busy.height - beforeRefresh.height) <= 1);
    await expect(page.locator('#image-library-status')).toHaveAttribute('data-tone', 'pending');
    await expect(page.locator('#image-library-status')).toContainText('正在读取图片库');
    await expect.poll(() => typeof releaseRefresh).toBe('function');
  } finally {
    releaseRefresh?.();
    await page.unroute(imageListRoute);
  }
  await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  const keepOriginal = page.getByRole('checkbox', { name: '保留上传原始文件' });
  const checkbox = await keepOriginal.boundingBox();
  const label = page.locator('label:has(> #image-keep-original)');
  const text = await label.locator('span').boundingBox();
  assert.ok(checkbox.x + checkbox.width <= text.x && checkbox.width <= 24);
  assert.ok(Math.abs(checkbox.y + checkbox.height / 2 - text.y - text.height / 2) <= 1);
  const initial = await keepOriginal.isChecked();
  await label.locator('span').click();
  assert.equal(await keepOriginal.isChecked(), !initial);
  await label.locator('span').click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const maintenance = page.locator('#image-maintenance > summary');
  assert.ok((await maintenance.boundingBox()).height >= 44);
  await page.screenshot({ path: resolve('cloud-web/dist/images.browser.png'), fullPage: true });
  await verifyImagePerformance(browser, context, page, mf, origin);
  await verifyImageMaintenance(context, page, mf, origin);
  await verifyUiStability(browser, origin, 'cloud-web/dist', 'chromium');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      imageLibrary: true,
      upload: true,
      preview: true,
      copyLink: true,
      reuse: true,
      referencesProtected: true,
      unusedFilter: true,
      physicalDeletion: true,
      mobile: true,
    }),
  );
} finally {
  await browser?.close();
  await mf.dispose();
}
