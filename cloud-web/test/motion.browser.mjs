// Real DOM motion tests, imported by the isolated three-engine audit.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';

export async function verifyMotion(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'no-preference',
  });
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const page = await context.newPage();
  await page.goto(origin + '/posts/slow-days/');
  await expect(page.locator('html')).toHaveAttribute('data-ci-motion', '');
  const button = page.locator('#share-btn');
  const idle = async () => {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const stats = CloudInkMotion.stats();
          return stats.springs + stats.effects + Number(stats.framePending);
        }),
      )
      .toBe(0);
  };
  const twoFrames = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  // Exercise the real mouse and keyboard actions; the share dialog becomes modal.
  await button.click();
  await expect(page.locator('.reader-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  await button.press('Space');
  await expect(page.locator('.reader-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  await idle();
  await page.locator('#site-search-btn').click();
  await expect(page.locator('#search-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#site-search-btn')).toBeFocused();
  await page.goto(origin + '/posts/slow-days/');
  const image = page.locator('.article-body img').first();
  await image.click();
  const dialog = page.locator('.reader-dialog');
  await expect(dialog).toBeVisible();
  await twoFrames();
  await page.evaluate(() => CloudInkMotion.closeDialog(document.querySelector('.reader-dialog')));
  await page.waitForTimeout(35);
  await page.evaluate(() => CloudInkMotion.openDialog(document.querySelector('.reader-dialog')));
  await page.waitForTimeout(350);
  await expect(dialog).toHaveAttribute('open', '');
  await page.screenshot({ path: resolve(output, 'motion-' + engine + '-dialog.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(image).toBeFocused();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  const cancellation = await page.evaluate(async () => {
    const probe = document.createElement('div');
    document.body.append(probe);
    const abort = new AbortController();
    let stale = 0;
    const first = CloudInkMotion.exit(probe, {
      signal: abort.signal,
      onFinish() {
        stale++;
      },
    });
    abort.abort();
    const second = CloudInkMotion.enter(probe);
    const result = [await first.finished, await second.finished, stale];
    probe.remove();
    return result;
  });
  assert.deepEqual(cancellation, [false, true, 0]);
  await idle();
  await page
    .locator('#share-btn')
    .dispatchEvent('pointerdown', { button: 0, pointerId: 56, isPrimary: true });
  await twoFrames();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await idle();
  await expect(page.locator('#share-btn')).toHaveCSS('scale', 'none');
  await image.click();
  await expect(dialog).toBeVisible();
  assert.equal(await page.evaluate(() => CloudInkMotion.stats().effects), 0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    Element.prototype.animate = undefined;
  });
  await image.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await idle();
  assert.deepEqual(errors, [], 'Motion interactions must not produce errors: ' + engine);
  await context.close();
  if (engine !== 'firefox') {
    const touch = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      colorScheme: 'light',
    });
    await touch.route('https://cdn.jsdelivr.net/**', (route) =>
      route.fulfill({ contentType: 'text/css', body: '' }),
    );
    const touchPage = await touch.newPage();
    await touchPage.goto(origin + '/posts/slow-days/');
    await touchPage.locator('#share-btn').tap();
    await expect(touchPage.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(touchPage.locator('#share-btn')).toHaveCSS('scale', 'none');
    await touch.close();
  }
}
