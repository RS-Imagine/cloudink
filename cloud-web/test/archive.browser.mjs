import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';

export async function verifyArchive(browser, origin, output, engine) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const page = await context.newPage();
  try {
    await page.goto(origin + '/');
    await page.locator('.home-archive-link a').click();
    await expect(page).toHaveURL(origin + '/archive/');
    await expect(page.locator('#swup')).toHaveAttribute('data-page', 'archive');
    await expect(page.locator('h1')).toHaveText('文章归档');
    await expect(page.locator('.archive-group a[href="/posts/slow-days/"]')).toBeVisible();
    // In-page navigation must update the head before any native reload.
    await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', origin + '/archive/');
    await page.reload();
    await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', origin + '/archive/');
    for (const [width, theme] of [
      [1440, 'light'],
      [390, 'dark'],
      [360, 'light'],
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({
        path: resolve(output, 'archive-' + engine + '-' + width + '-' + theme + '.png'),
        fullPage: true,
      });
    }
    await page.locator('.archive-group a[href="/posts/slow-days/"]').click();
    await expect(page.locator('#swup')).toHaveAttribute('data-page', 'post');
    await page.goBack();
    await expect(page.locator('#swup')).toHaveAttribute('data-page', 'archive');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
