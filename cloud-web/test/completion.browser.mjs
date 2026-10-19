// Final UI state checks use only the local audit account and generated content.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password } from './fixture.mjs';

export async function verifyCompletion(browser, origin, output, engine) {
  const errors = [];
  async function context(options = {}) {
    const result = await browser.newContext({
      viewport: { width: 360, height: 844 },
      colorScheme: 'light',
      reducedMotion: 'reduce',
      ...options,
    });
    result.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    await result.route('https://cdn.jsdelivr.net/**', (route) =>
      route.fulfill({ contentType: 'text/css', body: '' }),
    );
    return result;
  }
  const session = await context();
  const page = await session.newPage();
  let releaseConfig;
  const configGate = new Promise((done) => { releaseConfig = done; });
  await page.route('**/api/config', async (route) => {
    await configGate;
    await route.continue();
  });
  const anonymous = page.waitForResponse((response) => response.url().endsWith('/api/session'));
  try {
    await page.goto(origin + '/admin');
    assert.equal((await anonymous).status(), 401);
    await expect(page.locator('#startup-view')).toBeVisible();
    await expect(page.locator('#startup-view')).toHaveAttribute('aria-busy', 'true');
    for (const id of ['login-view', 'setup-view', 'app-view'])
      await expect(page.locator('#' + id)).toBeHidden();
    await page.screenshot({
      path: resolve(output, 'completion-startup-' + engine + '.png'),
      fullPage: true,
    });
  } finally {
    releaseConfig();
  }
  await expect(page.locator('#login-view')).toBeVisible();
  await expect(page.locator('#startup-view')).toBeHidden();
  await page.unroute('**/api/config');
  await page.locator('#login-form input[name=email]').fill(owner);
  await page.locator('#login-form input[name=password]').fill(password);
  await page.locator('#login-submit').click();
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#workspace')).toBeFocused();

  // An authenticated refresh stays in the startup view until the first data read succeeds.
  const resumed = await session.newPage();
  let releasePosts;
  const postsGate = new Promise((done) => { releasePosts = done; });
  let postAttempts = 0;
  await resumed.route('**/api/posts', async (route) => {
    if (++postAttempts === 1) {
      await postsGate;
      await route.fulfill({ status: 503, json: { error: 'Temporary startup data failure' } });
    } else await route.continue();
  });
  const firstRead = resumed.waitForRequest((request) => new URL(request.url()).pathname === '/api/posts');
  try {
    await resumed.goto(origin + '/admin');
    await firstRead;
    await expect(resumed.locator('#startup-view')).toBeVisible();
    await expect(resumed.locator('#login-view')).toBeHidden();
    await expect(resumed.locator('#app-view')).toBeHidden();
  } finally {
    releasePosts();
  }
  await expect(resumed.locator('#startup-view')).toHaveAttribute('data-state', 'error');
  await expect(resumed.locator('#startup-message')).toContainText('Temporary startup data failure');
  await resumed.locator('#startup-retry').click();
  await expect(resumed.locator('#app-view')).toBeVisible();
  await expect(resumed.locator('#workspace')).toBeFocused();
  assert.equal(postAttempts, 2);
  await resumed.close();

  await page.bringToFront();
  // Keyboard navigation through a card must enter the new work area, not a hidden card.
  const card = page.locator('.article-card').first();
  await card.focus();
  await card.press('Enter');
  await expect(page.locator('#editor-view')).toBeVisible();
  await expect(page.locator('#editor-view')).toBeFocused();
  const text = await page.locator('#body').inputValue();
  await page.locator('#body').evaluate((node) => node.setSelectionRange(1, 4));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('#show-split')).toHaveAttribute('aria-pressed', 'true');
  const article = page.frameLocator('#preview-frame').locator('article');
  await expect(article).toBeVisible();
  await article.evaluate((node) => {
    node.tabIndex = -1;
    node.focus();
  });
  await expect(page.locator('#preview-frame')).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#show-writing')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#show-writing')).toBeFocused();
  await expect(page.locator('#body')).toHaveValue(text);
  assert.deepEqual(
    await page.locator('#body').evaluate((node) => [node.selectionStart, node.selectionEnd]),
    [1, 4],
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#show-split').focus();
  await page.setViewportSize({ width: 360, height: 844 });
  await expect(page.locator('#show-writing')).toBeFocused();
  await page.locator('#dashboard-nav').click();
  await expect(page.locator('#home-view')).toBeFocused();
  await page.locator('#studio-tools summary').click();
  await page.locator('#logout').click();
  await expect(page.locator('#login-form input[name=email]')).toBeFocused();
  await expect(page.locator('#app-view')).toBeHidden();
  await session.close();

  // A failed configuration or session read remains a retryable state, not a false login.
  for (const path of ['/api/config', '/api/session']) {
    const retry = await context({ colorScheme: 'dark' });
    let attempts = 0;
    await retry.route('**' + path, (route) =>
      ++attempts === 1
        ? route.fulfill({ status: 503, json: { error: 'Temporary startup read failure' } })
        : route.continue(),
    );
    const failed = await retry.newPage();
    await failed.goto(origin + '/admin');
    await expect(failed.locator('#startup-view')).toHaveAttribute('data-state', 'error');
    await expect(failed.locator('#startup-message')).toHaveAttribute('role', 'alert');
    await expect(failed.locator('#startup-message')).toContainText('Temporary startup read failure');
    await expect(failed.locator('#login-view')).toBeHidden();
    await expect(failed.locator('#setup-view')).toBeHidden();
    if (path === '/api/config')
      await failed.screenshot({
        path: resolve(output, 'completion-startup-error-' + engine + '.png'),
        fullPage: true,
      });
    await failed.locator('#startup-retry').click();
    await expect(failed.locator('#login-view')).toBeVisible();
    await expect(failed.locator('#login-form input[name=email]')).toBeFocused();
    assert.equal(attempts, 2);
    await retry.close();
  }

  const wizard = await context();
  await wizard.route('**/api/config', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), initialized: false } });
  });
  const setup = await wizard.newPage();
  await setup.goto(origin + '/admin');
  await expect(setup.locator('#setup-view')).toBeVisible();
  await expect(setup.locator('#login-view')).toBeHidden();
  await expect(setup.locator('#startup-view')).toBeHidden();
  await wizard.close();

  const native = await context({ javaScriptEnabled: false });
  const plain = await native.newPage();
  await plain.goto(origin + '/admin');
  await expect(plain.locator('noscript')).toContainText('启用 JavaScript');
  await expect(plain.locator('.startup-indicator')).toBeHidden();
  await expect(plain.locator('#login-view')).toBeHidden();
  await expect(plain.locator('.startup-reload')).toHaveAttribute('href', '/admin');
  await native.close();
  assert.deepEqual(errors, [], engine + ' final UI states must not throw browser errors');
}
