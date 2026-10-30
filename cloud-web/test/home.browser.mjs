// Isolated SSR + responsive navigation regression; imported by the UI audit.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';

export async function verifyHome(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    colorScheme: 'light',
  });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const page = await context.newPage();
  await page.goto(origin + '/');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('.home-feature')).toHaveCount(1);
  await expect(page.locator('.home-card')).toHaveCount(3);
  await expect(page.locator('.home-feature h2 a')).toHaveAttribute('href', '/posts/slow-days/');
  await expect(page.locator('.desktop-reader-nav [aria-current]')).toHaveAttribute(
    'data-reader-nav',
    'posts',
  );
  assert.equal(
    await page
      .locator('.home-post-grid')
      .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length),
    1,
  );
  await page.setViewportSize({ width: 900, height: 1000 });
  assert.equal(
    await page
      .locator('.home-post-grid')
      .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length),
    1,
  );
  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('#site-search-btn')).toBeVisible();
    await expect(page.locator('#theme-toggle-btn')).toBeVisible();
    await expect(page.locator('.desktop-reader-nav')).toBeHidden();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  const summary = page.locator('#reader-menu summary'),
    menu = page.locator('#reader-menu');
  await summary.click();
  await expect(menu).toHaveAttribute('open', '');
  await expect(page.locator('.reader-menu-links a[href="/about/"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).not.toHaveAttribute('open', '');
  await expect(summary).toBeFocused();
  await summary.click();
  // The full-height menu dismisses from its blank backdrop.
  await page.locator('.reader-menu-links').click({ position: { x: 16, y: 160 } });
  await expect(menu).not.toHaveAttribute('open', '');
  await summary.click();
  await page.locator('#site-search-btn').click();
  await expect(menu).not.toHaveAttribute('open', '');
  await expect(page.locator('#search-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await summary.click();
  await page.locator('.reader-menu-links a[href="/about/"]').click();
  await expect(page.locator('#swup')).toHaveAttribute('data-page', 'about');
  await expect(page.locator('.reader-menu-links [aria-current]')).toHaveAttribute(
    'data-reader-nav',
    'about',
  );
  await page.goBack();
  await expect(page.locator('.home-hero h1')).toBeVisible();
  await expect(page.locator('.desktop-reader-nav [aria-current]')).toHaveAttribute(
    'data-reader-nav',
    'posts',
  );
  await page.goto(origin + '/');
  await page.keyboard.press('Tab');
  await expect(page.locator('.reader-skip')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#swup')).toBeFocused();
  for (const [width, theme] of [
    [1440, 'light'],
    [390, 'light'],
    [390, 'dark'],
  ]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.locator('select[data-theme-mode]').selectOption(theme);
    await page.screenshot({
      path: resolve(output, 'reader-home-' + engine + '-' + width + '-' + theme + '.png'),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 360, height: 844 });
  await summary.click();
  await page.screenshot({
    path: resolve(output, 'reader-menu-' + engine + '.png'),
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    document.querySelector('.site-title').textContent = 'LongSiteName'.repeat(30);
    document.querySelector('.home-hero h1').textContent = '长标题不截断。'.repeat(15);
    document.querySelector('.home-intro > p').textContent = 'https://example.com/'.repeat(15);
    document
      .querySelectorAll('.home-card h2 a')
      .forEach((node) => (node.textContent = 'LongArticleTitle'.repeat(25)));
  });
  const wideElements = await page.evaluate(() =>
    [...document.querySelectorAll('body *')]
      .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
      .map((node) => ({
        tag: node.tagName,
        class: node.className,
        width: node.getBoundingClientRect().width,
      })),
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    JSON.stringify(wideElements),
  );
  await page.screenshot({
    path: resolve(output, 'reader-long-text-' + engine + '.png'),
    fullPage: true,
  });
  await context.close();

  const noScript = await browser.newContext({
    javaScriptEnabled: false,
    colorScheme: 'dark',
    viewport: { width: 390, height: 844 },
  });
  await noScript.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const nativePage = await noScript.newPage();
  await nativePage.goto(origin + '/');
  await expect(nativePage.locator('.home-card')).toHaveCount(3);
  await nativePage.locator('#reader-menu summary').click();
  await expect(nativePage.locator('.reader-menu-links a').first()).toHaveCSS('animation-name', 'none');
  await nativePage.locator('.reader-menu-links a[href="/about/"]').click();
  await expect(nativePage.locator('#swup')).toHaveAttribute('data-page', 'about');
  await nativePage.goto(origin + '/');
  await nativePage.locator('.home-feature h2 a').click();
  await expect(nativePage.locator('article h1')).toBeVisible();
  const nativeLayout = await nativePage.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('body *')]
      .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
      .map((node) => ({
        tag: node.tagName,
        class: node.className,
        width: node.getBoundingClientRect().width,
      })),
  }));
  assert.equal(nativeLayout.scrollWidth > nativeLayout.width, false, JSON.stringify(nativeLayout));
  await noScript.close();
  assert.deepEqual(errors, [], engine + ' reader home must not produce browser errors');
}
