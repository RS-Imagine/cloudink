// Release reflow checks use generic content in the local UI audit fixture.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password } from './fixture.mjs';

const spacing = `
  * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }
  p { margin-bottom: 2em !important; }
`;
async function noOverflow(page, label) {
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    label + ' must reflow without document-level horizontal scrolling',
  );
}
export async function verifyRelease(browser, origin, output, engine) {
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: 360, height: 844 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const page = await context.newPage();
  await page.goto(origin + '/posts/slow-days/');
  await page.addStyleTag({ content: spacing });
  for (const mode of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: mode });
    await noOverflow(page, engine + ' reader text spacing');
    await page.locator('#site-search-btn').click();
    await expect(page.locator('#search-input')).toBeFocused();
    await page.locator('#search-input').fill('生活');
    await expect(page.locator('#search-results a')).toHaveCount(2);
    await noOverflow(page, engine + ' search text spacing');
    await page.keyboard.press('Escape');
    await expect(page.locator('#site-search-btn')).toBeFocused();
    await page.screenshot({
      path: resolve(output, 'release-text-spacing-reader-' + mode + '-' + engine + '.png'),
      fullPage: true,
    });
  }
  await page.goto(origin + '/admin');
  await page.addStyleTag({ content: spacing });
  await noOverflow(page, engine + ' login text spacing');
  await page.locator('#login-form input[name=email]').fill(owner);
  await page.locator('#login-form input[name=password]').fill(password);
  await page.locator('#login-submit').click();
  await expect(page.locator('#app-view')).toHaveAttribute('data-view', 'home');
  await noOverflow(page, engine + ' dashboard text spacing');
  await page.locator('#settings').click();
  await expect(page.locator('#site-form')).toBeVisible();
  await noOverflow(page, engine + ' settings text spacing');
  // Every primary destination remains operable after a text-spacing override.
  for (const id of ['dashboard-nav', 'articles-nav', 'images', 'settings']) {
    await expect(page.locator('#' + id)).toBeVisible();
    await page.locator('#' + id).click();
    await expect(page.locator('#' + id)).toHaveAttribute('aria-current', 'page');
    await noOverflow(page, engine + ' ' + id + ' text spacing');
  }
  await page.screenshot({
    path: resolve(output, 'release-text-spacing-settings-' + engine + '.png'),
    fullPage: true,
  });
  await context.close();
  assert.deepEqual(errors, [], engine + ' release reflow must not produce browser errors');
}
