// Exercise the shipped workflows against the audit's ephemeral Miniflare fixture.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password } from './fixture.mjs';

export async function acceptConfirmation(page) {
  await expect(page.locator('#confirmation-dialog')).toBeVisible();
  await page.locator('#confirmation-accept').click();
  await expect(page.locator('#confirmation-dialog')).toBeHidden();
}
export async function verifyWorkflows(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const page = await context.newPage();
  await page.goto(origin + '/admin');
  await page.locator('#login-form input[name=email]').fill(owner);
  await page.locator('#login-form input[name=password]').fill(password);
  await page.locator('#login-submit').click();
  await expect(page.locator('#app-view')).toHaveAttribute('data-view', 'home');
  await page.locator('#new-post').click();
  await page.locator('#title').fill('Workflow draft ' + engine);
  const slug = await page.locator('#slug').inputValue();
  let failSave = true;
  await page.route('**/api/posts/' + slug, async (route) => {
    if (route.request().method() === 'PUT' && failSave) {
      failSave = false;
      await route.fulfill({ status: 503, json: { error: 'Temporary draft save failure' } });
    } else await route.continue();
  });
  await page.locator('#body').fill('Retain this Markdown, selection and preview.');
  await expect(page.locator('#save-state')).toHaveAttribute('data-tone', 'error');
  await expect(page.locator('#body')).toHaveValue('Retain this Markdown, selection and preview.');
  await page.locator('#save-post').click();
  await expect(page.locator('#save-state')).toHaveAttribute('data-tone', 'success');
  await page.locator('#body').evaluate((node) => node.setSelectionRange(7, 11));
  await page.locator('#show-preview').click();
  await expect(page.locator('#show-preview')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#body')).toBeHidden();
  await page.frameLocator('#preview-frame').locator('article h1').waitFor();
  await page.locator('#show-writing').click();
  await expect(page.locator('#body')).toBeVisible();
  assert.deepEqual(
    await page.locator('#body').evaluate((node) => [node.selectionStart, node.selectionEnd]),
    [7, 11],
  );
  await page.locator('#show-split').click();
  await expect(page.locator('#body')).toBeVisible();
  await expect(page.locator('.preview-pane')).toBeVisible();
  await page.frameLocator('#preview-frame').locator('article h1').waitFor();
  for (const [width, theme] of [
    [1440, 'light'],
    [390, 'light'],
    [360, 'dark'],
    [320, 'dark'],
  ]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.evaluate((mode) => CloudInkTheme.setMode(mode), theme);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    for (const id of [
      'save-post',
      'publish-post',
      'download-post',
      'show-writing',
      'show-preview',
      'choose-library-image',
      'upload-image',
    ]) {
      const rect = await page.locator('#' + id).boundingBox();
      assert.ok(rect.width >= 44 && rect.height >= 44, engine + '/' + id + ' remains touchable');
    }
    if (width < 1100) {
      await expect(page.locator('#show-split')).toBeHidden();
      await expect(page.locator('#show-writing')).toHaveAttribute('aria-pressed', 'true');
    }
    if (width !== 320)
      await page.screenshot({
        path: resolve(output, 'workflow-editor-' + engine + '-' + width + '-' + theme + '.png'),
        fullPage: true,
      });
  }
  await page.locator('#delete-post').click();
  await expect(page.locator('#confirmation-dialog')).toBeVisible();
  await expect(page.locator('#confirmation-cancel')).toBeFocused();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await page.screenshot({
    path: resolve(output, 'workflow-confirmation-' + engine + '.png'),
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('#confirmation-dialog')).toBeHidden();
  await expect(page.locator('#delete-post')).toBeFocused();
  await expect(page.locator('#title')).toHaveValue('Workflow draft ' + engine);
  await page.locator('#delete-post').click();
  await acceptConfirmation(page);
  await expect(page.locator('#home-view')).toBeVisible();
  await expect(page.locator('#post-count')).toHaveText('4');
  let failImages = true;
  await page.route('**/api/images', async (route) => {
    if (route.request().method() === 'GET' && failImages) {
      failImages = false;
      await route.fulfill({ status: 503, json: { error: 'Temporary library failure' } });
    } else await route.continue();
  });
  await page.locator('#images').click();
  await expect(page.locator('#image-library-retry')).toBeVisible();
  await expect(page.locator('#images svg')).toHaveCount(1);
  await expect(page.locator('#image-library-status')).toHaveAttribute('data-tone', 'error');
  await expect(page.locator('#image-library-empty')).toContainText('无法读取');
  await page.locator('#image-library-retry').click();
  await expect(page.locator('.image-card')).toHaveCount(1);
  await expect(page.locator('#image-library-grid')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.image-card .danger')).toBeDisabled();
  await expect(page.locator('.image-protection')).toContainText('保护');
  const thumbnail = page.locator('.image-thumbnail').first();
  await thumbnail.click();
  await expect(page.locator('#image-preview-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#image-preview-dialog')).toBeHidden();
  await expect(thumbnail).toBeFocused();
  await page.locator('#image-library-unused').check();
  await expect(page.locator('.image-card')).toHaveCount(0);
  await expect(page.locator('#image-library-empty')).toContainText('筛选');
  await page.locator('#image-library-unused').uncheck();
  for (const [width, theme] of [
    [1440, 'light'],
    [390, 'light'],
    [360, 'dark'],
  ]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.evaluate((mode) => CloudInkTheme.setMode(mode), theme);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: resolve(output, 'workflow-images-' + engine + '-' + width + '-' + theme + '.png'),
      fullPage: true,
    });
  }
  await page.locator('#settings').click();
  await expect(page.locator('#site-form')).toBeVisible();
  let failSettings = true,
    accountRequests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/account')) accountRequests++;
  });
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'PUT' && failSettings) {
      failSettings = false;
      await route.fulfill({ status: 503, json: { error: 'Temporary settings failure' } });
    } else await route.continue();
  });
  await page.locator('#save-site').click();
  await expect(page.locator('#site-feedback')).toHaveAttribute('data-tone', 'error');
  await expect(page.locator('#site-feedback')).toContainText('Temporary settings failure');
  await expect(page.locator('#site-form input[name=title]')).not.toHaveValue('');
  await page.locator('#save-site').click();
  await expect(page.locator('#site-feedback')).toHaveAttribute('data-tone', 'success');
  await expect(page.locator('#site-feedback')).toContainText('保存');
  await page.locator('#account-form input[name=current_password]').fill(password);
  await page.locator('#account-form input[name=password]').fill('A-new-password-123');
  await page.locator('#account-form input[name=confirm]').fill('A-different-password-123');
  await page.locator('#save-account').click();
  await expect(page.locator('#account-feedback')).toHaveAttribute('data-tone', 'error');
  assert.equal(accountRequests, 0, 'A mismatched password never submits account changes');
  await page.route('**/api/backup', (route) =>
    route.fulfill({ status: 503, json: { error: 'Temporary backup failure' } }),
  );
  await page.locator('#download-backup').click();
  await expect(page.locator('#backup-status')).toHaveAttribute('data-tone', 'error');
  await expect(page.locator('#backup-status')).toContainText('Temporary backup failure');
  const cancelledArchive = {
    name: 'cancelled.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('Not imported'),
  };
  await page.locator('#backup-file').setInputFiles(cancelledArchive);
  await expect(page.locator('#confirmation-dialog')).toBeVisible();
  await page.locator('#confirmation-cancel').click();
  await expect(page.locator('#confirmation-dialog')).toBeHidden();
  await expect(page.locator('#backup-file')).toHaveValue('');
  for (const [width, theme] of [
    [1440, 'light'],
    [390, 'light'],
    [360, 'dark'],
    [320, 'dark'],
  ]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.evaluate((mode) => CloudInkTheme.setMode(mode), theme);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    for (const id of [
      'save-site',
      'publish-settings',
      'save-account',
      'download-backup',
      'restore-backup',
    ]) {
      const rect = await page.locator('#' + id).boundingBox();
      assert.ok(rect.width >= 44 && rect.height >= 44, id + ' keeps a touch target');
    }
    if (width !== 320)
      await page.screenshot({
        path: resolve(output, 'workflow-settings-' + engine + '-' + width + '-' + theme + '.png'),
        fullPage: true,
      });
  }
  await context.close();
  assert.deepEqual(errors, [], engine + ' workflow UI must not throw browser errors');
}
