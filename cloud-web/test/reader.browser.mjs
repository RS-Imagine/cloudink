// Reader regressions against temporary published fixtures, shared by all three engines.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';

export async function verifyReader(browser, origin, output, engine) {
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    colorScheme: 'light',
  });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const page = await context.newPage();
  await page.goto(origin + '/posts/slow-days/');
  await expect(page.locator('.article-heading h1')).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('.article-author-name')).toBeVisible();
  await expect(page.locator('.article-details')).toContainText('分钟阅读');
  await expect(page.locator('.toc-link')).toHaveCount(3);
  const bounds = await page.evaluate(() => {
    const article = document.querySelector('.reader-article article').getBoundingClientRect();
    const toc = document.querySelector('.toc-container').getBoundingClientRect();
    return { articleRight: article.right, tocLeft: toc.left, width: article.width };
  });
  assert.ok(bounds.width >= 600 && bounds.width <= 720);
  assert.ok(
    bounds.tocLeft >= bounds.articleRight + 30,
    'The desktop TOC must stay outside the reading column',
  );
  await expect(page.locator('.mobile-toc-btn')).toBeHidden();
  const ids = await page
    .locator('.article-body h2')
    .evaluateAll((nodes) => nodes.map((node) => node.id));
  assert.equal(new Set(ids).size, ids.length);
  await page.locator('.toc-link').first().click();
  await expect(page.locator('.article-body h2').first()).toBeFocused();
  await expect(page.locator('.toc-link[aria-current="location"]')).toHaveCount(1);
  await page.goto(origin + '/posts/slow-days/#' + encodeURIComponent(ids[0]));
  await page.reload();
  const headerBottom = await page
    .locator('.reader-header')
    .evaluate((node) => node.getBoundingClientRect().bottom);
  const target = page.locator('.article-body h2').first();
  await expect
    .poll(() => target.evaluate((node) => node.getBoundingClientRect().top))
    .toBeGreaterThanOrEqual(headerBottom + 8);
  await expect
    .poll(() => target.evaluate((node) => node.getBoundingClientRect().top))
    .toBeLessThan(headerBottom + 64);
  await expect(page.locator('.article-body .katex')).toHaveCount(1);
  await expect(page.locator('.article-body code.hljs')).toHaveCount(1);
  await expect(page.locator('.article-body table')).toHaveAttribute('tabindex', '0');
  for (const [width, theme] of [
    [1440, 'light'],
    [390, 'light'],
    [360, 'dark'],
  ]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.locator('select[data-theme-mode]').selectOption(theme);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: resolve(output, 'reader-article-' + engine + '-' + width + '-' + theme + '.png'),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 320, height: 720 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('.mobile-toc-btn').click();
  await expect(page.locator('.toc-link').first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.toc-container > .ci-sheet-grip')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.toc-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.mobile-toc-btn')).toBeFocused();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  await page.locator('.mobile-toc-btn').click();
  await page.locator('.toc-link').last().click();
  await expect(page.locator('.article-body h2').last()).toBeFocused();
  await expect(page.locator('.mobile-toc-btn')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#swup').focus();
  await page.keyboard.press('/');
  await expect(page.locator('#search-input')).toBeFocused();
  await expect(page.locator('#search-results a')).toHaveCount(3);
  await page.locator('#search-input').fill('不存在的搜索词');
  await expect(page.locator('#search-status')).toContainText('还没有找到');
  await expect(page.locator('#search-results a')).toHaveCount(0);
  await page.screenshot({
    path: resolve(output, 'reader-search-empty-' + engine + '.png'),
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('#site-search-btn')).toBeFocused();
  await page.goto(origin + '/');
  const last = page.locator('.home-card h2 a').first();
  await last.scrollIntoViewIfNeeded();
  const previousY = await page.evaluate(() => scrollY);
  await last.click();
  await expect(page.locator('#swup')).toHaveAttribute('data-page', 'post');
  await expect(page.locator('#swup')).toBeFocused();
  await page.evaluate(() => {
    scrollTo({ top: 500, behavior: 'instant' });
    return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  const articleY = await page.evaluate(() => scrollY);
  assert.ok(articleY > 300);
  await page.goBack();
  await expect(page.locator('.home-layout')).toBeVisible();
  await expect(page.locator('.toc-container')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate((expected) => Math.abs(scrollY - expected), previousY))
    .toBeLessThan(30);
  await page.goForward();
  await expect(page.locator('#swup')).toHaveAttribute('data-page', 'post');
  await expect(page.locator('.toc-container')).toHaveCount(1);
  await expect
    .poll(() => page.evaluate((expected) => Math.abs(scrollY - expected), articleY))
    .toBeLessThan(30);
  await context.close();

  const delayed = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
  });
  delayed.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await delayed.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  let release,
    requests = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const searchData = [
    {
      slug: 'slow-days',
      title: '<img src=x onerror=BAD> 长信',
      description: 'A & B',
      body: '一封长信',
    },
  ];
  await delayed.route('**/search_index.json', async (route) => {
    requests++;
    await gate;
    await route.fulfill({ json: searchData });
  });
  const slow = await delayed.newPage();
  await slow.goto(origin + '/');
  await slow.keyboard.press('Control+k');
  await expect(slow.locator('#search-input')).toBeFocused();
  await expect(slow.locator('#search-status')).toContainText('正在加载');
  await slow.locator('#search-input').fill('长信');
  await slow.keyboard.press('Escape');
  await slow.locator('#site-search-btn').click();
  release();
  await expect(slow.locator('#search-results a')).toHaveCount(1);
  assert.equal(requests, 1, 'Fast reopen must share the pending search request');
  await expect(slow.locator('#search-results img')).toHaveCount(0);
  await expect(slow.locator('#search-results')).toContainText('<img src=x onerror=BAD>');
  await expect(slow.locator('#search-results mark').first()).toHaveText('长信');
  await slow.screenshot({
    path: resolve(output, 'reader-search-results-' + engine + '.png'),
    fullPage: true,
  });
  await slow.keyboard.press('ArrowDown');
  await expect(slow.locator('#search-results a')).toBeFocused();
  await slow.keyboard.press('ArrowUp');
  await expect(slow.locator('#search-input')).toBeFocused();
  await slow.keyboard.press('Enter');
  await expect(slow.locator('.article-heading h1')).toBeVisible();
  await expect(slow.locator('#search-modal')).not.toHaveClass(/active/);
  await expect(slow.locator('body')).not.toHaveCSS('overflow', 'hidden');
  await delayed.close();

  const retry = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
  });
  retry.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await retry.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  let attempts = 0;
  await retry.route('**/search_index.json', (route) => {
    attempts++;
    return attempts === 1
      ? route.fulfill({ status: 503, body: 'Unavailable' })
      : route.fulfill({ json: searchData });
  });
  const recover = await retry.newPage();
  await recover.goto(origin + '/');
  await recover.locator('#site-search-btn').click();
  await expect(recover.locator('#search-status')).toContainText('重试');
  await expect(recover.locator('#search-results')).toHaveAttribute('aria-busy', 'false');
  await recover.keyboard.press('Escape');
  await recover.locator('#site-search-btn').click();
  await expect(recover.locator('#search-results a')).toHaveCount(1);
  assert.equal(attempts, 2);
  await retry.close();

  const native = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 360, height: 844 },
  });
  await native.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const plain = await native.newPage();
  await plain.goto(origin + '/posts/slow-days/');
  await expect(plain.locator('.article-heading h1')).toBeVisible();
  await expect(plain.locator('.article-body')).toContainText('写作');
  await expect(plain.locator('#search-modal')).toBeHidden();
  assert.equal(
    await plain.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await plain.locator('.article-back').click();
  await expect(plain.locator('.home-layout')).toBeVisible();
  await native.close();
  await verifyProgressivePreview(browser, origin, output, engine);
  assert.deepEqual(errors, [], engine + ' reader interactions must not produce errors');
}

async function verifyProgressivePreview(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
    colorScheme: 'dark',
  });
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  try {
    await page.goto(origin + '/posts/slow-days/');
    const image = page.locator('.article-body img').first();
    await image.scrollIntoViewIfNeeded();
    await image.evaluate((img) => img.decode());
    const preview = await image.evaluate((img) => img.currentSrc);
    const response = await context.request.get(preview, { headers: { Referer: origin + '/' } });
    assert.equal(response.status(), 200);
    const bytes = await response.body();
    let finish,
      fail = false;
    await page.route('**/images/lightbox-original.png*', async (route) => {
      if (fail) return route.fulfill({ status: 503, body: 'Unavailable' });
      await new Promise((resolve) => {
        finish = resolve;
      });
      await route.fulfill({ contentType: 'image/png', body: bytes }).catch(() => {});
    });
    const full = origin + '/images/lightbox-original.png?attempt=1';
    await image.evaluate((img, url) => {
      img.dataset.fullSrc = url;
    }, full);
    await image.focus();
    await page.keyboard.press('Enter');
    const dialog = page.locator('dialog.reader-dialog');
    await expect(dialog.locator('img')).toHaveAttribute('src', preview);
    await expect(dialog.locator('[role=status]')).toContainText('正在加载原图');
    await expect(dialog.locator('img')).toBeVisible();
    await expect(dialog.locator('a')).toHaveAttribute('href', full);
    await page.screenshot({
      path: resolve(output, 'image-progressive-loading-' + engine + '.png'),
    });
    await expect.poll(() => typeof finish).toBe('function');
    finish();
    await expect(dialog.locator('img')).toHaveAttribute('src', full);
    await expect(dialog.locator('[role=status]')).toContainText('原图已加载');
    await page.keyboard.press('Escape');
    await expect(image).toBeFocused();

    fail = true;
    finish = undefined;
    await image.evaluate((img) => {
      img.dataset.fullSrc += '&retry=1';
    });
    await image.click();
    await expect(dialog.locator('[role=status]')).toContainText('暂时无法加载');
    await expect(dialog.locator('img')).toHaveAttribute('src', preview);
    await expect(dialog.getByRole('button', { name: '重试原图' })).toBeVisible();
    await page.screenshot({ path: resolve(output, 'image-progressive-error-' + engine + '.png') });
    fail = false;
    await dialog.getByRole('button', { name: '重试原图' }).click();
    await expect.poll(() => typeof finish).toBe('function');
    // Closing during loading must dispose callbacks and retain keyboard focus.
    await page.keyboard.press('Escape');
    finish();
    await expect(dialog).toHaveCount(0);
    await expect(image).toBeFocused();
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
    assert.deepEqual(errors, [], 'progressive preview must not leak late callbacks');
  } finally {
    await context.close();
  }
}
