// Imported by the isolated three-engine UI audit; never contacts a deployed Worker.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';

export async function verifyThemes(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, colorScheme: 'light', reducedMotion: 'reduce',
  });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  const page = await context.newPage();
  const root = page.locator('html');
  const mode = page.locator('select[data-theme-mode]');
  await page.goto(origin + '/');
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(root).toHaveAttribute('data-theme-mode', 'auto');
  await expect(mode).toHaveValue('auto');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(20, 27, 23)');
  await mode.selectOption('light');
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'light');
  await mode.selectOption('auto');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.locator('.post-card h2 a').first().click();
  await expect(page.locator('article h1')).toBeVisible();
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(mode).toHaveValue('auto');
  await mode.focus();
  await expect(mode).toBeFocused();
  await expect(mode).toHaveCSS('outline-style', 'solid');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve(output, 'theme-' + engine + '-mobile-dark.png'), fullPage: true });
  // Reader mode and the admin cache must not override the published author palette.
  await page.evaluate(() => localStorage.setItem('cloudink-admin-palette', 'neutral'));
  await page.reload();
  await expect(root).toHaveAttribute('data-palette', 'ink');
  await page.goto(origin + '/admin');
  await expect(page.locator('#login-view')).toBeVisible();
  await expect(root).toHaveAttribute('data-palette', 'neutral');
  await page.locator('[data-theme-toggle]').first().click();
  await expect(root).toHaveAttribute('data-theme', 'light');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await context.close();

  // Denied storage must preserve system following, navigation and manual theme changes.
  const blocked = await browser.newContext({ colorScheme: 'dark' });
  blocked.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  await blocked.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await blocked.addInitScript(() => {
    for (const key of ['getItem', 'setItem']) Object.defineProperty(Storage.prototype, key, {
      configurable: true, value() { throw new DOMException('Unavailable', 'SecurityError'); },
    });
  });
  const blockedPage = await blocked.newPage();
  await blockedPage.goto(origin + '/');
  await expect(blockedPage.locator('html')).toHaveAttribute('data-theme', 'dark');
  await blockedPage.locator('select[data-theme-mode]').selectOption('light');
  await expect(blockedPage.locator('html')).toHaveAttribute('data-theme', 'light');
  await blocked.close();

  const noScript = await browser.newContext({ javaScriptEnabled: false, colorScheme: 'dark' });
  await noScript.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  const staticPage = await noScript.newPage();
  await staticPage.goto(origin + '/');
  await expect(staticPage.locator('body')).toHaveCSS('background-color', 'rgb(20, 27, 23)');
  await staticPage.locator('.post-card h2 a').first().click();
  await expect(staticPage.locator('article h1')).toBeVisible();
  await noScript.close();
  assert.deepEqual(errors, [], 'Theme smoke must have no browser errors: ' + engine);
}
