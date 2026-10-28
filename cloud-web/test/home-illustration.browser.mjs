import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password } from './fixture.mjs';
import { svgBytes } from './icon-fixtures.mjs';

export async function verifyHomeIllustrations(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + '/admin');
  await page.locator('#login-form input[name=email]').fill(owner);
  await page.locator('#login-form input[name=password]').fill(password);
  await page.locator('#login-submit').click();
  await expect(page.locator('#home-view')).toBeVisible();
  await context.route(origin + '/home-illustration.js', (route) => route.abort('failed'));
  await page.locator('#settings').click();
  await expect(page.locator('#notice')).toContainText('请刷新后台后重试');
  await expect(page.locator('#home-view')).toBeVisible();
  await context.unroute(origin + '/home-illustration.js');
  await page.reload();
  await expect(page.locator('#home-view')).toBeVisible();
  await page.locator('#settings').click();
  const originalPalette = await page.locator('input[name=themePalette]:checked').inputValue();
  await page.getByRole('radio', { name: '棕褐 Brown', exact: true }).check();
  const mode = page.locator('#home-illustration-mode');
  await mode.selectOption('default');
  await expect(page.locator('#home-illustration-value')).toHaveValue('default');
  await expect(page.locator('#home-illustration-preview')).toBeVisible();
  await page.locator('#save-site').click();
  await expect(page.locator('#site-feedback')).toHaveAttribute('data-tone', 'success');
  await page.reload();
  await expect(page.locator('#home-view')).toBeVisible();
  await page.locator('#settings').click();
  await expect(mode).toHaveValue('default');
  await page.locator('#publish-settings').click();
  await expect
    .poll(
      async () =>
        (await (await context.request.get(origin + '/')).text()).includes(
          'class="home-illustration"',
        ),
      { timeout: 60000 },
    )
    .toBe(true);
  await expect(page.locator('#publish-settings')).toBeEnabled({ timeout: 60000 });
  const reader = await context.newPage();
  for (const width of [1440, 390]) {
    await reader.setViewportSize({ width, height: 960 });
    await reader.goto(origin + '/');
    await expect(reader.locator('.home-illustration img')).toBeVisible();
    await expect(reader.locator('.home-illustration img')).toHaveAttribute(
      'src',
      '/editorial-botanical.svg',
    );
    await expect
      .poll(() =>
        reader
          .locator('.home-illustration img')
          .evaluate((image) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
    await expect(reader.locator('html')).toHaveAttribute('data-palette', 'brown');
    for (const theme of ['light', 'dark']) {
      await reader.locator('select[data-theme-mode]').selectOption(theme);
      assert.equal(
        await reader.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await reader.screenshot({
        path: resolve(
          output,
          'editorial-brown-home-' + width + '-' + theme + '-' + engine + '.png',
        ),
        fullPage: true,
      });
      if (engine === 'chromium') {
        console.log(
          'BROWN_HOME_PREVIEW ' +
            JSON.stringify({
              width,
              theme,
              image: (await reader.screenshot({ type: 'jpeg', quality: 65 })).toString('base64'),
            }),
        );
      }
    }
  }
  await reader.close();
  await mode.selectOption('custom');
  await page.locator('#home-illustration-file').setInputFiles({
    name: 'branches.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(svgBytes),
  });
  await expect(page.locator('#home-illustration-value')).toHaveValue(
    /^uploads\/icons\/[a-f0-9]{64}\.svg$/,
  );
  const key = await page.locator('#home-illustration-value').inputValue();
  await expect
    .poll(() =>
      page
        .locator('#home-illustration-preview')
        .evaluate((image) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  await page.locator('#save-site').click();
  await expect(page.locator('#site-feedback')).toHaveAttribute('data-tone', 'success');
  await page.locator('#home-illustration-library').click();
  await expect(page.locator('#home-illustration-choices')).toHaveValue(key);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: resolve(output, 'editorial-illustration-settings-' + engine + '.png'),
    fullPage: true,
  });
  await page.locator('#publish-settings').click();
  await expect
    .poll(
      async () =>
        (await (await context.request.get(origin + '/')).text()).includes('/images/' + key),
      { timeout: 60000 },
    )
    .toBe(true);
  await expect(page.locator('#publish-settings')).toBeEnabled({ timeout: 60000 });
  await page.reload();
  await expect(page.locator('#home-view')).toBeVisible();
  await page.locator('#settings').click();
  await expect(mode).toHaveValue('custom');
  await expect(page.locator('#home-illustration-value')).toHaveValue(key);
  await mode.selectOption('off');
  await page.locator('input[name=themePalette][value=' + originalPalette + ']').check();
  await expect(page.locator('#home-illustration-preview')).toBeHidden();
  await page.locator('#save-site').click();
  await expect(page.locator('#site-feedback')).toHaveAttribute('data-tone', 'success');
  await page.locator('#publish-settings').click();
  await expect
    .poll(
      async () =>
        (await (await context.request.get(origin + '/')).text()).includes(
          'class="home-illustration"',
        ),
      { timeout: 60000 },
    )
    .toBe(false);
  await expect(page.locator('#publish-settings')).toBeEnabled({ timeout: 60000 });
  const session = await (await context.request.get(origin + '/api/session')).json();
  const library = await (await context.request.get(origin + '/api/images')).json();
  const image = library.images.find((item) => item.key === key);
  assert.ok(image);
  assert.deepEqual(image.references, []);
  const removed = await context.request.delete(origin + '/api/images', {
    headers: { Origin: origin, 'X-CSRF-Token': session.csrf },
    data: { key, etag: image.etag },
  });
  assert.equal(removed.status(), 200);
  assert.deepEqual(errors, []);
  await context.close();
}
