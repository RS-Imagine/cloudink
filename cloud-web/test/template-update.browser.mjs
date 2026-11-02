import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password } from './fixture.mjs';

export async function verifyTemplateUpdates(browser, origin, output, engine) {
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  let failModule = true,
    staleRenderer = false,
    outdated = true;
  let prepared = 0,
    uploaded = 0;
  await context.route('**/publication.js', (route) =>
    failModule ? route.abort() : route.continue(),
  );
  await context.route('**/api/posts', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    if (outdated) value.templateStatus = 'outdated';
    await route.fulfill({ response, json: value });
  });
  await context.route('**/api/publish', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    prepared++;
    const response = await route.fetch();
    const value = await response.json();
    if (staleRenderer) value.template_version = '0'.repeat(64);
    await route.fulfill({ response, json: value });
  });
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/file?')) uploaded++;
  });
  try {
    await page.goto(origin + '/admin');
    await page.locator('#login-form input[name=email]').fill(owner);
    await page.locator('#login-form input[name=password]').fill(password);
    await page.locator('#login-submit').click();
    await expect(page.locator('#home-view')).toBeVisible();
    await expect(page.locator('#template-status')).toContainText('有新版排版待应用');
    await page.screenshot({
      path: resolve(output, 'template-update-' + engine + '-390.png'),
      fullPage: true,
    });
    await page.locator('#publish-welcome').click();
    await expect(page.locator('#notice')).toContainText('发布工具加载失败');
    assert.equal(prepared, 0, 'failed lazy import must not start a publication');

    failModule = false;
    staleRenderer = true;
    await page.reload();
    await expect(page.locator('#home-view')).toBeVisible();
    await page.locator('#publish-welcome').click();
    await expect(page.locator('#notice')).toContainText('后台版本已更新');
    assert.equal(uploaded, 0, 'a stale renderer must be rejected before uploading pages');
    await expect(page.locator('#publish-welcome')).not.toHaveAttribute('aria-busy', 'true');
    staleRenderer = false;
    outdated = false;
    await page.locator('#publish-welcome').click();
    await expect(page.locator('#publish-banner')).toContainText('已上线');
    await expect(page.locator('#template-status')).toHaveText('网站排版已是最新。');
    assert.ok(uploaded > 0);
    const status = await (await page.request.get(origin + '/api/posts')).json();
    assert.equal(status.templateStatus, 'current');
  } finally {
    await context.close();
  }
}
