import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password } from './fixture.mjs';
import { svgBytes, icoBytes, pngIcoBytes } from './icon-fixtures.mjs';

export async function verifySiteIcons(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 360, height: 844 },
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
  await expect(page.locator('#home-view')).toBeVisible();
  await page.locator('#settings').click();
  const uploaded = new Set();
  for (const [kind, bytes, mimeType] of [
    ['svg', svgBytes, 'image/svg+xml'],
    ['ico', icoBytes(), 'image/x-icon'],
    ['ico-png', pngIcoBytes(), 'image/x-icon'],
  ]) {
    const ext = kind === 'svg' ? 'svg' : 'ico';
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#upload-site-icon').click();
    await (await chooser).setFiles({ name: 'site.' + ext, mimeType, buffer: Buffer.from(bytes) });
    await expect(page.locator('#site-icon-status')).toHaveAttribute('data-tone', 'success');
    const key = await page.locator('#site-icon-value').inputValue();
    uploaded.add(key);
    assert.match(key, new RegExp('^uploads/icons/[a-f0-9]{64}\\.' + ext + '$'));
    console.log(
      JSON.stringify({
        iconDecode: { engine, kind, key },
        image: await page.locator('#site-icon-preview').evaluate((image) => ({
          src: image.getAttribute('src'),
          currentSrc: image.currentSrc,
          complete: image.complete,
          width: image.naturalWidth,
        })),
      }),
    );
    await expect
      .poll(() =>
        page
          .locator('#site-icon-preview')
          .evaluate((image) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
    await expect(page.locator('#site-icon-preview')).toHaveAttribute(
      'src',
      '/site-icon/' + key.split('/').pop(),
    );
    await page.locator('#save-site').click();
    await expect(page.locator('#site-feedback')).toHaveAttribute('data-tone', 'success');
    await expect(page.locator('head link[rel=icon]')).toHaveAttribute(
      'href',
      '/site-icon/' + key.split('/').pop(),
    );
    await page.reload();
    await expect(page.locator('#home-view')).toBeVisible();
    await expect(page.locator('.sidebar .brand-mark img')).toHaveAttribute(
      'src',
      '/site-icon/' + key.split('/').pop(),
    );
    await page.locator('#settings').click();
    await expect(page.locator('#site-icon-value')).toHaveValue(key);
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: resolve(output, 'site-icon-' + kind + '-' + width + '-' + engine + '.png'),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 360, height: 844 });
  }
  await page.locator('#reset-site-icon').click();
  await expect(page.locator('#site-icon-value')).toHaveValue('');
  await page.locator('#save-site').click();
  await expect(page.locator('head link[rel=icon]')).toHaveAttribute('href', '/favicon.svg');
  await page.reload();
  await expect(page.locator('#home-view')).toBeVisible();
  await expect(page.locator('.sidebar .brand-mark img')).toHaveAttribute('src', '/favicon.svg');
  const session = await (await context.request.get(origin + '/api/session')).json();
  const catalog = await (await context.request.get(origin + '/api/images')).json();
  for (const image of catalog.images.filter((image) => uploaded.has(image.key))) {
    assert.deepEqual(image.references, [], 'Reset icons are unused and removable');
    const response = await context.request.delete(origin + '/api/images', {
      headers: { Origin: origin, 'X-CSRF-Token': session.csrf },
      data: { key: image.key, etag: image.etag },
    });
    assert.equal(response.status(), 200);
    uploaded.delete(image.key);
  }
  assert.equal(uploaded.size, 0, 'The icon test cleans up its own uploads');
  await context.close();
  assert.deepEqual(errors, [], engine + ' custom site icons');
}
